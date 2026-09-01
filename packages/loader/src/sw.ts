/**
 * YuriRTC service-worker entry.
 *
 * The SW is the only place that can transparently swap transports, so the app
 * never learns how a request was served. It also converts what arrives over the
 * data channel into same-origin Responses, which sidesteps CORS entirely.
 */

import {
  ALWAYS_FRESH,
  DEFAULT_CACHE,
  buildVersion,
  normalizeBuildVersion
} from "./config.js";
import {
  INITIAL_CREDIT,
  WIRE_ACCEPT_ENCODING_HEADER,
  WIRE_CONTENT_ENCODING_HEADER,
  decodeWireBody,
  headerValue,
  requestBodyForTransport,
  responseCanHaveBody,
  responseHeaders,
  supportsWireGzip,
  withoutHeader
} from "./bridge.js";
import {
  cacheWhileConsumed,
  cachedResponseIsFresh,
  clearAllCaches,
  currentCacheNames,
  matchCached,
  purgeStale,
  putBounded,
  removeCached,
  responseForbidsStoredFallback,
  useVersion
} from "./cache.js";
import { classifyRequest, isRanged, requestPriority } from "./routing.js";
import { applySetCookie, clearSession, cookieHeader } from "./session.js";
import { needsIsolation, withIsolationHeaders } from "./coi.js";
import { NoCarrierError, SwBridge } from "./swbridge.js";
import {
  locationWithinScope,
  logicalPathForScope,
  scopePathFromUrl,
  shellPathForWorker
} from "./scope.js";
import { APP_PATH_PARAM } from "./shell.js";
import { isV4GameJsonRequest, rebaseV4GameJson } from "./game-json.js";
import {
  injectIntoStream,
  loadBootstrap,
  mergeBootstrap,
  rebaseWebManifestJson,
  saveBootstrap,
  shouldInjectDocument,
  type InjectedBootstrap
} from "./inject.js";
import {
  PROTOCOL_VERSION,
  type HeaderPairs,
  type RequestHead
} from "@yurirtc/protocol";
import {
  acceptWorkerAttachProtocol,
  shouldClaimClientsOnActivate
} from "./worker-rollout.js";

declare const self: ServiceWorkerGlobalScope & {
  __YURIRTC_SITE_BUILD__?: string;
  /** Legacy build hook used by already-deployed workers. */
  __EDUROCKS_SITE_BUILD__?: string;
};

const bridge = new SwBridge();
// During an update this points at the still-controlling prior worker. Capture
// it while this script is installing; `registration.active` becomes this
// worker by the time the activate callback itself runs.
const claimBootstrapClients = shouldClaimClientsOnActivate(self.registration.active);

/**
 * The active site's build version. Direct V4/V5 deployments put it in this
 * worker's URL; V5 also embeds it so every standalone build has different
 * worker bytes. A static WebRTC bucket receives it from the guarded app page.
 *
 * This worker replaces `frontend-dist/sw.js`, which existed to stop users being
 * left on a stale build. That mechanism is preserved exactly: a new build gives
 * the worker a new URL, which forces a fresh install, which drops the caches
 * scoped to the old version.
 */
const workerUrlBuildVersion = (() => {
  try {
    return normalizeBuildVersion(new URL(self.location.href).searchParams.get("v"));
  } catch {
    return null;
  }
})();
const embeddedBuildVersion =
  normalizeBuildVersion(self.__YURIRTC_SITE_BUILD__) ?? self.__EDUROCKS_SITE_BUILD__;
const workerBuildVersion = buildVersion(self.location, embeddedBuildVersion);
// A query parameter means this worker was registered by the directly hosted
// build and is authoritative. An embedded id is only the initial fallback for
// an unversioned copy used on the static bucket; the transported site may be a
// newer release and must be allowed to hand its identity across.
const acceptsTransportedBuildVersion = workerUrlBuildVersion === null;
let activeBuildVersion = workerBuildVersion;
useVersion(activeBuildVersion);

/** How to rebuild a page-side transport. See inject.ts for why this exists. */
let bootstrap: InjectedBootstrap | null = null;

function applyBuildVersion(value: unknown): boolean {
  const version = normalizeBuildVersion(value);
  if (!version || version === activeBuildVersion) return false;
  activeBuildVersion = version;
  useVersion(version);
  return true;
}

async function restoreBootstrap(): Promise<InjectedBootstrap | null> {
  if (!bootstrap) {
    const loaded = await loadBootstrap();
    // Another message can install a newer in-memory bootstrap while IndexedDB
    // is being read. Never replace that newer value with the earlier snapshot.
    bootstrap ??= loaded;
  }
  // An explicit query version belongs to a directly hosted build and wins over
  // stale loader state. An unversioned static worker, whether it has an
  // embedded fallback or not, recovers the transported identity from IDB.
  if (acceptsTransportedBuildVersion && bootstrap?.siteVersion) {
    if (applyBuildVersion(bootstrap.siteVersion)) {
      await purgeStale(currentCacheNames());
    }
  }
  return bootstrap;
}

/**
 * Whether this origin uses the WebRTC transport at all.
 *
 * The bucket origin stores a bootstrap the first time the loader runs. The
 * site's own origin never does — there, this worker is only the cache-buster it
 * replaced, and must not wait on a transport that is never coming.
 */
let expectsTransport: boolean | null = null;
async function transportExpected(): Promise<boolean> {
  // A worker installed with an explicit build query belongs to a direct host.
  // Ignore loader state that may be left behind if this origin previously
  // served the static WebRTC shell.
  if (workerUrlBuildVersion !== null) {
    expectsTransport = false;
    return false;
  }
  if (expectsTransport !== null) return expectsTransport;
  await restoreBootstrap();
  // An attach message may have set this while restoreBootstrap was waiting.
  if (expectsTransport === null) expectsTransport = bootstrap !== null;
  return expectsTransport;
}

/**
 * An injected app page may become a temporary carrier after a worker restart,
 * but it must not replace the permanent static shell's recovery path.
 */
async function rememberBootstrap(value: InjectedBootstrap): Promise<void> {
  const loaded = bootstrap ?? await loadBootstrap();
  const previous = bootstrap ?? loaded;
  let merged = mergeBootstrap(previous, value);
  // YuriRTCClient does not know the site version. If it raced the version
  // handoff, the in-memory value is newer than what its earlier IDB read saw.
  if (!value.siteVersion && activeBuildVersion !== "0") {
    merged = { ...merged, siteVersion: activeBuildVersion };
  }
  bootstrap = merged;
  if (merged.siteVersion) applyBuildVersion(merged.siteVersion);
  await saveBootstrap(merged);
}

/**
 * Applies the build id forwarded by an injected page whose own registration
 * was intentionally suppressed. Only versioned shell/route caches rotate; the
 * immutable, bounded LRU remains shared across releases.
 */
let siteVersionTransition: Promise<void> = Promise.resolve();

function adoptSiteVersion(value: unknown): Promise<void> {
  const version = normalizeBuildVersion(value);
  // A directly registered worker has an authoritative query build id. An
  // unversioned static worker accepts the transported build, even when its
  // bytes contain an embedded fallback from the V5 build that produced it.
  if (!version || !acceptsTransportedBuildVersion) return Promise.resolve();
  const requestedChange = version !== activeBuildVersion;

  const operation = siteVersionTransition.then(async () => {
    const loaded = bootstrap ?? await loadBootstrap();
    const previous = bootstrap ?? loaded;
    let persist: Promise<void> = Promise.resolve();
    if (previous && previous.siteVersion !== version) {
      bootstrap = { ...previous, siteVersion: version };
      // Persistence is recovery state, not a prerequisite for applying the
      // live build. An unavailable IndexedDB must not strand old caches.
      persist = saveBootstrap(bootstrap).catch(() => undefined);
    }
    expectsTransport = true;
    const changed = applyBuildVersion(version);
    // Always reconcile the namespace. This also repairs an interrupted prior
    // transition whose version was persisted before its purge completed.
    await Promise.all([purgeStale(currentCacheNames()), persist]);
    // requestedChange covers a concurrent restore that applied this build
    // before the queued transition ran; changed covers queued A -> B -> A.
    if (requestedChange || changed) await notifyActivated();
  });
  siteVersionTransition = operation.catch(() => undefined);
  return operation;
}

/**
 * Served by whatever hosts the loader, never by the content node. Resolved
 * against this worker's own location rather than the origin root, so the loader
 * still recognises its own files when deployed under a subdirectory.
 *
 * `client.js` is bootstrap-critical: it is the script that builds the
 * transport, so it can never be fetched *over* the transport.
 */
// Deliberately not index.html: at a root deployment that name belongs to the
// app as well, and excluding it would serve the bootstrap page forever instead
// of the site. The collision resolves on its own — the host answers it before
// the worker exists, the worker answers it from the transport afterwards.
const LOADER_DIR = new URL(".", self.location.href).pathname;
const APP_SCOPE = self.registration.scope;
const APP_BASE = scopePathFromUrl(APP_SCOPE);
const LOADER_ASSETS = new Set([
  LOADER_DIR + "sw.js",
  LOADER_DIR + "client.js",
  LOADER_DIR + "test.html"
]);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drops shell/route caches belonging to older builds. The LRU cover cache
      // is version-independent and deliberately survives — see config.ts.
      await restoreBootstrap();
      await purgeStale(currentCacheNames());
      // A first install may claim its bootstrap page immediately. An upgrade
      // must not seize already-open pages whose client bundle still speaks the
      // previous wire protocol; their existing controller remains valid until
      // they navigate or reload into this version.
      if (claimBootstrapClients) await self.clients.claim();
      await notifyActivated();
    })()
  );
});

/** The site's page listens for this to decide whether to reload. */
async function notifyActivated(): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "SW_ACTIVATED", version: activeBuildVersion });
  }
}

/** Replies on the port the site's page passes with its message. */
function replyToMessage(event: ExtendableMessageEvent, value: unknown): void {
  event.ports?.[0]?.postMessage(value);
}

self.addEventListener("message", (event) => {
  const data = event.data as
    | {
        t?: string;
        bootstrap?: InjectedBootstrap;
        version?: unknown;
        protocolVersion?: unknown;
      }
    | undefined;
  if (data?.t === "attach" && event.ports[0]) {
    const port = event.ports[0];
    // This guard must precede bridge.attach and rememberBootstrap. Otherwise a
    // older-protocol page can receive a successful acknowledgement and overwrite the
    // recovery bootstrap before either side discovers the wire mismatch.
    if (!acceptWorkerAttachProtocol(data.protocolVersion, port)) {
      console.warn("[YuriRTC] refusing attachment from a different protocol version");
      return;
    }
    if (!acceptsTransportedBuildVersion) {
      // A stale injected page from a former static deployment must not attach
      // to this build's worker: its cache names, shell path, and transport
      // expectations belong to the deployment that served it.
      console.warn("[YuriRTC] refusing attachment from a transported page");
      return;
    }
    const source = event.source;
    const ownerClientId = source && "id" in source ? source.id : undefined;
    bridge.attach(port, ownerClientId);
    return;
  }
  if (data?.t === "bootstrap" && event.ports[0]) {
    const port = event.ports[0];
    if (!acceptWorkerAttachProtocol(data.protocolVersion, port) || !data.bootstrap) {
      return;
    }
    // This second, versioned acknowledgement keeps v3 recovery URLs out of an
    // older-protocol worker. waitUntil preserves the IDB write even if the worker would
    // otherwise be terminated as soon as the message task finishes.
    expectsTransport = true;
    event.waitUntil(
      rememberBootstrap(data.bootstrap)
        .then(() => {
          port.postMessage({ t: "bootstrapped", protocolVersion: PROTOCOL_VERSION });
        })
        .catch(() => {
          port.postMessage({ t: "bootstrap-error", protocolVersion: PROTOCOL_VERSION });
        })
        .finally(() => port.close())
    );
    return;
  }
  if (data?.t === "logout") {
    event.waitUntil(clearSession());
    return;
  }
  if (data?.t === "site-version") {
    event.waitUntil(adoptSiteVersion(data.version).catch(() => undefined));
    return;
  }

  // The site's own message protocol, preserved verbatim. Its page code sends
  // these and waits on the reply port; changing the shape would break it.
  const message = event.data as string | { type?: string } | undefined;
  const type = typeof message === "string" ? message : message?.type;

  switch (type) {
    case "GET_VERSION":
      event.waitUntil(
        restoreBootstrap().then(() => replyToMessage(event, activeBuildVersion))
      );
      break;
    case "SKIP_WAITING":
      event.waitUntil(self.skipWaiting());
      break;
    case "CLEAR_CACHE":
    case "CLEAR_ALL_CACHE":
      event.waitUntil(
        clearAllCaches().then(() => replyToMessage(event, "CLEARED"))
      );
      break;
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Same-origin only. Anything else — Firebase, and whatever third parties the
  // site itself loads — goes to the network untouched. Only this origin's
  // traffic crosses the data channel, which is what keeps the content node from
  // being a general-purpose proxy.
  if (url.origin !== self.location.origin) return;

  // The loader's own assets live in the bucket, not on the content node.
  // Routing them through the transport would ask the node for files it does not
  // have — and worse, the client bundle is what *creates* the transport, so
  // that request could never be answered.
  if (LOADER_ASSETS.has(url.pathname)) return;

  // Scope decides which *documents* this worker controls, not which requests a
  // controlled document may issue. Legacy games still contain origin-root
  // URLs such as /filestorage/gn/sysload.js; browsers deliver those fetches to
  // this worker even when its registration lives at /bucket/. Keep prefixed
  // V5 paths mapped to the node root and preserve legacy root paths verbatim.
  const scopedLogicalPath = logicalPathForScope(url.pathname, APP_BASE);
  const logicalPath = scopedLogicalPath ?? url.pathname;

  event.respondWith(handle(request, logicalPath));
});

async function handle(request: Request, logicalPath: string): Promise<Response> {
  const logicalUrl = new URL(request.url);
  logicalUrl.pathname = logicalPath;
  const classification = classifyRequest({
    url: logicalUrl.href,
    mode: request.mode,
    destination: request.destination
  });
  const url = new URL(request.url);
  const ranged = isRanged(request.headers as unknown as Iterable<[string, string]>);
  const topLevelNavigation =
    request.mode === "navigate" &&
    request.destination !== "iframe" &&
    request.destination !== "frame";
  const expected = await transportExpected();
  const transportCacheable = classification.cacheable &&
    (classification.policy !== "revalidate-lru" || expected);
  // Every ancestor between the shell and a SAB game must opt into COEP. On a
  // static transport deployment that means all navigated frames, not only the
  // final g-fra-sab document. Direct hosting retains the narrower V4/V5 rule.
  const workerScript =
    request.destination === "worker" || request.destination === "sharedworker";
  const isolate =
    (request.mode === "navigate" && (expected || needsIsolation(logicalPath))) ||
    workerScript;

  // The bucket is a permanent shell: every top-level navigation stays in it,
  // while iframe navigations belong to the transported app. This is true even
  // when a live port still exists briefly during unload; routing that top-level
  // request through the port would replace the page that owns the sole
  // RTCPeerConnection. Redirect bookmarks to the canonical shell and always
  // fetch that shell from its static host.
  const staticShellNavigation =
    acceptsTransportedBuildVersion && url.pathname === loaderShellPath();
  if (topLevelNavigation && (expected || staticShellNavigation)) {
    return url.pathname === loaderShellPath()
      ? fetchLoaderShell()
      : redirectToLoaderShell(url);
  }

  // Inherited from the site worker's ALWAYS_FRESH_PATHS: these change every
  // build without a content hash, so a cached copy is how users end up on an
  // old page referencing dead assets.
  //
  // Skip the cache for these — unless there is no way to go fresh at all.
  //
  // On the site's own origin "fresh" means the network, which is always
  // available, so the rule holds exactly as the previous worker enforced it.
  // On the bucket origin it means the transport, and the navigation right after
  // the loader reloads has none yet — there the cached shell is the only thing
  // that can answer, so the rule yields rather than deadlocking the page.
  const alwaysFresh = request.mode === "navigate" || ALWAYS_FRESH.has(logicalPath);

  // Only these two decide *where* the answer comes from rather than how long it
  // takes to get there: an always-fresh path skips the cache on a positive, and
  // an origin with no transport goes to the network on a negative. Both must
  // see a freshly confirmed carrier. Every ordinary subresource — script,
  // image, font, cover, payload — reuses a recent confirmation instead of
  // asking the browser process again, which is where the volume is.
  const connected = alwaysFresh || !expected
    ? await bridge.isConnected()
    : await bridge.isLikelyConnected();
  const canGoFresh = connected || !expected;
  const preferFresh = alwaysFresh && canGoFresh;
  const cacheReadAllowed = request.cache !== "no-store" && request.cache !== "reload";
  const forceCached = request.cache === "force-cache" || request.cache === "only-if-cached";

  let validatorCacheHit: Response | undefined;

  if (
    transportCacheable &&
    cacheReadAllowed &&
    !ranged &&
    !preferFresh &&
    request.method === "GET"
  ) {
    const hit = await matchCached(request, classification.policy);
    if (hit) {
      if (
        classification.policy === "stale-while-revalidate" &&
        connected &&
        request.cache !== "no-cache"
      ) {
        // Fire and forget; a failed revalidation must not fail the response.
        void revalidate(request, classification.policy, logicalPath, hit.clone());
      }
      if (
        forceCached ||
        (classification.policy !== "revalidate-lru" && request.cache !== "no-cache") ||
        (request.cache !== "no-cache" && cachedResponseIsFresh(hit)) ||
        !connected
      ) {
        return withIsolationHeaders(await withTransport(hit, request), isolate);
      }
      // Generic static content is safe to retain, but not safe to assume
      // immutable. Hold this entry as an offline fallback and ask the node to
      // validate it before transferring another body.
      validatorCacheHit = hit;
    }
  }

  // `only-if-cached` is a cache-only operation. Letting a miss escape to the
  // transport both violates the request contract and can unexpectedly wake a
  // dormant carrier. A synthetic 504 matches browser HTTP-cache behavior.
  if (request.cache === "only-if-cached") {
    return new Response(null, { status: 504, statusText: "Gateway Timeout" });
  }

  // Two different reasons there might be no transport, needing opposite
  // handling — telling them apart is what makes one worker safe on both origins.
  if (!connected) {
    // (a) This origin never uses one. That is the site served directly by its
    //     own web server, where this worker's whole job is the cache-busting
    //     the site's previous worker did. Go to the network, no-store on the
    //     paths that must never be stale.
    if (!expected) {
      try {
        return await fetch(request, preferFresh ? { cache: "no-store" } : undefined);
      } catch {
        const stale = await matchCached(request, classification.policy);
        if (stale) return stale;
        throw new Error("offline and uncached");
      }
    }

    // No page can answer a wake-up on a cold top-level visit. Redirect to the
    // canonical static shell, which creates a fresh transport and then mounts
    // the requested app in its frame. A redirect keeps the visible URL aligned
    // with shellPath so the next reload follows this same recovery path.
    if (topLevelNavigation) return redirectToLoaderShell(url);

    // (b) A transport is expected but this worker has no port right now —
    //     it was restarted, or the document holding it went away. Do *not*
    //     fall through to the network: on a bucket that answers a navigation
    //     with a directory listing, which is what the user sees instead of the
    //     site. Fall through to the transport instead, which wakes the shell
    //     and waits for it to re-offer its port. Only a genuine first visit
    //     reaches here with nothing to wake, and that is case (a) above.
  }

  try {
    const transportRequest = validatorCacheHit
      ? conditionalRequest(request, validatorCacheHit)
      : request;
    let response = await fromTransport(transportRequest, logicalPath);
    if (response.status === 304) {
      if (!validatorCacheHit) {
        throw new Error("transport returned 304 without a cached representation");
      }
      response = mergeNotModified(validatorCacheHit, response);
      // Refresh validator/date metadata without making the foreground wait on
      // CacheStorage. The response clone reads local cache bytes, not YuriRTC.
      void putBounded(
        request,
        response.clone(),
        classification.policy,
        cacheBudget()
      );
      return withIsolationHeaders(await withTransport(response, request), isolate);
    }
    if (validatorCacheHit && responseForbidsStoredFallback(response)) {
      void removeCached(request, classification.policy);
    }
    if (
      transportCacheable &&
      !ranged &&
      request.method === "GET" &&
      response.ok
    ) {
      // Capture the original representation as the foreground consumes it.
      // This stays before injection so transport markers are never cached,
      // without an eager tee that keeps abandoned requests alive.
      response = cacheWhileConsumed(
        request,
        response,
        classification.policy,
        cacheBudget()
      );
    }
    return withIsolationHeaders(await withTransport(response, request), isolate);
  } catch (error) {
    if (topLevelNavigation && error instanceof NoCarrierError) {
      return url.pathname === loaderShellPath()
        ? fetchLoaderShell()
        : redirectToLoaderShell(url);
    }
    // Last resort: a stale cached copy beats an error page.
    const stale = validatorCacheHit ?? (transportCacheable
      ? await matchCached(request, classification.policy)
      : undefined);
    if (stale) return withIsolationHeaders(await withTransport(stale, request), isolate);
    return new Response(`transport error: ${String(error)}`, {
      status: 502,
      headers: { "content-type": "text/plain" }
    });
  }
}

function conditionalRequest(request: Request, cached: Response): Request {
  const headers = new Headers(request.headers);
  const etag = cached.headers.get("etag");
  const modified = cached.headers.get("last-modified");
  if (etag && !headers.has("if-none-match")) headers.set("if-none-match", etag);
  if (modified && !headers.has("if-modified-since")) {
    headers.set("if-modified-since", modified);
  }
  return new Request(request, { headers });
}

/** Applies metadata a 304 is allowed to update while retaining the cached body. */
function mergeNotModified(cached: Response, notModified: Response): Response {
  const headers = new Headers(cached.headers);
  for (const [name, value] of notModified.headers) {
    if (name.toLowerCase() === "content-length") continue;
    headers.set(name, value);
  }
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers
  });
}

/**
 * Every HTML document leaves with the loader in it. Without this the first
 * navigation the SW serves would be a page with no `RTCPeerConnection`, and the
 * transport would die exactly once it started being used. See inject.ts.
 */
async function withTransport(response: Response, request: Request): Promise<Response> {
  const requestPath = new URL(request.url).pathname;
  const logicalPath = logicalPathForScope(requestPath, APP_BASE) ?? requestPath;
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  const completeRepresentation = response.status === 200 && !request.headers.has("range");
  const webManifest =
    logicalPath === "/manifest.json" || logicalPath.endsWith(".webmanifest");
  const v4GameJson = isV4GameJsonRequest(request.method, logicalPath);

  if (
    APP_BASE !== "/" &&
    v4GameJson &&
    completeRepresentation &&
    response.body &&
    type.includes("json")
  ) {
    const original = await response.clone().text();
    const rebased = rebaseV4GameJson(
      original,
      request.method,
      logicalPath,
      APP_BASE
    );
    if (rebased === original) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("etag");
    headers.delete("accept-ranges");
    headers.delete("content-range");
    return new Response(rebased, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  if (
    APP_BASE !== "/" &&
    webManifest &&
    completeRepresentation &&
    response.body &&
    (type.includes("json") || type.includes("manifest"))
  ) {
    const original = await response.clone().text();
    const rebased = rebaseWebManifestJson(original, APP_BASE);
    if (rebased === original) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("etag");
    headers.delete("accept-ranges");
    headers.delete("content-range");
    return new Response(rebased, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  if (!shouldInjectDocument(request, response)) return response;

  // A live port means a shell page is already holding the connection and this
  // document is its frame, so it needs the guard but not a second transport.
  // Without a port the document must bootstrap its own.
  await restoreBootstrap();
  const needsTransport = !(await bridge.isConnected()) && bootstrap !== null;

  if (!response.body) return response;
  const headers = new Headers(response.headers);
  // Injection changes the body length. Transport responses normally have this
  // stripped already, but deleting it here also keeps cached/legacy responses
  // correct.
  headers.delete("content-length");
  return new Response(injectIntoStream(response.body, needsTransport ? bootstrap : null, APP_BASE), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function cacheBudget(): typeof DEFAULT_CACHE {
  const configured = bootstrap?.config.cache;
  return configured
    ? {
        budgetBytes: configured.lruBudgetBytes ?? DEFAULT_CACHE.budgetBytes,
        maxQuotaShare: configured.maxQuotaShare ?? DEFAULT_CACHE.maxQuotaShare
      }
    : DEFAULT_CACHE;
}

function loaderShellPath(): string {
  return shellPathForWorker(bootstrap?.shellPath, self.location.href, APP_SCOPE);
}

function loaderShellUrl(requested?: URL): URL {
  const shell = new URL(loaderShellPath(), self.location.origin);
  if (requested && requested.pathname !== shell.pathname) {
    shell.searchParams.set(APP_PATH_PARAM, requested.pathname + requested.search);
  }
  return shell;
}

async function fetchLoaderShell(): Promise<Response> {
  const response = await fetch(loaderShellUrl(), {
    cache: "no-store",
    credentials: "same-origin"
  });
  // The first object-store response cannot carry COOP/COEP. boot() performs a
  // one-time reload after activation; this synthesized response is what makes
  // that second top-level document cross-origin isolated.
  return withIsolationHeaders(response, true);
}

function redirectToLoaderShell(requested: URL): Response {
  return Response.redirect(loaderShellUrl(requested).href, 302);
}

const revalidations = new Map<string, Promise<void>>();

function revalidate(
  request: Request,
  policy: "stale-while-revalidate",
  logicalPath: string,
  cached: Response
): Promise<void> {
  const key = `${request.method} ${request.url}`;
  const active = revalidations.get(key);
  if (active) return active;

  const operation = (async () => {
    try {
      const fresh = await fromTransport(conditionalRequest(request, cached), logicalPath);
      const replacement = fresh.status === 304
        ? mergeNotModified(cached, fresh)
        : fresh;
      if (fresh.status !== 304 && responseForbidsStoredFallback(fresh)) {
        await removeCached(request, policy);
        return;
      }
      if (replacement.ok) {
        await putBounded(request, replacement, policy, cacheBudget());
      }
    } catch {
      /* offline or transport down; the stale copy already served */
    }
  })();
  revalidations.set(key, operation);
  void operation.finally(() => {
    if (revalidations.get(key) === operation) revalidations.delete(key);
  });
  return operation;
}

async function fromTransport(request: Request, logicalPath: string): Promise<Response> {
  const head = await buildHead(request, logicalPath);
  const body = await requestBodyForTransport(request);

  const { head: responseHead, body: stream } = await bridge.request(
    head,
    body,
    request.signal
  );

  // Capture Set-Cookie off the frame before it is stripped. The browser
  // would ignore it on a synthesized Response, so this is the only place the
  // session can be maintained at all.
  const setCookies = responseHead.headers.filter(
    ([name]) => name.toLowerCase() === "set-cookie"
  );
  for (const [, value] of setCookies) {
    await applySetCookie(value).catch(() => undefined);
  }

  const wireEncoding = headerValue(responseHead.headers, WIRE_CONTENT_ENCODING_HEADER);
  const headers = responseHeaders(responseHead.headers);
  const location = headers.get("location");
  if (location) {
    headers.set(
      "location",
      locationWithinScope(location, request.url, logicalPath, APP_SCOPE)
    );
  }

  const canHaveBody = responseCanHaveBody(request.method, responseHead.status);
  if (!canHaveBody) await stream.cancel().catch(() => undefined);
  if (responseHead.status < 200 || responseHead.status > 599) {
    throw new Error(`unsupported HTTP response status: ${responseHead.status}`);
  }

  let responseBody: ReadableStream<Uint8Array> | null = canHaveBody ? stream : null;
  if (responseBody && wireEncoding) {
    try {
      responseBody = decodeWireBody(responseBody, wireEncoding);
    } catch (error) {
      await stream.cancel(error).catch(() => undefined);
      throw error;
    }
  }

  return new Response(responseBody, {
    status: responseHead.status,
    statusText: responseHead.statusText,
    headers
  });
}

async function buildHead(request: Request, logicalPath: string): Promise<RequestHead> {
  const url = new URL(request.url);
  let headers: HeaderPairs = [...request.headers.entries()];

  // Never forward a browser-managed Cookie header; ours is authoritative.
  headers = withoutHeader(headers, "cookie");
  headers = withoutHeader(headers, WIRE_ACCEPT_ENCODING_HEADER);
  if (supportsWireGzip()) {
    headers = [...headers, [WIRE_ACCEPT_ENCODING_HEADER, "gzip"] as const];
  }
  // Static files cannot use the backend's session, so avoid opening IndexedDB
  // for every image, script, font, and cover on the page hot path.
  if (logicalPath === "/apiv2" || logicalPath.startsWith("/apiv2/")) {
    const jar = await cookieHeader().catch(() => undefined);
    if (jar) headers = [...headers, ["cookie", jar] as const];
  }

  // The node keys on origin-relative paths, never absolute URLs.
  const priority = requestPriority({
    method: request.method,
    mode: request.mode,
    destination: request.destination,
    logicalPath
  });
  return {
    version: PROTOCOL_VERSION,
    method: request.method,
    url: logicalPath + url.search,
    headers,
    hasBody: request.method !== "GET" && request.method !== "HEAD",
    priority,
    initialCredits: INITIAL_CREDIT[priority]
  };
}

export { headerValue };
