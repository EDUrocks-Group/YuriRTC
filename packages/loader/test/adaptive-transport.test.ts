import assert from "node:assert/strict";
import test from "node:test";

import {
  ResponseGoodputMonitor,
  clearRoutePreference,
  forceAnswerTransport,
  iceCandidateProtocol,
  readRoutePreference,
  rememberRoutePreference
} from "../src/adaptive-transport.js";

test("goodput monitor recommends TCP once after a sustained slow UDP sample", () => {
  const monitor = new ResponseGoodputMonitor({
    minBytes: 1_000_000,
    minSampleMs: 1_000,
    maxGoodputMbps: 10
  });
  monitor.setTransport("udp");
  monitor.beginRequest(7, "GET");

  assert.equal(monitor.recordBody(7, 500_000, 100), false);
  assert.equal(monitor.recordBody(7, 500_000, 1_100), true);
  assert.equal(monitor.recordBody(7, 500_000, 2_100), false, "recommendation repeats");
});

test("a reconnected route gets a fresh adaptive sample", () => {
  const monitor = new ResponseGoodputMonitor({
    minBytes: 1_000,
    minSampleMs: 1_000,
    maxGoodputMbps: 1
  });
  monitor.setTransport("udp");
  monitor.beginRequest(1, "GET");
  assert.equal(monitor.recordBody(1, 1_000, 0), false);
  assert.equal(monitor.recordBody(1, 1, 1_000), true);

  monitor.setTransport("udp");
  monitor.beginRequest(2, "GET");
  assert.equal(monitor.recordBody(2, 1_000, 10_000), false);
  assert.equal(monitor.recordBody(2, 1, 11_000), true);
});

test("goodput monitor requires both duration and bytes and ignores fast samples", () => {
  const monitor = new ResponseGoodputMonitor({
    minBytes: 1_000_000,
    minSampleMs: 1_000,
    maxGoodputMbps: 10
  });
  monitor.setTransport("udp");
  monitor.beginRequest(1, "GET");

  assert.equal(monitor.recordBody(1, 1_000_000, 0), false, "duration was too short");
  assert.equal(monitor.recordBody(1, 1_000_000, 1_000), false, "16 Mbps is healthy");
  assert.equal(monitor.recordBody(1, 1_000_000, 3_000), true, "longer 8 Mbps sample is slow");
});

test("goodput monitor aggregates overlapping GETs but resets between idle bursts", () => {
  const monitor = new ResponseGoodputMonitor({
    minBytes: 1_000,
    minSampleMs: 1_000,
    maxGoodputMbps: 1
  });
  monitor.setTransport("udp");
  monitor.beginRequest(1, "get");
  monitor.beginRequest(2, "GET");
  assert.equal(monitor.recordBody(1, 400, 0), false);
  assert.equal(monitor.recordBody(2, 400, 1_000), false, "combined bytes remain below minimum");
  monitor.endRequest(1);
  monitor.endRequest(2);

  monitor.beginRequest(3, "GET");
  assert.equal(monitor.recordBody(3, 1_000, 10_000), false, "idle time leaked into sample");
  assert.equal(monitor.recordBody(3, 1, 11_000), true);
});

test("goodput monitor ignores TCP, non-GET requests, unknown ids, and invalid frames", () => {
  const monitor = new ResponseGoodputMonitor({ minBytes: 1, minSampleMs: 1, maxGoodputMbps: 1 });
  monitor.setTransport("tcp");
  monitor.beginRequest(1, "GET");
  assert.equal(monitor.recordBody(1, 10, 0), false);

  monitor.setTransport("udp");
  monitor.beginRequest(2, "POST");
  assert.equal(monitor.recordBody(2, 10, 0), false);
  assert.equal(monitor.recordBody(3, 10, 0), false);
  monitor.beginRequest(4, "GET");
  assert.equal(monitor.recordBody(4, 0, 0), false);
  assert.equal(monitor.recordBody(4, Number.NaN, 0), false);
  assert.equal(monitor.recordBody(4, 10, Number.NaN), false);
});

test("candidate protocol parsing handles SDP and RTC candidate strings", () => {
  assert.equal(
    iceCandidateProtocol("a=candidate:1 1 UDP 2122260223 192.0.2.1 443 typ host"),
    "udp"
  );
  assert.equal(
    iceCandidateProtocol("candidate:2 1 tcp 1518280447 192.0.2.1 443 typ host tcptype passive"),
    "tcp"
  );
  assert.equal(iceCandidateProtocol("a=end-of-candidates"), "other");
});

test("forced TCP answers remove UDP candidates from SDP and trickle candidates", () => {
  const answer = {
    sdp: [
      "v=0",
      "a=candidate:1 1 UDP 1 192.0.2.1 443 typ host",
      "a=candidate:2 1 tcp 1 192.0.2.1 443 typ host tcptype passive",
      "a=end-of-candidates",
      ""
    ].join("\r\n"),
    candidates: [
      { candidate: "candidate:1 1 udp 1 192.0.2.1 443 typ host" },
      { candidate: "candidate:2 1 TCP 1 192.0.2.1 443 typ host tcptype passive" }
    ]
  };

  const forced = forceAnswerTransport(answer, "tcp");
  assert.equal(forced.sdp.includes("candidate:1"), false);
  assert.equal(forced.sdp.includes("candidate:2"), true);
  assert.equal(forced.sdp.includes("a=end-of-candidates"), true);
  assert.deepEqual(forced.candidates, [answer.candidates[1]]);
  assert.notEqual(forced, answer, "call mutated the source answer");
});

test("forced TCP accepts an in-SDP candidate and rejects an answer with no TCP route", () => {
  assert.doesNotThrow(() => forceAnswerTransport({
    sdp: "v=0\na=candidate:2 1 tcp 1 192.0.2.1 443 typ host tcptype passive\n",
    candidates: []
  }, "tcp"));

  assert.throws(() => forceAnswerTransport({
    sdp: "v=0\na=candidate:1 1 udp 1 192.0.2.1 443 typ host\n",
    candidates: []
  }, "tcp"), /no TCP ICE candidate/);
});

test("short-lived route preferences distinguish absent, auto, TCP, and expiry", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => { values.delete(key); }
  };

  assert.equal(readRoutePreference(storage, "route", 1_000), null);
  rememberRoutePreference(storage, "route", "auto", 1_000, 500);
  assert.equal(readRoutePreference(storage, "route", 1_100), "auto");
  rememberRoutePreference(storage, "route", "tcp", 1_000, 500);
  assert.equal(readRoutePreference(storage, "route", 1_100), "tcp");
  assert.equal(readRoutePreference(storage, "route", 1_501), null);
  rememberRoutePreference(storage, "route", "tcp", 2_000, 500);
  clearRoutePreference(storage, "route");
  assert.equal(readRoutePreference(storage, "route", 2_100), null);
});
