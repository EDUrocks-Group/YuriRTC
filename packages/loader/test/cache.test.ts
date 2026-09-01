import assert from "node:assert/strict";
import test from "node:test";

import {
  cacheWhileConsumed,
  cachedResponseIsFresh,
  contentLength,
  effectiveBudget,
  putBounded,
  responseForbidsStoredFallback,
  responseMayBeStored
} from "../src/cache.js";
import { injectInto, injectIntoStream } from "../src/inject.js";

interface CacheRecorder {
  writes: Array<{ request: Request; response: Response }>;
  restore(): void;
}

function installCacheRecorder(): CacheRecorder {
  const priorCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const writes: Array<{ request: Request; response: Response }> = [];
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({
        put: async (request: Request, response: Response) => {
          writes.push({ request, response });
        }
      })
    }
  });
  return {
    writes,
    restore() {
      if (priorCaches) Object.defineProperty(globalThis, "caches", priorCaches);
      else delete (globalThis as { caches?: unknown }).caches;
    }
  };
}

async function waitForWrites(recorder: CacheRecorder, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && recorder.writes.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(recorder.writes.length, count);
}

test("missing or malformed Content-Length is unknown rather than zero", () => {
  assert.equal(contentLength(new Headers()), undefined);
  assert.equal(contentLength(new Headers({ "content-length": "garbage" })), undefined);
  assert.equal(contentLength(new Headers({ "content-length": "1909675" })), 1_909_675);
});

test("a stalled quota estimate cannot block cache admission", async () => {
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { estimate: () => new Promise(() => undefined) } }
  });
  const config = { budgetBytes: 123_456_789, maxQuotaShare: 0.5 };
  const started = performance.now();
  try {
    assert.equal(await effectiveBudget(config), config.budgetBytes);
    assert.ok(performance.now() - started < 1_500, "quota fallback exceeded its bound");
  } finally {
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("universal cache admission rejects private and non-reusable responses", () => {
  const request = new Request("https://example.test/assets/app.js");
  assert.equal(responseMayBeStored(request, new Response("ok")), true);
  assert.equal(responseMayBeStored(
    request,
    new Response("secret", { headers: { "cache-control": "private, max-age=60" } })
  ), false);
  assert.equal(responseMayBeStored(
    request,
    new Response("no", { headers: { vary: "*" } })
  ), false);
  assert.equal(responseMayBeStored(
    new Request(request, { headers: { authorization: "Bearer private" } }),
    new Response("no")
  ), false);
  assert.equal(responseMayBeStored(
    request,
    new Response("events", { headers: { "content-type": "text/event-stream" } })
  ), false);
  assert.equal(responseForbidsStoredFallback(new Response("gone", { status: 404 })), true);
  assert.equal(responseForbidsStoredFallback(
    new Response("secret", { headers: { "cache-control": "no-store" } })
  ), true);
  assert.equal(responseForbidsStoredFallback(new Response("temporary", { status: 503 })), false);
});

test("HTTP-semantics entries are fresh only for an explicit live lifetime", () => {
  const now = Date.parse("2026-08-30T12:00:30Z");
  assert.equal(cachedResponseIsFresh(new Response("x", { headers: {
    date: "Sun, 30 Aug 2026 12:00:00 GMT",
    "cache-control": "public, max-age=60"
  } }), now), true);
  assert.equal(cachedResponseIsFresh(new Response("x", { headers: {
    date: "Sun, 30 Aug 2026 12:00:00 GMT",
    "cache-control": "public, max-age=10"
  } }), now), false);
  assert.equal(cachedResponseIsFresh(new Response("x", { headers: {
    date: "Sun, 30 Aug 2026 12:00:00 GMT",
    "cache-control": "public, max-age=600, must-revalidate"
  } }), now), true);
  assert.equal(cachedResponseIsFresh(new Response("x", { headers: {
    date: "Sun, 30 Aug 2026 11:00:00 GMT",
    "cache-control": "public, max-age=600, must-revalidate"
  } }), now), false);
  assert.equal(cachedResponseIsFresh(new Response("x", { headers: {
    "cache-control": "public, max-age=31536000, immutable"
  } }), now), true);
});

test("putBounded consumes its caller-owned response without cloning it again", async () => {
  const priorCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let stored: Response | undefined;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({
        put: async (_request: Request, response: Response) => {
          stored = response;
        }
      })
    }
  });

  const response = new Response("cache me");
  Object.defineProperty(response, "clone", {
    value: () => {
      throw new Error("unexpected response clone");
    }
  });

  try {
    await putBounded(
      new Request("https://example.test/a/app.js"),
      response,
      "cache-first-immutable"
    );
    assert.ok(stored);
    assert.equal(await stored.text(), "cache me");
  } finally {
    if (priorCaches) Object.defineProperty(globalThis, "caches", priorCaches);
    else delete (globalThis as { caches?: unknown }).caches;
  }
});

test("foreground-paced caching does not pull before the response is read", async () => {
  let pulls = 0;
  let cancelledWith: unknown;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode(`chunk-${pulls}`));
    },
    cancel(reason) {
      cancelledWith = reason;
    }
  }, { highWaterMark: 0 });

  const wrapped = cacheWhileConsumed(
    new Request("https://example.test/a/app.js"),
    new Response(source),
    "cache-first-immutable"
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pulls, 0);

  const reader = wrapped.body!.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "chunk-1");
  assert.equal(pulls, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pulls, 1, "the cache collector must not read ahead");

  await reader.cancel("foreground-finished");
  assert.equal(cancelledWith, "foreground-finished");
});

test("foreground-paced caching does not replace a response with URL semantics", async () => {
  const fetched = await fetch("data:text/plain,preserved");
  const wrapped = cacheWhileConsumed(
    new Request("https://example.test/a/fetched.js"),
    fetched,
    "cache-first-immutable"
  );
  assert.equal(wrapped, fetched);
  assert.equal(wrapped.url, "data:text/plain,preserved");
  assert.equal(wrapped.type, "basic");
  assert.equal(await wrapped.text(), "preserved");
});

test("complete foreground consumption caches the original representation", async () => {
  const recorder = installCacheRecorder();
  const original = "<!doctype html><html><head><title>original</title></head></html>";
  const request = new Request("https://example.test/app.html");
  try {
    const wrapped = cacheWhileConsumed(
      request,
      new Response(original, {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "text/html; charset=utf-8", "x-origin": "node" }
      }),
      "cache-first-immutable"
    );
    assert.equal(wrapped.status, 201);
    assert.equal(wrapped.statusText, "Created");
    assert.equal(wrapped.headers.get("x-origin"), "node");
    assert.equal(wrapped.url, "");

    const foreground = await new Response(injectIntoStream(wrapped.body!, null)).text();
    assert.equal(foreground, injectInto(original, null));
    await waitForWrites(recorder, 1);

    const { request: storedRequest, response: stored } = recorder.writes[0]!;
    assert.equal(storedRequest.url, request.url);
    assert.equal(stored.status, 201);
    assert.equal(stored.statusText, "Created");
    assert.equal(stored.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(stored.headers.get("x-origin"), "node");
    assert.equal(await stored.text(), original, "injected bytes must not enter the cache");
  } finally {
    recorder.restore();
  }
});

test("cancel during a pending upstream read propagates and never caches", async () => {
  const recorder = installCacheRecorder();
  let signalPull!: () => void;
  const pullStarted = new Promise<void>((resolve) => { signalPull = resolve; });
  let releasePull!: () => void;
  let cancelledWith: unknown;
  let latePullFinished = false;
  const source = new ReadableStream<Uint8Array>({
    async pull() {
      signalPull();
      await new Promise<void>((resolve) => { releasePull = resolve; });
      latePullFinished = true;
    },
    cancel(reason) {
      cancelledWith = reason;
      releasePull();
    }
  }, { highWaterMark: 0 });

  try {
    const wrapped = cacheWhileConsumed(
      new Request("https://example.test/a/slow.js"),
      new Response(source),
      "cache-first-immutable"
    );
    const reader = wrapped.body!.getReader();
    const pendingRead = reader.read();
    await pullStarted;
    await reader.cancel("page-left");
    assert.deepEqual(await pendingRead, { value: undefined, done: true });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(cancelledWith, "page-left");
    assert.equal(latePullFinished, true, "the in-flight source pull settled after cancellation");
    assert.equal(recorder.writes.length, 0);
  } finally {
    recorder.restore();
  }
});

test("request abort cancels the upstream body and discards partial cache bytes", async () => {
  const recorder = installCacheRecorder();
  const abort = new AbortController();
  let cancelledWith: unknown;
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel(reason) {
      cancelledWith = reason;
    }
  }, { highWaterMark: 0 });

  try {
    const wrapped = cacheWhileConsumed(
      new Request("https://example.test/a/abort.js", { signal: abort.signal }),
      new Response(source),
      "cache-first-immutable"
    );
    const reader = wrapped.body!.getReader();
    controllerRef.enqueue(new TextEncoder().encode("partial"));
    assert.equal(new TextDecoder().decode((await reader.read()).value), "partial");

    abort.abort();
    await assert.rejects(reader.read(), (error) =>
      error instanceof DOMException && error.name === "AbortError"
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelledWith, abort.signal.reason);
    assert.equal(recorder.writes.length, 0);
  } finally {
    recorder.restore();
  }
});

test("staging cap caches the exact boundary and discards an oversized body", async () => {
  const recorder = installCacheRecorder();
  const budget = { budgetBytes: 5, maxQuotaShare: 1 };
  try {
    const exact = cacheWhileConsumed(
      new Request("https://example.test/a/exact.js"),
      new Response("12345"),
      "cache-first-immutable",
      budget
    );
    assert.equal(await exact.text(), "12345");
    await waitForWrites(recorder, 1);
    assert.equal(await recorder.writes[0]!.response.text(), "12345");

    const oversized = cacheWhileConsumed(
      new Request("https://example.test/a/large.js"),
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("123"));
          controller.enqueue(new TextEncoder().encode("456"));
          controller.close();
        }
      })),
      "cache-first-immutable",
      budget
    );
    assert.equal(await oversized.text(), "123456", "the foreground body remains intact");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(recorder.writes.length, 1, "an over-cap body must not be cached");

    const declaredOversized = cacheWhileConsumed(
      new Request("https://example.test/a/declared-large.js"),
      new Response("still streams", { headers: { "content-length": "6" } }),
      "cache-first-immutable",
      budget
    );
    assert.equal(await declaredOversized.text(), "still streams");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(recorder.writes.length, 1, "an over-cap Content-Length must skip staging");
  } finally {
    recorder.restore();
  }
});
