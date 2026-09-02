import assert from "node:assert/strict";
import test from "node:test";

import {
  FirestoreBackend,
  firestoreServiceRoot,
  nextPollInterval
} from "../src/firestore.js";
import { RtdbBackend } from "../src/rtdb.js";
import { SignalError } from "../src/types.js";
import type { AnswerBlob, OfferBlob } from "../src/types.js";

const offer: OfferBlob = { sessionId: "s1", sdp: "v=0-offer", candidates: [] };
const answer: AnswerBlob = { sdp: "v=0-answer", candidates: [] };

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : String(input);

test("Firestore masks the create response and reads only the answer", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ url: requestUrl(input), method });
    if (method === "PATCH") return new Response("{}", { status: 200 });
    return Response.json({
      fields: { answer: { stringValue: JSON.stringify(answer) } }
    });
  }) as typeof fetch;

  try {
    const backend = new FirestoreBackend({ projectId: "project", firstPollMs: 0 });
    assert.deepEqual(await backend.exchange(offer, new AbortController().signal), answer);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.method, "PATCH");
  assert.match(requests[0]!.url, /\?mask\.fieldPaths=answer$/);
  assert.equal(requests[1]!.method, "GET");
  assert.match(requests[1]!.url, /\?mask\.fieldPaths=answer$/);
});

test("Firestore treats a post-create 404 as terminal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") return new Response("{}", { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const backend = new FirestoreBackend({ projectId: "project", firstPollMs: 0 });
    await assert.rejects(
      backend.exchange(offer, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof SignalError);
        assert.equal(error.backend, "firestore");
        assert.match(error.message, /disappeared/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Firestore poll backoff doubles and caps", () => {
  assert.equal(nextPollInterval(400, 1_600), 800);
  assert.equal(nextPollInterval(800, 1_600), 1_600);
  assert.equal(nextPollInterval(1_600, 1_600), 1_600);
});

test("Firestore accepts an explicit self-hosted REST root", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(requestUrl(input));
    if (init?.method === "PATCH") return Response.json({});
    return Response.json({
      fields: { answer: { stringValue: JSON.stringify(answer) } }
    });
  }) as typeof fetch;

  try {
    const backend = new FirestoreBackend({
      projectId: "project",
      baseUrl: "http://127.0.0.1:8080/firestore/",
      firstPollMs: 0
    });
    assert.deepEqual(await backend.exchange(offer, new AbortController().signal), answer);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.startsWith(
    "http://127.0.0.1:8080/firestore/v1/projects/project/"
  )));
  assert.equal(firestoreServiceRoot("https://signal.example.test/root/?ignored=1#ignored"),
    "https://signal.example.test/root");
  assert.throws(() => firestoreServiceRoot("data:text/plain,no"), /HTTP or HTTPS/);
});

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = 1;
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    }
  }
}

function installFakeEventSource(): () => void {
  const original = globalThis.EventSource;
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: FakeEventSource as unknown as typeof EventSource
  });
  return () => {
    if (original === undefined) Reflect.deleteProperty(globalThis, "EventSource");
    else {
      Object.defineProperty(globalThis, "EventSource", {
        configurable: true,
        writable: true,
        value: original
      });
    }
  };
}

test("RTDB atomically replaces a reused identity branch before streaming the answer", async () => {
  const originalFetch = globalThis.fetch;
  const restoreEventSource = installFakeEventSource();
  const order: string[] = [];
  let putUrl = "";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes("accounts:signUp")) {
      return Response.json({
        idToken: "token",
        localId: "uid",
        refreshToken: "refresh",
        expiresIn: "3600"
      });
    }

    assert.equal(init?.method, "PUT");
    putUrl = url;
    order.push("write");
    assert.equal(FakeEventSource.instances.length, 0, "stale answers must be replaced first");
    assert.deepEqual(JSON.parse(String(init?.body)), { offer });
    setTimeout(() => {
      FakeEventSource.instances[0]!.emit("put", { path: "/", data: answer });
    }, 0);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const backend = new RtdbBackend({ apiKey: "key", databaseUrl: "https://db.invalid" });
    const promise = backend.exchange(offer, new AbortController().signal);
    assert.deepEqual(await promise, answer);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEventSource();
  }

  assert.deepEqual(order, ["write"]);
  assert.match(putUrl, /\/signal\/uid\.json\?/);
  assert.match(putUrl, /[?&]print=silent(?:&|$)/);
  assert.equal(FakeEventSource.instances[0]!.closed, true);
});

test("RTDB does not open an answer stream when its branch write fails", async () => {
  const originalFetch = globalThis.fetch;
  const restoreEventSource = installFakeEventSource();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.includes("accounts:signUp")) {
      return Response.json({
        idToken: "token",
        localId: "uid",
        refreshToken: "refresh",
        expiresIn: "3600"
      });
    }
    return new Response(null, { status: 403 });
  }) as typeof fetch;

  try {
    const backend = new RtdbBackend({ apiKey: "key", databaseUrl: "https://db.invalid" });
    await assert.rejects(
      backend.exchange(offer, new AbortController().signal),
      /offer write failed: 403/
    );
    assert.equal(FakeEventSource.instances.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEventSource();
  }
});

test("RTDB reuses one stored anonymous identity across exchanges", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const restoreEventSource = installFakeEventSource();
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  });
  let signups = 0;
  let writes = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes("accounts:signUp")) {
      signups += 1;
      return Response.json({
        idToken: "token",
        localId: "stable-uid",
        refreshToken: "refresh",
        expiresIn: "3600"
      });
    }
    assert.equal(init?.method, "PUT");
    writes += 1;
    const sourceIndex = writes - 1;
    setTimeout(() => {
      FakeEventSource.instances[sourceIndex]!.emit("put", { path: "/", data: answer });
    }, 0);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const backend = new RtdbBackend({ apiKey: "reuse-key", databaseUrl: "https://db.invalid" });
    assert.deepEqual(await backend.exchange(offer, new AbortController().signal), answer);
    assert.deepEqual(await backend.exchange(offer, new AbortController().signal), answer);
    assert.equal(signups, 1);
    assert.equal(writes, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEventSource();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("RTDB refreshes an expired stored identity instead of creating an account", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const restoreEventSource = installFakeEventSource();
  const key = "yurirtc:rtdb-auth:refresh-key:https://db.invalid";
  const values = new Map([[key, JSON.stringify({
    idToken: "expired",
    localId: "stable-uid",
    refreshToken: "old-refresh",
    expiresAt: 0
  })]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => values.set(name, value),
      removeItem: (name: string) => values.delete(name)
    }
  });
  let refreshes = 0;
  let signups = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes("securetoken.googleapis.com")) {
      refreshes += 1;
      assert.match(String(init?.body), /refresh_token=old-refresh/);
      return Response.json({
        id_token: "new-token",
        refresh_token: "new-refresh",
        user_id: "stable-uid",
        expires_in: "3600"
      });
    }
    if (url.includes("accounts:signUp")) {
      signups += 1;
      throw new Error("sign-up should not run");
    }
    assert.match(url, /auth=new-token/);
    setTimeout(() => {
      FakeEventSource.instances[0]!.emit("put", { path: "/", data: answer });
    }, 0);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const backend = new RtdbBackend({ apiKey: "refresh-key", databaseUrl: "https://db.invalid" });
    assert.deepEqual(await backend.exchange(offer, new AbortController().signal), answer);
    assert.equal(refreshes, 1);
    assert.equal(signups, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEventSource();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
