/**
 * Detects a lossy/slow UDP route from application bytes that actually reached
 * the browser. Signalling, server think time and cache reads before the first
 * body frame are deliberately outside the sample.
 *
 * The monitor aggregates concurrent GETs. Measuring each request separately
 * would mistake a healthy connection shared by an asset waterfall for a slow
 * route. It only recommends; the client owns the safety decision about when a
 * connection can be replaced.
 */

export const ADAPTIVE_TCP_MIN_BYTES = 8 * 1024 * 1024;
export const ADAPTIVE_TCP_MIN_SAMPLE_MS = 4_000;
export const ADAPTIVE_TCP_MAX_GOODPUT_MBPS = 15;
export const ROUTE_PREFERENCE_TTL_MS = 10 * 60 * 1_000;

export type MeasuredTransport = "udp" | "tcp" | "unknown";

export interface GoodputMonitorOptions {
  minBytes?: number;
  minSampleMs?: number;
  maxGoodputMbps?: number;
}

interface StoredRoutePreference {
  transport: "auto" | "tcp";
  expiresAt: number;
}

/** Read a short-lived, origin-local result without assuming Storage is usable. */
export function readRoutePreference(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined,
  key: string,
  now = Date.now()
): "auto" | "tcp" | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredRoutePreference>;
    if (
      (value.transport === "auto" || value.transport === "tcp") &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt! > now
    ) {
      return value.transport;
    }
    storage.removeItem(key);
  } catch {
    // Hardened/private contexts may reject all Storage access.
  }
  return null;
}

export function rememberRoutePreference(
  storage: Pick<Storage, "setItem"> | undefined,
  key: string,
  transport: "auto" | "tcp",
  now = Date.now(),
  ttlMs = ROUTE_PREFERENCE_TTL_MS
): void {
  if (!storage || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
  try {
    storage.setItem(key, JSON.stringify({ transport, expiresAt: now + ttlMs }));
  } catch {
    /* optional optimization only */
  }
}

export function rememberTcpPreference(
  storage: Pick<Storage, "setItem"> | undefined,
  key: string,
  now = Date.now(),
  ttlMs = ROUTE_PREFERENCE_TTL_MS
): void {
  rememberRoutePreference(storage, key, "tcp", now, ttlMs);
}

export function clearRoutePreference(
  storage: Pick<Storage, "removeItem"> | undefined,
  key: string
): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* optional optimization only */
  }
}

export class ResponseGoodputMonitor {
  private transport: MeasuredTransport = "unknown";
  private readonly gets = new Set<number>();
  private sampleStartedAt: number | undefined;
  private sampleBytes = 0;
  private recommended = false;
  private readonly minBytes: number;
  private readonly minSampleMs: number;
  private readonly maxGoodputMbps: number;

  constructor(options: GoodputMonitorOptions = {}) {
    this.minBytes = positive(options.minBytes, ADAPTIVE_TCP_MIN_BYTES);
    this.minSampleMs = positive(options.minSampleMs, ADAPTIVE_TCP_MIN_SAMPLE_MS);
    this.maxGoodputMbps = positive(
      options.maxGoodputMbps,
      ADAPTIVE_TCP_MAX_GOODPUT_MBPS
    );
  }

  setTransport(transport: MeasuredTransport): void {
    this.transport = transport;
    // A reconnect or network transition is a new route sample. Suppress
    // duplicate callbacks only within one route, not for the lifetime of the
    // page-side client object.
    this.recommended = false;
    this.resetSample();
  }

  beginRequest(requestId: number, method: string): void {
    if (this.recommended || this.transport !== "udp") return;
    if (method.toUpperCase() === "GET") this.gets.add(requestId);
  }

  /** Returns true exactly once, when the current UDP sample warrants TCP. */
  recordBody(requestId: number, bytes: number, now: number): boolean {
    if (
      this.recommended ||
      this.transport !== "udp" ||
      !this.gets.has(requestId) ||
      !Number.isFinite(bytes) ||
      bytes <= 0 ||
      !Number.isFinite(now)
    ) return false;

    if (this.sampleStartedAt === undefined) this.sampleStartedAt = now;
    this.sampleBytes += bytes;
    const elapsedMs = Math.max(0, now - this.sampleStartedAt);
    if (elapsedMs < this.minSampleMs || this.sampleBytes < this.minBytes) return false;

    const goodputMbps = (this.sampleBytes * 8) / (elapsedMs * 1_000);
    if (goodputMbps >= this.maxGoodputMbps) return false;
    this.recommended = true;
    return true;
  }

  endRequest(requestId: number): void {
    this.gets.delete(requestId);
    // Separate request bursts must not be joined across an idle interval.
    if (this.gets.size === 0 && !this.recommended) this.resetSample();
  }

  private resetSample(): void {
    this.gets.clear();
    this.sampleStartedAt = undefined;
    this.sampleBytes = 0;
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** ICE candidates have a stable protocol field in both SDP and init strings. */
export function iceCandidateProtocol(candidate: unknown): MeasuredTransport | "other" {
  const match = String(candidate).trim().match(
    /^(?:a=)?candidate:\S+\s+\d+\s+([^\s]+)/i
  );
  const protocol = match?.[1]?.toLowerCase();
  if (protocol === "udp" || protocol === "tcp") return protocol;
  return "other";
}

/**
 * Removes every non-matching in-SDP and separately signalled candidate. This
 * is preferable to monkey-patching RTCPeerConnection and is supported by the
 * same browser APIs in Chrome, Firefox and Safari.
 */
export function forceAnswerTransport<T extends {
  sdp: string;
  candidates: RTCIceCandidateInit[];
}>(answer: T, transport: "tcp"): T {
  const sdp = answer.sdp.replace(
    /^a=candidate:[^\r\n]*(?:\r\n|\n|$)/gim,
    (line) => iceCandidateProtocol(line) === transport ? line : ""
  );
  const candidates = answer.candidates.filter(
    (candidate) => iceCandidateProtocol(candidate.candidate) === transport
  );
  const sdpHasCandidate = /^a=candidate:[^\r\n]*/gim.test(sdp);
  if (!sdpHasCandidate && candidates.length === 0) {
    throw new Error("server answer has no TCP ICE candidate");
  }
  return { ...answer, sdp, candidates };
}
