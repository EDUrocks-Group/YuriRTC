/**
 * A WebSocket carried over the YuriRTC transport.
 *
 * Nothing the service worker does can help here: a websocket handshake is not
 * a fetch, so it never reaches a worker's fetch handler and cannot be
 * intercepted. A page on the carrier that needs a socket therefore has to ask
 * for one explicitly, which is what this is -- an object shaped like a
 * `WebSocket` whose frames travel the data channel instead of a TCP connection
 * the page cannot open.
 *
 * It implements the parts of the interface a client library actually touches:
 * `readyState`, `binaryType`, `send`, `close`, the four `on*` handlers, and
 * `addEventListener`. It is deliberately not a subclass of `WebSocket` -- that
 * constructor opens a connection as a side effect, and there is nothing to
 * connect to.
 */

import {
  MAX_WS_MESSAGE_BYTES,
  WS_CLOSE_NORMAL,
  WebSocketDataKind,
  encodeWebSocketClose,
  encodeWebSocketData
} from "@yurirtc/protocol";

export type SocketReadyState = 0 | 1 | 2 | 3;

export const SOCKET_CONNECTING: SocketReadyState = 0;
export const SOCKET_OPEN: SocketReadyState = 1;
export const SOCKET_CLOSING: SocketReadyState = 2;
export const SOCKET_CLOSED: SocketReadyState = 3;

/** What the socket needs from its carrier, so this file owns no transport. */
export interface SocketCarrier {
  sendData(requestId: number, payload: Uint8Array): void;
  sendClose(requestId: number, payload: Uint8Array): void;
  /** Called once the socket is finished, so the carrier can forget it. */
  release(requestId: number): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Builds the close event.
 *
 * `CloseEvent` is a DOM interface, so it exists in the browsers this runs in
 * but not in every environment the package is loaded by -- Node has `Event` and
 * `MessageEvent` and no `CloseEvent`. Falling back to a plain `Event` carrying
 * the same three fields keeps the shape a client reads identical either way.
 */
function closeEvent(code: number, reason: string, wasClean: boolean): Event {
  const CloseEventCtor = (globalThis as { CloseEvent?: typeof CloseEvent }).CloseEvent;
  if (typeof CloseEventCtor === "function") {
    return new CloseEventCtor("close", { code, reason, wasClean });
  }
  return Object.assign(new Event("close"), { code, reason, wasClean });
}

export class CarriedWebSocket extends EventTarget {
  readonly CONNECTING = SOCKET_CONNECTING;
  readonly OPEN = SOCKET_OPEN;
  readonly CLOSING = SOCKET_CLOSING;
  readonly CLOSED = SOCKET_CLOSED;

  /** Matches WebSocket: "blob" or "arraybuffer". Clients set this to arraybuffer. */
  binaryType: "blob" | "arraybuffer" = "blob";

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  #readyState: SocketReadyState = SOCKET_CONNECTING;
  #protocol = "";
  #bufferedAmount = 0;

  constructor(
    readonly url: string,
    private readonly requestId: number,
    private readonly carrier: SocketCarrier
  ) {
    super();
  }

  get readyState(): SocketReadyState {
    return this.#readyState;
  }

  get protocol(): string {
    return this.#protocol;
  }

  get extensions(): string {
    // The carrier negotiates none, and reporting one would be a lie a client
    // could act on.
    return "";
  }

  get bufferedAmount(): number {
    return this.#bufferedAmount;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.#readyState === SOCKET_CONNECTING) {
      // Matches the platform: sending before open is a programming error, and
      // an InvalidStateError is how a client finds out.
      throw new DOMException("socket is still connecting", "InvalidStateError");
    }
    if (this.#readyState !== SOCKET_OPEN) return;

    if (typeof data === "string") {
      this.#transmit(WebSocketDataKind.Text, encoder.encode(data));
      return;
    }
    if (data instanceof Blob) {
      // Blob is async, and send() is not; queue the read and preserve order by
      // sending from the same promise chain.
      void data.arrayBuffer().then(buffer => {
        if (this.#readyState === SOCKET_OPEN) {
          this.#transmit(WebSocketDataKind.Binary, new Uint8Array(buffer));
        }
      });
      return;
    }
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBufferLike);
    this.#transmit(WebSocketDataKind.Binary, view);
  }

  #transmit(kind: WebSocketDataKind, body: Uint8Array): void {
    if (body.byteLength > MAX_WS_MESSAGE_BYTES) {
      // Too large to frame. The platform would close the connection rather than
      // silently truncate, so do the same.
      this.#fail("message exceeds the carrier frame limit");
      return;
    }
    try {
      this.carrier.sendData(this.requestId, encodeWebSocketData(kind, body));
    } catch {
      this.#fail("the carrier could not send");
    }
  }

  close(code = WS_CLOSE_NORMAL, reason = ""): void {
    if (this.#readyState === SOCKET_CLOSING || this.#readyState === SOCKET_CLOSED) return;
    this.#readyState = SOCKET_CLOSING;
    try {
      this.carrier.sendClose(this.requestId, encodeWebSocketClose(code, reason));
    } catch {
      // The carrier is already gone; finish locally rather than hang in CLOSING.
      this.acceptClose(1006, "", false);
      return;
    }
  }

  /* The carrier drives everything below. None of it is part of the public
     WebSocket surface, and a client should never call it. */

  /** @internal */
  acceptOpen(protocol: string): void {
    if (this.#readyState !== SOCKET_CONNECTING) return;
    this.#protocol = protocol;
    this.#readyState = SOCKET_OPEN;
    this.#emit(new Event("open"), this.onopen);
  }

  /** @internal */
  acceptMessage(kind: WebSocketDataKind, body: Uint8Array): void {
    if (this.#readyState !== SOCKET_OPEN) return;

    let data: string | ArrayBuffer | Blob;
    if (kind === WebSocketDataKind.Text) {
      data = decoder.decode(body);
    } else {
      // The view is a window onto the carrier's frame buffer, which is reused;
      // slice so the client keeps its own copy.
      const copy = body.slice();
      data = this.binaryType === "arraybuffer" ? copy.buffer : new Blob([copy]);
    }
    this.#emit(new MessageEvent("message", { data }), this.onmessage);
  }

  /** @internal */
  acceptClose(code: number, reason: string, wasClean = true): void {
    if (this.#readyState === SOCKET_CLOSED) return;
    const wasConnecting = this.#readyState === SOCKET_CONNECTING;
    this.#readyState = SOCKET_CLOSED;
    this.carrier.release(this.requestId);

    // A socket that never opened reports an error first, the way the platform
    // does, so a client waiting on onerror is not left waiting.
    if (wasConnecting) this.#emit(new Event("error"), this.onerror);
    this.#emit(
      closeEvent(code, reason, wasClean && !wasConnecting) as CloseEvent,
      this.onclose as ((event: Event) => void) | null
    );
  }

  /** @internal Reports a fault, then closes. */
  fail(message: string): void {
    this.#fail(message);
  }

  #fail(_message: string): void {
    if (this.#readyState === SOCKET_CLOSED) return;
    this.#emit(new Event("error"), this.onerror);
    this.acceptClose(1006, "", false);
  }

  #emit<E extends Event>(event: E, handler: ((event: E) => void) | null): void {
    try {
      handler?.call(this, event);
    } catch (error) {
      // A throwing handler must not stop the listeners registered separately,
      // nor take the carrier's frame loop down with it. reportError is the
      // platform's own route for exactly this: the error still reaches the
      // global handler and the console, without unwinding this call.
      const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
      if (typeof report === "function") report(error);
      else console.error("[YuriRTC] a websocket handler threw", error);
    }
    this.dispatchEvent(event);
  }
}
