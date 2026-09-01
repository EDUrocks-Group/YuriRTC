import assert from "node:assert/strict";
import test from "node:test";

import {
  DATA_CHANNEL_COUNT,
  DATA_CHANNEL_LABEL_PREFIX,
  LoaderClient,
  YuriRTCClient
} from "../src/client.js";
import type { PageToSw, SwToPage } from "../src/bridge.js";
import {
  decodeFrame,
  decodeJsonPayload,
  encodeCreditPayload,
  encodeFrame,
  FrameType,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  RequestPriority,
  type RequestHead
} from "@yurirtc/protocol";

const CONFIG = {
  firebase: { apiKey: "key", projectId: "project", databaseUrl: "https://db.invalid" },
  cache: { lruBudgetBytes: 1024, maxQuotaShare: 0.5 },
  signal: {}
};

type MutableChannel = RTCDataChannel & {
  readyState: RTCDataChannelState;
  bufferedAmount: number;
};

const DATA_CHANNEL_BUFFER_HIGH_WATER = 2 * 1024 * 1024;
const DATA_CHANNEL_BUFFER_LOW_WATER = 1 * 1024 * 1024;

function fakeDataChannel(
  label: string,
  readyState: RTCDataChannelState = "connecting",
  bufferedAmount = 0
): MutableChannel {
  const events = new EventTarget();
  const channel = {
    label,
    readyState,
    bufferedAmount,
    bufferedAmountLowThreshold: 0,
    binaryType: "blob" as BinaryType,
    onopen: null as ((event: Event) => void) | null,
    onclose: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    send() {},
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    close() {
      if (channel.readyState === "closed") return;
      channel.readyState = "closed";
      const event = new Event("close");
      channel.onclose?.(event);
      events.dispatchEvent(event);
    }
  } as unknown as MutableChannel;
  return channel;
}

function openChannel(channel: MutableChannel): void {
  channel.readyState = "open";
  channel.onopen?.(new Event("open"));
}

interface ClientInternals {
  pc: RTCPeerConnection | null;
  channel: Pick<RTCDataChannel, "readyState"> | null;
  channels: RTCDataChannel[];
  port: MessagePort | null;
  registration: ServiceWorkerRegistration | undefined;
  transportDown: boolean;
  connectionGeneration: number;
  bulkIdleTimer: ReturnType<typeof setTimeout> | null;
  channelLoads: Map<RTCDataChannel, number>;
  direct: Map<number, (message: PageToSw) => void>;
  requestBySw: Map<number, number>;
  swByRequest: Map<number, number>;
  requestAbortControllers: Map<number, AbortController>;
  uploads: Map<number, unknown>;
  startingRequests: Map<number, { cancelled: boolean }>;
  sockets: Map<number, unknown>;
  inbound: Map<number, { swId: number; channel: RTCDataChannel }>;
  outbound: Map<number, { credit: number }>;
  adaptiveTcpPending: boolean;
  successor: YuriRTCClient | null;
  post(message: PageToSw, transfer?: Transferable[]): void;
  startRequest(
    swId: number,
    head?: RequestHead,
    body?: ReadableStream<Uint8Array>
  ): Promise<void>;
  send(frame: Uint8Array, channel?: RTCDataChannel): void;
  sendWithBackpressure(
    frame: Uint8Array,
    channel: RTCDataChannel,
    signal?: AbortSignal
  ): Promise<void>;
  cancelRequest(swId: number): void;
  onServiceWorkerMessage(event: MessageEvent): void;
  onSwMessage(message: SwToPage, wakeWorker?: ServiceWorker): void;
  onFrame(data: ArrayBuffer, source?: RTCDataChannel): void;
  attachToServiceWorker(
    registration: ServiceWorkerRegistration,
    generation?: number
  ): Promise<void>;
  attachPortToWorker(worker: ServiceWorker, generation: number): Promise<void>;
  resetWorkerBridgeRequests(port: MessagePort, reason: string): void;
  handleIceConnectionState(pc: Pick<RTCPeerConnection, "iceConnectionState">): void;
  prepareChannel(channel: RTCDataChannel, lane: number, generation?: number): Promise<void>;
  ensureBulkChannels(): Promise<void>;
  chooseChannel(priority: RequestPriority, logicalPath?: string): RTCDataChannel | null;
  teardown(reason: string): void;
  maybeNotifyDrained(): void;
}

test("legacy LoaderClient export aliases the preferred YuriRTCClient", () => {
  assert.equal(LoaderClient, YuriRTCClient);
});

test("adaptive TCP warm-up starts immediately while old work drains separately", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  let suggestions = 0;
  internal.adaptiveTcpPending = true;
  internal.inbound.set(1, { swId: 1, channel });
  client.onAdaptiveTcpSuggested(() => { suggestions += 1; });
  await Promise.resolve();
  assert.equal(suggestions, 1, "background TCP warm-up waited for the active response");

  let drains = 0;
  client.onDrained(() => { drains += 1; });
  await Promise.resolve();
  assert.equal(drains, 0);
  internal.inbound.clear();
  internal.maybeNotifyDrained();
  assert.equal(drains, 1, "the predecessor did not report its independent drain");
});

test("promotion keeps an old GET on UDP while routing a new GET to its successor", async () => {
  const oldClient = new YuriRTCClient(CONFIG);
  const successor = new YuriRTCClient(CONFIG);
  const old = oldClient as unknown as ClientInternals;
  const next = successor as unknown as ClientInternals;
  const oldStarts: number[] = [];
  const newStarts: number[] = [];
  old.startRequest = async (id) => { oldStarts.push(id); };
  next.startRequest = async (id) => { newStarts.push(id); };
  const head = {
    version: PROTOCOL_VERSION,
    method: "GET",
    url: "/asset.js",
    headers: [],
    hasBody: false,
    priority: RequestPriority.Critical,
    initialCredits: 8
  } satisfies RequestHead;

  old.onSwMessage({ t: "req", id: 1, head });
  oldClient.adoptSuccessor(successor);
  old.onSwMessage({ t: "req", id: 2, head });
  await Promise.resolve();

  assert.deepEqual(oldStarts, [1]);
  assert.deepEqual(newStarts, [2]);
});

test("a draining predecessor failure does not send global DOWN or disconnect its successor", () => {
  const oldClient = new YuriRTCClient(CONFIG);
  const successor = new YuriRTCClient(CONFIG);
  const old = oldClient as unknown as ClientInternals;
  const next = successor as unknown as ClientInternals;
  next.channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  oldClient.adoptSuccessor(successor);
  const posted: PageToSw[] = [];
  old.post = (message) => posted.push(message);
  old.swByRequest.set(41, 7);
  old.requestBySw.set(7, 41);
  old.inbound.set(41, {
    swId: 7,
    channel: fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}2`, "open")
  });
  let disconnects = 0;
  oldClient.onDisconnect(() => { disconnects += 1; });

  old.teardown("old UDP route failed");

  assert.equal(posted.some((message) => message.t === "down"), false);
  assert.deepEqual(posted.filter((message) => message.t === "err").map((message) => message.id), [7]);
  assert.equal(disconnects, 0);
  assert.equal(next.channel?.readyState, "open");
  assert.equal(old.transportDown, false, "the healthy successor lost its SW-router attachment guard");
});

test("a page rejects a mismatched-protocol worker acknowledgement before sending ready", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const pageMessages: Array<{ t?: string }> = [];
  const worker = {
    state: "activated",
    postMessage(message: { t?: string; bootstrap?: unknown }, transfer: Transferable[]) {
      assert.equal(message.t, "attach");
      assert.equal(message.bootstrap, undefined, "a protocol probe must not expose v3 bootstrap data");
      const port = transfer[0] as MessagePort;
      port.onmessage = (event: MessageEvent<{ t?: string }>) => pageMessages.push(event.data);
      port.start();
      port.postMessage({ t: "attached", protocolVersion: 2 });
    }
  } as unknown as ServiceWorker;

  await assert.rejects(
    internal.attachPortToWorker(worker, internal.connectionGeneration),
    /does not match YuriRTC v3/
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(pageMessages.some((message) => message.t === "ready"), false);
  assert.equal(internal.port, null);
});

test("a page waits for an installing matching worker without probing the active mismatched one", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const attempts: number[] = [];
  const pageMessages = new Map<number, string[]>();
  const registrationEvents = new EventTarget();
  const newWorkerEvents = new EventTarget();

  const makeWorker = (
    protocolVersion: number,
    events: EventTarget,
    state: ServiceWorkerState
  ): ServiceWorker & { state: ServiceWorkerState } => {
    const worker = {
      state,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      postMessage(message: { t?: string; bootstrap?: unknown }, transfer: Transferable[]) {
        const port = transfer[0] as MessagePort;
        if (message.t === "attach") {
          assert.equal(message.bootstrap, undefined);
          attempts.push(protocolVersion);
          const received: string[] = [];
          pageMessages.set(protocolVersion, received);
          port.onmessage = (event: MessageEvent<{ t?: string }>) => {
            if (event.data.t) received.push(event.data.t);
          };
          port.start();
          port.postMessage({ t: "attached", protocolVersion });
          return;
        }
        assert.equal(message.t, "bootstrap");
        assert.equal(protocolVersion, PROTOCOL_VERSION);
        assert.ok(message.bootstrap, "v3 bootstrap was not sent after version confirmation");
        port.postMessage({ t: "bootstrapped", protocolVersion });
      }
    } as unknown as ServiceWorker & { state: ServiceWorkerState };
    return worker;
  };

  const oldWorker = makeWorker(2, new EventTarget(), "activated");
  const newWorker = makeWorker(PROTOCOL_VERSION, newWorkerEvents, "installing");
  const mutableRegistration = {
    active: oldWorker,
    waiting: null,
    installing: newWorker,
    addEventListener: registrationEvents.addEventListener.bind(registrationEvents),
    removeEventListener: registrationEvents.removeEventListener.bind(registrationEvents)
  } as unknown as ServiceWorkerRegistration & {
    active: ServiceWorker | null;
    waiting: ServiceWorker | null;
    installing: ServiceWorker | null;
  };

  const attaching = internal.attachToServiceWorker(
    mutableRegistration,
    internal.connectionGeneration
  );
  setTimeout(() => {
    newWorker.state = "activated";
    mutableRegistration.active = newWorker;
    mutableRegistration.installing = null;
    newWorkerEvents.dispatchEvent(new Event("statechange"));
  }, 10);

  await attaching;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(attempts, [PROTOCOL_VERSION]);
  assert.equal(pageMessages.has(2), false);
  assert.equal(pageMessages.get(PROTOCOL_VERSION)?.includes("ready"), true);
  client.close();
});

test("a standby election keeps the losing tab connected without owning a port", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const worker = {
    postMessage(message: { t?: string }, transfer: Transferable[]) {
      assert.equal(message.t, "attach");
      const port = transfer[0] as MessagePort;
      port.postMessage({ t: "standby", protocolVersion: PROTOCOL_VERSION });
      port.close();
    }
  } as unknown as ServiceWorker;

  await internal.attachPortToWorker(worker, internal.connectionGeneration);
  assert.equal(internal.port, null);
  assert.equal(internal.transportDown, false);
  client.close();
});

test("a configured same-origin recovery client precedes inline and CDN sources", async () => {
  const durable = "https://bucket.invalid/release/client.js";
  const client = new YuriRTCClient({
    ...CONFIG,
    recovery: { clientUrls: [durable, durable, ""] }
  });
  const internal = client as unknown as ClientInternals;
  let bootstrap: { clientUrls?: string[] } | undefined;
  const worker = {
    state: "activated",
    postMessage(message: { t?: string; bootstrap?: { clientUrls?: string[] } }, transfer: Transferable[]) {
      const port = transfer[0] as MessagePort;
      port.start();
      if (message.t === "attach") {
        port.postMessage({ t: "attached", protocolVersion: PROTOCOL_VERSION });
        return;
      }
      assert.equal(message.t, "bootstrap");
      bootstrap = message.bootstrap;
      port.postMessage({ t: "bootstrapped", protocolVersion: PROTOCOL_VERSION });
    }
  } as unknown as ServiceWorker;

  try {
    await internal.attachPortToWorker(worker, internal.connectionGeneration);
    assert.equal(bootstrap?.clientUrls?.[0], durable);
    assert.equal(bootstrap?.clientUrls?.filter((url) => url === durable).length, 1);
    assert.ok(bootstrap?.clientUrls?.some((url) => url.startsWith("https://unpkg.com/")));
    assert.ok(bootstrap?.clientUrls?.some((url) => url.startsWith("https://cdn.jsdelivr.net/")));
  } finally {
    client.close();
  }
});

test("a losing former carrier retires old bridge work without reporting ids to the winner", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = channel;
  internal.channels = [channel];
  const sent: Uint8Array[] = [];
  const newBridgeMessages: PageToSw[] = [];
  let workerPort: MessagePort | undefined;
  internal.send = (frame) => sent.push(frame);

  const worker = {
    postMessage(message: { t?: string }, transfer: Transferable[]) {
      assert.equal(message.t, "attach");
      workerPort = transfer[0] as MessagePort;
      workerPort.onmessage = (event: MessageEvent<PageToSw>) => {
        newBridgeMessages.push(event.data);
      };
      workerPort.start();
      workerPort.postMessage({ t: "standby", protocolVersion: PROTOCOL_VERSION });
    }
  } as unknown as ServiceWorker;
  const head: RequestHead = {
    version: PROTOCOL_VERSION,
    method: "GET",
    url: "/old-worker-asset",
    headers: [],
    hasBody: false,
    priority: RequestPriority.Interactive,
    initialCredits: 8
  };

  try {
    await internal.startRequest(19, head);
    assert.equal(internal.requestBySw.size, 1);

    await internal.attachPortToWorker(worker, internal.connectionGeneration);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      sent.map((frame) => decodeFrame(frame).type),
      [FrameType.Req, FrameType.Cancel]
    );
    assert.equal(internal.requestBySw.size, 0);
    assert.equal(internal.swByRequest.size, 0);
    assert.equal(internal.inbound.size, 0);
    assert.equal(internal.outbound.size, 0);
    assert.equal(internal.requestAbortControllers.size, 0);
    assert.deepEqual(
      newBridgeMessages,
      [],
      "old bridge ids must not collide with ids already allocated by the winner"
    );
    assert.equal(internal.port, null);
    assert.equal(internal.transportDown, false);
  } finally {
    workerPort?.close();
    client.close();
  }
});

test("a replacement worker wake cannot disturb live work owned by the old controller", async () => {
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldController = {} as ServiceWorker;
  const replacement = {} as ServiceWorker;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { controller: oldController } }
  });

  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = channel;
  internal.channels = [channel];
  internal.registration = { active: replacement } as ServiceWorkerRegistration;
  const sent: Uint8Array[] = [];
  const attachments: ServiceWorker[] = [];
  internal.send = (frame) => sent.push(frame);
  internal.attachPortToWorker = async (worker) => {
    attachments.push(worker);
  };
  const head: RequestHead = {
    version: PROTOCOL_VERSION,
    method: "GET",
    url: "/live-old-controller-asset",
    headers: [],
    hasBody: false,
    priority: RequestPriority.Interactive,
    initialCredits: 8
  };

  try {
    await internal.startRequest(23, head);
    internal.onServiceWorkerMessage({
      data: { t: "wake" },
      source: replacement
    } as MessageEvent);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(attachments, []);
    assert.equal(internal.requestBySw.size, 1);
    assert.deepEqual(sent.map((frame) => decodeFrame(frame).type), [FrameType.Req]);

    internal.onServiceWorkerMessage({
      data: { t: "wake" },
      source: oldController
    } as MessageEvent);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(attachments, [oldController]);
    assert.equal(internal.requestBySw.size, 1, "the accepted wake test double must not retire work");
  } finally {
    internal.cancelRequest(23);
    client.close();
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("a wake which overtakes standby is replayed after the losing attach settles", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  internal.channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.registration = {} as ServiceWorkerRegistration;
  const workerPorts: MessagePort[] = [];
  const worker = {
    postMessage(message: { t?: string }, transfer: Transferable[]) {
      assert.equal(message.t, "attach");
      const port = transfer[0] as MessagePort;
      workerPorts.push(port);
      port.start();
      if (workerPorts.length > 1) {
        port.postMessage({ t: "standby", protocolVersion: PROTOCOL_VERSION });
      }
    }
  } as unknown as ServiceWorker;

  try {
    internal.onSwMessage({ t: "wake" }, worker);
    for (let attempt = 0; attempt < 20 && workerPorts.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(workerPorts.length, 1, "the first election did not attach");

    // This newer discovery message is deliberately processed before the first
    // MessagePort's standby response, reproducing the cross-task-source race.
    internal.onSwMessage({ t: "wake" }, worker);
    workerPorts[0]!.postMessage({ t: "standby", protocolVersion: PROTOCOL_VERSION });

    for (let attempt = 0; attempt < 20 && workerPorts.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(workerPorts.length, 2, "the overtaking wake was lost after standby");
    assert.equal(internal.transportDown, false);
  } finally {
    for (const port of workerPorts) port.close();
    client.close();
  }
});

test("a restarted worker cannot reuse an id while an old RTC response is live", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = channel;
  internal.channels = [channel];
  const sent: Uint8Array[] = [];
  const posted: PageToSw[] = [];
  internal.send = (frame) => sent.push(frame);
  internal.post = (message) => posted.push(message);
  const head: RequestHead = {
    version: PROTOCOL_VERSION,
    method: "GET",
    url: "/asset",
    headers: [],
    hasBody: false,
    priority: RequestPriority.Interactive,
    initialCredits: 8
  };

  await internal.startRequest(1, head);
  const oldWireId = decodeFrame(sent[0]!).requestId;
  const replacement = new MessageChannel();
  const bridgeMessages: PageToSw[] = [];
  let receiveBridgeMessage!: () => void;
  const bridgeMessageReceived = new Promise<void>((resolve) => {
    receiveBridgeMessage = resolve;
  });
  replacement.port2.onmessage = (event: MessageEvent<PageToSw>) => {
    bridgeMessages.push(event.data);
    receiveBridgeMessage();
  };
  replacement.port2.start();
  internal.resetWorkerBridgeRequests(replacement.port1, "bridge restarted");
  let deliveryTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      bridgeMessageReceived,
      new Promise<void>((_resolve, reject) => {
        deliveryTimeout = setTimeout(
          () => reject(new Error("bridge cleanup message was not delivered")),
          500
        );
      })
    ]);
  } finally {
    if (deliveryTimeout) clearTimeout(deliveryTimeout);
  }

  await internal.startRequest(1, head);
  const requestFrames = sent.map((frame) => decodeFrame(frame));
  const requests = requestFrames.filter((frame) => frame.type === FrameType.Req);
  const newWireId = requests[requests.length - 1]!.requestId;
  assert.notEqual(newWireId, oldWireId);

  internal.onFrame(
    encodeFrame(
      FrameType.ResHead,
      oldWireId,
      new TextEncoder().encode(JSON.stringify({ status: 200, statusText: "OLD", headers: [] }))
    ).buffer as ArrayBuffer,
    channel
  );
  internal.onFrame(
    encodeFrame(
      FrameType.ResHead,
      newWireId,
      new TextEncoder().encode(JSON.stringify({ status: 200, statusText: "NEW", headers: [] }))
    ).buffer as ArrayBuffer,
    channel
  );

  assert.deepEqual(
    sent.map((frame) => decodeFrame(frame).type),
    [FrameType.Req, FrameType.Cancel, FrameType.Req]
  );
  assert.equal(bridgeMessages.length, 1);
  assert.deepEqual(bridgeMessages[0], { t: "err", id: 1, message: "bridge restarted" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.t, "head");
  assert.equal(posted[0]?.t === "head" ? posted[0].head.statusText : "", "NEW");

  internal.cancelRequest(1);
  replacement.port2.close();
});

test("a stale reattach failure cannot tear down a newer connection generation", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  internal.channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.registration = {} as ServiceWorkerRegistration;
  let rejectOld!: (error: Error) => void;
  internal.attachToServiceWorker = () => new Promise<void>((_resolve, reject) => {
    rejectOld = reject;
  });

  internal.onSwMessage({ t: "wake" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  internal.connectionGeneration += 1;
  rejectOld(new Error("old worker activation failed"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(internal.transportDown, false);
  client.close();
});

test("an exact-worker wake cannot install a port after its generation is superseded", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  internal.channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.registration = {} as ServiceWorkerRegistration;
  let attachMessages = 0;
  const worker = {
    postMessage() {
      attachMessages += 1;
    }
  } as unknown as ServiceWorker;

  internal.onSwMessage({ t: "wake" }, worker);
  internal.connectionGeneration += 1;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attachMessages, 0);
  assert.equal(internal.port, null);
  assert.equal(internal.transportDown, false);
  client.close();
});

test("direct requests synthesize HEAD and null-body statuses without a body", async () => {
  for (const testCase of [
    { method: "HEAD", status: 200 },
    { method: "GET", status: 204 },
    { method: "GET", status: 205 },
    { method: "GET", status: 304 }
  ]) {
    const client = new YuriRTCClient(CONFIG);
    const internal = client as unknown as ClientInternals;
    internal.channel = { readyState: "open" };
    internal.startRequest = async (id) => {
      const collect = internal.direct.get(id);
      assert.ok(collect, "direct collector must exist before transport starts");
      collect({
        t: "head",
        id,
        head: { status: testCase.status, statusText: "test", headers: [] }
      });
      // A misbehaving/older node may still send a body for a bodyless response.
      // It must be discarded instead of enqueueing into a closed stream.
      const chunk = Uint8Array.of(1).buffer;
      collect({ t: "body", id, chunk, byteOffset: 0, byteLength: 1 });
      collect({ t: "end", id });
    };

    const response = await client.request("/bodyless", { method: testCase.method });
    assert.equal(response.status, testCase.status);
    assert.equal(response.body, null);
    assert.equal(await response.text(), "");
  }
});

test("transient ICE disconnects do not tear down long-lived responses", () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const reasons: string[] = [];
  internal.teardown = (reason) => reasons.push(reason);

  const pc = { iceConnectionState: "new" } as unknown as RTCPeerConnection & {
    iceConnectionState: RTCIceConnectionState;
  };
  internal.pc = pc;
  for (const state of ["new", "checking", "connected", "completed", "disconnected"] as const) {
    pc.iceConnectionState = state;
    internal.handleIceConnectionState(pc);
  }
  assert.deepEqual(reasons, [], "recoverable ICE states must preserve the transport");

  pc.iceConnectionState = "failed";
  internal.handleIceConnectionState(pc);
  pc.iceConnectionState = "closed";
  internal.handleIceConnectionState(pc);
  assert.deepEqual(reasons, ["ice failed", "ice closed"]);
});

test("a terminal callback from an old peer cannot tear down its replacement", () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const reasons: string[] = [];
  const oldPc = { iceConnectionState: "failed" } as unknown as RTCPeerConnection;
  const currentPc = { iceConnectionState: "connected" } as unknown as RTCPeerConnection;
  internal.pc = currentPc;
  internal.teardown = (reason) => reasons.push(reason);

  internal.handleIceConnectionState(oldPc);
  assert.deepEqual(reasons, []);

  (currentPc as unknown as { iceConnectionState: RTCIceConnectionState }).iceConnectionState = "failed";
  internal.handleIceConnectionState(currentPc);
  assert.deepEqual(reasons, ["ice failed"]);
});

test("ICE disconnected gets a recoverable grace period before teardown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const pc = { iceConnectionState: "disconnected" } as unknown as RTCPeerConnection & {
    iceConnectionState: RTCIceConnectionState;
  };
  const reasons: string[] = [];
  internal.pc = pc;
  internal.teardown = (reason) => reasons.push(reason);

  internal.handleIceConnectionState(pc);
  t.mock.timers.tick(11_999);
  assert.deepEqual(reasons, []);
  pc.iceConnectionState = "connected";
  internal.handleIceConnectionState(pc);
  t.mock.timers.tick(1);
  assert.deepEqual(reasons, [], "recovery cancels the pending teardown");

  pc.iceConnectionState = "disconnected";
  internal.handleIceConnectionState(pc);
  t.mock.timers.tick(12_000);
  assert.deepEqual(reasons, ["ice disconnected"]);
});

test("terminal callbacks are coalesced across all lane closes", () => {
  const client = new YuriRTCClient(CONFIG);
  const reasons: string[] = [];
  client.onDisconnect((reason) => reasons.push(reason));
  const internal = client as unknown as ClientInternals;

  internal.teardown("lane 0 closed");
  internal.teardown("lane 1 closed");
  internal.teardown("ice failed");
  assert.deepEqual(reasons, ["lane 0 closed"]);
});

test("a lane-zero close from an old generation cannot tear down the new lane", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const oldLane = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`);
  const opened = internal.prepareChannel(oldLane, 0, 1);
  internal.connectionGeneration = 1;
  internal.channel = oldLane;
  openChannel(oldLane);
  await opened;

  const currentLane = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.connectionGeneration = 2;
  internal.channel = currentLane;
  const reasons: string[] = [];
  internal.teardown = (reason) => reasons.push(reason);
  oldLane.close();

  assert.deepEqual(reasons, []);
  assert.equal(internal.channel, currentLane);
});

test("bulk lane construction reserves lane zero and lane one by request class", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const made: Array<RTCDataChannel & { readyState: RTCDataChannelState }> = [];

  const primary = {
    label: `${DATA_CHANNEL_LABEL_PREFIX}0`,
    readyState: "open",
    bufferedAmount: 0,
    close() {}
  } as unknown as RTCDataChannel;
  internal.channel = primary;
  internal.channels = [primary];
  internal.pc = {
    createDataChannel(label: string) {
      const channel = fakeDataChannel(label);
      made.push(channel);
      queueMicrotask(() => {
        openChannel(channel);
      });
      return channel;
    }
  } as unknown as RTCPeerConnection;

  assert.equal(internal.channels.length, 1, "an idle peer owns only the persistent lane");
  await internal.ensureBulkChannels();
  assert.equal(internal.channels.length, DATA_CHANNEL_COUNT);
  assert.notEqual(internal.bulkIdleTimer, null, "eager bulk lanes were left open indefinitely");
  assert.deepEqual(
    made.map((channel) => channel.label),
    [1, 2, 3].map((lane) => `${DATA_CHANNEL_LABEL_PREFIX}${lane}`)
  );
  assert.equal(internal.chooseChannel(RequestPriority.Interactive), primary);
  assert.equal(internal.chooseChannel(RequestPriority.Critical, "/app.js"), made[0]);
  assert.ok(
    [made[1], made[2]].includes(internal.chooseChannel(RequestPriority.Bulk, "/game.data") as MutableChannel),
    "incremental work consumed the small-critical reserve"
  );

  for (const channel of made) channel.close();
  if (internal.bulkIdleTimer !== null) clearTimeout(internal.bulkIdleTimer);
});

test("critical requests use lane zero while bulk lanes open; bulk requests wait", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const primary = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  const made: MutableChannel[] = [];
  internal.channel = primary;
  internal.channels = [primary];
  internal.pc = {
    createDataChannel(label: string) {
      const channel = fakeDataChannel(label); // stays connecting until opened
      made.push(channel);
      return channel;
    }
  } as unknown as RTCPeerConnection;

  const sent: Array<{ channel: RTCDataChannel | undefined; frame: ReturnType<typeof decodeFrame> }> = [];
  internal.send = (frame, channel) => {
    sent.push({ channel, frame: decodeFrame(frame) });
  };

  const critical: RequestHead = {
    version: PROTOCOL_VERSION,
    method: "GET",
    url: "/a/app.js",
    headers: [],
    hasBody: false,
    priority: RequestPriority.Critical,
    initialCredits: 32
  };
  const started = internal.startRequest(21, critical);
  // The render-blocking REQ uses the only open lane while the same call kicks
  // the reserved/bulk lanes open behind it.
  assert.equal(made.length, DATA_CHANNEL_COUNT - 1, "the critical request opens the bulk lanes");
  await Promise.resolve();
  assert.equal(sent.length, 1, "the critical REQ must not wait for lane opening");
  assert.equal(sent[0]!.frame.type, FrameType.Req);
  assert.equal(sent[0]!.channel, primary);
  await started;

  const bulk: RequestHead = {
    ...critical,
    url: "/filestorage/gn/1/payload.bin",
    priority: RequestPriority.Bulk
  };
  const bulkStarted = internal.startRequest(22, bulk);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, "a bulk REQ must keep waiting for the bulk lanes");

  for (const channel of made) openChannel(channel);
  await bulkStarted;
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.frame.type, FrameType.Req);
  assert.notEqual(sent[1]!.channel, primary, "bulk stays off the interactive lane");

  for (const channel of made) channel.close();
});

test("bulk starts are FIFO-bounded to two lanes and a cancelled waiter never starts", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channels = [0, 1, 2, 3].map((lane) =>
    fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}${lane}`, "open")
  );
  internal.channel = channels[0]!;
  internal.channels = channels;
  for (const channel of channels) internal.channelLoads.set(channel, 0);
  internal.ensureBulkChannels = async () => undefined;
  const sent: Array<{
    frame: ReturnType<typeof decodeFrame>;
    channel: RTCDataChannel | undefined;
  }> = [];
  internal.send = (frame, channel) => sent.push({ frame: decodeFrame(frame), channel });
  const head = {
    version: PROTOCOL_VERSION,
    method: "GET",
    url: "/game.data",
    headers: [],
    hasBody: false,
    priority: RequestPriority.Bulk,
    initialCredits: 8
  } satisfies RequestHead;

  const first = internal.startRequest(1, head);
  const second = internal.startRequest(2, head);
  const third = internal.startRequest(3, head);
  const fourth = internal.startRequest(4, head);
  await Promise.all([first, second]);
  await Promise.resolve();
  assert.equal(sent.length, 2);
  assert.deepEqual(new Set(sent.map((entry) => entry.channel)), new Set([channels[2], channels[3]]));

  internal.cancelRequest(1);
  await third;
  assert.equal(sent.length, 4, "FIFO waiter did not receive the first released slot");
  // CANCEL for request one is the third frame; request three's REQ follows it.
  assert.equal(sent[3]!.frame.type, FrameType.Req);
  internal.cancelRequest(4);
  await fourth;
  assert.equal(
    sent.filter((entry) => entry.frame.type === FrameType.Req).length,
    3,
    "cancelled waiter started on the wire"
  );

  internal.cancelRequest(2);
  internal.cancelRequest(3);
});

test("a failed bulk lane is replaced without duplicating lanes still opening", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const primary = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  const made: MutableChannel[] = [];
  internal.channel = primary;
  internal.channels = [primary];
  internal.pc = {
    createDataChannel(label: string) {
      const channel = fakeDataChannel(label);
      made.push(channel);
      return channel;
    }
  } as unknown as RTCPeerConnection;

  const first = internal.ensureBulkChannels();
  assert.equal(made.length, 3);
  made[0]!.onerror?.({} as RTCErrorEvent);
  await assert.rejects(first, /failed to open/);

  const second = internal.ensureBulkChannels();
  assert.equal(made.length, 4, "only the failed label is recreated");
  for (const channel of made) {
    if (channel.readyState === "connecting") openChannel(channel);
  }
  await second;
  assert.equal(
    new Set(internal.channels.filter((channel) => channel !== primary).map((channel) => channel.label)).size,
    3
  );
});

test("closing one bulk lane fails and releases only requests assigned to it", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const primary = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  const bulk = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}1`);
  internal.channel = primary;
  internal.channels = [primary, bulk];
  const opened = internal.prepareChannel(bulk, 1);
  openChannel(bulk);
  await opened;

  const requestId = 61;
  const swId = 19;
  const posted: PageToSw[] = [];
  internal.requestBySw.set(swId, requestId);
  internal.swByRequest.set(requestId, swId);
  internal.inbound.set(requestId, { swId, channel: bulk });
  internal.outbound.set(requestId, { credit: 1 });
  internal.channelLoads.set(bulk, 1);
  internal.post = (message) => posted.push(message);

  bulk.close();

  assert.equal(posted[0]?.t, "err");
  assert.equal(internal.requestBySw.has(swId), false);
  assert.equal(internal.inbound.has(requestId), false);
  assert.equal(internal.channels.includes(primary), true, "the interactive lane remains usable");
});

test("upload backpressure pauses above two MiB and resumes at one MiB", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}2`);
  const opened = internal.prepareChannel(channel, 2);
  openChannel(channel);
  await opened;
  assert.equal(channel.bufferedAmountLowThreshold, DATA_CHANNEL_BUFFER_LOW_WATER);

  const sent: Uint8Array[] = [];
  internal.send = (frame) => sent.push(frame);
  channel.bufferedAmount = DATA_CHANNEL_BUFFER_HIGH_WATER;
  await internal.sendWithBackpressure(Uint8Array.of(1), channel);
  assert.equal(sent.length, 1, "the exact high-water bound remains usable");

  channel.bufferedAmount = DATA_CHANNEL_BUFFER_HIGH_WATER + 1;
  const blocked = internal.sendWithBackpressure(Uint8Array.of(2), channel);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, "bytes above the high-water bound must pause");
  channel.bufferedAmount = DATA_CHANNEL_BUFFER_LOW_WATER;
  channel.dispatchEvent(new Event("bufferedamountlow"));
  await blocked;
  assert.equal(sent.length, 2);
});

test("a channel close rejects an upload waiting on bufferedAmountLow", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(
    `${DATA_CHANNEL_LABEL_PREFIX}2`,
    "open",
    DATA_CHANNEL_BUFFER_HIGH_WATER + 1
  );
  const sending = internal.sendWithBackpressure(Uint8Array.of(1), channel);
  channel.close();
  await assert.rejects(sending, /closed during backpressure/);
});

test("cancelling a backpressured upload sends no later body or end frames", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(
    `${DATA_CHANNEL_LABEL_PREFIX}0`,
    "open",
    DATA_CHANNEL_BUFFER_HIGH_WATER + 1
  );
  internal.channel = channel;
  internal.channels = [channel];
  const frames: Uint8Array[] = [];
  const posted: PageToSw[] = [];
  let sourceCancelled = false;
  let supplied = false;
  internal.send = (frame) => frames.push(frame);
  internal.post = (message) => posted.push(message);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (supplied) return;
      supplied = true;
      controller.enqueue(new Uint8Array(MAX_PAYLOAD_BYTES));
    },
    cancel() {
      sourceCancelled = true;
    }
  }, { highWaterMark: 0 });

  const uploading = internal.startRequest(
    27,
    {
      version: PROTOCOL_VERSION,
      method: "POST",
      url: "/apiv2/upload",
      headers: [],
      hasBody: true,
      priority: RequestPriority.Interactive,
      initialCredits: 8
    },
    body
  );
  const requestId = decodeFrame(frames[0]!).requestId;
  internal.onFrame(
    encodeFrame(FrameType.ReqCredit, requestId, encodeCreditPayload(1)).buffer as ArrayBuffer,
    channel
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  internal.cancelRequest(27);
  await uploading;

  assert.deepEqual(
    frames.map((frame) => decodeFrame(frame).type),
    [FrameType.Req, FrameType.Cancel],
    "REQ_BODY and REQ_END must not follow CANCEL"
  );
  assert.deepEqual(posted, [], "an intentional cancel must not surface as an upload error");
  assert.equal(internal.requestBySw.size, 0);
  assert.equal(internal.requestAbortControllers.size, 0);
  assert.equal(sourceCancelled, true, "cancellation must propagate to the upload source");
});

test("streaming uploads wait for node credit and coalesce small source chunks", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = channel;
  internal.channels = [channel];
  const frames: Uint8Array[] = [];
  internal.send = (frame) => frames.push(frame);

  const sourceChunks = [Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5)];
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      const chunk = sourceChunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    }
  }, { highWaterMark: 0 });

  const uploading = internal.startRequest(31, {
    version: PROTOCOL_VERSION,
    method: "POST",
    url: "/apiv2/upload",
    headers: [],
    hasBody: true,
    priority: RequestPriority.Interactive,
    initialCredits: 8
  }, body);

  assert.equal(pulls, 0, "the page must not pull upload bytes before node credit");
  const requestId = decodeFrame(frames[0]!).requestId;
  internal.onFrame(
    encodeFrame(FrameType.ReqCredit, requestId, encodeCreditPayload(1)).buffer as ArrayBuffer,
    channel
  );
  await uploading;

  const decoded = frames.map((frame) => decodeFrame(frame));
  assert.deepEqual(decoded.map((frame) => frame.type), [
    FrameType.Req,
    FrameType.ReqBody,
    FrameType.ReqEnd
  ]);
  assert.deepEqual([...decoded[1]!.payload], [1, 2, 3, 4, 5]);
});

test("one request credit never permits more than one maximum-sized upload frame", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = channel;
  internal.channels = [channel];
  const frames: Uint8Array[] = [];
  internal.send = (frame) => frames.push(frame);
  const source = new Uint8Array(MAX_PAYLOAD_BYTES + 5);

  const uploading = internal.startRequest(32, {
    version: PROTOCOL_VERSION,
    method: "POST",
    url: "/apiv2/upload",
    headers: [],
    hasBody: true,
    priority: RequestPriority.Interactive,
    initialCredits: 8
  }, new Blob([source]).stream());
  const requestId = decodeFrame(frames[0]!).requestId;

  internal.onFrame(
    encodeFrame(FrameType.ReqCredit, requestId, encodeCreditPayload(1)).buffer as ArrayBuffer,
    channel
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(frames.map((frame) => decodeFrame(frame).type), [
    FrameType.Req,
    FrameType.ReqBody
  ]);
  assert.equal(decodeFrame(frames[1]!).payload.byteLength, MAX_PAYLOAD_BYTES);

  internal.onFrame(
    encodeFrame(FrameType.ReqCredit, requestId, encodeCreditPayload(1)).buffer as ArrayBuffer,
    channel
  );
  await uploading;
  const decoded = frames.map((frame) => decodeFrame(frame));
  assert.deepEqual(decoded.map((frame) => frame.type), [
    FrameType.Req,
    FrameType.ReqBody,
    FrameType.ReqBody,
    FrameType.ReqEnd
  ]);
  assert.equal(decoded[2]!.payload.byteLength, 5);
});

test("request upload grants cannot exceed the bounded sixteen-frame window", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = channel;
  internal.channels = [channel];
  const frames: Uint8Array[] = [];
  const posted: PageToSw[] = [];
  internal.send = (frame) => frames.push(frame);
  internal.post = (message) => posted.push(message);
  const body = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });

  const uploading = internal.startRequest(33, {
    version: PROTOCOL_VERSION,
    method: "POST",
    url: "/apiv2/upload",
    headers: [],
    hasBody: true,
    priority: RequestPriority.Interactive,
    initialCredits: 8
  }, body);
  const requestId = decodeFrame(frames[0]!).requestId;

  internal.onFrame(
    encodeFrame(FrameType.ReqCredit, requestId, encodeCreditPayload(17)).buffer as ArrayBuffer,
    channel
  );
  await uploading;

  assert.deepEqual(frames.map((frame) => decodeFrame(frame).type), [
    FrameType.Req,
    FrameType.Cancel
  ]);
  assert.equal(posted[0]?.t, "err");
  assert.match(posted[0]?.t === "err" ? posted[0].message : "", /credit exceeded/);
});

test("an upload source error cancels the partially sent request and releases its state", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = channel;
  internal.channels = [channel];
  const frames: Uint8Array[] = [];
  const posted: PageToSw[] = [];
  internal.send = (frame) => frames.push(frame);
  internal.post = (message) => posted.push(message);
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array(MAX_PAYLOAD_BYTES));
      } else {
        controller.error(new Error("source exploded"));
      }
    }
  }, { highWaterMark: 0 });

  const uploading = internal.startRequest(34, {
    version: PROTOCOL_VERSION,
    method: "POST",
    url: "/apiv2/upload",
    headers: [],
    hasBody: true,
    priority: RequestPriority.Interactive,
    initialCredits: 8
  }, body);
  const requestId = decodeFrame(frames[0]!).requestId;

  internal.onFrame(
    encodeFrame(FrameType.ReqCredit, requestId, encodeCreditPayload(2)).buffer as ArrayBuffer,
    channel
  );
  await uploading;

  assert.deepEqual(frames.map((frame) => decodeFrame(frame).type), [
    FrameType.Req,
    FrameType.ReqBody,
    FrameType.Cancel
  ]);
  assert.equal(posted[0]?.t, "err");
  assert.match(posted[0]?.t === "err" ? posted[0].message : "", /source exploded/);
  assert.equal(internal.requestBySw.size, 0);
  assert.equal(internal.requestAbortControllers.size, 0);
  assert.equal(internal.uploads.size, 0);
});

test("a channel which never opens is closed and rejected at the bounded timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}3`);
  const opening = internal.prepareChannel(channel, 3);

  t.mock.timers.tick(15_000);

  await assert.rejects(opening, /open timed out/);
  assert.equal(channel.readyState, "closed");
});

test("a fetch cancelled while bulk lanes open never starts on the wire", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const primary = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = primary;
  internal.channels = [primary];

  let finishOpening!: () => void;
  internal.ensureBulkChannels = () => new Promise<void>((resolve) => {
    finishOpening = resolve;
  });
  const frames: Uint8Array[] = [];
  internal.send = (frame) => frames.push(frame);

  internal.onSwMessage({
    t: "req",
    id: 29,
    head: {
      version: PROTOCOL_VERSION,
      method: "GET",
      url: "/cancelled-cover.png",
      headers: [],
      hasBody: false,
      priority: RequestPriority.Normal,
      initialCredits: 8
    }
  });
  await Promise.resolve();
  internal.onSwMessage({ t: "cancel", id: 29 });
  finishOpening();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(frames, []);
  assert.equal(internal.requestBySw.has(29), false);
});

test("transport teardown tombstones requests still waiting for bulk lanes", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const primary = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = primary;
  internal.channels = [primary];

  let finishOpening!: () => void;
  internal.ensureBulkChannels = () => new Promise<void>((resolve) => {
    finishOpening = resolve;
  });
  const frames: Uint8Array[] = [];
  internal.send = (frame) => frames.push(frame);
  internal.onSwMessage({
    t: "req",
    id: 30,
    head: {
      version: PROTOCOL_VERSION,
      method: "GET",
      url: "/abandoned-game.bin",
      headers: [],
      hasBody: false,
      priority: RequestPriority.Bulk,
      initialCredits: 8
    }
  });
  await Promise.resolve();
  internal.teardown("test transport loss");
  finishOpening();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(frames, []);
  assert.equal(internal.requestBySw.has(30), false);
});

test("cancelling a direct response sends CANCEL and releases its collector", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.channel = channel;
  const frames: Uint8Array[] = [];
  internal.send = (frame) => frames.push(frame);
  internal.startRequest = async (swId) => {
    const requestId = 81;
    internal.requestBySw.set(swId, requestId);
    internal.swByRequest.set(requestId, swId);
    internal.inbound.set(requestId, { swId, channel });
    internal.outbound.set(requestId, { credit: 64 });
    internal.direct.get(swId)?.({
      t: "head",
      id: swId,
      head: { status: 200, statusText: "OK", headers: [] }
    });
  };

  const response = await client.request("/long-stream");
  await response.body?.cancel();

  assert.equal(decodeFrame(frames.at(-1)!).type, FrameType.Cancel);
  assert.equal(internal.direct.size, 0);
  assert.equal(internal.requestBySw.size, 0);
});

test("transport teardown rejects a direct request still waiting for its head", async () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  internal.channel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  internal.startRequest = async () => undefined;

  const response = client.request("/never-answers");
  await Promise.resolve();
  internal.teardown("test disconnect");

  await assert.rejects(response, /transport disconnected/);
  assert.equal(internal.direct.size, 0);
});

test("response data beyond the granted window is cancelled instead of queued", () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const requestId = 41;
  const swId = 7;
  const fakeChannel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
  const posted: PageToSw[] = [];
  const frames: Uint8Array[] = [];
  const state = { credit: 1 };

  internal.requestBySw.set(swId, requestId);
  internal.swByRequest.set(requestId, swId);
  internal.inbound.set(requestId, { swId, channel: fakeChannel });
  internal.outbound.set(requestId, state);
  internal.post = (message) => posted.push(message);
  internal.send = (frame) => frames.push(frame);

  internal.onFrame(
    encodeFrame(FrameType.ResBody, requestId, Uint8Array.of(1)).buffer as ArrayBuffer,
    fakeChannel
  );
  internal.onFrame(
    encodeFrame(FrameType.ResBody, requestId, Uint8Array.of(2)).buffer as ArrayBuffer,
    fakeChannel
  );

  assert.deepEqual(posted.map((message) => message.t), ["body", "err"]);
  assert.match(posted[1]?.t === "err" ? posted[1].message : "", /exceeded.*credit/i);
  assert.deepEqual(frames.map((frame) => decodeFrame(frame).type), [FrameType.Cancel]);
  assert.equal(internal.outbound.has(requestId), false, "failed response state must be released");
  assert.equal(internal.requestBySw.has(swId), false, "SW/request mapping must be released");
});

test("malformed response metadata cancels and releases its request", () => {
  for (const [type, expected] of [
    [FrameType.ResHead, /invalid response head/],
    [FrameType.ResErr, /invalid response error/]
  ] as const) {
    const client = new YuriRTCClient(CONFIG);
    const internal = client as unknown as ClientInternals;
    const requestId = type;
    const swId = type + 100;
    const fakeChannel = fakeDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, "open");
    const posted: PageToSw[] = [];
    const sent: Uint8Array[] = [];

    internal.requestBySw.set(swId, requestId);
    internal.swByRequest.set(requestId, swId);
    internal.inbound.set(requestId, { swId, channel: fakeChannel });
    internal.outbound.set(requestId, { credit: 1 });
    internal.post = (message) => posted.push(message);
    internal.send = (frame) => sent.push(frame);

    internal.onFrame(
      encodeFrame(type, requestId, Uint8Array.of(0x7b)).buffer as ArrayBuffer,
      fakeChannel
    );

    assert.equal(posted.length, 1);
    assert.match(posted[0]?.t === "err" ? posted[0].message : "", expected);
    assert.deepEqual(sent.map((frame) => decodeFrame(frame).type), [FrameType.Cancel]);
    assert.equal(internal.inbound.has(requestId), false);
    assert.equal(internal.outbound.has(requestId), false);
    assert.equal(internal.requestBySw.has(swId), false);
    assert.equal(internal.swByRequest.has(requestId), false);
  }
});

test("response demand is forwarded to a flow-controlled content node", () => {
  const client = new YuriRTCClient(CONFIG);
  const internal = client as unknown as ClientInternals;
  const requestId = 52;
  const swId = 8;
  const frames: Uint8Array[] = [];
  const posted: PageToSw[] = [];

  internal.requestBySw.set(swId, requestId);
  internal.outbound.set(requestId, { credit: 0 });
  internal.send = (frame) => frames.push(frame);
  internal.post = (message) => posted.push(message);

  internal.onSwMessage({ t: "credit", id: swId, n: 3 });

  assert.deepEqual(posted, []);
  assert.equal(frames.length, 1);
  const credit = decodeFrame(frames[0]!);
  assert.equal(credit.type, FrameType.Credit);
  assert.equal(credit.requestId, requestId);
  assert.equal(new DataView(credit.payload.buffer).getUint32(0, false), 3);
});
