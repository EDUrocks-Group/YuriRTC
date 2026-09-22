import type { CachePolicy } from "./routing.js";

export const CACHE_DIRECTIVE_HEADER = "x-yurirtc-cache";
export const CACHE_TAG_HEADER = "cache-tag";

export function cacheTags(headers: Headers): string[] {
  return [...new Set((headers.get(CACHE_TAG_HEADER) ?? "").split(",")
    .map(tag => tag.trim()).filter(tag => /^[a-zA-Z0-9_.:-]{1,64}$/.test(tag)))].slice(0, 32);
}

/** Origin policy can opt static payloads in, but never override privacy rules. */
export function responseCachePolicy(path: string, fallback: CachePolicy, headers: Headers): CachePolicy {
  const directive = headers.get(CACHE_DIRECTIVE_HEADER)?.trim().toLowerCase();
  if (path === "/apiv2" || path.startsWith("/apiv2/")) return "never";
  if (directive === "no-store" || directive === "never") return "never";
  if (directive === "cache" && fallback === "never") return "revalidate-lru";
  return fallback;
}

export function forbidsStale(headers: Headers): boolean {
  return /(?:^|,)\s*(?:no-cache|must-revalidate|no-store|private)(?:\s*(?:=|,|$))/i.test(headers.get("cache-control") ?? "");
}

export function hasExplicitFreshness(headers: Headers): boolean {
  return headers.has("expires") || /(?:^|,)\s*(?:max-age|no-cache|must-revalidate)(?:\s*(?:=|,|$))/i.test(headers.get("cache-control") ?? "");
}
