/**
 * Wire format shared by the service worker and the content node.
 *
 * Every frame is `[u8 type][u32be requestId][payload]`. Frames for a given
 * requestId form an ordered stream. A request stays on one lane in the fixed
 * v3 SCTP pool; frames for different requests interleave freely on that lane.
 */

/**
 * Version 3 is intentionally a hard cut-over. The content node and browser
 * loader are deployed as a pair, so retaining the old optional flow-control
 * modes would make malformed/old peers silently fall back to unbounded request
 * or response queues.
 */
export const PROTOCOL_VERSION = 3 as const;

/** Lower values are scheduled first by the content node. */
export enum RequestPriority {
  /** Navigations, API calls, and user-initiated mutations. */
  Interactive = 0,
  /** Render-blocking scripts, styles, fonts, workers, and WebAssembly. */
  Critical = 1,
  /** Images and ordinary static resources. */
  Normal = 2,
  /** Large game/media payloads which must not delay the app shell. */
  Bulk = 3
}

export enum FrameType {
  /** client -> node: JSON `RequestHead`, opens a request */
  Req = 1,
  /** client -> node: raw request body bytes */
  ReqBody = 2,
  /** client -> node: request body complete */
  ReqEnd = 3,
  /** node -> client: JSON `ResponseHead` */
  ResHead = 4,
  /** node -> client: raw response body bytes */
  ResBody = 5,
  /** node -> client: response body complete */
  ResEnd = 6,
  /** node -> client: JSON `ProtocolErrorPayload`, terminates the request */
  ResErr = 7,
  /** client -> node: abandon the request, stop reading and free resources */
  Cancel = 8,
  /** client -> node: permit more response-body frames for this request */
  Credit = 9,
  /** node -> client: permit more request-body frames for this request */
  ReqCredit = 10,

  /*
   * WebSocket streams.
   *
   * A websocket occupies a requestId like any other exchange, but the frames
   * for it flow in both directions for as long as it is open rather than
   * turning around once. It cannot be modelled as a request: a service worker
   * never sees a websocket handshake, so a socket that must cross the carrier
   * has to be opened explicitly by the page and carried here.
   *
   * Flow control reuses the existing credit frames unchanged. Credit still
   * means "the node may send more", ReqCredit still means "the browser may
   * send more"; for a socket both simply keep replenishing instead of running
   * down once. WsOpen carries the initial grant in each direction.
   */

  /** client -> node: JSON `WebSocketOpen`, opens a socket on this requestId */
  WsOpen = 11,
  /** node -> client: JSON `WebSocketOpened`, the handshake succeeded */
  WsOpened = 12,
  /** both directions: `[u8 kind][payload]`, one websocket message */
  WsData = 13,
  /** both directions: `[u16be code][utf8 reason]`, closes the socket */
  WsClose = 14
}

/** How a WsData payload should be surfaced to the peer. */
export enum WebSocketDataKind {
  Text = 0,
  Binary = 1
}

export interface WebSocketOpen {
  /** Required so an older loader can never accidentally talk to a v3 node. */
  version: typeof PROTOCOL_VERSION;
  /** Origin-relative: pathname + search. Never an absolute URL. */
  url: string;
  protocols: readonly string[];
  /** Frames the node may send before it has been granted more. */
  initialCredits: number;
}

export interface WebSocketOpened {
  /** The subprotocol the upstream selected, or "" when it selected none. */
  protocol: string;
}


export const HEADER_BYTES = 5;

/**
 * Chrome and Pion negotiate 256 KiB messages in production. Keeping frames at
 * half that ceiling cuts body-message and MessagePort scheduling overhead in
 * half versus v1 while preserving headroom for SCTP implementation limits.
 * This is the total frame size; payloads are bounded by MAX_PAYLOAD_BYTES.
 */
export const MAX_FRAME_BYTES = 128 * 1024;
export const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - HEADER_BYTES;

/**
 * Maximum response frames that may be in flight for one request. At the
 * 128 KiB frame ceiling this is just under 8 MiB: enough bandwidth-delay
 * product for a fast WAN path without allowing one request to queue an
 * unbounded amount of memory in Chrome or Pion.
 */
export const MAX_RESPONSE_CREDITS = 64;

/**
 * Maximum request-body frames the browser may have outstanding. Sixteen full
 * frames are just under 2 MiB, keeping uploads moving without allowing a slow
 * backend to turn the page, MessagePort, or node into an unbounded queue.
 */
export const MAX_REQUEST_CREDITS = 16;

/**
 * Close codes the carrier itself originates.
 *
 * 1006 is deliberately absent: it means "closed abnormally, no close frame
 * seen" and the spec reserves it for endpoints to synthesise locally, so
 * sending it over the wire would be a protocol violation.
 */
export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_GOING_AWAY = 1001;
/** The carrier dropped underneath an open socket. */
export const WS_CLOSE_CARRIER_LOST = 4001;

/** Largest websocket message the carrier will relay, in either direction. */
export const MAX_WS_MESSAGE_BYTES = MAX_PAYLOAD_BYTES - 1;

/**
 * Websocket frames the node may send before the browser replenishes.
 *
 * One credit is one message regardless of size, so this window is a hard
 * messages-per-round-trip ceiling. Wisp-style carried sockets multiplex many
 * small messages, which made the former window of 16 the binding throughput
 * limit (~160 messages/second at 100 ms RTT). Byte pressure is bounded on the
 * node side by the shared association watermarks, not by this count.
 *
 * Deploy ordering: the node rejects a WsOpen whose initialCredits exceed its
 * own cap, so its cap must be raised (and deployed) before this constant.
 * Equal to MAX_RESPONSE_CREDITS; the node clamps grants there.
 */
export const MAX_WS_CREDITS = 64;

/** requestId 0 is reserved so an uninitialised id fails loudly. */
export const MIN_REQUEST_ID = 1;
export const MAX_REQUEST_ID = 0xffffffff;

/**
 * Headers travel as pairs rather than an object because duplicates are
 * significant — notably `Set-Cookie`, which the service worker consumes to
 * maintain the service-worker cookie jar.
 */
export type HeaderPairs = ReadonlyArray<readonly [string, string]>;

export interface RequestHead {
  /** Required so an older loader can never accidentally talk to a v3 node. */
  version: typeof PROTOCOL_VERSION;
  method: string;
  /** Origin-relative: pathname + search. Never an absolute URL. */
  url: string;
  headers: HeaderPairs;
  hasBody: boolean;
  /** Scheduling class used across the peer's fixed data-channel pool. */
  priority: RequestPriority;
  /**
   * Response frames the node may send immediately. Further slots arrive in
   * Credit frames only after the service worker consumes body chunks.
   */
  initialCredits: number;
}

export interface ResponseHead {
  status: number;
  statusText: string;
  headers: HeaderPairs;
}

export interface ProtocolErrorPayload {
  message: string;
  /** Set when the node mapped a host-side error, e.g. ENOENT -> 404. */
  code?: string;
}

export interface Frame {
  type: FrameType;
  requestId: number;
  payload: Uint8Array;
}

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

const KNOWN_TYPES = new Set<number>([
  FrameType.Req,
  FrameType.ReqBody,
  FrameType.ReqEnd,
  FrameType.ResHead,
  FrameType.ResBody,
  FrameType.ResEnd,
  FrameType.ResErr,
  FrameType.Cancel,
  FrameType.Credit,
  FrameType.ReqCredit,
  FrameType.WsOpen,
  FrameType.WsOpened,
  FrameType.WsData,
  FrameType.WsClose
]);

export function isFrameType(value: number): value is FrameType {
  return KNOWN_TYPES.has(value);
}

export function isValidRequestId(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_REQUEST_ID && value <= MAX_REQUEST_ID;
}
