/**
 * Service-worker side of the bridge.
 *
 * The SW can be killed and restarted with no page attached, and it outlives and
 * predeceases pages unpredictably — this is the most likely source of
 * "works, then randomly doesn't". So the port is never assumed: requests queue
 * until one is available, and the SW asks whatever clients exist to reconnect.
 */

import {
  CREDIT_REFILL,
  CREDIT_GROWTH_STEP,
  CREDIT_SAMPLE_FRAMES,
  CARRIER_ACQUIRE_TIMEOUT_MS,
  CARRIER_READY_TIMEOUT_MS,
  MAX_RESPONSE_CREDITS,
  type PageToSw,
  type SwToPage
} from "./bridge.js";
import {
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  type RequestHead,
  type ResponseHead
} from "@yurirtc/protocol";

declare const self: ServiceWorkerGlobalScope;

interface Pending {
  headReceived: boolean;
  onHead: (head: ResponseHead) => void;
  onChunk: (chunk: Uint8Array) => void;
  onPull: () => void;
  onEnd: () => void;
  onError: (error: Error) => void;
}

interface PortWaiter {
  resolve: (port: MessagePort) => void;
  reject: (error: unknown) => void;
}

export interface TransportResponse {
  head: ResponseHead;
  body: ReadableStream<Uint8Array>;
}

/**
 * How long a confirmed-live carrier may be taken on trust.
 *
 * Long enough that one page's asset burst asks the browser process once
 * instead of once per file; short enough that a crashed tab is noticed within
 * a frame or two of work.
 */
const OWNER_LIVENESS_TTL_MS = 250;

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

export class NoCarrierError extends Error {
  constructor() {
    super("no page available to carry the transport");
    this.name = "NoCarrierError";
  }
}

export class SwBridge {
  private port: MessagePort | null = null;
  private portReady = false;
  private ownerClientId: string | null = null;
  /** Retains a port's owner after same-page replacement for in-flight routing. */
  private readonly portOwners = new WeakMap<MessagePort, string | null>();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private waiters: PortWaiter[] = [];
  /** One matchAll/wake broadcast is shared by every queued fetch. */
  private wakeEpoch: symbol | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** The port whose owner was last confirmed to still exist, and when. */
  private ownerAliveFor: MessagePort | null = null;
  private ownerAliveAt = 0;

  /** Called by the SW's `message` handler when a page hands over its port. */
  attach(port: MessagePort, ownerClientId?: string): void {
    const nextOwner = ownerClientId ?? null;
    if (
      this.port &&
      this.ownerClientId !== null &&
      nextOwner !== null &&
      this.ownerClientId !== nextOwner
    ) {
      // A disconnected fetch broadcasts WAKE to every controlled window. The
      // first responder owns this epoch; later tabs stay warm as standbys
      // instead of replacing it and cancelling all of its active transfers.
      port.start();
      port.postMessage({
        t: "standby",
        protocolVersion: PROTOCOL_VERSION
      } satisfies SwToPage);
      port.close();
      return;
    }
    const canContinueInflight =
      this.port !== null &&
      this.ownerClientId !== null &&
      nextOwner !== null &&
      this.ownerClientId === nextOwner;
    const preHead: Array<[number, Pending]> = [];
    if (this.port && !canContinueInflight) {
      // Requests in flight belong to the previous page's data channel. A new
      // carrier cannot finish them, so fail them instead of leaving them hung.
      this.detach("carrier page replaced");
    } else {
      this.port?.close();
      // A response head proves the page consumed REQ and created request state
      // that its replacement port can continue to control. Before HEAD, REQ
      // may still be a queued task on the port we just closed, so preserving it
      // would leave an unknowable request hanging forever.
      for (const [id, entry] of this.pending) {
        if (!entry.headReceived) {
          this.pending.delete(id);
          preHead.push([id, entry]);
        }
      }
    }
    this.port = port;
    this.portReady = false;
    // A new carrier has not been confirmed yet; the previous one's liveness
    // says nothing about it.
    this.ownerAliveFor = null;
    // Invalidate an in-flight matchAll before its continuation can emit a wake
    // that arrives after this attachment has already completed.
    this.wakeEpoch = null;
    this.ownerClientId = nextOwner;
    this.portOwners.set(port, nextOwner);
    port.onmessage = (event: MessageEvent<PageToSw>) => {
      // Closing a MessagePort does not discard tasks already queued from it.
      // Never let a late `down` or response from the old carrier detach or
      // mutate the replacement carrier.
      if (this.port !== port) return;
      this.onMessage(event.data);
    };
    port.start();

    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      if (this.port !== port || this.portReady) return;
      this.detach("carrier ready handshake timed out");
    }, CARRIER_READY_TIMEOUT_MS);
    (this.readyTimer as unknown as { unref?: () => void }).unref?.();

    // Tell the page the transport is live before it starts using it.
    port.postMessage({ t: "attached", protocolVersion: PROTOCOL_VERSION } satisfies SwToPage);

    for (const [id, entry] of preHead) {
      // If the old page did consume REQ just before replacement, its transport
      // maps survive the MessagePort refresh and this terminates that work. If
      // it did not, the page safely ignores the unknown id.
      try {
        port.postMessage({ t: "cancel", id } satisfies SwToPage);
      } catch {
        /* the replacement failed while attaching */
      }
      entry.onError(new Error("transport down: carrier port replaced before response"));
    }

  }

  /**
   * Routes request control traffic across a same-page MessagePort refresh.
   * A different (or unidentified) page cannot inherit another page's RTC
   * request state, so only an exact, non-empty owner match permits rerouting.
   */
  private postForRequest(
    originalPort: MessagePort,
    message: SwToPage,
    transfer: Transferable[] = []
  ): boolean {
    const currentPort = this.port;
    if (!currentPort) return false;
    if (currentPort !== originalPort) {
      const originalOwner = this.portOwners.get(originalPort);
      const currentOwner = this.portOwners.get(currentPort);
      if (!originalOwner || originalOwner !== currentOwner) return false;
    }
    try {
      currentPort.postMessage(message, transfer);
      return true;
    } catch {
      return false;
    }
  }

  get connected(): boolean {
    return this.port !== null && this.portReady;
  }

  /** MessagePort has no close event; confirm its owning page still exists. */
  async isConnected(): Promise<boolean> {
    return this.checkCarrier(false);
  }

  /**
   * The same check, allowing a recent positive answer to be reused.
   *
   * `clients.get()` is a round trip to the browser process, and it was being
   * paid once per fetch — including for requests answered entirely from cache.
   * Only a positive result is ever reused, and only briefly: a carrier that has
   * genuinely gone away must still be detached promptly so the wake/recovery
   * path in acquire() can run. A page that unloads normally reports it anyway
   * (client.ts posts `down` on pagehide), so this window only matters for a
   * crashed or force-closed tab.
   *
   * Callers must use the strict check wherever a stale positive could change
   * routing rather than merely delay it.
   */
  isLikelyConnected(): Promise<boolean> {
    return this.checkCarrier(true);
  }

  private async checkCarrier(allowCached: boolean): Promise<boolean> {
    const port = this.port;
    if (!port) return false;
    const ownerClientId = this.ownerClientId;
    if (!ownerClientId) return this.portReady;

    // Monotonic: a wall clock that steps backwards (an NTP correction, or a
    // Chromebook waking from suspend) would otherwise pin a stale positive
    // open indefinitely rather than for the window documented above.
    if (
      allowCached &&
      this.ownerAliveFor === port &&
      performance.now() - this.ownerAliveAt < OWNER_LIVENESS_TTL_MS
    ) {
      return this.portReady;
    }

    const owner = await self.clients.get(ownerClientId);
    // An attach may have replaced either half of the ownership pair while the
    // asynchronous client lookup was in flight. Re-check the current carrier
    // instead of returning a result for a stale snapshot.
    if (this.port !== port || this.ownerClientId !== ownerClientId) {
      return this.checkCarrier(allowCached);
    }
    if (owner) {
      this.ownerAliveFor = port;
      this.ownerAliveAt = performance.now();
      return this.portReady;
    }

    this.detach("carrier page closed");
    return false;
  }

  private detach(reason: string): void {
    const port = this.port;
    // A transferred upload stream now lives in the carrier page. Tell that
    // page to cancel each request before severing the only control channel, so
    // replacing a carrier cannot leave an old page reading and uploading in
    // the background.
    if (port) {
      for (const id of this.pending.keys()) {
        try {
          port.postMessage({ t: "cancel", id } satisfies SwToPage);
        } catch {
          /* the port is already unusable */
        }
      }
      port.close();
    }
    this.port = null;
    this.portReady = false;
    this.ownerClientId = null;
    this.ownerAliveFor = null;
    this.clearReadyTimer();
    this.wakeEpoch = null;
    const inflight = [...this.pending.values()];
    this.pending.clear();
    // Fail everything in flight rather than let it hang forever.
    for (const entry of inflight) entry.onError(new Error(`transport down: ${reason}`));
    // A port can disappear while fetches wait for READY. Start one replacement
    // discovery round immediately instead of making each request burn its own
    // timeout before recovery begins.
    this.ensureWakeEpoch();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private onMessage(message: PageToSw): void {
    if (message.t === "down") {
      this.detach(message.reason);
      return;
    }
    if (message.t === "ready") {
      if (this.portReady || !this.port) return;
      this.portReady = true;
      this.clearReadyTimer();
      // Page retirement errors and READY cross the same MessagePort direction
      // in FIFO order. Only now may a restarted bridge allocate ids and expose
      // queued fetches, so an old id can never reject a new request.
      const waiters = this.waiters;
      this.waiters = [];
      this.wakeEpoch = null;
      for (const waiter of waiters) waiter.resolve(this.port);
      return;
    }

    const entry = this.pending.get(message.id);
    if (!entry) return;

    switch (message.t) {
      case "head":
        entry.onHead(message.head);
        break;
      case "body": {
        // The page transfers the whole wire frame and supplies bounds,
        // avoiding a 128 KiB copy per chunk.
        const byteOffset = message.byteOffset;
        const byteLength = message.byteLength;
        if (
          !Number.isInteger(byteOffset) ||
          !Number.isInteger(byteLength) ||
          byteOffset < 0 ||
          byteLength < 0 ||
          byteOffset + byteLength > message.chunk.byteLength
        ) {
          this.pending.delete(message.id);
          entry.onError(new Error("invalid response chunk bounds"));
          break;
        }
        entry.onChunk(
          new Uint8Array(message.chunk, byteOffset, byteLength)
        );
        break;
      }
      case "end":
        this.pending.delete(message.id);
        entry.onEnd();
        break;
      case "err":
        this.pending.delete(message.id);
        entry.onError(new Error(message.message));
        break;
    }
  }

  /**
   * Waits for a page to attach, asking any existing client to reconnect. A SW
   * woken by a fetch event with no controlled page is the normal case after the
   * worker has been evicted for idleness.
   */
  private async acquire(signal: AbortSignal): Promise<MessagePort> {
    if (signal.aborted) throw abortError();
    if (await this.isConnected()) {
      if (signal.aborted) throw abortError();
      return this.port!;
    }

    return await new Promise<MessagePort>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      let waiter: PortWaiter;

      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        if (this.waiters.length === 0 && !this.portReady) {
          // A page which never completes READY must not pin a dead wake epoch
          // forever. Close the half-attached port so a later fetch can retry.
          if (this.port) this.detach("carrier ready handshake abandoned");
          else this.wakeEpoch = null;
        }
      };
      const succeed = (port: MessagePort): void => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(port);
      };
      const fail = (error: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const onPort = (port: MessagePort): void => succeed(port);
      const onAbort = (): void => fail(abortError());
      waiter = { resolve: onPort, reject: fail };

      timer = setTimeout(() => fail(new NoCarrierError()), CARRIER_ACQUIRE_TIMEOUT_MS);
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });

      // Attach can land after isConnected() resolves false but before this
      // waiter is installed. Check synchronously after installation so either
      // the attach callback or this branch must observe the new port.
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (this.port && this.portReady) {
        onPort(this.port);
        return;
      }

      // An attachment handshake is already in progress. READY will release
      // this waiter; another global wake would only create a second port race.
      if (this.port) return;

      this.ensureWakeEpoch();
    });
  }

  private ensureWakeEpoch(): void {
    if (this.wakeEpoch || this.port || this.waiters.length === 0) return;
    const epoch = Symbol("wake");
    this.wakeEpoch = epoch;
    // Start on a resolved promise so an unusual synchronous matchAll throw is
    // still routed through every waiter and fully clears the shared epoch.
    void Promise.resolve()
      // A newly activated upgrade intentionally does not claim pages still
      // controlled by its predecessor. Waking those pages would make their
      // live old-controller transfers attach to the wrong bridge and be
      // retired as stale. A restarted worker still sees all of its own clients.
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: false }))
      .then((clients) => {
        if (this.wakeEpoch !== epoch || this.port) return;
        for (const client of clients) {
          client.postMessage({ t: "wake" } satisfies SwToPage);
        }
      })
      .catch((error) => {
        if (this.wakeEpoch !== epoch) return;
        this.wakeEpoch = null;
        const waiters = [...this.waiters];
        for (const waiter of waiters) waiter.reject(error);
      });
  }

  async request(
    head: RequestHead,
    body: ReadableStream<Uint8Array> | undefined,
    signal: AbortSignal
  ): Promise<TransportResponse> {
    if (signal.aborted) {
      void body?.cancel(signal.reason).catch(() => undefined);
      throw abortError();
    }
    if (
      head.version !== PROTOCOL_VERSION ||
      !Number.isInteger(head.initialCredits) ||
      head.initialCredits < 1 ||
      head.initialCredits > MAX_RESPONSE_CREDITS
    ) {
      void body?.cancel().catch(() => undefined);
      throw new Error("invalid YuriRTC v3 request window");
    }
    if (body && !head.hasBody) {
      void body.cancel().catch(() => undefined);
      throw new Error("request body provided for a bodyless request");
    }
    let port: MessagePort;
    try {
      port = await this.acquire(signal);
    } catch (error) {
      void body?.cancel(error).catch(() => undefined);
      throw error;
    }
    if (signal.aborted) {
      void body?.cancel(signal.reason).catch(() => undefined);
      throw abortError();
    }
    const id = this.nextId++;

    let resolveHead: (head: ResponseHead) => void;
    let rejectHead: (error: Error) => void;
    const headPromise = new Promise<ResponseHead>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });

    let settled = false;
    let removeAbortListener = (): void => undefined;
    const entry: Pending = {
      headReceived: false,
      onHead: (value) => {
        entry.headReceived = true;
        settled = true;
        resolveHead(value);
      },
      onChunk: () => undefined,
      onPull: () => undefined,
      onEnd: () => undefined,
      onError: (error) => {
        removeAbortListener();
        if (!settled) rejectHead(error);
      }
    };

    const queued: Uint8Array[] = [];
    let waitingForChunk = false;
    let ended = false;
    const initialCredit = head.initialCredits;
    let targetCredit = initialCredit;
    // Credits issued to the node but not yet observed back as body frames.
    // In-flight frames remain included, which makes this conservative rather
    // than accidentally granting more than the bounded target.
    let creditBalance = initialCredit;
    let sampleConsumed = 0;
    let samplePeakQueue = 0;
    let sampleStartedAt = Date.now();

    const body$ = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const refillCredit = (force = false, flushGrowth = false): void => {
          if (ended || !this.pending.has(id)) return;
          const available = targetCredit - creditBalance - queued.length;
          if (available <= 0) return;
          // Ordinarily batch control traffic. Force only when no server credit
          // remains, otherwise a partial final batch could introduce an RTT
          // bubble while the consumer waits on an empty stream.
          const refillThreshold = Math.min(CREDIT_REFILL, Math.ceil(targetCredit / 2));
          if (
            available < refillThreshold &&
            !flushGrowth &&
            !(force && creditBalance === 0)
          ) return;
          if (!this.postForRequest(
            port,
            { t: "credit", id, n: available } satisfies SwToPage
          )) {
            this.pending.delete(id);
            queued.length = 0;
            entry.onError(new Error("transport down: carrier page replaced"));
            return;
          }
          creditBalance += available;
        };
        const recordConsumption = (): boolean => {
          sampleConsumed += 1;
          if (sampleConsumed < CREDIT_SAMPLE_FRAMES) return false;

          const elapsedMs = Date.now() - sampleStartedAt;
          let grew = false;
          // If 2 MiB drained in under half a second with almost no SW backlog,
          // the path can use more bandwidth-delay product. Grow in small steps
          // so a burst of concurrent assets cannot instantly reserve 4 MiB
          // apiece. Backlogged consumers return toward their initial bound.
          if (
            elapsedMs <= 500 &&
            samplePeakQueue <= 2 &&
            targetCredit < MAX_RESPONSE_CREDITS
          ) {
            targetCredit = Math.min(MAX_RESPONSE_CREDITS, targetCredit + CREDIT_GROWTH_STEP);
            grew = true;
          } else if (
            samplePeakQueue >= Math.ceil(targetCredit / 2) &&
            targetCredit > initialCredit
          ) {
            targetCredit = Math.max(initialCredit, targetCredit - CREDIT_GROWTH_STEP);
          }
          sampleConsumed = 0;
          samplePeakQueue = queued.length;
          sampleStartedAt = Date.now();
          return grew;
        };
        const closeIfDrained = (): void => {
          if (!ended || queued.length > 0) return;
          waitingForChunk = false;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        entry.onChunk = (chunk) => {
          if (chunk.byteLength > MAX_PAYLOAD_BYTES) {
            this.pending.delete(id);
            queued.length = 0;
            this.postForRequest(port, { t: "cancel", id } satisfies SwToPage);
            entry.onError(new Error("response chunk exceeds protocol limit"));
            return;
          }
          if (creditBalance <= 0) {
            this.pending.delete(id);
            queued.length = 0;
            this.postForRequest(port, { t: "cancel", id } satisfies SwToPage);
            entry.onError(new Error("response exceeded its v3 credit grant"));
            return;
          }
          creditBalance -= 1;
          if (waitingForChunk) {
            waitingForChunk = false;
            controller.enqueue(chunk);
            // A pending pull means this chunk goes straight to downstream;
            // release its slot without waiting for another pull callback.
            const grew = recordConsumption();
            // Make a newly-earned BDP window available immediately. Without
            // this, a fast stream can wait another half-window before the
            // growth credit is sent, introducing exactly the RTT bubble the
            // adaptive window is intended to remove.
            refillCredit(false, grew);
            return;
          }
          if (queued.length >= targetCredit) {
            this.pending.delete(id);
            queued.length = 0;
            this.postForRequest(port, { t: "cancel", id } satisfies SwToPage);
            entry.onError(new Error("response exceeded its credit window"));
            return;
          }
          queued.push(chunk);
          samplePeakQueue = Math.max(samplePeakQueue, queued.length);
        };
        entry.onEnd = () => {
          ended = true;
          removeAbortListener();
          closeIfDrained();
        };
        const priorError = entry.onError;
        entry.onError = (error) => {
          queued.length = 0;
          waitingForChunk = false;
          priorError(error);
          try {
            controller.error(error);
          } catch {
            /* already errored */
          }
        };

        // Pull is the downstream demand signal. Keep received chunks in our
        // bounded window and replenish page/node credit only as that window is
        // actually drained, rather than immediately on network arrival.
        entry.onPull = () => {
          const chunk = queued.shift();
          if (chunk) {
            controller.enqueue(chunk);
            if (!ended) {
              const grew = recordConsumption();
              refillCredit(false, grew);
            }
            closeIfDrained();
            return;
          }
          if (ended) {
            closeIfDrained();
            return;
          }
          waitingForChunk = true;
          refillCredit(true);
        };
      },
      pull: () => {
        entry.onPull();
      },
      cancel: () => {
        queued.length = 0;
        removeAbortListener();
        if (this.pending.delete(id)) {
          this.postForRequest(port, { t: "cancel", id } satisfies SwToPage);
        }
      }
    });

    this.pending.set(id, entry);

    const onAbort = (): void => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      queued.length = 0;
      removeAbortListener();
      // CANCEL is not optional: a user closing a game mid-download must stop
      // the transfer or the node keeps pushing gigabytes into a dead channel.
      this.postForRequest(port, { t: "cancel", id } satisfies SwToPage);
      entry.onError(abortError());
    };
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (!this.postForRequest(
        port,
        { t: "req", id, head, ...(body ? { body } : {}) } satisfies SwToPage,
        body ? [body] : []
      )) {
        throw new Error("transport down: carrier page replaced");
      }
    } catch (error) {
      this.pending.delete(id);
      queued.length = 0;
      removeAbortListener();
      void body?.cancel(error).catch(() => undefined);
      entry.onError(error instanceof Error ? error : new Error(String(error)));
    }

    const responseHead = await headPromise;
    return { head: responseHead, body: body$ };
  }
}
