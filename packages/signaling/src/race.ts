/**
 * Races the signaling legs.
 *
 * A zero hedge delay preserves the original eager race. A positive delay starts
 * the preferred leg immediately and staggers the fallbacks, avoiding redundant
 * Firebase work when the primary answers quickly without turning a slow primary
 * into a full sequential timeout.
 */

import { AnswerBlob, OfferBlob, SignalBackend, SignalError, isAbort } from "./types.js";

export interface RaceResult {
  answer: AnswerBlob;
  /** Which leg won. Worth reporting — it is how you notice a leg has died. */
  backend: string;
  elapsedMs: number;
}

export interface RaceOptions {
  signal?: AbortSignal;
  onLegFailure?: (backend: string, error: unknown) => void;
  /**
   * Delay between starting successive backends. A failed active cohort starts
   * the next backend immediately rather than waiting out the delay.
   */
  hedgeDelayMs?: number;
}

export async function raceBackends(
  backends: readonly SignalBackend[],
  offer: OfferBlob,
  options: RaceOptions = {}
): Promise<RaceResult> {
  if (backends.length === 0) throw new SignalError("no backends configured", "race");

  const hedgeDelay = options.hedgeDelayMs ?? 0;
  if (!Number.isFinite(hedgeDelay) || hedgeDelay < 0) {
    throw new SignalError("hedgeDelayMs must be a finite non-negative number", "race");
  }

  const started = Date.now();
  const controller = new AbortController();
  const failures: unknown[] = new Array(backends.length);
  let active = 0;
  let next = 0;
  let settled = false;
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHedge = (): void => {
    if (hedgeTimer === undefined) return;
    clearTimeout(hedgeTimer);
    hedgeTimer = undefined;
  };

  let rejectRace!: (reason: unknown) => void;
  const onOuterAbort = (): void => {
    if (settled) return;
    settled = true;
    clearHedge();
    controller.abort();
    rejectRace(new DOMException("aborted", "AbortError"));
  };

  try {
    return await new Promise<RaceResult>((resolve, reject) => {
      rejectRace = reject;

      const launchNext = (): void => {
        if (settled || next >= backends.length) return;
        clearHedge();

        const index = next++;
        const backend = backends[index]!;
        active++;

        void Promise.resolve()
          .then(() => backend.exchange(offer, controller.signal))
          .then(
            (answer) => {
              if (settled) return;
              settled = true;
              clearHedge();
              // Cancel active losers. Without this their polls and streams keep
              // running and keep billing.
              controller.abort();
              resolve({ answer, backend: backend.name, elapsedMs: Date.now() - started });
            },
            (error: unknown) => {
              active--;
              failures[index] = error;
              if (settled) return;

              // An abort after another leg won is routine and is suppressed by
              // `settled`; a leg's own timeout still participates in all-failed.
              if (!isAbort(error)) {
                try {
                  options.onLegFailure?.(backend.name, error);
                } catch {
                  // Diagnostics must never prevent the remaining legs running.
                }
              }

              if (active !== 0) return;
              clearHedge();
              if (next < backends.length) {
                // Every backend launched so far failed. Do not make a known-dead
                // primary consume the rest of the hedge window.
                launchNext();
                return;
              }

              settled = true;
              controller.abort();
              const causes = failures
                .slice(0, next)
                .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
                .join("; ");
              reject(new SignalError(`every signaling leg failed: ${causes}`, "race"));
            }
          );

        if (next >= backends.length) return;
        if (hedgeDelay === 0) {
          launchNext();
          return;
        }
        hedgeTimer = setTimeout(launchNext, hedgeDelay);
      };

      options.signal?.addEventListener("abort", onOuterAbort, { once: true });
      if (options.signal?.aborted) {
        onOuterAbort();
        return;
      }
      launchNext();
    });
  } finally {
    clearHedge();
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
