/**
 * Signaling contract shared by both legs.
 *
 * The interface deliberately carries no provider identity or addressing: the
 * RTDB leg signs in and keys by uid, the Firestore leg mints a capability id and
 * never authenticates at all. Leaking either scheme across this boundary is what
 * would shape the interface around one provider.
 */

export interface OfferBlob {
  /**
   * Client-generated random id, carried *inside* the payload so it is identical
   * on every leg regardless of how each one addresses the client. The node
   * dedupes on this; without it a raced offer opens two peer connections and
   * leaks one.
   */
  sessionId: string;
  sdp: string;
  candidates: RTCIceCandidateInit[];
}

export interface AnswerBlob {
  sdp: string;
  candidates: RTCIceCandidateInit[];
}

export interface SignalBackend {
  readonly name: string;
  /** Publish an offer, resolve with the node's answer. */
  exchange(offer: OfferBlob, signal: AbortSignal): Promise<AnswerBlob>;
}

export class SignalError extends Error {
  override name = "SignalError";
  constructor(
    message: string,
    readonly backend: string
  ) {
    super(message);
  }
}

/** Cryptographically random lowercase hex, `bytes * 2` characters long. */
export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Rejects when `signal` aborts, so a leg can race its own fetch against
 * cancellation without leaking a pending promise.
 */
export function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true }
    );
  });
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
