import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { SwBridge } from "../src/swbridge.js";
import {
  CARRIER_READY_TIMEOUT_MS,
  WORKER_ATTACH_ACK_TIMEOUT_MS,
  WORKER_BOOTSTRAP_TIMEOUT_MS
} from "../src/bridge.js";
import { PROTOCOL_VERSION, RequestPriority } from "@yurirtc/protocol";

const requestHead = {
  version: PROTOCOL_VERSION,
  method: "GET",
  url: "/asset",
  headers: [],
  hasBody: false,
  priority: RequestPriority.Interactive,
  initialCredits: 8
} as const;
const responseHead = { status: 200, statusText: "OK", headers: [] } as const;

test("the carrier READY budget covers both page handshake phases plus margin", () => {
  assert.ok(
    CARRIER_READY_TIMEOUT_MS >
      WORKER_ATTACH_ACK_TIMEOUT_MS + WORKER_BOOTSTRAP_TIMEOUT_MS
  );
});

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function attachReady(
  bridge: SwBridge,
  channel: MessageChannel,
  ownerClientId?: string
): void {
  bridge.attach(channel.port1, ownerClientId);
  channel.port2.postMessage({ t: "ready", clientId: ownerClientId ?? "test-page" });
}

async function waitForConnected(bridge: SwBridge): Promise<void> {
  for (let attempt = 0; attempt < 100 && !bridge.connected; attempt += 1) {
    await delay(1);
  }
  assert.equal(bridge.connected, true, "carrier did not complete its ready handshake");
}

test("a queued message from a replaced port cannot detach the new carrier", async () => {
  const bridge = new SwBridge();
  const old = new MessageChannel();
  const replacement = new MessageChannel();

  attachReady(bridge, old, "same-page");
  // Queue the stale message before replacement so it can already be waiting in
  // the old port's task source when attach() closes that port.
  old.port2.postMessage({ t: "down", reason: "old port closed" });
  attachReady(bridge, replacement, "same-page");
  await waitForConnected(bridge);

  assert.equal(bridge.connected, true);
  old.port2.close();
  replacement.port2.close();
});

test("same-page replacement fails a request that has not received its head", async () => {
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: { clients: { get: () => Promise.resolve({ id: "same-page" }) } }
  });
  const bridge = new SwBridge();
  const old = new MessageChannel();
  const replacement = new MessageChannel();
  let sawRequest!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    sawRequest = resolve;
  });
  const replacementMessages: string[] = [];

  old.port2.onmessage = (event: MessageEvent<{ t?: string }>) => {
    if (event.data.t === "req") sawRequest();
  };
  old.port2.start();
  replacement.port2.onmessage = (event: MessageEvent<{ t?: string }>) => {
    if (event.data.t) replacementMessages.push(event.data.t);
  };
  replacement.port2.start();
  attachReady(bridge, old, "same-page");

  try {
    const pending = bridge.request(
      requestHead,
      undefined,
      new AbortController().signal
    );
    await requestSeen;
    attachReady(bridge, replacement, "same-page");

    await assert.rejects(
      Promise.race([
        pending,
        delay(250).then(() => {
          throw new Error("pre-head request hung after carrier replacement");
        })
      ]),
      /carrier port replaced before response/
    );
    await delay(0);
    assert.deepEqual(replacementMessages, ["attached", "cancel"]);
  } finally {
    old.port2.close();
    replacement.port2.close();
    if (priorSelf) Object.defineProperty(globalThis, "self", priorSelf);
    else delete (globalThis as { self?: unknown }).self;
  }
});

test("response credits follow a same-page carrier port replacement", async () => {
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: { clients: { get: () => Promise.resolve({ id: "same-page" }) } }
  });
  const bridge = new SwBridge();
  const old = new MessageChannel();
  const replacement = new MessageChannel();
  let requestId = 0;
  let sent = 0;
  const oldCredits: number[] = [];
  const replacementCredits: number[] = [];

  const sendBody = (port: MessagePort, count: number): void => {
    for (let index = 0; index < count; index += 1) {
      sent += 1;
      const chunk = Uint8Array.of(sent).buffer;
      port.postMessage({
        t: "body",
        id: requestId,
        chunk,
        byteOffset: 0,
        byteLength: chunk.byteLength
      });
    }
  };

  old.port2.onmessage = (event: MessageEvent<{ t?: string; id?: number; n?: number }>) => {
    const message = event.data;
    if (message.t === "credit" && message.n !== undefined) {
      oldCredits.push(message.n);
      return;
    }
    if (message.t !== "req" || message.id === undefined) return;
    requestId = message.id;
    old.port2.postMessage({ t: "head", id: requestId, head: responseHead });
    sendBody(old.port2, requestHead.initialCredits);
  };
  old.port2.start();
  replacement.port2.onmessage = (
    event: MessageEvent<{ t?: string; id?: number; n?: number }>
  ) => {
    const message = event.data;
    if (message.t !== "credit" || message.n === undefined) return;
    replacementCredits.push(message.n);
    const remaining = 12 - sent;
    if (remaining <= 0) return;
    sendBody(replacement.port2, Math.min(remaining, message.n));
    if (sent === 12) replacement.port2.postMessage({ t: "end", id: requestId });
  };
  replacement.port2.start();
  attachReady(bridge, old, "same-page");

  try {
    const response = await bridge.request(
      requestHead,
      undefined,
      new AbortController().signal
    );
    const reader = response.body.getReader();
    const values: number[] = [];

    // Drain half of the original window first so all remaining old-port body
    // frames are known to have crossed the bridge before replacing the port.
    for (let index = 0; index < requestHead.initialCredits / 2; index += 1) {
      const next = await reader.read();
      assert.equal(next.done, false);
      values.push(next.value![0]!);
    }
    await delay(0);
    attachReady(bridge, replacement, "same-page");

    await Promise.race([
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          values.push(next.value[0]!);
        }
      })(),
      delay(500).then(() => {
        throw new Error("response stalled after same-page carrier replacement");
      })
    ]);

    assert.deepEqual(values, Array.from({ length: 12 }, (_, index) => index + 1));
    assert.ok(oldCredits.length > 0, "the original carrier should receive its first refill");
    assert.ok(
      replacementCredits.length > 0,
      "later refills must be routed to the replacement carrier"
    );
  } finally {
    old.port2.close();
    replacement.port2.close();
    if (priorSelf) Object.defineProperty(globalThis, "self", priorSelf);
    else delete (globalThis as { self?: unknown }).self;
  }
});

test("a later tab becomes standby without replacing the ready carrier", async () => {
  const bridge = new SwBridge();
  const old = new MessageChannel();
  const standby = new MessageChannel();
  const standbyMessages: string[] = [];
  standby.port2.onmessage = (event: MessageEvent<{ t?: string }>) => {
    if (event.data.t) standbyMessages.push(event.data.t);
  };
  standby.port2.start();
  try {
    attachReady(bridge, old, "old-page");
    await waitForConnected(bridge);
    bridge.attach(standby.port1, "new-page");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bridge.connected, true);
    assert.deepEqual(standbyMessages, ["standby"]);
  } finally {
    old.port2.close();
    standby.port2.close();
  }
});

test("an attach during client lookup cannot be missed by acquire", async () => {
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  const bridge = new SwBridge();
  const carrier = new MessageChannel();
  carrier.port2.onmessage = (event: MessageEvent<{ t?: string; id?: number }>) => {
    if (event.data.t !== "req" || event.data.id === undefined) return;
    carrier.port2.postMessage({ t: "head", id: event.data.id, head: responseHead });
    carrier.port2.postMessage({ t: "end", id: event.data.id });
  };
  carrier.port2.start();

  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      clients: {
        get: () => Promise.resolve(undefined),
        matchAll: async () => {
          // This is the old lost-wakeup window: attach after isConnected()
          // returned false but before acquire installed its waiter.
          attachReady(bridge, carrier);
          return [];
        }
      }
    }
  });

  try {
    const response = await Promise.race([
      bridge.request(requestHead, undefined, new AbortController().signal),
      delay(250).then(() => {
        throw new Error("acquire missed the attached carrier");
      })
    ]);
    assert.equal(response.head.status, 200);
    assert.deepEqual(await new Response(response.body).bytes(), new Uint8Array());
  } finally {
    carrier.port2.close();
    if (priorSelf) Object.defineProperty(globalThis, "self", priorSelf);
    else delete (globalThis as { self?: unknown }).self;
  }
});

test("ready drains old bridge ids before a queued fetch can reuse them", async () => {
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: { clients: { matchAll: () => Promise.resolve([]) } }
  });
  const bridge = new SwBridge();
  const carrier = new MessageChannel();
  const received: string[] = [];
  carrier.port2.onmessage = (event: MessageEvent<{ t?: string; id?: number }>) => {
    const message = event.data;
    if (message.t) received.push(message.t);
    if (message.t === "attached") {
      // This is cleanup from the former worker bridge. It deliberately reuses
      // the first id that a fresh SwBridge will allocate.
      carrier.port2.postMessage({ t: "err", id: 1, message: "old bridge request" });
      carrier.port2.postMessage({ t: "ready", clientId: "same-page" });
      return;
    }
    if (message.t === "req" && message.id !== undefined) {
      carrier.port2.postMessage({ t: "head", id: message.id, head: responseHead });
      carrier.port2.postMessage({ t: "end", id: message.id });
    }
  };
  carrier.port2.start();

  try {
    const pending = bridge.request(
      requestHead,
      undefined,
      new AbortController().signal
    );
    await delay(0);
    bridge.attach(carrier.port1, "same-page");
    const response = await Promise.race([
      pending,
      delay(250).then(() => {
        throw new Error("queued fetch did not cross the ready barrier");
      })
    ]);

    assert.equal(response.head.status, 200);
    assert.deepEqual(await new Response(response.body).bytes(), new Uint8Array());
    assert.deepEqual(received, ["attached", "req"]);
  } finally {
    carrier.port2.close();
    if (priorSelf) Object.defineProperty(globalThis, "self", priorSelf);
    else delete (globalThis as { self?: unknown }).self;
  }
});

test("concurrent disconnected fetches share one wake epoch", async () => {
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  let matchAllCalls = 0;
  let wakes = 0;
  let matchAllOptions: unknown;
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      clients: {
        matchAll: async (options: unknown) => {
          matchAllCalls += 1;
          matchAllOptions = options;
          return [{ postMessage: () => { wakes += 1; } }];
        }
      }
    }
  });
  const bridge = new SwBridge();
  const carrier = new MessageChannel();
  carrier.port2.onmessage = (event: MessageEvent<{ t?: string; id?: number }>) => {
    if (event.data.t !== "req" || event.data.id === undefined) return;
    carrier.port2.postMessage({ t: "head", id: event.data.id, head: responseHead });
    carrier.port2.postMessage({ t: "end", id: event.data.id });
  };
  carrier.port2.start();

  try {
    const pending = Array.from({ length: 8 }, () => bridge.request(
      requestHead,
      undefined,
      new AbortController().signal
    ));
    await delay(10);
    assert.equal(matchAllCalls, 1);
    assert.equal(wakes, 1);
    assert.deepEqual(matchAllOptions, { type: "window", includeUncontrolled: false });

    attachReady(bridge, carrier);
    const responses = await Promise.all(pending);
    await Promise.all(responses.map((response) => new Response(response.body).bytes()));
    await delay(10);
    assert.equal(matchAllCalls, 1, "a late waiter started a duplicate wake round");
    assert.equal(wakes, 1, "duplicate wakes could force a destructive reattach");
  } finally {
    carrier.port2.close();
    if (priorSelf) Object.defineProperty(globalThis, "self", priorSelf);
    else delete (globalThis as { self?: unknown }).self;
  }
});

test("a carrier which never sends ready is discarded by an identity-bound timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bridge = new SwBridge();
  const stalled = new MessageChannel();
  const replacement = new MessageChannel();
  bridge.attach(stalled.port1, "same-page");
  assert.equal(bridge.connected, false);

  t.mock.timers.tick(CARRIER_READY_TIMEOUT_MS);
  stalled.port2.postMessage({ t: "ready", clientId: "same-page" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.connected, false, "late READY revived the timed-out port");

  attachReady(bridge, replacement, "same-page");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.connected, true, "a fresh port could not recover after timeout");
  stalled.port2.close();
  replacement.port2.close();
});

test("a stalled winner expires while the original fetch can promote a standby", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  let wakes = 0;
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      clients: {
        matchAll: async () => [{ postMessage: () => { wakes += 1; } }]
      }
    }
  });
  const bridge = new SwBridge();
  const stalled = new MessageChannel();
  const promoted = new MessageChannel();
  promoted.port2.onmessage = (event: MessageEvent<{ t?: string; id?: number }>) => {
    if (event.data.t !== "req" || event.data.id === undefined) return;
    promoted.port2.postMessage({ t: "head", id: event.data.id, head: responseHead });
    promoted.port2.postMessage({ t: "end", id: event.data.id });
  };
  promoted.port2.start();

  try {
    const pending = bridge.request(
      requestHead,
      undefined,
      new AbortController().signal
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(wakes, 1);

    bridge.attach(stalled.port1, "stalled-page");
    t.mock.timers.tick(CARRIER_READY_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(wakes, 2, "READY expiry did not start a second discovery round");

    attachReady(bridge, promoted, "promoted-page");
    const response = await pending;
    assert.equal(response.head.status, 200);
    assert.deepEqual(await new Response(response.body).bytes(), new Uint8Array());
  } finally {
    stalled.port2.close();
    promoted.port2.close();
    if (priorSelf) Object.defineProperty(globalThis, "self", priorSelf);
    else delete (globalThis as { self?: unknown }).self;
  }
});

test("an already-aborted request never wakes or sends to a carrier", async () => {
  const controller = new AbortController();
  controller.abort();
  const bridge = new SwBridge();

  await assert.rejects(
    bridge.request(requestHead, undefined, controller.signal),
    isAbort
  );
  assert.equal(bridge.connected, false);
});

test("v3 rejects a missing version/window before touching a carrier", async () => {
  const bridge = new SwBridge();
  await assert.rejects(
    bridge.request(
      { method: "GET", url: "/old", headers: [], hasBody: false } as never,
      undefined,
      new AbortController().signal
    ),
    /v3 request window/
  );
  assert.equal(bridge.connected, false);
});

test("request bodies cross the page bridge as transferable streams", async () => {
  const bridge = new SwBridge();
  const carrier = new MessageChannel();
  const received: number[] = [];
  let resolveConsumed!: () => void;
  const consumed = new Promise<void>((resolve) => {
    resolveConsumed = resolve;
  });

  carrier.port2.onmessage = (event: MessageEvent<{
    t?: string;
    id?: number;
    body?: ReadableStream<Uint8Array>;
  }>) => {
    if (event.data.t !== "req" || event.data.id === undefined) return;
    assert.ok(event.data.body instanceof ReadableStream);
    void (async () => {
      const reader = event.data.body!.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received.push(...chunk.value);
      }
      resolveConsumed();
      carrier.port2.postMessage({ t: "head", id: event.data.id, head: responseHead });
      carrier.port2.postMessage({ t: "end", id: event.data.id });
    })();
  };
  carrier.port2.start();
  attachReady(bridge, carrier);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
      controller.enqueue(Uint8Array.of(3));
      controller.close();
    }
  });
  const response = await bridge.request({
    ...requestHead,
    method: "POST",
    hasBody: true
  }, body, new AbortController().signal);

  await consumed;
  assert.deepEqual(received, [1, 2, 3]);
  assert.equal(response.head.status, 200);
  carrier.port2.close();
});

test("aborting before the response head sends cancel and rejects promptly", async () => {
  const bridge = new SwBridge();
  const carrier = new MessageChannel();
  const controller = new AbortController();
  const messages: Array<{ t?: string }> = [];

  carrier.port2.onmessage = (event: MessageEvent<{ t?: string }>) => {
    messages.push(event.data);
    if (event.data.t === "req") controller.abort();
  };
  carrier.port2.start();
  attachReady(bridge, carrier);

  try {
    await assert.rejects(
      bridge.request(requestHead, undefined, controller.signal),
      isAbort
    );
    await delay(0);
    assert.ok(messages.some((message) => message.t === "cancel"));
  } finally {
    carrier.port2.close();
  }
});

test("response credit follows downstream pulls and END preserves queued chunks", async () => {
  const bridge = new SwBridge();
  const carrier = new MessageChannel();
  const credits: number[] = [];
  let requestId = 0;
  let sent = false;

  carrier.port2.onmessage = (event: MessageEvent<{ t?: string; id?: number; n?: number }>) => {
    const message = event.data;
    if (message.t === "req" && message.id !== undefined && !sent) {
      requestId = message.id;
      sent = true;
      carrier.port2.postMessage({ t: "head", id: requestId, head: responseHead });
      for (let value = 1; value <= requestHead.initialCredits; value += 1) {
        const chunk = Uint8Array.of(value).buffer;
        carrier.port2.postMessage({
          t: "body",
          id: requestId,
          chunk,
          byteOffset: 0,
          byteLength: chunk.byteLength
        });
      }
      return;
    }
    if (message.t === "credit" && message.n !== undefined) credits.push(message.n);
  };
  carrier.port2.start();
  attachReady(bridge, carrier);

  try {
    const response = await bridge.request(
      requestHead,
      undefined,
      new AbortController().signal
    );
    await delay(0);
    assert.deepEqual(credits, [], "arrival alone must not replenish credit");

    const reader = response.body.getReader();
    const values: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await reader.read();
      assert.equal(result.done, false);
      values.push(result.value![0]!);
    }
    await delay(0);
    assert.deepEqual(credits, [4], "draining half the window should replenish it");

    carrier.port2.postMessage({ t: "end", id: requestId });
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      values.push(result.value[0]!);
    }
    assert.deepEqual(values, [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    carrier.port2.close();
  }
});

test("a fast-draining bulk stream grows its bounded credit window", async () => {
  const bridge = new SwBridge();
  const carrier = new MessageChannel();
  const credits: number[] = [];
  const bulkHead = {
    ...requestHead,
    priority: RequestPriority.Bulk,
    initialCredits: 32
  } as const;

  carrier.port2.onmessage = (event: MessageEvent<{ t?: string; id?: number; n?: number }>) => {
    const message = event.data;
    if (message.t === "credit" && message.n !== undefined) {
      credits.push(message.n);
      return;
    }
    if (message.t !== "req" || message.id === undefined) return;
    const id = message.id;
    carrier.port2.postMessage({ t: "head", id, head: responseHead });
    void (async () => {
      for (let value = 1; value <= 16; value += 1) {
        const chunk = Uint8Array.of(value).buffer;
        carrier.port2.postMessage({
          t: "body",
          id,
          chunk,
          byteOffset: 0,
          byteLength: 1
        });
        await delay(0);
      }
    })();
  };
  carrier.port2.start();
  attachReady(bridge, carrier);

  try {
    const response = await bridge.request(
      bulkHead,
      undefined,
      new AbortController().signal
    );
    const reader = response.body.getReader();
    for (let value = 1; value <= 8; value += 1) {
      const next = await reader.read();
      assert.equal(next.done, false);
      assert.equal(next.value?.[0], value);
    }
    await delay(0);
    assert.deepEqual(
      credits,
      [8],
      "eight drained slots should refill without changing the adaptive window"
    );
    for (let value = 9; value <= 16; value += 1) {
      const next = await reader.read();
      assert.equal(next.done, false);
      assert.equal(next.value?.[0], value);
    }
    await delay(0);
    assert.equal(
      credits.reduce((total, value) => total + value, 0),
      24,
      "growth should add eight slots only after the sixteen-frame sample"
    );
    assert.ok(credits.every((value) => value > 0), "credit messages must never be empty");
    await reader.cancel();
  } finally {
    carrier.port2.close();
  }
});

/**
 * The cheap liveness probe is the only thing standing between a per-fetch
 * browser-process round trip and a request routed off a stale answer, and it
 * has no other coverage — sw.ts, its only consumer, has no test file.
 */
test("the cheap liveness probe reuses a positive briefly and never a negative", async () => {
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  let lookups = 0;
  let owner: { id: string } | undefined = { id: "carrier" };
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      clients: {
        get: () => {
          lookups += 1;
          return Promise.resolve(owner);
        },
        matchAll: () => Promise.resolve([])
      }
    }
  });

  const bridge = new SwBridge();
  const carrier = new MessageChannel();
  try {
    attachReady(bridge, carrier, "carrier");
    await waitForConnected(bridge);

    lookups = 0;
    assert.equal(await bridge.isLikelyConnected(), true);
    assert.equal(lookups, 1, "the first probe must ask");

    // A burst of subresources inside the window asks once, not once each.
    for (let i = 0; i < 25; i += 1) {
      assert.equal(await bridge.isLikelyConnected(), true);
    }
    assert.equal(lookups, 1, "a confirmed carrier must not be re-checked per request");

    // The strict probe never reads the cache — routing decisions depend on it.
    assert.equal(await bridge.isConnected(), true);
    assert.equal(lookups, 2, "isConnected must always ask");

    // A carrier that goes away is noticed, and only the positive was cached:
    // the negative detaches immediately rather than being remembered.
    owner = undefined;
    assert.equal(await bridge.isConnected(), false);
    assert.equal(bridge.connected, false, "a dead carrier must be detached");
  } finally {
    carrier.port2.close();
    if (priorSelf) Object.defineProperty(globalThis, "self", priorSelf);
    else delete (globalThis as { self?: unknown }).self;
  }
});

test("a cached liveness positive does not survive a new attachment", async () => {
  const priorSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  let lookups = 0;
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      clients: {
        get: () => {
          lookups += 1;
          return Promise.resolve({ id: "carrier" });
        },
        matchAll: () => Promise.resolve([])
      }
    }
  });

  const bridge = new SwBridge();
  const first = new MessageChannel();
  const second = new MessageChannel();
  try {
    attachReady(bridge, first, "carrier");
    await waitForConnected(bridge);
    await bridge.isLikelyConnected();
    const before = lookups;

    // A replacement port for the same page: the previous port's confirmation
    // says nothing about this one.
    attachReady(bridge, second, "carrier");
    await waitForConnected(bridge);
    await bridge.isLikelyConnected();

    assert.ok(lookups > before, "a re-attached carrier must be confirmed again");
  } finally {
    first.port2.close();
    second.port2.close();
    if (priorSelf) Object.defineProperty(globalThis, "self", priorSelf);
    else delete (globalThis as { self?: unknown }).self;
  }
});
