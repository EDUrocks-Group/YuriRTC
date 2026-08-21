import assert from "node:assert/strict";
import test from "node:test";

import { sharedIdb, type SharedIdb } from "../src/idb.js";

/**
 * A fake IndexedDB, because the point of this module is connection lifetime and
 * the real one is not available where these tests run. It models only what
 * `sharedIdb` touches: an open request, a connection with versionchange/close,
 * transactions that complete once their queued requests have reported, and the
 * two failure modes the helper is expected to recover from.
 */
interface Fake {
  factory: IDBFactory;
  opens: number;
  rows: Map<string, unknown>;
  failNextOpen: Error | null;
  /** Throw InvalidStateError from the next db.transaction() call. */
  killNextTransaction: boolean;
  /** Fire onclose on the live connection, as a force-close would. */
  forceClose(): void;
  /** Fire onversionchange on the live connection. */
  requestVersionChange(): void;
  closes: number;
}

function makeFake(): Fake {
  const rows = new Map<string, unknown>();
  let live: {
    onversionchange: (() => void) | null;
    onclose: (() => void) | null;
    close: () => void;
  } | null = null;

  const fake: Fake = {
    factory: undefined as unknown as IDBFactory,
    opens: 0,
    rows,
    failNextOpen: null,
    killNextTransaction: false,
    closes: 0,
    forceClose: () => live?.onclose?.(),
    requestVersionChange: () => live?.onversionchange?.()
  };

  class Request {
    onsuccess: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result: unknown = undefined;
    error: unknown = null;
  }

  class Tx {
    oncomplete: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    error: unknown = null;
    private outstanding = 0;

    objectStore(): unknown {
      const settle = (request: Request, value: unknown): Request => {
        request.result = value;
        this.outstanding += 1;
        setImmediate(() => {
          request.onsuccess?.();
          // Commit once every queued request has reported, one turn later so a
          // request callback may queue further work in the same transaction.
          setImmediate(() => {
            this.outstanding -= 1;
            if (this.outstanding === 0) this.oncomplete?.();
          });
        });
        return request;
      };
      return {
        put: (value: { url?: string; name?: string }) => {
          const key = value.url ?? value.name ?? "";
          rows.set(key, value);
          return settle(new Request(), key);
        },
        get: (key: string) => settle(new Request(), rows.get(key)),
        delete: (key: string) => {
          rows.delete(key);
          return settle(new Request(), undefined);
        },
        getAll: () => settle(new Request(), [...rows.values()]),
        clear: () => {
          rows.clear();
          return settle(new Request(), undefined);
        }
      };
    }
  }

  class Connection {
    onversionchange: (() => void) | null = null;
    onclose: (() => void) | null = null;
    close(): void {
      fake.closes += 1;
      if (live === this) live = null;
    }
    transaction(): Tx {
      if (fake.killNextTransaction) {
        fake.killNextTransaction = false;
        throw new DOMException("connection is closing", "InvalidStateError");
      }
      return new Tx();
    }
  }

  fake.factory = {
    open: () => {
      fake.opens += 1;
      const request = new Request() as Request & {
        onupgradeneeded: (() => void) | null;
      };
      request.onupgradeneeded = null;
      const failure = fake.failNextOpen;
      fake.failNextOpen = null;
      setImmediate(() => {
        if (failure) {
          request.error = failure;
          request.onerror?.();
          return;
        }
        const db = new Connection();
        request.result = db;
        live = db;
        request.onsuccess?.();
      });
      return request;
    }
  } as unknown as IDBFactory;

  return fake;
}

function withFake(run: (fake: Fake, db: SharedIdb) => Promise<void>): () => Promise<void> {
  return async () => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const fake = makeFake();
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: fake.factory
    });
    try {
      await run(fake, sharedIdb({
        name: "test-db",
        version: 1,
        store: "entries",
        upgrade: () => undefined
      }));
    } finally {
      if (prior) Object.defineProperty(globalThis, "indexedDB", prior);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  };
}

test("sequential operations share one connection", withFake(async (fake, db) => {
  await db.commit("readwrite", (store) => {
    (store as unknown as { put(v: unknown): void }).put({ url: "/a", size: 1 });
  });
  await db.commit("readwrite", (store) => {
    (store as unknown as { put(v: unknown): void }).put({ url: "/b", size: 2 });
  });
  const all = await db.request<unknown[]>("readonly", (store) =>
    (store as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
  );

  assert.equal(fake.opens, 1, "the connection must be reused");
  assert.equal(all.length, 2);
}));

test("concurrent operations coalesce onto one open", withFake(async (fake, db) => {
  await Promise.all([
    db.request("readonly", (s) => (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()),
    db.request("readonly", (s) => (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()),
    db.request("readonly", (s) => (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll())
  ]);
  assert.equal(fake.opens, 1);
}));

test("a versionchange gives the connection up and the next call reopens", withFake(
  async (fake, db) => {
    await db.request("readonly", (s) =>
      (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
    );
    assert.equal(fake.opens, 1);

    // Another context wants to upgrade or delete; holding on would block it.
    fake.requestVersionChange();
    assert.equal(fake.closes, 1, "the held connection must be closed");

    await db.request("readonly", (s) =>
      (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
    );
    assert.equal(fake.opens, 2, "the next call must open again");
  }
));

test("a force-closed connection is dropped and reopened", withFake(async (fake, db) => {
  await db.request("readonly", (s) =>
    (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
  );
  fake.forceClose();
  await db.request("readonly", (s) =>
    (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
  );
  assert.equal(fake.opens, 2);
}));

test("a transaction on a dead handle is retried once on a fresh connection", withFake(
  async (fake, db) => {
    await db.request("readonly", (s) =>
      (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
    );
    assert.equal(fake.opens, 1);

    // The connection closed after connect() handed it over.
    fake.killNextTransaction = true;
    await db.commit("readwrite", (store) => {
      (store as unknown as { put(v: unknown): void }).put({ url: "/retried", size: 9 });
    });

    assert.equal(fake.opens, 2, "the retry must open a fresh connection");
    assert.equal(fake.rows.has("/retried"), true, "the retried write must land");
  }
));

test("a failed open is not remembered", withFake(async (fake, db) => {
  fake.failNextOpen = new Error("disk is on fire");
  await assert.rejects(
    db.request("readonly", (s) =>
      (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
    )
  );

  // A rejected open must not become permanent worker state.
  await db.request("readonly", (s) =>
    (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
  );
  assert.equal(fake.opens, 2);
}));

test("commit resolves only once the transaction has committed", withFake(async (_fake, db) => {
  let committed = false;
  const done = db.commit("readwrite", (store) => {
    const typed = store as unknown as {
      get(k: string): { onsuccess: (() => void) | null };
      put(v: unknown): void;
    };
    // A read-modify-write: the put is queued from the read's callback, so
    // resolving on request success would resolve before the put exists.
    const read = typed.get("/rmw");
    read.onsuccess = () => {
      committed = true;
      typed.put({ url: "/rmw", size: 5 });
    };
  });
  await done;
  assert.equal(committed, true);
}));

test("an absent indexedDB rejects instead of throwing at import time", async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
  try {
    // Constructing the helper must not touch the factory — session.ts and
    // cache.ts both build one at module scope, and these tests run in Node.
    const db = sharedIdb({
      name: "absent",
      version: 1,
      store: "entries",
      upgrade: () => undefined
    });
    await assert.rejects(
      db.request("readonly", (s) =>
        (s as unknown as { getAll(): IDBRequest<unknown[]> }).getAll()
      )
    );
  } finally {
    if (prior) Object.defineProperty(globalThis, "indexedDB", prior);
  }
});
