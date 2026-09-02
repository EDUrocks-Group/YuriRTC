/**
 * Firestore leg — capability-based and polled.
 *
 * Deliberately unauthenticated. If both legs signed in, a filter blocking
 * `identitytoolkit.googleapis.com` would take out the whole signaling layer and
 * the second leg would buy nothing. Here the 128-bit document id *is* the
 * authorisation: rules allow `get` but deny `list`, so a document is readable by
 * id while the collection stays unqueryable.
 *
 * It also saves a round trip on the cold-start path.
 */

import {
  AnswerBlob,
  OfferBlob,
  SignalBackend,
  SignalError,
  isAbort,
  randomId
} from "./types.js";
import { anySignal } from "./rtdb.js";

export interface FirestoreConfig {
  projectId: string;
  /**
   * Firestore-compatible REST root. Defaults to Google's service. A
   * root-relative value is resolved against the page origin, which lets
   * self-hosted deployments proxy signaling without changing this client.
   */
  baseUrl?: string;
  /** First poll is deferred by this much; the node is usually done by then. */
  firstPollMs?: number;
  /** Initial interval between subsequent polls. Every poll is a billed read. */
  pollIntervalMs?: number;
  /** Ceiling for exponential poll backoff (defaults to 3200ms). */
  maxPollIntervalMs?: number;
  timeoutMs?: number;
  /** How long the document should live if the node never reaps it. */
  ttlSeconds?: number;
}

const DOCUMENT_BUDGET_BYTES = 16 * 1024;

export class FirestoreBackend implements SignalBackend {
  readonly name = "firestore";

  constructor(private readonly config: FirestoreConfig) {}

  async exchange(offer: OfferBlob, signal: AbortSignal): Promise<AnswerBlob> {
    const firstPoll = this.config.firstPollMs ?? 1_000;
    const interval = this.config.pollIntervalMs ?? 800;
    const maxInterval = Math.max(interval, this.config.maxPollIntervalMs ?? 3_200);
    const timeout = this.config.timeoutMs ?? 8_000;
    const ttl = this.config.ttlSeconds ?? 300;

    const combined = anySignal([signal, AbortSignal.timeout(timeout)]);
    const capability = randomId(16);
    const serviceRoot = firestoreServiceRoot(this.config.baseUrl);
    const base =
      `${serviceRoot}/v1/projects/${encodeURIComponent(this.config.projectId)}` +
      `/databases/(default)/documents/signal/${capability}`;

    const payload = JSON.stringify(offer);
    if (payload.length > DOCUMENT_BUDGET_BYTES) {
      throw new SignalError(
        `offer of ${payload.length}B exceeds the ${DOCUMENT_BUDGET_BYTES}B rule budget`,
        this.name
      );
    }

    // Typed-value encoding is Firestore's wart. Do not fight it: one stringValue.
    // The PATCH response normally echoes the complete document. Projecting the
    // not-yet-present answer field keeps our offer out of a response we ignore.
    const answerOnly = `${base}?mask.fieldPaths=answer`;
    const created = await fetch(answerOnly, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fields: {
          offer: { stringValue: payload },
          expireAt: { timestampValue: new Date(Date.now() + ttl * 1000).toISOString() }
        }
      }),
      signal: combined
    });
    if (!created.ok) {
      throw new SignalError(`offer write failed: ${created.status}`, this.name);
    }

    await sleep(firstPoll, combined);
    let nextInterval = interval;
    for (;;) {
      const answer = await this.poll(base, combined);
      if (answer) return answer;
      await sleep(nextInterval, combined);
      nextInterval = nextPollInterval(nextInterval, maxInterval);
    }
  }

  private async poll(base: string, signal: AbortSignal): Promise<AnswerBlob | null> {
    // Project only `answer` — it does not reduce the billed read, but it keeps
    // the offer we just wrote out of every response body.
    const response = await fetch(`${base}?mask.fieldPaths=answer`, { signal });

    // Creation is strongly consistent. Once our PATCH succeeded, a 404 means
    // the node discarded this raced offer (or its answer expired); polling the
    // missing capability can never produce an answer and only burns reads.
    if (response.status === 404) {
      throw new SignalError("answer document disappeared", this.name);
    }
    if (!response.ok) {
      throw new SignalError(`poll failed: ${response.status}`, this.name);
    }

    const body = (await response.json()) as {
      fields?: { answer?: { stringValue?: string } };
    };
    const raw = body.fields?.answer?.stringValue;
    if (!raw) return null;

    let answer: AnswerBlob;
    try {
      answer = JSON.parse(raw) as AnswerBlob;
    } catch {
      throw new SignalError("answer field is not valid JSON", this.name);
    }
    if (typeof answer.sdp !== "string" || !Array.isArray(answer.candidates)) {
      throw new SignalError("answer is missing sdp/candidates", this.name);
    }
    return answer;
  }
}

export function firestoreServiceRoot(configured?: string): string {
  if (!configured) return "https://firestore.googleapis.com";
  const fallback = typeof globalThis.location?.origin === "string"
    ? globalThis.location.origin
    : "https://firestore.googleapis.com";
  const parsed = new URL(configured, fallback);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SignalError("Firestore base URL must use HTTP or HTTPS", "firestore");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/+$/, "");
}

export function nextPollInterval(current: number, maximum: number): number {
  return Math.min(maximum, current * 2);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export { isAbort };
