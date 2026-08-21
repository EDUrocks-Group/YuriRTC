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
  other: "never"
};

/** `pathname` must be origin-relative and already normalised. */
export function classify(pathname: string): Classification {
  const kind = classifyKind(pathname);
  const policy = POLICY[kind];
  return { kind, policy, cacheable: policy !== "never" };
}

function classifyKind(pathname: string): RequestClass {
  if (pathname.startsWith("/apiv2/")) return "api";

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
  if (pathname === "/favicon.ico" || pathname.startsWith("/icons/")) return "shell";
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
  return classify(pathname);
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
  ".wasm",
  ".woff",
  ".woff2"
]);

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
    classify(request.logicalPath).kind === "payload"
  ) {
    return RequestPriority.Bulk;
  }
  return RequestPriority.Normal;
}
