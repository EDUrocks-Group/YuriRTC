import type { FirestoreConfig, RtdbConfig } from "@yurirtc/signaling";

export interface YuriRTCConfig {
  /** Public by design; the security rules enforce access, not the key. */
  firebase: {
    apiKey: string;
    projectId: string;
    databaseUrl: string;
  };
  cache: {
    /**
     * Hard ceiling for the LRU class. The measured cover + launcher set is
     * ~330MB; anything beyond this evicts. Kept well under the reported quota
     * because eviction is origin-atomic and would take the session with it.
     */
    lruBudgetBytes: number;
    /** Never let our own footprint exceed this share of the reported quota. */
    maxQuotaShare: number;
  };
  signal: {
    /** Start the RTDB fallback only if Firestore has not answered by then. */
    hedgeDelayMs?: number;
    rtdb?: Partial<RtdbConfig>;
    firestore?: Partial<FirestoreConfig>;
  };
}

/** Legacy type name retained for source compatibility. */
export type LoaderConfig = YuriRTCConfig;

const BUILD_VERSION_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * Keeps an app-provided build id safe to use as part of a Cache API name.
 *
 * V4 uses a decimal timestamp and V5 uses a 64-character hexadecimal id. The
 * deliberately small alphabet supports both while preventing a transported
 * page from creating unbounded or awkward cache names.
 */
export function normalizeBuildVersion(value: unknown): string | null {
  if (typeof value !== "string" || !BUILD_VERSION_PATTERN.test(value)) return null;
  return value;
}

/**
 * The site's build version, normally read from this worker's own URL.
 *
 * Direct deployments register `/sw.js?v=<BUILD_VERSION>`, preserving the V4
 * update mechanism. V5 also embeds its id in the self-contained worker so its
 * bytes change every build. An unversioned static WebRTC loader receives the
 * transported site's real version through the registration guard; its own
 * embedded id, when present, is only a startup fallback.
 */
export function buildVersion(location: { href: string }, embedded?: unknown): string {
  try {
    const query = normalizeBuildVersion(new URL(location.href).searchParams.get("v"));
    if (query) return query;
  } catch {
    // Fall through to the build-time value.
  }
  return normalizeBuildVersion(embedded) ?? "0";
}

/**
 * Shell and route caches are version-scoped: a new build invalidates them
 * wholesale, which is exactly the staleness the site's own worker existed to
 * prevent.
 *
 * The LRU cache deliberately is not. It holds game covers keyed by id, which
 * are immutable across builds — re-fetching ~330MB on every deploy would be
 * pure waste, and that cache is already treated as the expensive class.
 */
export const cacheNames = (version: string) => ({
  shell: `edurocks-shell-${version}`,
  route: `edurocks-route-${version}`,
  lru: "edurocks-lru-v1"
});

/** Prefix used to recognise our caches when clearing old builds. */
export const CACHE_PREFIX = "edurocks-";

/**
 * Never served from cache, matching the legacy V4 worker's explicit list.
 * V5 navigations are always fresh and its build assets live under hashed `/a/`
 * paths, so this remains only for direct compatibility with V4 deployments.
 */
export const ALWAYS_FRESH = new Set([
  "/index.php",
  "/index.html",
  "/gxxes.json",
  "/style.css"
]);

/** Measured cover + launcher set is ~330MB; this leaves a little headroom. */
export const DEFAULT_CACHE = {
  budgetBytes: 350 * 1024 * 1024,
  maxQuotaShare: 0.5
};

export function resolveConfig(partial: YuriRTCConfig): YuriRTCConfig {
  return {
    firebase: partial.firebase,
    cache: {
      lruBudgetBytes: partial.cache?.lruBudgetBytes ?? DEFAULT_CACHE.budgetBytes,
      maxQuotaShare: partial.cache?.maxQuotaShare ?? DEFAULT_CACHE.maxQuotaShare
    },
    signal: partial.signal ?? {}
  };
}
