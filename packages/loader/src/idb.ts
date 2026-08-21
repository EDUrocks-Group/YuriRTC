/**
 * One IndexedDB connection per database, reused across calls.
 *
 * The service worker opens these databases on the request hot path — an LRU
 * touch for every cover a games grid serves from cache, a cookie read for every
 * `/apiv2` call — and an open is a cross-process round trip to disk. On the
 * eMMC Chromebooks this ships to that cost is what the cache was supposed to
 * save. Opening once and holding the handle removes it from every call but the
 * first.
 *
 * Holding a connection is only safe if it is given up on demand, so the handle
 * is dropped on `versionchange` (another context wants to upgrade or delete the
 * database and must not be blocked by us), on `close` (the browser force-closed
 * the backing store — which is what origin-atomic eviction looks like from
 * here), and on a failed open (a rejected promise must never become permanent
 * worker state). Every drop is transparent: the next call opens again.
 *
 * The worker can be terminated between any two tasks. Losing this module's
 * state costs exactly one re-open and nothing else — there is no deferred work
 * held here, every transaction is started and settled inside the call that
 * asked for it.
 */

export interface IdbSpec {
  name: string;
  version: number;
  /** The single object store this database has. */
  store: string;
  /** Runs inside `upgradeneeded`; must be synchronous. */
  upgrade(db: IDBDatabase): void;
}

export interface SharedIdb {
  /**
   * Runs one request in its own transaction and resolves with its result.
   * Resolves when the request succeeds, not when the transaction commits —
   * matching what the per-call helpers this replaced did.
   */
  request<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T>;
  /**
   * Runs work in its own transaction and resolves when it commits. What a
   * read-modify-write needs, since the write is queued from a read callback.
   */
  commit(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<void>;
}

/**
 * Errors that mean the connection we were handed is no longer usable, rather
 * than that the operation itself was rejected.
 *
 * `InvalidStateError` is what `transaction()` throws on a connection that
 * closed after `connect()` resolved. `AbortError` is what a live transaction
 * reports when the backing store is force-closed underneath it. A quota abort
 * is deliberately not in this set: it reports `QuotaExceededError` and retrying
 * would just fail again.
 */
function isClosedConnection(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "InvalidStateError" || error.name === "AbortError");
}

export function sharedIdb(spec: IdbSpec): SharedIdb {
  let connection: Promise<IDBDatabase> | null = null;
  let handle: IDBDatabase | null = null;

  const forget = (): void => {
    connection = null;
    handle = null;
  };

  const connect = (): Promise<IDBDatabase> => {
    if (connection) return connection;

    // Absent in Node (where the tests run) and wherever storage is disabled.
    // Never cached: there is nothing to reuse, and every caller already treats
    // a failure here as non-fatal.
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error(`${spec.name}_unavailable`));
    }

    const opened = new Promise<IDBDatabase>((resolve, reject) => {
      // open() itself throws on an opaque origin; the executor turns that into
      // a rejection like any other failure.
      const request = indexedDB.open(spec.name, spec.version);
      request.onupgradeneeded = () => spec.upgrade(request.result);
      request.onsuccess = () => {
        const db = request.result;
        handle = db;
        // A held connection blocks another context's upgrade or delete, so it
        // is given up the moment one is requested. close() lets transactions
        // already running finish; only new ones are refused.
        db.onversionchange = () => {
          if (handle === db) forget();
          db.close();
        };
        // Force-close: origin eviction, a deleted database, a disk error.
        db.onclose = () => {
          if (handle === db) forget();
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error(`${spec.name}_open_failed`));
      // `blocked` is deliberately unhandled. It cannot fire at a fixed version,
      // and rejecting on it would be wrong anyway: success still follows once
      // the other connection closes.
    });

    connection = opened;
    // A failed open must not become permanent state — the next caller opens
    // again instead of inheriting a rejected promise for the life of the
    // worker. Attaching the handler here also keeps the rejection from being
    // reported as unhandled when the caller is a fire-and-forget `void`.
    opened.catch(() => {
      if (connection === opened) forget();
    });
    return opened;
  };

  const run = async <T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    const db = await connect();
    try {
      return await work(db);
    } catch (error) {
      if (!isClosedConnection(error)) throw error;
      // The connection died between being handed over and the transaction
      // finishing. Drop it and try once on a fresh one. Every operation built
      // on this helper is idempotent — put, delete, clear, getAll, and a
      // get-then-put that recomputes its own timestamp — so a retry cannot
      // double-apply. A second failure is the caller's to swallow.
      if (handle === db) forget();
      return await work(await connect());
    }
  };

  return {
    request: <T>(
      mode: IDBTransactionMode,
      make: (store: IDBObjectStore) => IDBRequest<T>
    ): Promise<T> =>
      run((db) => new Promise<T>((resolve, reject) => {
        const tx = db.transaction(spec.store, mode);
        const request = make(tx.objectStore(spec.store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(`${spec.name}_request_failed`));
        // Settles the promise when the request never gets to report anything —
        // a transaction killed by a dying connection. After a resolve above
        // this is a no-op.
        tx.onabort = () => reject(tx.error ?? new Error(`${spec.name}_transaction_aborted`));
      })),

    commit: (
      mode: IDBTransactionMode,
      work: (store: IDBObjectStore) => void
    ): Promise<void> =>
      run((db) => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(spec.store, mode);
        work(tx.objectStore(spec.store));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error(`${spec.name}_transaction_failed`));
        tx.onabort = () => reject(tx.error ?? new Error(`${spec.name}_transaction_aborted`));
      }))
  };
}
