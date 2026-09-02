/**
 * Page-side YuriRTC transport.
 *
 * Owns the `RTCPeerConnection` — which does not exist in the SW — plus the wire
 * protocol and the data channel. The SW sends semantic requests over a
 * `MessageChannel` and this turns them into frames.
 *
 * ICE does the UDP-then-TCP choice on its own: the node advertises a host
 * candidate per protocol and RFC 6544 ranks TCP below UDP, so the best working
 * pair wins with no logic here.
 */

import {
  FrameType,
  MAX_REQUEST_CREDITS,
  MAX_RESPONSE_CREDITS,
  PROTOCOL_VERSION,
  RequestPriority,
  createRequestIdSource,
  decodeCreditPayload,
  decodeFrameView,
  decodeJsonPayload,
  encodeCreditPayload,
  encodeFrame,
  encodeFrameChunks,
  encodeJsonFrame,
  MAX_PAYLOAD_BYTES,
  MAX_WS_CREDITS,
  WS_CLOSE_CARRIER_LOST,
  decodeWebSocketClose,
  decodeWebSocketData,
  type RequestHead,
  type ResponseHead,
  type WebSocketOpen,
  type WebSocketOpened
} from "@yurirtc/protocol";
import { CarriedWebSocket } from "./websocket.js";
import {
  FirestoreBackend,
  RtdbBackend,
  raceBackends,
  randomId,
  type AnswerBlob,
  type OfferBlob,
  type SignalBackend
} from "@yurirtc/signaling";
import {
  WORKER_ATTACH_ACK_TIMEOUT_MS,
  WORKER_BOOTSTRAP_TIMEOUT_MS,
  responseCanHaveBody,
  responseHeaders,
  type PageToSw,
  type SwToPage
} from "./bridge.js";
import { clientUrls } from "./sources.js";
import type { YuriRTCConfig } from "./config.js";
import type { InjectedBootstrap } from "./inject.js";
import { isIncrementalAsset, requestPriority } from "./routing.js";
import {
  WORKER_UPGRADE_GRACE_MS,
  WorkerProtocolMismatchError,
  isCurrentWorkerProtocol,
  waitForActivatedWorker
} from "./worker-rollout.js";
import {
  ResponseGoodputMonitor,
  forceAnswerTransport
} from "./adaptive-transport.js";

/** Keep two MiB queued for throughput, then resume at one MiB to avoid churn. */
const BUFFER_HIGH_WATER = 2 * 1024 * 1024;
const BUFFER_LOW_WATER = 1 * 1024 * 1024;
/** ICE gathering can hang forever if a candidate source is unreachable. */
const GATHER_TIMEOUT_MS = 2_000;
/** Bound a route that gathers/signals but can never open SCTP. */
const CHANNEL_OPEN_TIMEOUT_MS = 15_000;
/** Ignore brief consent-check/network-handoff blips, then reconnect. */
const ICE_DISCONNECT_GRACE_MS = 12_000;
/** One latency-sensitive lane plus three parallel static/bulk lanes. */
export const DATA_CHANNEL_COUNT = 4;
export const DATA_CHANNEL_LABEL_PREFIX = "yuriRTC-v3/";
/** Reclaim Pion's per-lane receive buffers once an asset waterfall is over. */
const BULK_LANE_IDLE_MS = 15_000;
/**
 * Messages consumed before credit for them is handed back.
 *
 * A quarter of the window, the same fraction request-body credit uses. One
 * frame per message would double the sends on a socket that carries every
 * proxied request in the session.
 */
const WS_CREDIT_BATCH = Math.max(1, Math.floor(MAX_WS_CREDITS / 4));

interface Outbound {
  credit: number;
}

interface UploadCreditWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  removeAbort: () => void;
}

interface UploadFlow {
  credits: number;
  waiter: UploadCreditWaiter | undefined;
}

interface UploadPayload {
  parts: Uint8Array[];
}

interface AttachWaiter {
  generation: number;
  worker: ServiceWorker;
  port: MessagePort;
  bootstrap: InjectedBootstrap;
  completing: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AttachOperation {
  generation: number;
  promise: Promise<void>;
}

interface StartingRequest {
  cancelled: boolean;
}

interface LaneWaiter {
  head: RequestHead;
  starting: StartingRequest;
  resolve: (channel: RTCDataChannel | null) => void;
}

interface QueuedWorkerWake {
  generation: number;
  worker: ServiceWorker | undefined;
}

export interface ConnectionDiagnostics {
  /** Coarse route only; raw candidates, addresses, and ports stay private. */
  route: {
    transport: "udp" | "tcp" | "unknown";
    portClass: "standard" | "443" | "unknown";
  };
  signalBackend: string;
  signalElapsedMs: number;
}

export interface ConnectionOptions {
  /** Restrict the node's remote ICE candidates for this connection attempt. */
  transport?: "auto" | "tcp";
}

export class YuriRTCClient {
  private pc: RTCPeerConnection | null = null;
  private channels: RTCDataChannel[] = [];
  /** Primary lane retained as an internal compatibility seam for unit tests. */
  private channel: RTCDataChannel | null = null;
  private port: MessagePort | null = null;
  private readonly nextRequestId = createRequestIdSource();
  private readonly inbound = new Map<number, { swId: number; channel: RTCDataChannel }>();
  private readonly outbound = new Map<number, Outbound>();
  /** Websockets carried over the transport, keyed by their requestId. */
  private readonly sockets = new Map<number, { socket: CarriedWebSocket; channel: RTCDataChannel; consumed: number }>();
  private readonly swByRequest = new Map<number, number>();
  private readonly requestBySw = new Map<number, number>();
  /** Wakes an upload blocked on SCTP backpressure when its fetch is cancelled. */
  private readonly requestAbortControllers = new Map<number, AbortController>();
  /** Node-granted request-body slots; one waiter exists per streaming upload. */
  private readonly uploads = new Map<number, UploadFlow>();
  /** Requests can be cancelled while lazy bulk lanes are still opening. */
  private readonly startingRequests = new Map<number, StartingRequest>();
  /** SW-less request collectors, keyed by negative id. See request(). */
  private readonly direct = new Map<number, (m: PageToSw) => void>();
  private nextDirectId = -1;
  private attachWaiter: AttachWaiter | undefined;
  /** Coalesces wake messages across the full mismatch/update/bootstrap retry. */
  private attachOperation: AttachOperation | undefined;
  /** Kept so the port can be re-offered when the worker asks. */
  private registration: ServiceWorkerRegistration | undefined;
  private listeningForWorkerWake = false;
  private reattaching: { generation: number } | null = null;
  /** A newer discovery round that raced an attachment/standby message. */
  private queuedWorkerWake: QueuedWorkerWake | null = null;
  private transportDown = false;
  private connectionGeneration = 0;
  private iceDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly channelLoads = new Map<RTCDataChannel, number>();
  private readonly laneWaiters: LaneWaiter[] = [];
  private readonly channelOpenPromises = new Map<RTCDataChannel, Promise<void>>();
  private bulkOpening: Promise<void> | null = null;
  private bulkIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly disconnectListeners = new Set<(reason: string) => void>();
  private readonly adaptiveTcpListeners = new Set<() => void>();
  private readonly drainedListeners = new Set<() => void>();
  private readonly responseGoodput: ResponseGoodputMonitor;
  private readonly adaptiveTcpEnabled: boolean;
  private adaptiveTcpPending = false;
  /** Public calls on a boot() result follow the currently promoted route. */
  private successor: YuriRTCClient | null = null;
  /** A warmed successor returns SW responses through the original single port. */
  private bridgeOutput: ((message: PageToSw, transfer?: Transferable[]) => void) | null = null;

  /** A restarted worker has no private port, so its wake-up arrives globally. */
  private readonly onServiceWorkerMessage = (event: MessageEvent): void => {
    const message = event.data as SwToPage | undefined;
    if (message?.t !== "wake") return;
    // An activated upgrade can coexist with pages still controlled by its
    // predecessor. Accept discovery only from this page's exact controller (or
    // the active worker during the narrow first-control window), then reattach
    // to that same worker rather than whichever version registration.active
    // may expose by the time this task runs.
    const controller = navigator.serviceWorker.controller;
    const worker = controller ?? this.registration?.active;
    if (!worker || event.source !== worker) return;
    this.onSwMessage(message, worker);
  };

  /** Let the worker discard this port before the browser silently destroys it. */
  private readonly onPageHide = (): void => {
    this.post({ t: "down", reason: "carrier page unloaded" });
  };

  constructor(
    private readonly config: YuriRTCConfig,
    /** Canonical static shell path; injected pages may only forward the persisted value. */
    private readonly shellPath?: string
  ) {
    const adaptive = config.transport?.adaptiveTcp;
    this.adaptiveTcpEnabled = adaptive?.enabled !== false;
    this.responseGoodput = new ResponseGoodputMonitor(adaptive);
  }

  /** Receives one coalesced callback when the peer's transport becomes terminal. */
  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /**
   * Reports one evidence-based TCP recommendation as soon as a sustained slow
   * UDP sample is known. The owner may warm a replacement without interrupting
   * work already assigned to this route.
   */
  onAdaptiveTcpSuggested(listener: () => void): () => void {
    this.adaptiveTcpListeners.add(listener);
    if (this.adaptiveTcpPending) queueMicrotask(listener);
    return () => this.adaptiveTcpListeners.delete(listener);
  }

  /** Runs when this exact route has no HTTP starts, responses, or sockets. */
  onDrained(listener: () => void): () => void {
    this.drainedListeners.add(listener);
    if (!this.hasActiveWork()) queueMicrotask(listener);
    return () => this.drainedListeners.delete(listener);
  }

  /** Keep an object returned by boot() useful after its transport is promoted. */
  adoptSuccessor(successor: YuriRTCClient): void {
    if (successor === this) return;
    this.successor = successor;
    successor.bridgeOutput = (message, transfer = []) => this.post(message, transfer);
    successor.onDisconnect((reason) => {
      if (this.successor !== successor) return;
      for (const listener of this.disconnectListeners) listener(reason);
    });
  }

  /**
   * Establishes the peer connection.
   *
   * `registration` is optional: without it the client is usable directly via
   * `request()` and never touches a service worker. That is what makes a
   * single-file diagnostic page possible — a SW script must be same-origin and
   * cannot be inlined, but the transport itself has no such constraint.
  */
  async connect(
    registration?: ServiceWorkerRegistration,
    options: ConnectionOptions = {}
  ): Promise<ConnectionDiagnostics> {
    if (this.successor) return this.successor.connect(registration, options);
    if (this.pc) this.close();
    const generation = ++this.connectionGeneration;
    this.reattaching = null;
    this.queuedWorkerWake = null;
    if (generation !== this.connectionGeneration) {
      throw new Error("connection attempt superseded");
    }
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    this.transportDown = false;
    this.clearIceDisconnectTimer();

    try {
      // Pion retains a receive buffer for every open channel. Keeping four eager
      // lanes would consume roughly 5 GiB at 20k idle peers, so only lane zero is
      // negotiated up front. The three asset lanes open on the first waterfall
      // and are reclaimed after it becomes idle.
      const channel = pc.createDataChannel(`${DATA_CHANNEL_LABEL_PREFIX}0`, { ordered: true });
      this.channels = [channel];
      this.channel = channel;
      const opened = this.prepareChannel(channel, 0, generation);

      pc.oniceconnectionstatechange = () =>
        this.handleIceConnectionState(pc, generation);

      const offer = await pc.createOffer();
      this.assertCurrent(pc, generation);
      await pc.setLocalDescription(offer);
      await gatherCandidates(pc);
      this.assertCurrent(pc, generation);

      const sessionId = randomId(16);
      const blob: OfferBlob = {
        sessionId,
        sdp: pc.localDescription?.sdp ?? offer.sdp ?? "",
        // Non-trickle gathering has already placed every candidate in the
        // completed SDP. Repeating them as JSON made each offer substantially
        // larger without adding a route; old nodes already consume SDP first.
        candidates: []
      };

      const result = await raceBackends(this.backends(), blob, {
        // RTDB is a resilience leg, not routine duplicate work. A healthy
        // Firestore exchange normally finishes before this window; an actual
        // Firestore failure still launches RTDB immediately in raceBackends.
        hedgeDelayMs: this.config.signal.hedgeDelayMs ?? 4_000,
        onLegFailure: (name) => console.warn(`[YuriRTC] signal leg ${name} failed`)
      });
      this.assertCurrent(pc, generation);
      await this.applyAnswer(pc, result.answer, options.transport ?? "auto");
      await opened;
      this.assertCurrent(pc, generation);

      // Establish all SCTP streams before the first application waterfall. The
      // lanes remain one association/cwnd, but separate ordered streams prevent
      // a large incremental asset from head-of-line blocking small critical
      // files. Idle retirement still bounds long-lived node memory.
      await this.ensureBulkChannels();
      this.assertCurrent(pc, generation);

      if (registration) {
        await this.attach(registration, generation);
        this.assertCurrent(pc, generation);
      }
      const route = await selectedPair(pc);
      this.assertCurrent(pc, generation);
      if (this.transportDown) throw new Error("transport closed while connecting");
      this.responseGoodput.setTransport(route.route.transport);
      return { ...route, signalBackend: result.backend, signalElapsedMs: result.elapsedMs };
    } catch (error) {
      if (this.isCurrent(pc, generation)) {
        this.teardown("connection attempt failed");
        this.releaseConnection(pc, generation);
      }
      throw error;
    }
  }

  /** Attach an already-open route after a bounded probe or background warm-up. */
  async attach(
    registration: ServiceWorkerRegistration,
    generation = this.connectionGeneration
  ): Promise<void> {
    if (!this.transportIsOpen() || generation !== this.connectionGeneration) {
      throw new Error("transport is not open");
    }
    this.registration = registration;
    if (!this.listeningForWorkerWake) {
      navigator.serviceWorker.addEventListener("message", this.onServiceWorkerMessage);
      window.addEventListener("pagehide", this.onPageHide);
      this.listeningForWorkerWake = true;
    }
    await this.attachToServiceWorker(registration, generation);
  }

  private backends(): SignalBackend[] {
    const { apiKey, projectId, databaseUrl } = this.config.firebase;
    return [
      new FirestoreBackend({ projectId, ...this.config.signal.firestore }),
      new RtdbBackend({ apiKey, databaseUrl, ...this.config.signal.rtdb })
    ];
  }

  private handleIceConnectionState(
    pc: Pick<RTCPeerConnection, "iceConnectionState">,
    generation = this.connectionGeneration
  ): void {
    if (this.pc !== pc || generation !== this.connectionGeneration) return;
    const state = pc.iceConnectionState;
    if (state === "disconnected") {
      // Browsers enter disconnected briefly during consent checks and network
      // handoffs. Preserve streams during that grace, but do not wait forever
      // on Chrome builds which never advance the state to failed.
      if (this.iceDisconnectTimer === null) {
        this.iceDisconnectTimer = setTimeout(() => {
          this.iceDisconnectTimer = null;
          if (
            this.pc === pc &&
            generation === this.connectionGeneration &&
            pc.iceConnectionState === "disconnected"
          ) {
            this.teardown("ice disconnected");
          }
        }, ICE_DISCONNECT_GRACE_MS);
        (this.iceDisconnectTimer as unknown as { unref?: () => void }).unref?.();
      }
      return;
    }
    this.clearIceDisconnectTimer();
    if (state === "failed" || state === "closed") {
      this.teardown(`ice ${state}`);
    }
  }

  private async applyAnswer(
    pc: RTCPeerConnection,
    answer: AnswerBlob,
    transport: "auto" | "tcp"
  ): Promise<void> {
    const selected = transport === "tcp" ? forceAnswerTransport(answer, "tcp") : answer;
    await pc.setRemoteDescription({ type: "answer", sdp: selected.sdp });
    for (const candidate of selected.candidates) {
      if (!candidate.candidate) continue;
      await pc.addIceCandidate(candidate).catch(() => {
        // Candidate strings contain server addresses. Never include the RTC
        // error object in a page-visible console message.
        console.warn("[YuriRTC] a remote candidate was rejected");
      });
    }
  }

  private attachToServiceWorker(
    registration: ServiceWorkerRegistration,
    generation = this.connectionGeneration
  ): Promise<void> {
    const current = this.attachOperation;
    if (current?.generation === generation) return current.promise;

    const operation = this.performServiceWorkerAttach(registration, generation);
    const tracked = operation.finally(() => {
      if (this.attachOperation?.promise === tracked) this.attachOperation = undefined;
      this.replayQueuedWorkerWake(generation);
    });
    this.attachOperation = { generation, promise: tracked };
    return tracked;
  }

  private async performServiceWorkerAttach(
    registration: ServiceWorkerRegistration,
    generation: number
  ): Promise<void> {
    if (generation !== this.connectionGeneration) {
      throw new Error("connection attempt superseded");
    }

    const deadline = Date.now() + WORKER_UPGRADE_GRACE_MS;
    const active = registration.active ?? navigator.serviceWorker.controller;
    const replacement = registration.installing ?? registration.waiting;
    // If registration already exposes an update, do not probe the old worker at
    // all: even a rejected MessagePort temporarily replaces an existing carrier. Wait
    // for the distinct worker we actually intend to use.
    let worker = replacement && replacement !== active
      ? await waitForActivatedWorker(registration, active, WORKER_UPGRADE_GRACE_MS)
      : active;
    for (;;) {
      if (!worker) {
        worker = await waitForActivatedWorker(
          registration,
          null,
          Math.max(0, deadline - Date.now())
        );
      }
      if (generation !== this.connectionGeneration) {
        throw new Error("connection attempt superseded");
      }
      try {
        await this.attachPortToWorker(worker, generation);
        return;
      } catch (error) {
        if (!(error instanceof WorkerProtocolMismatchError)) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw error;
        // `ready` may still refer to an older-protocol worker while the @latest one installs.
        // Wait for that distinct worker, then perform a fresh versioned
        // handshake. No request is allowed through the mismatched port.
        worker = await waitForActivatedWorker(registration, worker, remaining);
      }
    }
  }

  private attachPortToWorker(
    worker: ServiceWorker,
    generation: number
  ): Promise<void> {
    // Exact-worker WAKE reattachment is scheduled in a microtask. A reconnect
    // or teardown can supersede it before that task runs; reject before closing
    // or replacing any state owned by the newer connection.
    if (generation !== this.connectionGeneration || this.transportDown) {
      return Promise.reject(new Error("connection attempt superseded"));
    }
    this.port?.close();
    this.rejectAttachWaiter(new Error("service worker attachment replaced"));
    const channel = new MessageChannel();
    this.port = channel.port1;
    channel.port1.onmessage = (event: MessageEvent<SwToPage>) => {
      // Closing a MessagePort does not discard tasks already queued from it.
      // A late older-protocol acknowledgement must not reject a newer retry.
      if (this.port === channel.port1) this.onSwMessage(event.data);
    };
    channel.port1.start();
    // A bundled carrier supplies a durable same-origin source first. The URL
    // this copy loaded from follows for ordinary CDN builds; for an inline
    // Blob it is intentionally only a fallback because that URL may be revoked
    // as soon as the first import completes.
    const here = new URL(import.meta.url).href;
    const urls = [...new Set([
      ...(this.config.recovery?.clientUrls ?? []),
      here,
      ...clientUrls()
    ])];
    const bootstrap: InjectedBootstrap = {
      clientUrls: urls,
      config: this.config,
      ...(this.shellPath ? { shellPath: this.shellPath } : {})
    };
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.attachWaiter;
        if (!waiter || waiter.generation !== generation || waiter.port !== channel.port1) return;
        this.closeRejectedAttach(waiter, "service worker attachment timed out");
        this.rejectAttachWaiter(new Error("service worker attachment timed out"));
      }, WORKER_ATTACH_ACK_TIMEOUT_MS);
      this.attachWaiter = {
        generation,
        worker,
        port: channel.port1,
        bootstrap,
        completing: false,
        resolve,
        reject,
        timer
      };
    });

    try {
      worker.postMessage(
        {
          t: "attach",
          protocolVersion: PROTOCOL_VERSION
        },
        [channel.port2]
      );
    } catch (error) {
      const waiter = this.attachWaiter;
      if (waiter?.port === channel.port1) {
        this.closeRejectedAttach(waiter, "service worker attachment failed");
        this.rejectAttachWaiter(
          error instanceof Error ? error : new Error("service worker attachment failed")
        );
      }
    }
    return acknowledged;
  }

  private post(message: PageToSw, transfer: Transferable[] = []): void {
    // Direct requests carry negative ids so they never collide with the SW's,
    // and are routed to a local collector instead of over the port.
    if ("id" in message && message.id < 0) {
      this.direct.get(message.id)?.(message);
      return;
    }
    if (this.bridgeOutput) {
      this.bridgeOutput(message, transfer);
      return;
    }
    this.port?.postMessage(message, transfer);
  }

  /**
   * Performs one request over the data channel without a service worker.
   *
   * Returns a real `Response`, so callers can `.text()`, `.json()`, or stream
   * it exactly as they would a normal fetch — the point being that the app
   * cannot tell the difference, which is the transport's central contract.
   */
  async request(url: string, init: {
    method?: string;
    headers?: HeadersInit;
    /** Internal diagnostics may start with a one-frame window for a fair barrier. */
    initialCredits?: number;
  } = {}): Promise<Response> {
    if (this.successor) return this.successor.request(url, init);
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") throw new Error("data channel not open");

    const id = this.nextDirectId--;
    const target = new URL(url, "http://placeholder");
    const method = init.method ?? "GET";
    const priority = requestPriority({
      method,
      logicalPath: target.pathname
    });
    const head: RequestHead = {
      version: PROTOCOL_VERSION,
      method,
      url: target.pathname + target.search,
      headers: [...new Headers(init.headers ?? {}).entries()],
      hasBody: false,
      priority,
      // Direct mode is diagnostic-only and has no service-worker pull signal.
      // Keep one bounded maximum window and replenish as frames are delivered.
      initialCredits:
        Number.isInteger(init.initialCredits) &&
        init.initialCredits! > 0 &&
        init.initialCredits! <= MAX_RESPONSE_CREDITS
          ? init.initialCredits!
          : MAX_RESPONSE_CREDITS
    };

    let onHead!: (h: ResponseHead) => void;
    let onFail!: (e: Error) => void;
    const headReady = new Promise<ResponseHead>((resolve, reject) => {
      onHead = resolve;
      onFail = reject;
    });

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let canHaveBody = true;
    let bodyFinished = false;
    let directEnded = false;
    let directWaiting = false;
    let directReleased = 0;
    const directQueue: Uint8Array[] = [];
    const flushDirectCredit = (force = false): void => {
      if (directReleased === 0 || directEnded) return;
      if (!force && directReleased < 16) return;
      this.onSwMessage({ t: "credit", id, n: directReleased });
      directReleased = 0;
    };
    const releaseDirectCredit = (): void => {
      directReleased += 1;
      flushDirectCredit();
    };
    const closeBody = (): void => {
      if (bodyFinished) return;
      if (!directEnded || directQueue.length > 0) return;
      bodyFinished = true;
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    };
    const cancelDirect = (): void => {
      directQueue.length = 0;
      directEnded = true;
      bodyFinished = true;
      this.direct.delete(id);
      this.cancelRequest(id);
    };
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      pull: () => {
        const chunk = directQueue.shift();
        if (chunk) {
          controller.enqueue(chunk);
          releaseDirectCredit();
          closeBody();
          return;
        }
        if (directEnded) {
          closeBody();
          return;
        }
        directWaiting = true;
        // A partial batch must not leave an empty consumer behind a zero-credit
        // node window.
        flushDirectCredit(true);
      },
      cancel: cancelDirect
    });

    this.direct.set(id, (message) => {
      switch (message.t) {
        case "head":
          canHaveBody = responseCanHaveBody(head.method, message.head.status);
          if (!canHaveBody) {
            directEnded = true;
            closeBody();
          }
          onHead(message.head);
          break;
        case "body":
          if (canHaveBody && !bodyFinished) {
            const byteOffset = message.byteOffset ?? 0;
            const byteLength = message.byteLength ?? message.chunk.byteLength;
            const chunk = new Uint8Array(message.chunk, byteOffset, byteLength);
            if (directWaiting) {
              directWaiting = false;
              controller.enqueue(chunk);
              releaseDirectCredit();
            } else {
              directQueue.push(chunk);
            }
          }
          break;
        case "end":
          this.direct.delete(id);
          directEnded = true;
          closeBody();
          break;
        case "err":
          this.direct.delete(id);
          directQueue.length = 0;
          directEnded = true;
          onFail(new Error(message.message));
          if (!bodyFinished) {
            bodyFinished = true;
            try {
              controller.error(new Error(message.message));
            } catch {
              /* already errored */
            }
          }
          break;
      }
    });

    // Direct mode is deliberately not used for the content library, but it still
    // replenishes v3 response credits only as the returned stream is consumed.
    await this.startRequest(id, head, undefined);
    const responseHead = await headReady;
    if (responseHead.status < 200 || responseHead.status > 599) {
      this.direct.delete(id);
      directEnded = true;
      closeBody();
      this.cancelRequest(id);
      throw new Error(`unsupported HTTP response status: ${responseHead.status}`);
    }

    return new Response(canHaveBody ? body : null, {
      status: responseHead.status,
      statusText: responseHead.statusText,
      headers: responseHeaders(responseHead.headers)
    });
  }

  private onSwMessage(message: SwToPage, wakeWorker?: ServiceWorker): void {
    switch (message.t) {
      case "req": {
        const route = this.successor ?? this;
        void route.startRequest(message.id, message.head, message.body);
        break;
      }
      case "credit": {
        const requestId = this.requestBySw.get(message.id);
        if (requestId === undefined) {
          this.successor?.onSwMessage(message);
          return;
        }
        const state = this.outbound.get(requestId);
        if (!state) return;
        if (
          !Number.isInteger(message.n) ||
          message.n <= 0 ||
          message.n > MAX_RESPONSE_CREDITS ||
          state.credit > MAX_RESPONSE_CREDITS - message.n
        ) {
          this.failRequest(requestId, "invalid response credit grant");
          return;
        }
        state.credit += message.n;
        // Propagate browser demand to the v3 content node on the request's
        // originating SCTP lane.
        try {
          const requestChannel = this.inbound.get(requestId)?.channel;
          this.send(responseCreditFrame(requestId, message.n), requestChannel);
        } catch (error) {
          this.post({ t: "err", id: message.id, message: String(error) });
          this.finish(requestId);
          return;
        }
        break;
      }
      case "cancel": {
        if (this.requestBySw.has(message.id) || this.startingRequests.has(message.id)) {
          this.cancelRequest(message.id);
        } else {
          this.successor?.onSwMessage(message);
        }
        break;
      }
      case "attached": {
        const waiter = this.attachWaiter;
        if (!waiter || waiter.generation !== this.connectionGeneration) return;
        if (!isCurrentWorkerProtocol(message.protocolVersion)) {
          this.closeRejectedAttach(waiter, "service worker protocol mismatch");
          this.rejectAttachWaiter(new WorkerProtocolMismatchError());
          return;
        }
        if (waiter.completing) return;
        waiter.completing = true;
        clearTimeout(waiter.timer);
        waiter.timer = setTimeout(() => {
          if (this.attachWaiter !== waiter || this.port !== waiter.port) return;
          this.closeRejectedAttach(waiter, "service worker bootstrap timed out");
          this.rejectAttachWaiter(new Error("service worker bootstrap timed out"));
        }, 3_000);
        // A restarted worker begins allocating bridge ids from its own fresh
        // sequence. Retaining requests from the old worker would let a late
        // RTC response with the same SW id resolve or corrupt a new fetch. The
        // attached message is ordered before any REQ on this new port, so this
        // synchronous barrier safely retires all old bridge-owned work first.
        this.resetWorkerBridgeRequests(waiter.port, "service worker bridge restarted");
        // Bootstrap data contains this v3 bundle's recovery URLs. Persist it
        // only through a second message understood and acknowledged by v3;
        // sending it in the probe would let an older-protocol worker corrupt its own
        // recovery state before returning a mismatched acknowledgement.
        void this.completeWorkerAttach(waiter);
        break;
      }
      case "standby": {
        const waiter = this.attachWaiter;
        if (!waiter || waiter.generation !== this.connectionGeneration) return;
        if (!isCurrentWorkerProtocol(message.protocolVersion)) {
          this.closeRejectedAttach(waiter, "service worker protocol mismatch");
          this.rejectAttachWaiter(new WorkerProtocolMismatchError());
          return;
        }
        // This tab may have carried the worker that just restarted but lost the
        // new worker's first-responder election. Retire that dead bridge's RTC
        // work locally. Never report its ids through the winner's bridge: a
        // fresh SwBridge can already have reused the same positive numbers.
        this.retireWorkerBridgeRequests();
        clearTimeout(waiter.timer);
        this.attachWaiter = undefined;
        if (this.port === waiter.port) this.port = null;
        waiter.port.close();
        // Standby is a successful election outcome: keep RTC and the global
        // wake listener alive so this tab can take over if the winner exits.
        waiter.resolve();
        break;
      }
      case "wake":
        // The worker lost its port — it was restarted, or a document it was
        // serving went away. The connection here is still live, so hand the
        // port over again rather than leaving the worker with nothing to route
        // through. Without this, the next navigation falls through to whatever
        // hosts the loader, which on a bucket is a directory listing.
        if (!this.registration || !this.transportIsOpen()) break;
        if (this.attachOperation || this.reattaching) {
          // MessagePort and ServiceWorker messages use different task sources.
          // A newer WAKE can overtake the STANDBY response to an in-progress
          // election; retain it so the losing tab cannot miss the next round.
          this.queuedWorkerWake = {
            generation: this.connectionGeneration,
            worker: wakeWorker
          };
          break;
        }
        {
          const registration = this.registration;
          const reattach = { generation: this.connectionGeneration };
          this.reattaching = reattach;
          // attachToServiceWorker can throw before returning a Promise while a
          // worker update is swapping active/controller. Always clear the
          // coalescing flag so a later wake can retry.
          void Promise.resolve()
            .then(() => wakeWorker
              ? this.attachPortToWorker(wakeWorker, reattach.generation)
              : this.attachToServiceWorker(registration, reattach.generation))
            .catch(() => {
              if (
                this.reattaching !== reattach ||
                reattach.generation !== this.connectionGeneration
              ) return;
              console.warn("[YuriRTC] service worker reattach failed");
              this.teardown("service worker attachment failed");
            })
            .finally(() => {
              if (this.reattaching === reattach) this.reattaching = null;
              this.replayQueuedWorkerWake(reattach.generation);
            });
        }
        break;
    }
  }

  private async startRequest(
    swId: number,
    head: RequestHead,
    body?: ReadableStream<Uint8Array>
  ): Promise<void> {
    const starting: StartingRequest = { cancelled: false };
    // A new bridge may reuse an id while an old request is still awaiting lazy
    // lane creation. Supersede that specific start without letting its finally
    // block delete the replacement's tracking entry.
    const superseded = this.startingRequests.get(swId);
    if (superseded) superseded.cancelled = true;
    this.startingRequests.set(swId, starting);
    try {
      if (head.priority === RequestPriority.Critical) {
        // Render-blocking scripts, styles, fonts, and wasm must not wait a
        // DCEP round trip for the lazy bulk lanes after every idle period.
        // Kick the lanes open for the waterfall behind them, but send this
        // request on whatever is open now: chooseChannel uses the bulk lanes
        // once they exist and falls back to lane 0 while they are opening,
        // which is exactly the interactive window in which lane 0 is idle.
        void this.ensureBulkChannels().catch(() => undefined);
      } else if (head.priority !== RequestPriority.Interactive) {
        try {
          await this.ensureBulkChannels();
        } catch {
          if (!starting.cancelled) {
            this.post({ t: "err", id: swId, message: "asset transport lanes unavailable" });
          }
          return;
        }
      }
      if (starting.cancelled) return;
      const scheduled = this.acquireScheduledChannel(head, starting);
      const channel = scheduled instanceof Promise ? await scheduled : scheduled;
      if (starting.cancelled) {
        if (channel) this.releaseChannelReservation(channel);
        return;
      }
      if (!channel) {
        this.post({ t: "err", id: swId, message: "data channel not open" });
        return;
      }

      const requestId = this.nextRequestId();
      this.swByRequest.set(requestId, swId);
      this.requestBySw.set(swId, requestId);
      this.outbound.set(requestId, {
        credit: head.initialCredits
      });
      this.inbound.set(requestId, { swId, channel });
      this.responseGoodput.beginRequest(requestId, head.method);
      const requestAbort = new AbortController();
      this.requestAbortControllers.set(requestId, requestAbort);
      if (head.hasBody) this.uploads.set(requestId, { credits: 0, waiter: undefined });

      try {
        this.send(encodeJsonFrame(FrameType.Req, requestId, head), channel);
        if (body && head.hasBody) {
          await this.streamRequestBody(requestId, body, channel, requestAbort.signal);
        } else if (body) {
          await body.cancel("request metadata declared no body").catch(() => undefined);
          throw new Error("request body provided for a bodyless request");
        }
        // Cancellation interrupts credit waits, source reads, and RTC
        // backpressure. Therefore REQ_END can never follow CANCEL on the lane.
        if (head.hasBody && !requestAbort.signal.aborted) {
          this.uploads.delete(requestId);
          this.send(encodeFrame(FrameType.ReqEnd, requestId), channel);
        }
      } catch (error) {
        if (!requestAbort.signal.aborted) {
          try {
            this.send(encodeFrame(FrameType.Cancel, requestId), channel);
          } catch {
            /* a closed lane already abandoned the request */
          }
          this.post({ t: "err", id: swId, message: String(error) });
          this.finish(requestId);
        }
      }
    } finally {
      if (this.startingRequests.get(swId) === starting) {
        this.startingRequests.delete(swId);
      }
      this.maybeNotifyDrained();
    }
  }

  /**
   * Retires every request owned by the previous service-worker bridge before
   * the new port can reuse its numeric ids. Direct diagnostic requests use
   * negative ids and intentionally survive this reset.
   */
  private resetWorkerBridgeRequests(port: MessagePort, reason: string): void {
    const failedSwIds = this.retireWorkerBridgeRequests();
    for (const swId of failedSwIds) {
      try {
        port.postMessage({ t: "err", id: swId, message: reason } satisfies PageToSw);
      } catch {
        // Attachment failure will make the worker fail all pending requests.
        break;
      }
    }
  }

  /** Retires positive ids owned by a service worker, preserving direct calls. */
  private retireWorkerBridgeRequests(): Set<number> {
    const failedSwIds = new Set<number>();
    for (const [requestId, swId] of [...this.swByRequest]) {
      if (swId < 1) continue;
      failedSwIds.add(swId);
      const channel = this.inbound.get(requestId)?.channel;
      if (channel) {
        try {
          this.send(encodeFrame(FrameType.Cancel, requestId), channel);
        } catch {
          /* a closed lane has already abandoned this request */
        }
      }
      this.finish(requestId);
    }
    for (const [swId, starting] of this.startingRequests) {
      if (swId < 1) continue;
      starting.cancelled = true;
      failedSwIds.add(swId);
    }
    for (const id of this.successor?.retireWorkerBridgeRequests() ?? []) failedSwIds.add(id);
    return failedSwIds;
  }

  /**
   * Opens a websocket over the carrier.
   *
   * The page calls this instead of `new WebSocket(...)` when it is running on
   * the transport, because a service worker cannot intercept a handshake and
   * there is no origin server to reach directly. The node only dials the one
   * upstream it is configured for, so `url` is origin-relative like every
   * other address that crosses the carrier.
   */
  openWebSocket(url: string, protocols: string | string[] = []): CarriedWebSocket {
    if (this.successor) return this.successor.openWebSocket(url, protocols);
    const channel = this.chooseChannel(RequestPriority.Interactive);
    const requestId = this.nextRequestId();
    const list = typeof protocols === "string" ? (protocols ? [protocols] : []) : protocols;

    const socket = new CarriedWebSocket(url, requestId, {
      sendData: (id, payload) => this.send(encodeFrame(FrameType.WsData, id, payload), this.socketChannel(id)),
      sendClose: (id, payload) => this.send(encodeFrame(FrameType.WsClose, id, payload), this.socketChannel(id)),
      release: id => {
        this.sockets.delete(id);
        this.maybeNotifyDrained();
      }
    });

    if (!channel) {
      // Nothing to open on. Report it the way a failed connection is reported
      // rather than throwing out of a constructor-shaped call.
      queueMicrotask(() => socket.fail("data channel not open"));
      return socket;
    }

    this.sockets.set(requestId, { socket, channel, consumed: 0 });
    const open: WebSocketOpen = {
      version: PROTOCOL_VERSION,
      url,
      protocols: list,
      initialCredits: MAX_WS_CREDITS
    };
    try {
      this.send(encodeJsonFrame(FrameType.WsOpen, requestId, open), channel);
    } catch {
      this.sockets.delete(requestId);
      queueMicrotask(() => socket.fail("the carrier could not send"));
    }
    return socket;
  }

  /** Returns credit for consumed messages in batches rather than one at a time. */
  private replenishSocketCredit(requestId: number): void {
    const entry = this.sockets.get(requestId);
    if (!entry) return;
    entry.consumed += 1;
    if (entry.consumed < WS_CREDIT_BATCH) return;

    const amount = entry.consumed;
    entry.consumed = 0;
    try {
      this.send(encodeFrame(FrameType.Credit, requestId, encodeCreditPayload(amount)), entry.channel);
    } catch {
      // The socket is already going away; its close will follow.
    }
  }

  private socketChannel(requestId: number): RTCDataChannel | undefined {
    return this.sockets.get(requestId)?.channel;
  }

  /** Closes every carried socket when the transport goes away. */
  private failAllSockets(reason: string): void {
    const entries = [...this.sockets.values()];
    this.sockets.clear();
    for (const { socket } of entries) {
      socket.acceptClose(WS_CLOSE_CARRIER_LOST, reason, false);
    }
  }

  private onFrame(data: ArrayBuffer, source = this.channel): void {
    let frame;
    try {
      frame = decodeFrameView(data);
    } catch {
      console.warn("[YuriRTC] an undecodable transport frame was discarded");
      return;
    }

    // Websockets belong to the page, not the service worker, so they are routed
    // before the request bridge's own bookkeeping is consulted.
    const carried = this.sockets.get(frame.requestId);
    if (carried) {
      if (carried.channel !== source) return;
      this.onSocketFrame(frame, carried.socket);
      return;
    }

    const entry = this.inbound.get(frame.requestId);
    if (!entry || !source || entry.channel !== source) return;
    const swId = entry.swId;

    switch (frame.type) {
      case FrameType.ResHead: {
        let head: ResponseHead;
        try {
          head = decodeJsonPayload<ResponseHead>(frame);
        } catch {
          this.failRequest(frame.requestId, "invalid response head");
          return;
        }
        this.post({ t: "head", id: swId, head });
        break;
      }
      case FrameType.ResBody: {
        const state = this.outbound.get(frame.requestId);
        // The RTC message ArrayBuffer is ours. Transfer the complete frame to
        // the worker with payload bounds instead of copying 128 KiB merely to
        // remove the five-byte header.
        if (!state || state.credit <= 0) {
          this.failRequest(frame.requestId, "response exceeded its v3 credit grant");
          return;
        }
        state.credit -= 1;
        if (
          this.adaptiveTcpEnabled &&
          this.responseGoodput.recordBody(
            frame.requestId,
            frame.payload.byteLength,
            performance.now()
          )
        ) {
          this.adaptiveTcpPending = true;
          for (const listener of this.adaptiveTcpListeners) listener();
        }
        this.post(
          {
            t: "body",
            id: swId,
            chunk: data,
            byteOffset: frame.payload.byteOffset,
            byteLength: frame.payload.byteLength
          },
          [data]
        );
        break;
      }
      case FrameType.ResEnd:
        this.post({ t: "end", id: swId });
        this.finish(frame.requestId);
        break;
      case FrameType.ResErr: {
        let payload: { message?: string };
        try {
          payload = decodeJsonPayload<{ message?: string }>(frame);
        } catch {
          this.failRequest(frame.requestId, "invalid response error");
          return;
        }
        this.post({ t: "err", id: swId, message: payload.message ?? "node error" });
        this.finish(frame.requestId);
        break;
      }
      case FrameType.ReqCredit:
        this.grantUploadCredit(frame.requestId, frame.payload);
        break;
    }
  }

  /**
   * Routes one frame belonging to a carried socket.
   *
   * Every message consumed hands a credit straight back. A socket's window is
   * a standing allocation rather than one request's burst, so it has to keep
   * refilling or the node stops sending after the initial grant.
   */
  private onSocketFrame(frame: { type: FrameType; requestId: number; payload: Uint8Array }, socket: CarriedWebSocket): void {
    switch (frame.type) {
      case FrameType.WsOpened: {
        let opened: WebSocketOpened;
        try {
          opened = decodeJsonPayload<WebSocketOpened>({ ...frame });
        } catch {
          socket.fail("invalid websocket open");
          return;
        }
        socket.acceptOpen(typeof opened.protocol === "string" ? opened.protocol : "");
        break;
      }
      case FrameType.WsData: {
        let message;
        try {
          message = decodeWebSocketData(frame.payload);
        } catch {
          socket.fail("invalid websocket message");
          return;
        }
        socket.acceptMessage(message.kind, message.data);
        this.replenishSocketCredit(frame.requestId);
        break;
      }
      case FrameType.WsClose: {
        let close;
        try {
          close = decodeWebSocketClose(frame.payload);
        } catch {
          socket.acceptClose(WS_CLOSE_CARRIER_LOST, "", false);
          return;
        }
        socket.acceptClose(close.code, close.reason);
        break;
      }
      case FrameType.ResErr: {
        let payload: { message?: string };
        try {
          payload = decodeJsonPayload<{ message?: string }>({ ...frame });
        } catch {
          payload = {};
        }
        socket.fail(payload.message ?? "node error");
        break;
      }
    }
  }

  private grantUploadCredit(requestId: number, payload: Uint8Array): void {
    const state = this.uploads.get(requestId);
    if (!state) return;

    let count: number;
    try {
      count = decodeCreditPayload(payload);
    } catch {
      this.failRequest(requestId, "invalid request upload credit");
      return;
    }
    if (count > MAX_REQUEST_CREDITS || state.credits > MAX_REQUEST_CREDITS - count) {
      this.failRequest(requestId, "request upload credit exceeded its v3 window");
      return;
    }

    state.credits += count;
    const waiter = state.waiter;
    if (waiter) {
      state.waiter = undefined;
      waiter.removeAbort();
      waiter.resolve();
    }
  }

  private failRequest(requestId: number, message: string): void {
    const entry = this.inbound.get(requestId);
    if (!entry) return;
    try {
      this.send(encodeFrame(FrameType.Cancel, requestId), entry.channel);
    } catch {
      /* a closed lane already abandoned the request */
    }
    this.post({ t: "err", id: entry.swId, message });
    this.finish(requestId);
  }

  private async takeUploadCredit(requestId: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new Error("request upload cancelled");
      const state = this.uploads.get(requestId);
      if (!state) throw new Error("request upload cancelled");
      if (state.credits > 0) {
        state.credits -= 1;
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          if (state.waiter !== waiter) return;
          state.waiter = undefined;
          reject(new Error("request upload cancelled"));
        };
        const waiter: UploadCreditWaiter = {
          resolve,
          reject,
          removeAbort: () => signal.removeEventListener("abort", onAbort)
        };
        state.waiter = waiter;
        signal.addEventListener("abort", onAbort, { once: true });

        // Re-check after installing the waiter. This also makes direct unit-test
        // grants safe if they synchronously mutate the state around an await.
        if (signal.aborted) onAbort();
        else if (state.credits > 0 && state.waiter === waiter) {
          state.waiter = undefined;
          waiter.removeAbort();
          resolve();
        }
      });
    }
  }

  private async readUploadPayload(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    state: { carry: Uint8Array | undefined; ended: boolean }
  ): Promise<UploadPayload | null> {
    const parts: Uint8Array[] = [];
    let byteLength = 0;

    while (byteLength < MAX_PAYLOAD_BYTES) {
      if (!state.carry || state.carry.byteLength === 0) {
        state.carry = undefined;
        const result = await reader.read();
        if (result.done) {
          state.ended = true;
          break;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new Error("request body produced a non-byte chunk");
        }
        if (result.value.byteLength === 0) continue;
        state.carry = result.value;
      }

      const remaining = MAX_PAYLOAD_BYTES - byteLength;
      const take = Math.min(remaining, state.carry.byteLength);
      parts.push(state.carry.subarray(0, take));
      byteLength += take;
      state.carry = take === state.carry.byteLength
        ? undefined
        : state.carry.subarray(take);
    }

    return byteLength === 0 ? null : { parts };
  }

  private async streamRequestBody(
    requestId: number,
    body: ReadableStream<Uint8Array>,
    channel: RTCDataChannel,
    signal: AbortSignal
  ): Promise<void> {
    const reader = body.getReader();
    const state: { carry: Uint8Array | undefined; ended: boolean } = {
      carry: undefined,
      ended: false
    };
    let completed = false;
    const onAbort = (): void => {
      void reader.cancel(signal.reason ?? "request upload cancelled").catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (!state.ended || state.carry) {
        await this.takeUploadCredit(requestId, signal);
        const payload = await this.readUploadPayload(reader, state);
        if (!payload) break;
        if (signal.aborted) throw new Error("request upload cancelled");
        await this.sendWithBackpressure(
          encodeFrameChunks(FrameType.ReqBody, requestId, payload.parts),
          channel,
          signal
        );
      }
      completed = state.ended && !state.carry;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!completed) {
        await reader.cancel(signal.reason ?? "request upload interrupted").catch(() => undefined);
      }
      reader.releaseLock();
    }
  }

  private send(frame: Uint8Array, channel = this.channel): void {
    if (!channel || channel.readyState !== "open") throw new Error("data channel not open");
    channel.send(frame as unknown as ArrayBufferView as ArrayBuffer & ArrayBufferView);
  }

  /**
   * Backpressure is mandatory. Without it a single large upload balloons
   * memory and stalls the channel for every multiplexed request on it.
   */
  private async sendWithBackpressure(
    frame: Uint8Array,
    channel = this.channel,
    signal?: AbortSignal
  ): Promise<void> {
    if (!channel) throw new Error("data channel not open");
    if (signal?.aborted) throw new Error("request upload cancelled");
    if (channel.bufferedAmount > BUFFER_HIGH_WATER) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          channel.removeEventListener("bufferedamountlow", onLow);
          channel.removeEventListener("close", onClosed);
          channel.removeEventListener("error", onClosed);
          signal?.removeEventListener("abort", onAbort);
        };
        const onLow = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const onClosed = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("data channel closed during backpressure"));
        };
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("request upload cancelled"));
        };
        channel.addEventListener("bufferedamountlow", onLow);
        channel.addEventListener("close", onClosed, { once: true });
        channel.addEventListener("error", onClosed, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (channel.readyState !== "open") onClosed();
        else if (signal?.aborted) onAbort();
      });
    }
    if (signal?.aborted) throw new Error("request upload cancelled");
    this.send(frame, channel);
  }

  private prepareChannel(
    channel: RTCDataChannel,
    lane: number,
    generation = this.connectionGeneration
  ): Promise<void> {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    this.channelLoads.set(channel, 0);
    channel.onmessage = (event: MessageEvent<ArrayBuffer>) =>
      generation === this.connectionGeneration && this.onFrame(event.data, channel);

    const opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        settle(new Error(`transport lane ${lane} open timed out`));
        if (generation === this.connectionGeneration) channel.close();
      }, CHANNEL_OPEN_TIMEOUT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();

      channel.onopen = () => settle();
      channel.onclose = () => {
        settle(new Error(`transport lane ${lane} closed before opening`));
        this.handleChannelClose(channel, lane, generation);
      };
      // Do not pass the RTC error object through logs or UI: implementations
      // may include candidate details. The actionable failure is generic.
      channel.onerror = () => {
        settle(new Error(`transport lane ${lane} failed to open`));
        if (generation === this.connectionGeneration && channel.readyState !== "closed") {
          channel.close();
        }
      };
    });
    this.channelOpenPromises.set(channel, opened);
    void opened.then(
      () => this.channelOpenPromises.delete(channel),
      () => this.channelOpenPromises.delete(channel)
    );
    return opened;
  }

  private async ensureBulkChannels(): Promise<void> {
    if (this.bulkOpening) return this.bulkOpening;
    const pc = this.pc;
    if (!pc || this.channel?.readyState !== "open") {
      throw new Error("interactive transport lane is not open");
    }
    const generation = this.connectionGeneration;

    this.cancelBulkIdleClose();
    const opening: Promise<void>[] = [];
    const existing = new Map<string, RTCDataChannel>();
    for (const channel of [...this.channels]) {
      if (channel === this.channel) continue;
      if (channel.readyState === "closed") {
        this.removeChannel(channel);
        continue;
      }
      const duplicate = existing.get(channel.label);
      if (duplicate) {
        this.removeChannel(channel);
        channel.close();
        continue;
      }
      existing.set(channel.label, channel);
    }

    for (let lane = 1; lane < DATA_CHANNEL_COUNT; lane += 1) {
      const label = `${DATA_CHANNEL_LABEL_PREFIX}${lane}`;
      const present = existing.get(label);
      if (present?.readyState === "open") continue;
      if (present) {
        const pending = this.channelOpenPromises.get(present);
        if (pending) {
          opening.push(pending);
          continue;
        }
        this.removeChannel(present);
        present.close();
      }
      const channel = pc.createDataChannel(label, { ordered: true });
      this.channels.push(channel);
      opening.push(this.prepareChannel(channel, lane, generation));
    }
    this.bulkOpening = Promise.all(opening)
      .then(() => {
        if (generation !== this.connectionGeneration || pc !== this.pc) {
          throw new Error("bulk lane opening superseded");
        }
        this.scheduleBulkIdleClose();
      })
      .finally(() => {
        this.bulkOpening = null;
      });
    return this.bulkOpening;
  }

  private cancelBulkIdleClose(): void {
    if (this.bulkIdleTimer !== null) clearTimeout(this.bulkIdleTimer);
    this.bulkIdleTimer = null;
  }

  private scheduleBulkIdleClose(): void {
    this.cancelBulkIdleClose();
    const active = this.channels.slice(1).some(
      (channel) => (this.channelLoads.get(channel) ?? 0) > 0
    );
    if (active || this.channels.length <= 1) return;
    this.bulkIdleTimer = setTimeout(() => {
      this.bulkIdleTimer = null;
      const stillActive = this.channels.slice(1).some(
        (channel) => (this.channelLoads.get(channel) ?? 0) > 0
      );
      if (stillActive) return;
      const idle = this.channels.slice(1);
      this.channels = this.channels.slice(0, 1);
      for (const channel of idle) {
        this.channelLoads.delete(channel);
        channel.close();
      }
    }, BULK_LANE_IDLE_MS);
    // Node's MessageChannel-backed unit tests should not be kept alive by a
    // browser-only housekeeping timer.
    (this.bulkIdleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private transportIsOpen(): boolean {
    return this.channel?.readyState === "open" || this.successor?.transportIsOpen() === true;
  }

  /**
   * Lane zero is kept free for navigations/API traffic. Static and bulk
   * requests use the least-loaded one of lanes 1-3, which lets SCTP's separate
   * ordered streams avoid cross-asset head-of-line blocking on UDP.
   */
  private chooseChannel(priority: RequestPriority, logicalPath = ""): RTCDataChannel | null {
    const all = (this.channels.length > 0 ? this.channels : this.channel ? [this.channel] : [])
      .filter((channel) => channel.readyState === "open");
    if (all.length === 0) return null;
    if (priority === RequestPriority.Interactive || all.length === 1) return all[0]!;

    const bulk = all.slice(1);
    // Lane one is the small critical-file reserve. Large/incremental formats
    // and ordinary assets fill lanes two and three, so a game payload cannot
    // make a stylesheet or bootstrap script wait behind it. An older worker
    // may still label WASM Critical, hence the URL guard as well as priority.
    const isIncremental = priority === RequestPriority.Bulk || isIncrementalAsset(logicalPath);
    if (priority === RequestPriority.Critical && !isIncremental) return bulk[0] ?? all[0]!;
    const candidates = isIncremental || priority === RequestPriority.Normal
      ? (bulk.slice(1).length > 0 ? bulk.slice(1) : bulk)
      : bulk;
    let selected = candidates[0] ?? bulk[0] ?? all[0]!;
    for (const channel of candidates.slice(1)) {
      const selectedLoad = this.channelLoads.get(selected) ?? 0;
      const load = this.channelLoads.get(channel) ?? 0;
      if (
        load < selectedLoad ||
        (load === selectedLoad && channel.bufferedAmount < selected.bufferedAmount)
      ) {
        selected = channel;
      }
    }
    return selected;
  }

  /**
   * Reserve at most one non-critical request on each non-reserved bulk lane.
   * The node admits three noninteractive handlers, so this leaves its third
   * slot available for lane one's critical file even during a game waterfall.
   */
  private acquireScheduledChannel(
    head: RequestHead,
    starting: StartingRequest
  ): RTCDataChannel | null | Promise<RTCDataChannel | null> {
    const constrained =
      head.priority === RequestPriority.Normal ||
      head.priority === RequestPriority.Bulk ||
      isIncrementalAsset(head.url);
    const available = this.chooseChannel(head.priority, head.url);
    if (!constrained || (available && (this.channelLoads.get(available) ?? 0) < 1)) {
      if (available) this.channelLoads.set(available, (this.channelLoads.get(available) ?? 0) + 1);
      return available;
    }
    return new Promise((resolve) => {
      this.laneWaiters.push({ head, starting, resolve });
    });
  }

  private releaseChannelReservation(channel: RTCDataChannel): void {
    if (this.channelLoads.has(channel)) {
      this.channelLoads.set(channel, Math.max(0, (this.channelLoads.get(channel) ?? 1) - 1));
    }
    this.releaseLaneWaiters();
  }

  /** Strict FIFO among bounded bulk/normal starts prevents a busy stream from starving a waiter. */
  private releaseLaneWaiters(): void {
    while (this.laneWaiters.length > 0) {
      const waiter = this.laneWaiters[0]!;
      if (waiter.starting.cancelled) {
        this.laneWaiters.shift();
        waiter.resolve(null);
        continue;
      }
      const channel = this.chooseChannel(waiter.head.priority, waiter.head.url);
      if (!channel || (this.channelLoads.get(channel) ?? 0) >= 1) return;
      this.laneWaiters.shift();
      this.channelLoads.set(channel, (this.channelLoads.get(channel) ?? 0) + 1);
      waiter.resolve(channel);
    }
  }

  private handleChannelClose(
    channel: RTCDataChannel,
    lane: number,
    generation: number
  ): void {
    if (generation !== this.connectionGeneration) return;
    if (lane === 0) {
      if (channel === this.channel) this.teardown("interactive transport lane closed");
      return;
    }

    this.removeChannel(channel);
    this.releaseLaneWaiters();
    const failed = [...this.inbound.entries()].filter(([, entry]) => entry.channel === channel);
    for (const [requestId, entry] of failed) {
      this.post({ t: "err", id: entry.swId, message: "asset transport lane closed" });
      this.finish(requestId);
    }
  }

  private removeChannel(channel: RTCDataChannel): void {
    this.channels = this.channels.filter((candidate) => candidate !== channel);
    this.channelLoads.delete(channel);
    this.channelOpenPromises.delete(channel);
  }

  private cancelRequest(swId: number): void {
    const requestId = this.requestBySw.get(swId);
    if (requestId === undefined) {
      const starting = this.startingRequests.get(swId);
      if (starting) {
        starting.cancelled = true;
        this.releaseLaneWaiters();
      }
      return;
    }
    const channel = this.inbound.get(requestId)?.channel;
    try {
      this.send(encodeFrame(FrameType.Cancel, requestId), channel);
    } catch {
      // A closed lane has already cancelled its server-side request. Local state
      // must still be released, and the RTC error must not reach page logs.
    } finally {
      this.finish(requestId);
    }
  }

  private finish(requestId: number): void {
    const swId = this.swByRequest.get(requestId);
    const channel = this.inbound.get(requestId)?.channel;
    this.responseGoodput.endRequest(requestId);
    this.requestAbortControllers.get(requestId)?.abort();
    this.requestAbortControllers.delete(requestId);
    this.uploads.delete(requestId);
    this.inbound.delete(requestId);
    this.outbound.delete(requestId);
    this.swByRequest.delete(requestId);
    if (swId !== undefined) {
      this.requestBySw.delete(swId);
    }
    if (channel && this.channelLoads.has(channel)) {
      this.releaseChannelReservation(channel);
      if (channel !== this.channel) this.scheduleBulkIdleClose();
    }
    this.maybeNotifyDrained();
  }

  private hasActiveWork(): boolean {
    return this.inbound.size > 0 || this.startingRequests.size > 0 || this.sockets.size > 0;
  }

  private maybeNotifyDrained(): void {
    if (this.hasActiveWork()) return;
    for (const listener of this.drainedListeners) listener();
  }

  private teardown(reason: string): void {
    if (this.transportDown) return;
    this.transportDown = true;
    const successorHealthy = this.successor?.transportIsOpen() === true;
    const failedSwIds = successorHealthy
      ? new Set([
          ...[...this.swByRequest.values()].filter((id) => id > 0),
          ...[...this.startingRequests.keys()].filter((id) => id > 0)
        ])
      : null;
    this.queuedWorkerWake = null;
    this.clearIceDisconnectTimer();
    this.rejectAttachWaiter(new Error("service worker attachment interrupted"));
    // Sockets are page-owned and outlive individual requests, so nothing else
    // in this teardown reaches them.
    this.failAllSockets(reason);
    if (failedSwIds) {
      // The worker's one MessagePort is also the router for the healthy
      // successor. Fail only ids which belonged to this old route; a global
      // DOWN would incorrectly destroy new TCP requests as well.
      for (const id of failedSwIds) this.post({ t: "err", id, message: `transport down: ${reason}` });
    } else {
      this.post({ t: "down", reason });
    }
    const direct = [...this.direct.entries()];
    this.direct.clear();
    for (const [id, collect] of direct) {
      collect({ t: "err", id, message: "transport disconnected" });
    }
    this.inbound.clear();
    this.outbound.clear();
    this.swByRequest.clear();
    this.requestBySw.clear();
    for (const controller of this.requestAbortControllers.values()) controller.abort();
    this.requestAbortControllers.clear();
    this.uploads.clear();
    // A lazy lane may still finish opening after teardown. Preserve a tombstone
    // until each start coroutine unwinds so it cannot create fresh wire work on
    // a transport the worker already considers down.
    for (const starting of this.startingRequests.values()) starting.cancelled = true;
    for (const waiter of this.laneWaiters.splice(0)) waiter.resolve(null);
    this.channelLoads.clear();
    this.channelOpenPromises.clear();
    this.cancelBulkIdleClose();
    this.responseGoodput.setTransport("unknown");
    this.maybeNotifyDrained();
    if (successorHealthy) {
      const pc = this.pc;
      if (pc) this.releaseConnection(pc, this.connectionGeneration, true);
      // This object still owns the live SW router port; only its predecessor
      // RTC association is down. Keep attachment/wake guards available for the
      // successor and future worker restarts.
      this.transportDown = false;
      return;
    }
    for (const listener of this.disconnectListeners) listener(reason);
  }

  close(): void {
    const successor = this.successor;
    this.successor = null;
    this.retireRoute();
    successor?.close();
  }

  /** Close only this route after its requests drain, preserving its successor. */
  retireRoute(): void {
    this.teardown("carrier closed");
    const pc = this.pc;
    const generation = this.connectionGeneration;
    if (pc) {
      this.releaseConnection(pc, generation);
      return;
    }
    this.connectionGeneration += 1;
    this.releasePageHooks();
    this.port?.close();
    this.port = null;
  }

  /** Close only this client's RTC association while retaining its SW router port. */
  retireTransport(): void {
    if (this.hasActiveWork()) throw new Error("cannot retire a transport with active work");
    const pc = this.pc;
    if (!pc) return;
    this.responseGoodput.setTransport("unknown");
    this.releaseConnection(pc, this.connectionGeneration, true);
  }

  private isCurrent(pc: RTCPeerConnection, generation: number): boolean {
    return this.pc === pc && this.connectionGeneration === generation;
  }

  private assertCurrent(pc: RTCPeerConnection, generation: number): void {
    if (!this.isCurrent(pc, generation)) throw new Error("connection attempt superseded");
  }

  private clearIceDisconnectTimer(): void {
    if (this.iceDisconnectTimer !== null) clearTimeout(this.iceDisconnectTimer);
    this.iceDisconnectTimer = null;
  }

  private replayQueuedWorkerWake(generation: number): void {
    const queued = this.queuedWorkerWake;
    if (!queued) return;
    if (
      queued.generation !== generation ||
      generation !== this.connectionGeneration ||
      this.transportDown ||
      this.attachOperation ||
      this.reattaching
    ) return;
    this.queuedWorkerWake = null;
    queueMicrotask(() => {
      if (generation !== this.connectionGeneration || this.transportDown) return;
      this.onSwMessage({ t: "wake" }, queued.worker);
    });
  }

  private rejectAttachWaiter(error: Error): void {
    const waiter = this.attachWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.attachWaiter = undefined;
    waiter.reject(error);
  }

  private async completeWorkerAttach(waiter: AttachWaiter): Promise<void> {
    try {
      await this.persistWorkerBootstrap(waiter.worker, waiter.bootstrap);
      if (
        this.attachWaiter !== waiter ||
        this.port !== waiter.port ||
        waiter.generation !== this.connectionGeneration
      ) return;
      waiter.port.postMessage({ t: "ready", clientId: randomId(8) } satisfies PageToSw);
      // A WAKE received during this successful proactive attachment belongs to
      // the discovery round the new READY just satisfied, so it is not replayed.
      if (this.queuedWorkerWake?.generation === waiter.generation) {
        this.queuedWorkerWake = null;
      }
      clearTimeout(waiter.timer);
      this.attachWaiter = undefined;
      waiter.resolve();
    } catch (error) {
      if (this.attachWaiter !== waiter) return;
      this.closeRejectedAttach(waiter, "service worker bootstrap failed");
      this.rejectAttachWaiter(
        error instanceof Error ? error : new Error("service worker bootstrap failed")
      );
    }
  }

  private persistWorkerBootstrap(
    worker: ServiceWorker,
    bootstrap: InjectedBootstrap
  ): Promise<void> {
    const channel = new MessageChannel();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.port1.close();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("service worker bootstrap timed out")),
        WORKER_BOOTSTRAP_TIMEOUT_MS
      );
      channel.port1.onmessage = (event: MessageEvent<{
        t?: string;
        protocolVersion?: unknown;
      }>) => {
        if (
          event.data?.t === "bootstrapped" &&
          isCurrentWorkerProtocol(event.data.protocolVersion)
        ) {
          finish();
          return;
        }
        finish(new Error("service worker rejected its bootstrap"));
      };
      channel.port1.start();
      try {
        worker.postMessage(
          { t: "bootstrap", protocolVersion: PROTOCOL_VERSION, bootstrap },
          [channel.port2]
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error("service worker bootstrap failed"));
      }
    });
  }

  private closeRejectedAttach(waiter: AttachWaiter, reason: string): void {
    if (this.port !== waiter.port) return;
    try {
      waiter.port.postMessage({ t: "down", reason } satisfies PageToSw);
    } catch {
      /* the incompatible endpoint may already have closed its half */
    }
    waiter.port.close();
    this.port = null;
  }

  private releasePageHooks(): void {
    if (this.listeningForWorkerWake) {
      navigator.serviceWorker.removeEventListener("message", this.onServiceWorkerMessage);
      window.removeEventListener("pagehide", this.onPageHide);
      this.listeningForWorkerWake = false;
    }
  }

  private releaseConnection(
    pc: RTCPeerConnection,
    generation: number,
    preserveBridge = false
  ): void {
    if (!this.isCurrent(pc, generation)) return;
    this.connectionGeneration += 1;
    this.clearIceDisconnectTimer();
    this.rejectAttachWaiter(new Error("connection closed"));
    if (!preserveBridge) this.releasePageHooks();
    const channels = new Set(
      this.channels.length > 0 ? this.channels : this.channel ? [this.channel] : []
    );
    // Invalidate object identity before close events are queued.
    this.channel = null;
    this.channels = [];
    this.pc = null;
    this.channelLoads.clear();
    this.channelOpenPromises.clear();
    this.bulkOpening = null;
    this.cancelBulkIdleClose();
    for (const channel of channels) channel.close();
    pc.oniceconnectionstatechange = null;
    pc.close();
    if (!preserveBridge) {
      this.port?.close();
      this.port = null;
    }
  }
}

/** Legacy public name retained for already-deployed bootstrap code. */
export { YuriRTCClient as LoaderClient };

function responseCreditFrame(requestId: number, amount: number): Uint8Array {
  return encodeFrame(FrameType.Credit, requestId, encodeCreditPayload(amount));
}

/**
 * Non-trickle gathering with a timeout. `onicecandidate` never firing with a
 * null candidate is a real hang — adrift has no timeout here and blocks forever
 * when a candidate source is unreachable.
 */
function gatherCandidates(pc: RTCPeerConnection): Promise<RTCIceCandidateInit[]> {
  return new Promise((resolve) => {
    const candidates: RTCIceCandidateInit[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(candidates);
    };
    const timer = setTimeout(finish, GATHER_TIMEOUT_MS);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        candidates.push(event.candidate.toJSON());
        return;
      }
      finish();
    };
    if (pc.iceGatheringState === "complete") finish();
  });
}

/**
 * Which path ICE actually chose. Report this: head-of-line blocking only
 * affects the TCP cohort, and "slow for some users" is otherwise unattributable.
 */
async function selectedPair(pc: RTCPeerConnection): Promise<Omit<ConnectionDiagnostics, "signalBackend" | "signalElapsedMs">> {
  const fallback = {
    route: { transport: "unknown", portClass: "unknown" }
  } as const;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const stats = await pc.getStats();
      for (const report of stats.values()) {
        const pair = report as RTCIceCandidatePairStats & { nominated?: boolean; selected?: boolean };
        if (
          pair.type !== "candidate-pair" ||
          pair.state !== "succeeded" ||
          (!pair.nominated && !pair.selected)
        ) continue;
        // `RTCIceCandidateStats` is not in every lib.dom; the shape is stable.
        type CandidateStats = {
          protocol?: string;
          port?: number;
        };
        const local = stats.get(pair.localCandidateId ?? "") as CandidateStats | undefined;
        const remote = stats.get(pair.remoteCandidateId ?? "") as CandidateStats | undefined;
        const rawProtocol = (remote?.protocol ?? local?.protocol ?? "").toLowerCase();
        const transport = rawProtocol === "udp" || rawProtocol === "tcp"
          ? rawProtocol
          : "unknown";
        const portClass = remote?.port === 443
          ? "443"
          : typeof remote?.port === "number" && remote.port > 0
            ? "standard"
            : "unknown";
        return { route: { transport, portClass } };
      }
    } catch {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return fallback;
}
