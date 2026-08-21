import assert from "node:assert/strict";
import test from "node:test";

import { RETRY_BASE_DELAYS_MS, retryDelayMs } from "../src/retry.js";

test("retry jitter spreads every attempt and stays within the five-minute UI bound", () => {
  for (let attempt = 1; attempt <= RETRY_BASE_DELAYS_MS.length + 3; attempt += 1) {
    const base = RETRY_BASE_DELAYS_MS[
      Math.min(attempt - 1, RETRY_BASE_DELAYS_MS.length - 1)
    ]!;
    assert.equal(retryDelayMs(attempt, () => 0), Math.round(base * 0.75));
    assert.equal(retryDelayMs(attempt, () => 0.5), base);
    assert.equal(retryDelayMs(attempt, () => 1), Math.round(base * 1.25));
    assert.ok(retryDelayMs(attempt, () => 1) <= 300_000);
  }
});

test("retry jitter clamps hostile random sources", () => {
  assert.equal(retryDelayMs(1, () => -10), 750);
  assert.equal(retryDelayMs(1, () => 10), 1_250);
  assert.equal(retryDelayMs(1, () => Number.NaN), 1_000);
});
