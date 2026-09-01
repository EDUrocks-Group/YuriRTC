import type { ConnectionDiagnostics, ConnectionOptions, YuriRTCClient } from "./client.js";

export const ROUTE_PROBE_BYTES = 1024 * 1024;
export const ROUTE_PROBE_HEADER = "x-yurirtc-route-probe";
export const ROUTE_PROBE_TIMEOUT_MS = 8_000;
export const TCP_WIN_MARGIN = 1.15;

export interface RouteRaceCandidate {
  connect(
    registration?: ServiceWorkerRegistration,
    options?: ConnectionOptions
  ): Promise<ConnectionDiagnostics>;
  request(url: string, init?: {
    method?: string;
    headers?: HeadersInit;
    initialCredits?: number;
  }): Promise<Response>;
  retireRoute(): void;
}

export interface InitialRouteSelection<T extends RouteRaceCandidate = YuriRTCClient> {
  winner: T;
  diagnostics: ConnectionDiagnostics;
  transport: "auto" | "tcp";
}

interface Measurement {
  supported: boolean;
  elapsedMs: number;
}

/**
 * Race a normal ICE route against forced TCP without touching the SW port.
 * An old node which ignores the private probe marker always keeps normal ICE.
 */
export async function raceInitialRoutes<T extends RouteRaceCandidate>(
  automatic: T,
  tcp: T,
  options: { timeoutMs?: number; now?: () => number } = {}
): Promise<InitialRouteSelection<T>> {
  const timeoutMs = positive(options.timeoutMs, ROUTE_PROBE_TIMEOUT_MS);
  const now = options.now ?? (() => performance.now());
  try {
    // Connection setup has its own gathering, signaling, and SCTP deadlines.
    // Do not charge an ICE path for taking longer to connect: the comparison is
    // deliberately a transfer benchmark after both candidates are ready.
    const [autoConnection, tcpConnection] = await Promise.allSettled([
      automatic.connect(undefined, { transport: "auto" }),
      tcp.connect(undefined, { transport: "tcp" })
    ]);

    if (autoConnection.status === "rejected") {
      if (tcpConnection.status === "rejected") throw autoConnection.reason;
      automatic.retireRoute();
      return { winner: tcp, diagnostics: tcpConnection.value, transport: "tcp" as const };
    }
    if (tcpConnection.status === "rejected") {
      tcp.retireRoute();
      return { winner: automatic, diagnostics: autoConnection.value, transport: "auto" as const };
    }

    const probeAbort = new AbortController();
    let autoProbe: PromiseSettledResult<Measurement>;
    let tcpProbe: PromiseSettledResult<Measurement>;
    try {
      [autoProbe, tcpProbe] = await withTimeout(
        measureTogether(automatic, tcp, now, probeAbort.signal),
        timeoutMs
      );
    } catch {
      // Route selection is an optimization, never a startup dependency. Abort
      // its direct readers so their one-frame windows release, discard the
      // speculative TCP connection, and continue on ordinary ICE.
      probeAbort.abort("route probe stopped");
      tcp.retireRoute();
      return { winner: automatic, diagnostics: autoConnection.value, transport: "auto" as const };
    }
    // Backward compatibility is the fail-safe: no exact private marker means
    // the ordinary route wins even when speculative TCP succeeded.
    if (
      (autoProbe.status === "fulfilled" && !autoProbe.value.supported) ||
      (tcpProbe.status === "fulfilled" && !tcpProbe.value.supported)
    ) {
      tcp.retireRoute();
      return { winner: automatic, diagnostics: autoConnection.value, transport: "auto" as const };
    }
    if (autoProbe.status === "rejected") {
      if (tcpProbe.status === "rejected") {
        tcp.retireRoute();
        return { winner: automatic, diagnostics: autoConnection.value, transport: "auto" as const };
      }
      automatic.retireRoute();
      return { winner: tcp, diagnostics: tcpConnection.value, transport: "tcp" as const };
    }
    if (tcpProbe.status === "rejected") {
      tcp.retireRoute();
      return { winner: automatic, diagnostics: autoConnection.value, transport: "auto" as const };
    }

    const tcpMateriallyFaster =
      tcpProbe.value.elapsedMs * TCP_WIN_MARGIN < autoProbe.value.elapsedMs;
    if (tcpMateriallyFaster) {
      automatic.retireRoute();
      return { winner: tcp, diagnostics: tcpConnection.value, transport: "tcp" as const };
    }
    tcp.retireRoute();
    return { winner: automatic, diagnostics: autoConnection.value, transport: "auto" as const };
  } catch (error) {
    // Timeout and dual failure must not leak either speculative node session.
    automatic.retireRoute();
    tcp.retireRoute();
    throw error;
  }
}

async function measureTogether(
  automatic: RouteRaceCandidate,
  tcp: RouteRaceCandidate,
  now: () => number,
  signal: AbortSignal
): Promise<[PromiseSettledResult<Measurement>, PromiseSettledResult<Measurement>]> {
  // One frame lets each node deliver its response head while preventing either
  // candidate from buffering the complete probe before the other is ready.
  const request = (client: RouteRaceCandidate): Promise<Response> => client.request("/", {
    method: "GET",
    headers: { [ROUTE_PROBE_HEADER]: String(ROUTE_PROBE_BYTES) },
    initialCredits: 1
  });
  const responses = await Promise.allSettled([request(automatic), request(tcp)]);
  if (responses[0].status === "rejected" || responses[1].status === "rejected") {
    return responses.map((response) => response.status === "rejected"
      ? response
      : { status: "fulfilled", value: unsupported(response.value) }
    ) as [PromiseSettledResult<Measurement>, PromiseSettledResult<Measurement>];
  }

  const autoResponse = responses[0].value;
  const tcpResponse = responses[1].value;
  if (!supported(autoResponse) || !supported(tcpResponse)) {
    await Promise.all([
      autoResponse.body?.cancel("route probe unsupported").catch(() => undefined),
      tcpResponse.body?.cancel("route probe unsupported").catch(() => undefined)
    ]);
    return [
      { status: "fulfilled", value: unsupported(autoResponse) },
      { status: "fulfilled", value: unsupported(tcpResponse) }
    ];
  }

  // The body readers begin at one shared barrier. Their completion timestamps
  // are therefore comparable even when response-head latency differed.
  const transferStartedAt = now();
  return Promise.allSettled([
    measureBody(autoResponse, transferStartedAt, now, signal),
    measureBody(tcpResponse, transferStartedAt, now, signal)
  ]);
}

function supported(response: Response): boolean {
  const marker = response.headers.get(ROUTE_PROBE_HEADER);
  return response.status === 200 && marker === String(ROUTE_PROBE_BYTES);
}

function unsupported(_response: Response): Measurement {
  return { supported: false, elapsedMs: 0 };
}

async function measureBody(
  response: Response,
  transferStartedAt: number,
  now: () => number,
  signal: AbortSignal
): Promise<Measurement> {
  if (!response.body) throw new Error("route probe returned no body");
  const reader = response.body.getReader();
  let byteLength = 0;
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > ROUTE_PROBE_BYTES) break;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (signal.aborted) throw new Error("route probe stopped");
  if (byteLength !== ROUTE_PROBE_BYTES) {
    throw new Error("route probe returned the wrong byte count");
  }
  return { supported: true, elapsedMs: Math.max(0.01, now() - transferStartedAt) };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("route probe timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
