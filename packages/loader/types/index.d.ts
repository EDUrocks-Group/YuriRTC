export interface RtdbSignalConfig {
  apiKey?: string;
  databaseUrl?: string;
  timeoutMs?: number;
}

export interface FirestoreSignalConfig {
  projectId?: string;
  firstPollMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  timeoutMs?: number;
  ttlSeconds?: number;
}

export interface YuriRTCConfig {
  firebase: {
    apiKey: string;
    projectId: string;
    databaseUrl: string;
  };
  cache: {
    lruBudgetBytes: number;
    maxQuotaShare: number;
  };
  signal: {
    hedgeDelayMs?: number;
    rtdb?: RtdbSignalConfig;
    firestore?: FirestoreSignalConfig;
  };
}

/** Compatibility type retained for existing consumers. */
export type LoaderConfig = YuriRTCConfig;

export interface ConnectionDiagnostics {
  route: {
    transport: "udp" | "tcp" | "unknown";
    portClass: "standard" | "443" | "unknown";
  };
  signalBackend: string;
  signalElapsedMs: number;
}

export declare class YuriRTCClient {
  constructor(config: YuriRTCConfig, shellPath?: string);
  connect(registration?: ServiceWorkerRegistration): Promise<ConnectionDiagnostics>;
  onDisconnect(listener: (reason: string) => void): () => void;
  request(
    url: string,
    init?: { method?: string; headers?: HeadersInit }
  ): Promise<Response>;
  close(): void;
}

/** Compatibility alias retained for all existing loader consumers. */
export { YuriRTCClient as LoaderClient };

export interface BootOptions extends YuriRTCConfig {
  onDiagnostics?: (diagnostics: ConnectionDiagnostics) => void;
  swUrl?: string;
  mount?: string | Element;
  appPath?: string;
  scope?: string;
}

export declare function boot(options: BootOptions): Promise<YuriRTCClient>;

export type RequestClass = "shell" | "route" | "cover" | "payload" | "api" | "other";
export type CachePolicy =
  | "cache-first-immutable"
  | "stale-while-revalidate"
  | "cache-first-lru"
  | "never";

export interface Classification {
  kind: RequestClass;
  policy: CachePolicy;
  cacheable: boolean;
}

export declare function classify(pathname: string): Classification;
export declare function classifyRequest(request: {
  url: string;
  mode?: string;
  destination?: string;
}): Classification;
