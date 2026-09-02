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
  refreshToken: string;
  expiresIn: string;
}

interface RefreshResponse {
  id_token: string;
  refresh_token: string;
  user_id: string;
  expires_in: string;
}

interface StoredIdentity {
  idToken: string;
  localId: string;
  refreshToken: string;
  expiresAt: number;
}

const AUTH_EXPIRY_SKEW_MS = 60_000;
const authInFlight = new Map<string, Promise<StoredIdentity>>();

export class RtdbBackend implements SignalBackend {
  readonly name = "rtdb";

  constructor(private readonly config: RtdbConfig) {}

  async exchange(offer: OfferBlob, signal: AbortSignal): Promise<AnswerBlob> {
    const timeout = this.config.timeoutMs ?? 15_000;
    const timer = AbortSignal.timeout(timeout);
    const combined = anySignal([signal, timer]);

    const identity = await this.identity(combined);
    const { idToken, localId } = identity;
    const base = this.config.databaseUrl.replace(/\/+$/, "");
    const auth = encodeURIComponent(idToken);
    const operation = new AbortController();
    const active = anySignal([combined, operation.signal]);

    // The identity is deliberately reused, so replace the complete branch
    // before opening the stream. That atomically removes any answer left from a
    // prior connection; the EventSource's initial snapshot still catches an
    // answer the node writes between this PUT and stream establishment.
    const write = await fetch(
      `${base}/signal/${localId}.json?auth=${auth}&print=silent`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer }),
        signal: active
      }
    );
    if (!write.ok) {
      // 401 means the cached credential is unusable. A 403 can instead mean
      // deployment rules or App Check rejected an otherwise valid identity;
      // minting another anonymous account would repeat the failure and cost.
      if (write.status === 401) this.clearIdentity(identity);
      throw new SignalError(`offer write failed: ${write.status}`, this.name);
    }

    const answer = this.awaitAnswer(
      `${base}/signal/${localId}/answer.json?auth=${auth}`,
      active
    );

    try {
      return await answer;
    } finally {
      operation.abort();
    }
  }

  private async identity(signal: AbortSignal): Promise<StoredIdentity> {
    const key = this.identityKey();
    const cached = this.readIdentity();
    if (cached && cached.expiresAt > Date.now() + AUTH_EXPIRY_SKEW_MS) return cached;

    const pending = authInFlight.get(key);
    if (pending) return pending;
    const operation = this.acquireIdentity(cached, signal).finally(() => {
      if (authInFlight.get(key) === operation) authInFlight.delete(key);
    });
    authInFlight.set(key, operation);
    return operation;
  }

  private async acquireIdentity(
    cached: StoredIdentity | null,
    signal: AbortSignal
  ): Promise<StoredIdentity> {
    if (cached?.refreshToken) {
      try {
        const refreshed = await this.refresh(cached, signal);
        this.writeIdentity(refreshed);
        return refreshed;
      } catch (error) {
        if (isAbort(error)) throw error;
        this.clearIdentity(cached);
      }
    }

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
    if (!body.idToken || !body.localId || !body.refreshToken) {
      throw new SignalError("sign-in response missing token identity", this.name);
    }
    const identity = storedIdentity(
      body.idToken,
      body.localId,
      body.refreshToken,
      body.expiresIn
    );
    this.writeIdentity(identity);
    return identity;
  }

  private async refresh(
    cached: StoredIdentity,
    signal: AbortSignal
  ): Promise<StoredIdentity> {
    const response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.config.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: cached.refreshToken
        }),
        signal
      }
    );
    if (!response.ok) {
      throw new SignalError(`anonymous token refresh failed: ${response.status}`, this.name);
    }
    const body = (await response.json()) as Partial<RefreshResponse>;
    if (!body.id_token || !body.refresh_token) {
      throw new SignalError("refresh response missing token identity", this.name);
    }
    return storedIdentity(
      body.id_token,
      body.user_id ?? cached.localId,
      body.refresh_token,
      body.expires_in
    );
  }

  private identityKey(): string {
    return `yurirtc:rtdb-auth:${this.config.apiKey}:${this.config.databaseUrl.replace(/\/+$/, "")}`;
  }

  private readIdentity(): StoredIdentity | null {
    try {
      const raw = globalThis.localStorage?.getItem(this.identityKey());
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<StoredIdentity>;
      if (
        typeof value.idToken === "string" &&
        typeof value.localId === "string" &&
        typeof value.refreshToken === "string" &&
        Number.isFinite(value.expiresAt)
      ) return value as StoredIdentity;
    } catch {
      // Private contexts and strict storage policies may reject localStorage.
    }
    return null;
  }

  private writeIdentity(identity: StoredIdentity): void {
    try {
      globalThis.localStorage?.setItem(this.identityKey(), JSON.stringify(identity));
    } catch {
      /* anonymous auth reuse is an optional cost optimization */
    }
  }

  private clearIdentity(identity: StoredIdentity): void {
    try {
      const current = this.readIdentity();
      if (!current || current.refreshToken === identity.refreshToken) {
        globalThis.localStorage?.removeItem(this.identityKey());
      }
    } catch {
      /* storage is optional */
    }
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

function storedIdentity(
  idToken: string,
  localId: string,
  refreshToken: string,
  expiresIn: string | undefined
): StoredIdentity {
  const seconds = Number(expiresIn);
  const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 3_600_000;
  return { idToken, localId, refreshToken, expiresAt: Date.now() + lifetimeMs };
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
