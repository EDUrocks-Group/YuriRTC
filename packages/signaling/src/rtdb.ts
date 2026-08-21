/**
 * RTDB leg — authenticated and streaming.
 *
 * REST plus `EventSource` rather than the Firebase SDK: the SDK is ~100KB
 * gzipped and sits on the cold-start path in front of first paint, where this
 * is a few hundred bytes.
 *
 * `EventSource` cannot set an `Authorization` header, which is exactly why RTDB
 * accepts `?auth=`.
 */

import {
  AnswerBlob,
  OfferBlob,
  SignalBackend,
  SignalError,
  abortPromise,
  isAbort
} from "./types.js";

export interface RtdbConfig {
  /** Web API key. Public by design — the security rules enforce access. */
  apiKey: string;
  /**
   * Full database URL from the console, e.g.
   * `https://NAME-default-rtdb.REGION.firebasedatabase.app`.
   * Read it, do not construct it — the region-shaped form is easy to get wrong.
   */
  databaseUrl: string;
  /** Give up and let the other leg win. */
  timeoutMs?: number;
}

interface SignUpResponse {
  idToken: string;
  localId: string;
}

export class RtdbBackend implements SignalBackend {
  readonly name = "rtdb";

  constructor(private readonly config: RtdbConfig) {}

  async exchange(offer: OfferBlob, signal: AbortSignal): Promise<AnswerBlob> {
    const timeout = this.config.timeoutMs ?? 15_000;
    const timer = AbortSignal.timeout(timeout);
    const combined = anySignal([signal, timer]);

    const { idToken, localId } = await this.signIn(combined);
    const base = this.config.databaseUrl.replace(/\/+$/, "");
    const auth = encodeURIComponent(idToken);
    const operation = new AbortController();
    const active = anySignal([combined, operation.signal]);

    // This uid is freshly minted, so its answer leaf cannot be stale. Open the
    // stream before issuing the write and overlap their network setup. If either
    // side fails, abort the other so neither a fetch nor an EventSource leaks.
    const answer = this.awaitAnswer(
      `${base}/signal/${localId}/answer.json?auth=${auth}`,
      active
    );
    const write = fetch(
      `${base}/signal/${localId}/offer.json?auth=${auth}&print=silent`,
      {
        method: "PUT",
        body: JSON.stringify(offer),
        signal: active
      }
    ).then((response) => {
      if (!response.ok) {
        throw new SignalError(`offer write failed: ${response.status}`, this.name);
      }
    });

    try {
      const [, result] = await Promise.all([write, answer]);
      return result;
    } finally {
      operation.abort();
    }
  }

  private async signIn(signal: AbortSignal): Promise<SignUpResponse> {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true }),
        signal
      }
    );
    if (!response.ok) {
      throw new SignalError(`anonymous sign-in failed: ${response.status}`, this.name);
    }
    const body = (await response.json()) as Partial<SignUpResponse>;
    if (!body.idToken || !body.localId) {
      throw new SignalError("sign-in response missing idToken/localId", this.name);
    }
    return { idToken: body.idToken, localId: body.localId };
  }

  /**
   * RTDB's REST API answers with 307 redirects to a shard host and the client
   * must follow them. `EventSource` does so on its own; an allowlist that pins
   * the exact hostname will not.
   */
  private awaitAnswer(url: string, signal: AbortSignal): Promise<AnswerBlob> {
    return new Promise<AnswerBlob>((resolve, reject) => {
      const source = new EventSource(url);

      const close = (): void => {
        source.close();
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        close();
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      const onPayload = (event: MessageEvent<string>): void => {
        // Server-sent frames are `{"path":"/","data":<value>}`; `data` is null
        // until the node writes, and `path` is "/" because we stream one leaf.
        let envelope: { path?: string; data?: unknown };
        try {
          envelope = JSON.parse(event.data) as { path?: string; data?: unknown };
        } catch {
          return;
        }
        if (envelope.data === null || envelope.data === undefined) return;
        const answer = envelope.data as AnswerBlob;
        if (typeof answer.sdp !== "string" || !Array.isArray(answer.candidates)) return;
        close();
        resolve(answer);
      };

      source.addEventListener("put", onPayload as EventListener);
      source.addEventListener("patch", onPayload as EventListener);
      source.addEventListener("cancel", () => {
        close();
        reject(new SignalError("stream cancelled by server (rules denied?)", this.name));
      });
      source.onerror = (): void => {
        // EventSource retries on its own; only a closed stream is terminal.
        if (source.readyState === EventSource.CLOSED) {
          close();
          reject(new SignalError("answer stream closed", this.name));
        }
      };
    }).catch((error: unknown) => {
      if (isAbort(error)) throw error;
      throw error instanceof SignalError
        ? error
        : new SignalError(String(error), this.name);
    });
  }
}

/** `AbortSignal.any` is not in every target yet; this is the same contract. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true
    });
  }
  return controller.signal;
}

export { abortPromise };
