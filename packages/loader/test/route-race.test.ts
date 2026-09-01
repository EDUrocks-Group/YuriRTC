import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTE_PROBE_BYTES,
  ROUTE_PROBE_HEADER,
  raceInitialRoutes,
  type RouteRaceCandidate
} from "../src/route-race.js";
import type { ConnectionDiagnostics, ConnectionOptions } from "../src/client.js";

const AUTO_DIAGNOSTICS: ConnectionDiagnostics = {
  route: { transport: "udp", portClass: "standard" },
  signalBackend: "test",
  signalElapsedMs: 1
};
const TCP_DIAGNOSTICS: ConnectionDiagnostics = {
  route: { transport: "tcp", portClass: "443" },
  signalBackend: "test",
  signalElapsedMs: 1
};

class Candidate implements RouteRaceCandidate {
  retired = 0;
  requestCalls = 0;
  bodyStarts = 0;
  bodyCancels = 0;
  initialCredits: number | undefined;
  connectTransport: ConnectionOptions["transport"] | undefined;

  constructor(
    private readonly diagnostics: ConnectionDiagnostics,
    private readonly marker = true,
    private readonly connectError?: Error,
    private readonly connectGate?: Promise<void>,
    private readonly requestGate?: Promise<void>,
    private readonly stallBody = false
  ) {}

  async connect(
    _registration?: ServiceWorkerRegistration,
    options?: ConnectionOptions
  ): Promise<ConnectionDiagnostics> {
    this.connectTransport = options?.transport;
    await this.connectGate;
    if (this.connectError) throw this.connectError;
    return this.diagnostics;
  }

  async request(_url: string, init?: {
    headers?: HeadersInit;
    initialCredits?: number;
  }): Promise<Response> {
    this.requestCalls += 1;
    this.initialCredits = init?.initialCredits;
    assert.equal(new Headers(init?.headers).get(ROUTE_PROBE_HEADER), String(ROUTE_PROBE_BYTES));
    assert.equal(init?.initialCredits, 1);
    await this.requestGate;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (!sent) {
          sent = true;
          this.bodyStarts += 1;
          if (this.stallBody) return;
          controller.enqueue(new Uint8Array(ROUTE_PROBE_BYTES));
          return;
        }
        controller.close();
      },
      cancel: () => {
        this.bodyCancels += 1;
      }
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: 200,
      headers: this.marker ? { [ROUTE_PROBE_HEADER]: String(ROUTE_PROBE_BYTES) } : {}
    });
  }

  retireRoute(): void {
    this.retired += 1;
  }
}

test("body probes wait at a concurrent-connect barrier", async () => {
  let releaseAuto!: () => void;
  let releaseTcp!: () => void;
  const automatic = new Candidate(
    AUTO_DIAGNOSTICS,
    true,
    undefined,
    new Promise<void>((resolve) => { releaseAuto = resolve; })
  );
  const tcp = new Candidate(
    TCP_DIAGNOSTICS,
    true,
    undefined,
    new Promise<void>((resolve) => { releaseTcp = resolve; })
  );
  const racing = raceInitialRoutes(automatic, tcp);
  await Promise.resolve();
  releaseAuto();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(automatic.requestCalls + tcp.requestCalls, 0);

  releaseTcp();
  await racing;
  assert.equal(automatic.requestCalls, 1);
  assert.equal(tcp.requestCalls, 1);
});

test("body reads wait until both probe response heads are ready", async () => {
  let releaseTcpHead!: () => void;
  const automatic = new Candidate(AUTO_DIAGNOSTICS);
  const tcp = new Candidate(
    TCP_DIAGNOSTICS,
    true,
    undefined,
    undefined,
    new Promise<void>((resolve) => { releaseTcpHead = resolve; })
  );
  const racing = raceInitialRoutes(automatic, tcp);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(automatic.requestCalls, 1);
  assert.equal(tcp.requestCalls, 1);
  assert.equal(automatic.bodyStarts + tcp.bodyStarts, 0);

  releaseTcpHead();
  await racing;
  assert.equal(automatic.bodyStarts, 1);
  assert.equal(tcp.bodyStarts, 1);
});

test("probe timeout does not include ICE and signaling setup", async () => {
  let releaseConnections!: () => void;
  const gate = new Promise<void>((resolve) => { releaseConnections = resolve; });
  const automatic = new Candidate(AUTO_DIAGNOSTICS, true, undefined, gate);
  const tcp = new Candidate(TCP_DIAGNOSTICS, true, undefined, gate);
  const racing = raceInitialRoutes(automatic, tcp, { timeoutMs: 1 });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  releaseConnections();

  const selected = await racing;
  assert.equal(selected.winner, automatic);
});

test("a stalled route probe falls back to auto and cancels both readers", async () => {
  const automatic = new Candidate(
    AUTO_DIAGNOSTICS,
    true,
    undefined,
    undefined,
    undefined,
    true
  );
  const tcp = new Candidate(
    TCP_DIAGNOSTICS,
    true,
    undefined,
    undefined,
    undefined,
    true
  );

  const selected = await raceInitialRoutes(automatic, tcp, { timeoutMs: 5 });
  assert.equal(selected.winner, automatic);
  assert.equal(selected.transport, "auto");
  assert.equal(tcp.retired, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(automatic.bodyCancels, 1);
  assert.equal(tcp.bodyCancels, 1);
});

test("initial route race keeps auto when forced TCP cannot connect", async () => {
  const automatic = new Candidate(AUTO_DIAGNOSTICS);
  const tcp = new Candidate(TCP_DIAGNOSTICS, true, new Error("TCP blocked"));
  const selected = await raceInitialRoutes(automatic, tcp);

  assert.equal(selected.winner, automatic);
  assert.equal(selected.transport, "auto");
  assert.equal(tcp.retired, 1);
  assert.equal(automatic.connectTransport, "auto");
  assert.equal(tcp.connectTransport, "tcp");
});

test("an old node without the exact private marker safely keeps auto", async () => {
  const automatic = new Candidate(AUTO_DIAGNOSTICS, false);
  const tcp = new Candidate(TCP_DIAGNOSTICS, false);
  const selected = await raceInitialRoutes(automatic, tcp);

  assert.equal(selected.winner, automatic);
  assert.equal(tcp.retired, 1);
});

test("a materially faster TCP body probe wins and closes auto", async () => {
  const automatic = new Candidate(AUTO_DIAGNOSTICS);
  const tcp = new Candidate(TCP_DIAGNOSTICS);
  // One shared start, then auto and TCP completion timestamps.
  const times = [0, 200, 100];
  const selected = await raceInitialRoutes(automatic, tcp, {
    now: () => times.shift() ?? 100
  });

  assert.equal(selected.winner, tcp);
  assert.equal(selected.transport, "tcp");
  assert.equal(automatic.retired, 1);
  assert.equal(tcp.retired, 0);
});

test("dual connection failure retires both speculative candidates", async () => {
  const automatic = new Candidate(AUTO_DIAGNOSTICS, true, new Error("auto failed"));
  const tcp = new Candidate(TCP_DIAGNOSTICS, true, new Error("tcp failed"));

  await assert.rejects(raceInitialRoutes(automatic, tcp), /auto failed/);
  assert.equal(automatic.retired, 1);
  assert.equal(tcp.retired, 1);
});
