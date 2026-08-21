/**
 * YuriRTC cache policy.
 *
 * Two things shape everything here:
 *
 * 1. We are a passenger, not the driver. The games fill OPFS on their own and
 *    share this origin's quota, so we cannot prevent eviction by being frugal.
 *    Every hit is optional and every write can fail mid-flight.
 * 2. Eviction is origin-atomic — Chrome drops Cache API, IndexedDB, and OPFS
 *    together — so exceeding quota does not just cost us the cache, it takes the
 *    service-worker session with it. We self-evict well below the ceiling to stay away from
 *    the browser's blunt instrument.
 */

import { CACHE_PREFIX, DEFAULT_CACHE, cacheNames } from "./config.js";
import { sharedIdb } from "./idb.js";
import type { CachePolicy } from "./routing.js";

/** Set once at worker start from the version in this worker's own URL. */
let names = cacheNames("0");
export function useVersion(version: string): void {
  names = cacheNames(version);
  dropOpenCaches();
}
export function currentCacheNames(): string[] {
  return [names.shell, names.route, names.lru];
}

/**
 * Memoized `caches.open()` handles.
 *
 * `caches.open()` is an async round trip to the CacheStorage backend, and it
 * was being paid per request on the read path and per write on the write path.
 * The handle is stable for the life of a cache, so it is opened once.
 *
 * The memo is bound to the identity of the `caches` object it came from: a test
 * (or a page swapping the global) gets a fresh set rather than another
 * registry's handles. Anything that changes which caches exist drops it.
 */
let openedFrom: unknown;
let opened = new Map<string, Promise<Cache>>();

function dropOpenCaches(): void {
  opened = new Map();
  openedFrom = undefined;
}

function openCache(name: string): Promise<Cache> {
  const registry = caches;
  if (openedFrom !== registry) {
    opened = new Map();
    openedFrom = registry;
  }
  const existing = opened.get(name);
  if (existing) return existing;

  const handle = registry.open(name);
  opened.set(name, handle);
  // A failed open must not be remembered, or one transient error would make
  // this cache unusable for the life of the worker.
  handle.catch(() => {
    if (opened.get(name) === handle) opened.delete(name);
  });
  return handle;
}

const META_DB = "edurocks-cache-meta";
const META_STORE = "entries";

interface LruEntry {
  url: string;
  size: number;
  usedAt: number;
}

export interface CacheBudget {
  budgetBytes: number;
  maxQuotaShare: number;
}

// Staging happens in service-worker memory before Cache API owns the bytes.
// Deployed V5 shell objects are below 0.5 MiB and measured covers below 2.3 MiB;
// 8 MiB leaves ample growth room without allowing one response to retain the
// 350 MiB aggregate cache budget.
const MAX_STAGED_RESPONSE_BYTES = 8 * 1024 * 1024;

export function cacheNameFor(policy: CachePolicy): string | null {
  switch (policy) {
    case "cache-first-immutable":
      return names.shell;
    case "stale-while-revalidate":
      return names.route;
    case "cache-first-lru":
      return names.lru;
    default:
      return null;
  }
}

/** One connection for the metadata store; see idb.ts for why. */
const meta = sharedIdb({
  name: META_DB,
  version: 1,
  store: META_STORE,
  upgrade: (db) => {
    if (!db.objectStoreNames.contains(META_STORE)) {
      const store = db.createObjectStore(META_STORE, { keyPath: "url" });
      store.createIndex("usedAt", "usedAt");
    }
  }
});

/**
 * Effective budget: the configured ceiling, clamped to a share of whatever the
 * browser currently reports.
 *
 * `estimate()` walks the origin's quota accounting and is one of the more
 * expensive calls available here; it was being made once per cached cover. The
 * answer moves slowly — quota shrinks as the disk fills, not between two images
 * on one page — so it is held briefly rather than re-read per write.
 */
const BUDGET_TTL_MS = 30_000;
let budgetValue: number | null = null;
let budgetFor: CacheBudget | null = null;
let budgetAt = 0;

function invalidateBudget(): void {
  budgetValue = null;
  budgetFor = null;
}

export async function effectiveBudget(config: CacheBudget): Promise<number> {
  if (
    budgetValue !== null &&
    budgetFor !== null &&
    budgetFor.budgetBytes === config.budgetBytes &&
    budgetFor.maxQuotaShare === config.maxQuotaShare &&
    Date.now() - budgetAt < BUDGET_TTL_MS
  ) {
    return budgetValue;
  }

  let budget = config.budgetBytes;
  try {
    const { quota } = await navigator.storage.estimate();
    if (typeof quota === "number" && quota > 0) {
      budget = Math.min(config.budgetBytes, Math.floor(quota * config.maxQuotaShare));
    }
  } catch {
    // estimate() can throw in odd storage states; fall through to the ceiling.
  }
  budgetValue = budget;
  budgetFor = { budgetBytes: config.budgetBytes, maxQuotaShare: config.maxQuotaShare };
  budgetAt = Date.now();
  return budget;
}

/* -------------------------------------------------------------------------- */
/* Running LRU total                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Bytes recorded in the metadata table, or null when this worker has not read
 * the table yet. One `getAll()` per worker lifetime seeds it and every mutation
 * this module performs keeps it in step, so an ordinary cover write no longer
 * scans the whole table to decide whether it fits.
 *
 * The invariant is "equal to the sum of the table", not "equal to the cache":
 * the table has always been an approximation of the cache (see touch()). What
 * the running total additionally cannot see is a second worker instance writing
 * during an update handover, so it is re-read on a bounded schedule and always
 * re-read before any decision taken near the ceiling. A total that reads too
 * low is the one error that would let the cache pass its budget, and the file
 * header explains why that matters: eviction here is origin-atomic.
 */
let lruBytes: number | null = null;
/** Forces the next decision to re-read the table. */
let totalStale = true;
/** Monotonic count of added bytes; corrects a table read that raced a write. */
let committedBytes = 0;
/** Drift budget since the last authoritative read. */
let writesSinceSync = 0;
let lastSyncAt = 0;
/** Bytes promised by writes that have not landed yet. */
let reservedBytes = 0;
/** Bumped when the table is emptied, so an in-flight read is not adopted. */
let metaGeneration = 0;

/** Re-read the table at least this often. Covers a second worker instance. */
const SYNC_INTERVAL_MS = 10_000;
/** ...and at least this often by write count, for small entries. */
const SYNC_WRITE_LIMIT = 16;
/** Arithmetic alone is trusted only this far below the budget. */
const RESERVE_SHARE = 0.125;
const MIN_RESERVE_BYTES = 16 * 1024 * 1024;

function reserveFor(budget: number): number {
  return Math.min(budget, Math.max(MIN_RESERVE_BYTES, Math.floor(budget * RESERVE_SHARE)));
}

function sizeOf(entry: LruEntry | undefined): number {
  const size = entry?.size;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

function sumSizes(all: readonly LruEntry[]): number {
  let sum = 0;
  for (const entry of all) sum += sizeOf(entry);
  return sum;
}

/** Records a table mutation this module performed. */
function applyDelta(delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return;
  // Only growth counts toward the resync schedule: shrinkage is applied inside
  // the eviction lock, immediately after an authoritative read.
  if (delta > 0) {
    committedBytes += delta;
    writesSinceSync += 1;
  }
  if (lruBytes === null) return;
  lruBytes = Math.max(0, lruBytes + delta);
}

/**
 * Re-reads the whole table, adopts it as the running total, and hands back the
 * rows so an eviction can pick victims from the same snapshot.
 *
 * Returns null when the table could not be read or was emptied under the read.
 * In both cases the previous total is left alone rather than replaced by a
 * fabricated zero.
 */
async function syncTotal(): Promise<LruEntry[] | null> {
  const generation = metaGeneration;
  const mark = committedBytes;
  let all: LruEntry[];
  try {
    all = await meta.request<LruEntry[]>("readonly", (store) => store.getAll());
  } catch {
    return null;
  }
  if (generation !== metaGeneration) return null;
  // A write that committed while the read was in flight may or may not be in
  // this snapshot. Counting it twice evicts early; missing it overruns.
  lruBytes = sumSizes(all) + (committedBytes - mark);
  totalStale = false;
  writesSinceSync = 0;
  lastSyncAt = Date.now();
  return all;
}

/**
 * Serialises the authoritative path. Two passes over the same snapshot would
 * choose the same victims and subtract them twice; queueing also collapses a
 * burst of concurrent covers into a single table read.
 */
let evictions: Promise<unknown> = Promise.resolve();
function serialised<T>(run: () => Promise<T>): Promise<T> {
  const next = evictions.then(run, run);
  evictions = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Whether arithmetic alone can answer, with room to spare for drift.
 * Bytes about to be written are in `reservedBytes`, counted exactly once.
 */
function fitsWithoutReading(budget: number): boolean {
  const total = lruBytes;
  if (total === null || totalStale) return false;
  const age = Date.now() - lastSyncAt;
  if (age < 0 || age >= SYNC_INTERVAL_MS) return false;
  if (writesSinceSync >= SYNC_WRITE_LIMIT) return false;
  return total + reservedBytes <= budget - reserveFor(budget);
}

/**
 * Makes room for whatever is currently reserved. Returns bytes freed.
 * Called before a write, not on a timer — pressure is what matters, not
 * elapsed time.
 *
 * The ordinary call is arithmetic against the running total: a cover that lands
 * with the cache far below its ceiling touches neither IndexedDB nor
 * `estimate()`. The table is re-read whenever the answer could matter — inside
 * the reserve band, on a schedule, after a refused write, and before every
 * eviction — so a drifting total costs an early eviction, never an overrun.
 */
async function ensureRoom(config: CacheBudget): Promise<number> {
  if (fitsWithoutReading(await effectiveBudget(config))) return 0;
  return serialised(async () => {
    // The pass we queued behind may already have reconciled and freed room.
    const budget = await effectiveBudget(config);
    if (fitsWithoutReading(budget)) return 0;
    return evictFromTable(budget);
  });
}

/**
 * Evicts least-recently-used entries until `incomingBytes` more would fit the
 * budget. Retained for callers outside this module; putBodyBounded holds its
 * own reservation across the whole write and calls ensureRoom directly.
 */
export async function evictToFit(config: CacheBudget, incomingBytes: number): Promise<number> {
  const claim = Number.isFinite(incomingBytes) && incomingBytes > 0 ? incomingBytes : 0;
  reservedBytes += claim;
  try {
    return await ensureRoom(config);
  } finally {
    reservedBytes = Math.max(0, reservedBytes - claim);
  }
}

/** The authoritative path. Callers must hold the eviction lock. */
async function evictFromTable(budget: number): Promise<number> {
  await flushUses();
  const all = await syncTotal();
  // No readable table means no trustworthy victim list and no trustworthy
  // total; bookkeeping is skipped exactly as it is everywhere else here.
  if (all === null) return 0;

  let projected = (lruBytes ?? 0) + reservedBytes;
  if (projected <= budget) return 0;

  let cache: Cache;
  try {
    cache = await openCache(names.lru);
  } catch {
    return 0;
  }

  let freed = 0;
  for (const entry of all.sort((a, b) => a.usedAt - b.usedAt)) {
    if (projected <= budget) break;
    const size = sizeOf(entry);
    try {
      await cache.delete(entry.url);
    } catch {
      /* already gone; still drop the bookkeeping */
    }
    await forgetEntry(entry.url);
    applyDelta(-size);
    projected -= size;
    freed += size;
  }
  return freed;
}

/* -------------------------------------------------------------------------- */
/* Recency bookkeeping                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Buffered `usedAt` refreshes.
 *
 * A games grid serves a hundred covers from cache in one burst, and each one
 * used to be its own read-modify-write transaction. Recency only has to be
 * approximately right for eviction order, so refreshes are collected and
 * written together.
 *
 * Losing a buffered refresh to worker termination costs eviction accuracy and
 * nothing else, which is the tradeoff `touch()` has always documented.
 */
const FLUSH_DELAY_MS = 250;
const MAX_PENDING_USES = 256;

interface PendingUse {
  size: number | undefined;
  usedAt: number;
}

let pendingUses = new Map<string, PendingUse>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushDue: Promise<void> | null = null;
let flushEarly: (() => void) | null = null;
/** Serialises batch writes so two flushes cannot interleave transactions. */
let metaWrites: Promise<void> = Promise.resolve();

export function noteUse(url: string, size?: number): void {
  const previous = pendingUses.get(url);
  pendingUses.set(url, { size: size ?? previous?.size, usedAt: Date.now() });
  scheduleFlush();
  if (pendingUses.size >= MAX_PENDING_USES) void flushUses();
}

function scheduleFlush(): void {
  if (flushDue !== null) return;
  flushDue = new Promise<void>((resolve) => {
    flushEarly = resolve;
    flushTimer = setTimeout(resolve, FLUSH_DELAY_MS);
  }).then(runFlush);
  // Housekeeping must never hold a Node test process open.
  (flushTimer as unknown as { unref?: () => void } | null)?.unref?.();
}

function runFlush(): Promise<void> {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  flushDue = null;
  flushEarly = null;
  if (pendingUses.size === 0) return metaWrites;
  const batch = pendingUses;
  pendingUses = new Map();
  metaWrites = metaWrites.then(() => writeUses(batch), () => writeUses(batch));
  return metaWrites;
}

/** Forces any buffered refreshes out and resolves once they have landed. */
export function flushUses(): Promise<void> {
  if (flushDue === null) return metaWrites;
  const due = flushDue;
  flushEarly?.();
  return due;
}

/**
 * Writes one batch of refreshes in a single transaction.
 *
 * Each entry is still read before it is written: a row that no longer exists
 * must not be recreated. An eviction can delete a cover while a `cache.match`
 * for it is still in flight, and blind-putting would resurrect a phantom row
 * whose body is gone — making every later sweep over-count and evict a live
 * cover to make room for nothing.
 */
async function writeUses(batch: Map<string, PendingUse>): Promise<void> {
  let delta = 0;
  try {
    await meta.commit("readwrite", (store) => {
      // The helper may retry this callback on a connection that died under it.
      // Only the surviving attempt's arithmetic may reach the running total.
      delta = 0;
      for (const [url, use] of batch) {
        const read = store.get(url);
        read.onsuccess = () => {
          const previous = read.result as LruEntry | undefined;
          const next = use.size ?? (previous === undefined ? undefined : sizeOf(previous));
          // A cache/metadata mismatch is repaired on the next write. Inventing
          // a zero-byte entry here would make eviction under-count the cache.
          if (next === undefined || previous === undefined) return;
          delta += next - sizeOf(previous);
          store.put({ url, size: next, usedAt: use.usedAt } satisfies LruEntry);
        };
      }
    });
    applyDelta(delta);
  } catch {
    // Losing LRU bookkeeping degrades eviction order; it must not fail a request.
  }
}

/**
 * Records an entry the cache has just stored.
 *
 * Unlike a refresh this creates the row, so it is written through immediately
 * rather than buffered: the running total and every later eviction depend on it.
 */
export async function touch(url: string, size?: number): Promise<void> {
  if (size === undefined) {
    noteUse(url);
    return;
  }
  let delta = 0;
  try {
    await meta.commit("readwrite", (store) => {
      const read = store.get(url);
      read.onsuccess = () => {
        const previous = read.result as LruEntry | undefined;
        // Storing a URL the table already holds moves the total by the
        // difference, not by the whole body.
        delta = size - sizeOf(previous);
        store.put({ url, size, usedAt: Date.now() } satisfies LruEntry);
      };
    });
    applyDelta(delta);
  } catch {
    /* see writeUses() */
  }
}

/** A trustworthy byte size from a cached response, if it still carries one. */
export function contentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const size = Number(raw);
  return Number.isSafeInteger(size) ? size : undefined;
}

async function forgetEntry(url: string): Promise<void> {
  pendingUses.delete(url);
  try {
    await meta.request("readwrite", (store) => store.delete(url));
  } catch {
    /* see writeUses() */
  }
}

/**
 * Drops an entry's bookkeeping. The caller does not say how big the entry was,
 * so the running total can only be repaired by re-reading the table; that is
 * deferred to the next eviction decision rather than paid here.
 */
export async function forget(url: string): Promise<void> {
  totalStale = true;
  await forgetEntry(url);
}

/**
 * Stores a response under a bounded budget.
 *
 * Must tolerate `QuotaExceededError` mid-write: the games can fill the origin at
 * any moment and a failed cache write is never a failed request.
 */
export async function putBounded(
  request: Request,
  response: Response,
  policy: CachePolicy,
  config: CacheBudget = DEFAULT_CACHE
): Promise<void> {
  const cacheName = cacheNameFor(policy);
  if (!cacheName) return;

  // Never cache a partial. Chrome rejects `cache.put()` outright for 206 with
  // "Partial response (status code 206) is unsupported" — verified, and not
  // what MDN documents.
  if (response.status === 206 || !response.ok) return;

  // The caller already gives this function its own response branch. Cloning it
  // again creates an unread tee that retains the complete body until GC.
  const body = await response.blob().catch(() => null);
  if (!body) return;

  await putBodyBounded(request, body, response, policy, config);
}

async function putBodyBounded(
  request: Request,
  body: Blob,
  response: Pick<Response, "status" | "statusText" | "headers">,
  policy: CachePolicy,
  config: CacheBudget
): Promise<void> {
  const cacheName = cacheNameFor(policy);
  if (!cacheName) return;
  const bounded = policy === "cache-first-lru";
  const size = body.size;

  // Concurrent covers each ask "does mine fit?" before any of them has landed.
  // Holding the promised bytes is what makes those questions see each other.
  if (bounded) reservedBytes += size;
  try {
    if (bounded) await ensureRoom(config);
    const cache = await openCache(cacheName);
    await cache.put(request, new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }));
    if (bounded) await touch(request.url, size);
  } catch (error) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      // Expected under pressure. Drop what we can and move on uncached. The
      // quota reading is discarded too: it demonstrably no longer describes
      // this origin, and the running total may have raced a foreign write.
      invalidateBudget();
      totalStale = true;
      await ensureRoom(config).catch(() => 0);
      return;
    }
    // Any other cache failure is also non-fatal by design.
  } finally {
    if (bounded) reservedBytes = Math.max(0, reservedBytes - size);
  }
}

/**
 * Makes caching follow the foreground consumer instead of teeing the response.
 *
 * `Response.clone()` creates a tee whose cache branch can drain the complete
 * transport after an image/navigation consumer has gone away. Besides wasting
 * bandwidth, those invisible reads can occupy every bulk lane. This wrapper
 * has a zero-sized queue and performs exactly one upstream read for each
 * foreground pull. Bytes are copied for a possible cache write as they pass;
 * only a clean EOF stores them. Cancellation or request abort is propagated to
 * the original body and drops the partial copy.
 */
export function cacheWhileConsumed(
  request: Request,
  response: Response,
  policy: CachePolicy,
  config: CacheBudget = DEFAULT_CACHE
): Response {
  if (
    !cacheNameFor(policy) ||
    response.status === 206 ||
    !response.ok ||
    !response.body ||
    response.bodyUsed ||
    response.body.locked
  ) {
    return response;
  }

  // A constructed Response cannot inherit the internal URL list/type of a
  // fetched response. Transport responses are synthetic (the default type and
  // an empty URL); preserve any other response exactly by declining to wrap it.
  if (response.url !== "" || response.redirected || response.type !== "default") return response;

  const metadata = {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  };
  const reader = response.body.getReader();
  const configuredLimit = Number.isSafeInteger(config.budgetBytes) && config.budgetBytes > 0
    ? Math.min(config.budgetBytes, MAX_STAGED_RESPONSE_BYTES)
    : 0;
  const declaredLength = contentLength(metadata.headers);
  let retainForCache = configuredLimit > 0 &&
    (declaredLength === undefined || declaredLength <= configuredLimit);
  let retainedBytes = 0;
  // Retained by reference, not copied. Every chunk here is a view into a wire
  // frame the page transferred to this worker (client.ts posts the whole
  // ArrayBuffer in the transfer list), so this worker is its only owner and
  // nothing can mutate it behind the cache. The annotation is load-bearing:
  // BlobPart requires ArrayBufferView<ArrayBuffer>, not ArrayBufferLike.
  let chunks: Uint8Array<ArrayBuffer>[] = [];
  let stopped = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const discard = (): void => {
    retainForCache = false;
    retainedBytes = 0;
    chunks = [];
  };
  const removeAbort = (): void => {
    request.signal.removeEventListener("abort", onAbort);
  };
  const abortReason = (): unknown => request.signal.reason ??
    new DOMException("The request was aborted", "AbortError");
  const onAbort = (): void => {
    if (stopped) return;
    stopped = true;
    discard();
    removeAbort();
    const reason = abortReason();
    void reader.cancel(reason).catch(() => undefined);
    try {
      controllerRef?.error(reason);
    } catch {
      /* the foreground already closed or cancelled */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (stopped) return;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (stopped) return;
        stopped = true;
        discard();
        removeAbort();
        controller.error(error);
        return;
      }
      if (stopped) return;

      if (result.done) {
        stopped = true;
        removeAbort();
        controller.close();
        if (!retainForCache) return;

        // Blob joins the pieces in the blob store rather than building a
        // second contiguous copy on this worker's heap.
        let body: Blob;
        try {
          body = new Blob(chunks);
        } catch {
          // Never leave the frames pinned in this closure if the join fails.
          discard();
          return;
        }
        chunks = [];
        retainedBytes = 0;
        void putBodyBounded(request, body, metadata, policy, config);
        return;
      }

      const chunk = result.value as Uint8Array<ArrayBuffer>;
      if (retainForCache) {
        if (chunk.byteLength > configuredLimit - retainedBytes) {
          discard();
        } else {
          chunks.push(chunk);
          retainedBytes += chunk.byteLength;
        }
      }
      controller.enqueue(chunk);
    },
    async cancel(reason) {
      if (stopped) return;
      stopped = true;
      discard();
      removeAbort();
      await reader.cancel(reason).catch(() => undefined);
    }
  }, {
    // A positive high-water mark permits a pull before anybody reads the
    // Response, recreating the speculative transfer this wrapper prevents.
    highWaterMark: 0
  });

  return new Response(stream, metadata);
}

export async function matchCached(
  request: Request,
  policy: CachePolicy
): Promise<Response | undefined> {
  const cacheName = cacheNameFor(policy);
  if (!cacheName) return undefined;
  try {
    const cache = await openCache(cacheName);
    const hit = await cache.match(request);
    if (hit && policy === "cache-first-lru") {
      // Buffered: a grid of covers becomes one transaction, not one each.
      noteUse(request.url, contentLength(hit.headers));
    }
    return hit;
  } catch {
    return undefined;
  }
}

/**
 * Drops caches from previous site builds. Only touches our own namespace, so a
 * co-existing worker's caches are left alone.
 */
export async function purgeStale(keep: readonly string[]): Promise<void> {
  const existing = await caches.keys();
  const stale = existing.filter(
    (name) => name.startsWith(CACHE_PREFIX) && !keep.includes(name)
  );
  if (stale.length === 0) return;
  try {
    await Promise.all(stale.map((name) => caches.delete(name)));
  } finally {
    dropOpenCaches();
  }
}

/** Everything, for the site's CLEAR_CACHE / CLEAR_ALL_CACHE messages. */
export async function clearAllCaches(): Promise<void> {
  // The table describes caches that are about to stop existing.
  metaGeneration += 1;
  pendingUses.clear();
  lruBytes = 0;
  totalStale = true;
  const existing = await caches.keys();
  try {
    await Promise.all(existing.map((name) => caches.delete(name)));
    await meta.request("readwrite", (store) => store.clear()).catch(() => undefined);
  } finally {
    dropOpenCaches();
  }
}
