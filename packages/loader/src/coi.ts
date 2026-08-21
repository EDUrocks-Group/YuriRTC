/**
 * Cross-origin isolation for SharedArrayBuffer content.
 *
 * A GCS bucket cannot set arbitrary response headers, so COOP/COEP have to be
 * synthesized by the SW on the top-level navigation — the `coi-serviceworker`
 * technique. That costs one extra reload on first visit, which SW activation
 * needs anyway.
 *
 * Because the SW synthesizes every subresource too, they must all carry
 * `Cross-Origin-Resource-Policy: same-origin` or the isolated document will
 * refuse to load them.
 */

/** Paths that need SharedArrayBuffer. Everything else stays un-isolated. */
export const ISOLATED_PATHS = ["/g-fra-sab.html"];

export function needsIsolation(pathname: string): boolean {
  return ISOLATED_PATHS.includes(pathname);
}

export function withIsolationHeaders(response: Response, isolate: boolean): Response {
  const headers = new Headers(response.headers);
  if (isolate) {
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    // credentialless, not require-corp: the transported app embeds third-party
    // no-cors resources (the ad script and its frames) whose servers send no
    // CORP header, and require-corp blocks them outright. credentialless keeps
    // crossOriginIsolated — SAB games still work — while loading those
    // embeds without credentials. Verified in headless Chromium: under
    // require-corp invoke.js fails with
    // ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep;
    // under credentialless it loads and SharedArrayBuffer stays available.
    //
    // The cost: cross-origin no-cors requests lose cookies, and non-Chromium
    // browsers ignore the value entirely (they lose isolation, not ads — the
    // deployment target is Chromebooks).
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  }
  // Set unconditionally: a subresource fetched *by* an isolated document needs
  // CORP even though the subresource itself is not isolated.
  if (!headers.has("Cross-Origin-Resource-Policy")) {
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
