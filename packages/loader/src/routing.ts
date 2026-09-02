import { RequestPriority } from "@yurirtc/protocol";

/**
 * Request classification and cache policy.
 *
 * The split that matters: game *payloads* under `gn/<id>/…` and `gd/…` are
 * cached by the games themselves in OPFS, so caching them here would store the
 * same bytes twice against one origin quota. Covers and launchers — one path
 * segment under `gn/` — are ours to cache and are the highest-value thing in the
 * whole set.
 */

export type RequestClass = "shell" | "route" | "cover" | "payload" | "api" | "other";

export type CachePolicy =
  | "cache-first-immutable"
  | "stale-while-revalidate"
  | "cache-first-lru"
  | "revalidate-lru"
  | "never";

export interface Classification {
  kind: RequestClass;
  policy: CachePolicy;
  /** False for anything that must never touch our cache. */
  cacheable: boolean;
}

const POLICY: Record<RequestClass, CachePolicy> = {
  shell: "cache-first-immutable",
  route: "stale-while-revalidate",
  cover: "cache-first-lru",
  payload: "never",
  api: "never",
  // A content node serves every non-API path from a static tree. Unknown
  // assets are therefore reusable, but not assumed immutable: their HTTP
  // validators are checked before reuse and storage remains quota-bounded.
  other: "revalidate-lru"
};

/** `pathname` must be origin-relative and already normalised. */
export function classify(pathname: string): Classification {
  const kind = classifyKind(pathname);
  const policy = POLICY[kind];
  return { kind, policy, cacheable: policy !== "never" };
}

function classifyKind(pathname: string): RequestClass {
  if (pathname === "/apiv2" || pathname.startsWith("/apiv2/")) return "api";

  // Content-hashed build output. Immutable by construction.
  if (pathname.startsWith("/a/")) return "shell";

  if (pathname.startsWith("/filestorage/")) {
    const rest = pathname.slice("/filestorage/".length);
    const segments = rest.split("/").filter(Boolean);

    // `gn/<file>` is a cover or a launcher; `gn/<id>/…` is bundle payload.
    if (segments[0] === "gn" && segments.length === 2) {
      const leaf = segments[1]!;
      if (leaf.endsWith(".png") || leaf.endsWith(".html")) return "cover";
    }
    return "payload";
  }

  if (pathname === "/" || pathname.endsWith(".html")) return "route";
  // These names are conventional, not content hashes. Treat them as ordinary
  // validator-backed files so arbitrary hosted sites may replace them.
  if (pathname === "/favicon.ico" || pathname.startsWith("/icons/")) return "other";
  if (pathname.endsWith(".webmanifest") || pathname === "/manifest.json") return "route";

  return "other";
}

/**
 * A navigation is a route regardless of its extension — the bucket has no SPA
 * rewrite, so cold entry lands on a real `.html`, but in-app navigation does not.
 */
export function classifyRequest(request: {
  url: string;
  mode?: string;
  destination?: string;
}): Classification {
  const { pathname } = new URL(request.url);
  if (request.mode === "navigate" || request.destination === "document") {
    return { kind: "route", policy: POLICY.route, cacheable: true };
  }

  const pathClassification = classify(pathname);
  // API responses remain private/dynamic regardless of Fetch destination, and
  // content-hashed shell files keep their stronger immutable policy.
  if (pathClassification.kind === "api" || pathClassification.kind === "shell") {
    return pathClassification;
  }

  // A transported site can organise thumbnails however it wants. EDUrocks 5,
  // for example, uses logn/zones/<id>/cover.png and gd/<id>/image.png rather
  // than the old two-segment gn convention. Fetch metadata identifies their
  // actual role without baking either site's directory layout into YuriRTC.
  // Full game payloads requested with fetch/XHR keep the payload/no-cache rule.
  if (request.destination === "image") {
    return { kind: "cover", policy: POLICY.cover, cacheable: true };
  }
  if (
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "font" ||
    request.destination === "worker" ||
    request.destination === "sharedworker" ||
    request.destination === "serviceworker"
  ) {
    // These are reusable static representations even when a hosted site's
    // directory happens to be named filestorage. Keep validators authoritative
    // rather than assuming arbitrary third-party filenames are immutable.
    return { kind: "other", policy: POLICY.other, cacheable: true };
  }
  return pathClassification;
}

/**
 * Ranged requests never come from our cache. The Cache API cannot store a 206
 * at all and `cache.match()` ignores `Range` outright, returning the full 200 —
 * both verified in Chrome. Nothing we cache is ever requested with `Range`, so
 * this is belt and braces rather than a workaround.
 */
export function isRanged(headers: Iterable<[string, string]>): boolean {
  for (const [name] of headers) {
    if (name.toLowerCase() === "range") return true;
  }
  return false;
}

const CRITICAL_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".woff",
  ".woff2"
]);

/** Large/streamable formats should not occupy the small critical-file lane. */
const INCREMENTAL_EXTENSIONS = new Set([
  ".br",
  ".bundle",
  ".data",
  ".gz",
  ".pak",
  ".wasm",
  ".zip"
]);

export function isIncrementalAsset(logicalPath: string): boolean {
  const leaf = logicalPath.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  const dot = leaf.lastIndexOf(".");
  return dot >= 0 && INCREMENTAL_EXTENSIONS.has(leaf.slice(dot));
}

/**
 * Maps Fetch metadata to the node's v3 scheduler. This keeps chat/navigation
 * responsive while three separate bulk lanes fill the connection with static
 * assets. Extensions are a fallback for fetch()/WASM requests whose browser
 * destination is the empty string.
 */
export function requestPriority(request: {
  method?: string;
  mode?: string;
  destination?: string;
  logicalPath: string;
}): RequestPriority {
  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return RequestPriority.Interactive;
  if (
    request.mode === "navigate" ||
    request.destination === "document" ||
    request.logicalPath === "/apiv2" ||
    request.logicalPath.startsWith("/apiv2/")
  ) {
    return RequestPriority.Interactive;
  }

  const destination = request.destination ?? "";
  if (
    destination === "script" ||
    destination === "style" ||
    destination === "font" ||
    destination === "worker" ||
    destination === "sharedworker" ||
    destination === "serviceworker"
  ) {
    return RequestPriority.Critical;
  }

  const leaf = request.logicalPath.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  const dot = leaf.lastIndexOf(".");
  if (dot >= 0 && CRITICAL_EXTENSIONS.has(leaf.slice(dot))) {
    return RequestPriority.Critical;
  }

  if (
    destination === "audio" ||
    destination === "video" ||
    destination === "track" ||
    isIncrementalAsset(request.logicalPath) ||
    classify(request.logicalPath).kind === "payload"
  ) {
    return RequestPriority.Bulk;
  }
  return RequestPriority.Normal;
}
