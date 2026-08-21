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
  "set-cookie"
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
