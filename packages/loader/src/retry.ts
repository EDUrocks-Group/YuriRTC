/**
 * Reconnect pacing shared by the carrier lifecycle and focused tests.
 *
 * A deterministic retry schedule turns a regional outage into a Firebase and
 * content-node thundering herd. The final base stays below five minutes so its
 * jitter remains representable by the loader UI's existing 300-second bound.
 */
export const RETRY_BASE_DELAYS_MS = [
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  30_000,
  60_000,
  120_000,
  240_000
] as const;

export function retryDelayMs(attempt: number, random = Math.random): number {
  const index = Math.max(0, Math.min(Math.trunc(attempt) - 1, RETRY_BASE_DELAYS_MS.length - 1));
  const base = RETRY_BASE_DELAYS_MS[index]!;
  const sampled = random();
  const sample = Number.isFinite(sampled) ? Math.max(0, Math.min(1, sampled)) : 0.5;
  // 0.75x..1.25x: enough spread to protect the service without making the
  // first recovery feel arbitrary or exceeding the UI's five-minute ceiling.
  return Math.round(base * (0.75 + sample * 0.5));
}
