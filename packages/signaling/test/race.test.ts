import assert from "node:assert/strict";
import test from "node:test";

import { raceBackends } from "../src/race.js";
import { SignalError, randomId } from "../src/types.js";
import type { AnswerBlob, OfferBlob, SignalBackend } from "../src/types.js";

const offer: OfferBlob = { sessionId: "s1", sdp: "v=0", candidates: [] };
const answer: AnswerBlob = { sdp: "v=0-answer", candidates: [] };

function backend(
  name: string,
  behaviour: (signal: AbortSignal) => Promise<AnswerBlob>
): SignalBackend {
  return { name, exchange: (_offer, signal) => behaviour(signal) };
}

function delayed(ms: number, signal: AbortSignal): Promise<AnswerBlob> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(answer), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

test("the faster leg wins and is reported", async () => {
  const result = await raceBackends(
    [
      backend("slow", (s) => delayed(200, s)),
      backend("fast", (s) => delayed(10, s))
    ],
    offer
  );
  assert.equal(result.backend, "fast");
  assert.deepEqual(result.answer, answer);
});

test("the losing leg is aborted once someone wins", async () => {
  let aborted = false;
  await raceBackends(
    [
      backend("loser", (s) => {
        s.addEventListener("abort", () => {
          aborted = true;
        });
        return delayed(500, s);
      }),
      backend("winner", (s) => delayed(5, s))
    ],
    offer
  );
  assert.equal(aborted, true, "loser must be cancelled or it keeps billing");
});

test("a failing leg does not sink a working one", async () => {
  const failures: string[] = [];
  const result = await raceBackends(
    [
      backend("broken", () => Promise.reject(new SignalError("nope", "broken"))),
      backend("working", (s) => delayed(10, s))
    ],
    offer,
    { onLegFailure: (name) => failures.push(name) }
  );
  assert.equal(result.backend, "working");
  assert.deepEqual(failures, ["broken"]);
});

test("a throwing failure observer does not sink a working leg", async () => {
  const result = await raceBackends(
    [
      backend("broken", () => Promise.reject(new SignalError("nope", "broken"))),
      backend("working", (s) => delayed(5, s))
    ],
    offer,
    {
      onLegFailure: () => {
        throw new Error("observer failed");
      }
    }
  );
  assert.equal(result.backend, "working");
});

test("all legs failing surfaces every cause", async () => {
  await assert.rejects(
    raceBackends(
      [
        backend("a", () => Promise.reject(new SignalError("a down", "a"))),
        backend("b", () => Promise.reject(new SignalError("b down", "b")))
      ],
      offer
    ),
    (error: unknown) => {
      assert.ok(error instanceof SignalError);
      assert.match(error.message, /a down/);
      assert.match(error.message, /b down/);
      return true;
    }
  );
});

test("routine loser-cancellation is not reported as a leg failure", async () => {
  const failures: string[] = [];
  await raceBackends(
    [
      backend("loser", (s) => delayed(500, s)),
      backend("winner", (s) => delayed(5, s))
    ],
    offer,
    { onLegFailure: (name) => failures.push(name) }
  );
  assert.deepEqual(failures, [], "an abort is the race working, not a failure");
});

test("a hedge does not start the fallback when the primary wins quickly", async () => {
  let fallbackStarted = false;
  const result = await raceBackends(
    [
      backend("primary", (s) => delayed(5, s)),
      backend("fallback", async () => {
        fallbackStarted = true;
        return answer;
      })
    ],
    offer,
    { hedgeDelayMs: 100 }
  );

  assert.equal(result.backend, "primary");
  assert.equal(fallbackStarted, false, "an unused fallback should incur no signaling cost");
});

test("a slow primary starts the fallback after the hedge delay", async () => {
  const launches: Array<{ name: string; at: number }> = [];
  const started = Date.now();
  const result = await raceBackends(
    [
      backend("primary", (s) => {
        launches.push({ name: "primary", at: Date.now() - started });
        return delayed(200, s);
      }),
      backend("fallback", (s) => {
        launches.push({ name: "fallback", at: Date.now() - started });
        return delayed(5, s);
      })
    ],
    offer,
    { hedgeDelayMs: 30 }
  );

  assert.equal(result.backend, "fallback");
  assert.deepEqual(launches.map(({ name }) => name), ["primary", "fallback"]);
  assert.ok(launches[1]!.at >= 20, `fallback started too early at ${launches[1]!.at}ms`);
});

test("a failed primary starts the fallback without waiting for the hedge", async () => {
  const started = Date.now();
  let fallbackAt = Number.POSITIVE_INFINITY;
  const result = await raceBackends(
    [
      backend("primary", () => Promise.reject(new SignalError("down", "primary"))),
      backend("fallback", async () => {
        fallbackAt = Date.now() - started;
        return answer;
      })
    ],
    offer,
    { hedgeDelayMs: 1_000 }
  );

  assert.equal(result.backend, "fallback");
  assert.ok(fallbackAt < 200, `known failure waited ${fallbackAt}ms for the hedge`);
});

test("successive fallbacks are staggered rather than launched as one cohort", async () => {
  const launches: string[] = [];
  const result = await raceBackends(
    [
      backend("one", (s) => {
        launches.push("one");
        return delayed(200, s);
      }),
      backend("two", (s) => {
        launches.push("two");
        return delayed(200, s);
      }),
      backend("three", async () => {
        launches.push("three");
        return answer;
      })
    ],
    offer,
    { hedgeDelayMs: 20 }
  );

  assert.equal(result.backend, "three");
  assert.deepEqual(launches, ["one", "two", "three"]);
  assert.ok(result.elapsedMs >= 30, `fallbacks were not staggered: ${result.elapsedMs}ms`);
});

test("invalid hedge delays fail before any backend starts", async () => {
  let started = false;
  await assert.rejects(
    raceBackends(
      [backend("unused", async () => {
        started = true;
        return answer;
      })],
      offer,
      { hedgeDelayMs: -1 }
    ),
    /hedgeDelayMs/
  );
  assert.equal(started, false);
});

test("no backends configured is an error, not a hang", async () => {
  await assert.rejects(raceBackends([], offer), /no backends configured/);
});

test("randomId is 128 bits of lowercase hex", () => {
  const id = randomId(16);
  assert.equal(id.length, 32);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(id, randomId(16));
});
