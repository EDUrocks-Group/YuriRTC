/**
 * The service-worker ↔ page bridge.
 *
 * `RTCPeerConnection` does not exist in `ServiceWorkerGlobalScope`, so the
 * connection lives in the page and the SW talks to it over `MessageChannel`.
 * The page owns the wire protocol and the data channel; the SW sends semantic
 * requests and receives semantic responses.
 *
 * Flow control is credit-based and not optional. Without it, a 90GB asset
 * arriving faster than the SW consumes it piles up in the page and OOMs the tab
 * — the postMessage boundary has no backpressure of its own.
 */

import {
  MAX_RESPONSE_CREDITS,
  RequestPriority,
  type HeaderPairs,
  type RequestHead,
  type ResponseHead
} from "@yurirtc/protocol";

/** Initial v3 response window. Each frame is at most 128 KiB. */
export const INITIAL_CREDIT: Readonly<Record<RequestPriority, number>> = {
  [RequestPriority.Interactive]: 8,
  [RequestPriority.Critical]: 32,
  [RequestPriority.Normal]: 24,
  [RequestPriority.Bulk]: 32
};

/** Replenish often enough to keep a high-RTT response window from draining. */
export const CREDIT_REFILL = 8;

/** Keep adaptive-window observations stable independently of refill batching. */
export const CREDIT_SAMPLE_FRAMES = 16;

/** A fast-draining stream grows one step at a time, up to the protocol cap. */
export const CREDIT_GROWTH_STEP = 8;
export { MAX_RESPONSE_CREDITS };

/** Independent page↔worker handshake budgets. */
export const WORKER_ATTACH_ACK_TIMEOUT_MS = 3_000;
export const WORKER_BOOTSTRAP_TIMEOUT_MS = 3_000;
/** The worker covers both page phases plus an explicit delivery margin. */
export const CARRIER_READY_TIMEOUT_MS =
  WORKER_ATTACH_ACK_TIMEOUT_MS + WORKER_BOOTSTRAP_TIMEOUT_MS + 1_000;
/** One stalled winner may expire while a standby still gets a full READY turn. */
export const CARRIER_ACQUIRE_TIMEOUT_MS = CARRIER_READY_TIMEOUT_MS * 3;

/**
 * Private hop-by-hop representation negotiation for the YuriRTC data channel.
 *
 * These deliberately are not Accept-Encoding/Content-Encoding. A synthesized
 * Fetch Response is not passed through the browser's HTTP content decoder, so
 * advertising ordinary HTTP gzip here would hand compressed bytes to the site.
 * Old nodes ignore the request header and old loaders never send it, making the
 * optimization independently deployable on either side of protocol v3.
 */
export const WIRE_ACCEPT_ENCODING_HEADER = "x-yurirtc-accept-wire-encoding";
export const WIRE_CONTENT_ENCODING_HEADER = "x-yurirtc-wire-encoding";

export function supportsWireGzip(): boolean {
  return typeof globalThis.DecompressionStream === "function";
}

export function decodeWireBody(
  body: ReadableStream<Uint8Array>,
  encoding: string | undefined
): ReadableStream<Uint8Array> {
  if (!encoding) return body;
  if (encoding.toLowerCase().trim() !== "gzip") {
    throw new Error(`unsupported YuriRTC wire encoding: ${encoding}`);
  }
  if (!supportsWireGzip()) {
    throw new Error("YuriRTC node sent gzip to a browser without DecompressionStream");
  }
  // DOM and WebWorker lib declarations disagree on whether the writable side
  // accepts BufferSource or Uint8Array, although Uint8Array is a BufferSource
  // in every target browser. Keep the cast at this boundary only.
  const decoder = new DecompressionStream("gzip") as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  return body.pipeThrough(decoder);
}

interface TransportRequestBody {
  readonly method: string;
  /** Firefox currently leaves this undefined on FetchEvent requests. */
  readonly body?: ReadableStream<Uint8Array> | null;
  blob(): Promise<Blob>;
}

/**
 * Expose a Fetch request body to the page transport.
 *
 * Chromium exposes FetchEvent.request.body and therefore keeps uploads truly
 * streaming. Firefox, and some Safari service-worker releases, expose the Body
 * mixin methods but leave Request.body nullish. Materialising a Blob is the
 * interoperable fallback in those engines. Blob.stream() avoids another full
 * Uint8Array copy and the page still fragments it into credit-controlled
 * YuriRTC frames.
 */
export async function requestBodyForTransport(
  request: TransportRequestBody
): Promise<ReadableStream<Uint8Array> | undefined> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  if (request.body) return request.body;

  const blob = await request.blob();
  return blob.size === 0 ? undefined : blob.stream();
}

export type SwToPage =
  | {
      t: "req";
      id: number;
      head: RequestHead;
      /** Transferred to the page; bytes are pulled only as node credit allows. */
      body?: ReadableStream<Uint8Array>;
    }
  | { t: "credit"; id: number; n: number }
  | { t: "cancel"; id: number }
  /** SW woke with no transport and is asking whoever is alive to reconnect. */
  | { t: "wake" }
  /** Another controlled tab already owns the live carrier; remain available. */
  | { t: "standby"; protocolVersion: number }
  /**
   * The port arrived and the worker will now route through it.
   *
   * Without this the page cannot tell when the worker is ready: postMessage is
   * asynchronous, so anything started immediately after handing over the port
   * races the worker receiving it, and gets passed through to the network.
   */
  | { t: "attached"; protocolVersion: number };

export type PageToSw =
  | { t: "ready"; clientId: string }
  | { t: "head"; id: number; head: ResponseHead }
  | {
      t: "body";
      id: number;
      /** Owns the complete wire frame; byteOffset skips its five-byte header. */
      chunk: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
    }
  | { t: "end"; id: number }
  | { t: "err"; id: number; message: string }
  /** Transport died; the SW should fail everything in flight rather than hang. */
  | { t: "down"; reason: string };

export function headerValue(headers: HeaderPairs, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of headers) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function withoutHeader(headers: HeaderPairs, name: string): HeaderPairs {
  const wanted = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() !== wanted);
}

/**
 * Headers a synthesized Response must not carry. Content-Encoding and
 * Content-Length describe the wire form the node already undid; leaving them on
 * makes the browser try to decode an already-decoded body or truncate it.
 */
const STRIPPED = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  WIRE_CONTENT_ENCODING_HEADER
]);

export function responseHeaders(headers: HeaderPairs): Headers {
  const out = new Headers();
  for (const [key, value] of headers) {
    if (STRIPPED.has(key.toLowerCase())) continue;
    out.append(key, value);
  }
  return out;
}

/** Fetch responses for these methods/statuses must not be given a body. */
export function responseCanHaveBody(method: string, status: number): boolean {
  if (method.toUpperCase() === "HEAD") return false;
  // Fetch's null-body statuses. Informational responses cannot ultimately be
  // synthesized by the Response constructor, but marking them bodyless still
  // lets the caller cancel their transport stream before reporting the error.
  return status !== 101 && status !== 103 && status !== 204 && status !== 205 && status !== 304;
}
