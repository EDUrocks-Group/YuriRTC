/**
 * V4 exposes game launch URLs in two JSON responses. Those strings are later
 * assigned to an iframe, so unlike an ordinary subresource fetch the browser
 * must see the physical object-store scope in the URL itself.
 */

const GAME_DETAIL_PATH = /^\/apiv2\/gxxe\/[^/]+$/;
const YURIRTC_LOGICAL_ORIGIN = "https://yurirtc.invalid/";

export function isV4GameJsonRequest(method: string, logicalPath: string): boolean {
  return method === "GET" && (
    logicalPath === "/gxxes.json" || GAME_DETAIL_PATH.test(logicalPath)
  );
}

function scopedGameUrl(value: string, scopePath: string): string {
  if (scopePath === "/") return value;
  if (!value.startsWith("./") && (!value.startsWith("/") || value.startsWith("//"))) {
    return value;
  }

  const base = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
  try {
    const logical = new URL(value, YURIRTC_LOGICAL_ORIGIN);
    // These values came from the content node, where every root-relative path
    // is logical. Never infer that it is already browser-scoped just because
    // it happens to begin with the same text as the bucket path: a bucket named
    // `filestorage` must still map logical `/filestorage/...` to physical
    // `/filestorage/filestorage/...`.
    return `${base}${logical.pathname.replace(/^\/+/, "")}${logical.search}${logical.hash}`;
  } catch {
    return value;
  }
}

function rebaseImmediateUrl(value: unknown, scopePath: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string") return value;
  const url = scopedGameUrl(record.url, scopePath);
  return url === record.url ? value : { ...record, url };
}

/**
 * Rebase only the fields in V4's deployed contract:
 *
 * - each array entry's immediate `url` in `/gxxes.json`;
 * - the response object's top-level `url` in GET `/apiv2/gxxe/:id`.
 *
 * This deliberately does not walk arbitrary JSON or mutate metadata.
 */
export function rebaseV4GameJson(
  json: string,
  method: string,
  logicalPath: string,
  scopePath: string
): string {
  if (scopePath === "/" || !isV4GameJsonRequest(method, logicalPath)) return json;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }

  let rebased: unknown;
  if (logicalPath === "/gxxes.json") {
    if (!Array.isArray(parsed)) return json;
    rebased = parsed.map((entry) => rebaseImmediateUrl(entry, scopePath));
  } else {
    rebased = rebaseImmediateUrl(parsed, scopePath);
  }

  return rebased === parsed || (
    Array.isArray(parsed) &&
    Array.isArray(rebased) &&
    parsed.every((entry, index) => entry === rebased[index])
  )
    ? json
    : JSON.stringify(rebased);
}
