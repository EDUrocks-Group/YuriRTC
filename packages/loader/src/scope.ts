/**
 * URL translation for loaders installed below an origin root.
 *
 * Object-store path URLs put the worker at (for example)
 * `/bucket/sw.js`, so without a Service-Worker-Allowed header its largest
 * possible scope is `/bucket/`. Browser-facing requests must stay below that
 * path, while the content node must continue to receive the root-relative
 * paths its filesystem and API router use.
 */

/** Returns a directory-shaped pathname for an absolute registration scope. */
export function scopePathFromUrl(scopeUrl: string): string {
  const pathname = new URL(scopeUrl).pathname;
  if (pathname === "/") return pathname;
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export interface WorkerRegistrationTarget {
  /** Absolute script URL passed to `navigator.serviceWorker.register()`. */
  scriptUrl: string;
  /** Largest scope available without a `Service-Worker-Allowed` header. */
  directoryScope: string;
}

/**
 * Resolves a worker reference from the actual bootstrap page rather than from
 * the origin root. Object-store path deployments cannot add a
 * `Service-Worker-Allowed` response header, so the script's own directory is
 * also the only portable default scope.
 *
 * Keeping these two values together is intentional: deriving a prefixed
 * script URL but registering it for `/` is the subtle mismatch that breaks
 * otherwise-identical S3/GCS objects below `/bucket/` or a nested release
 * directory.
 */
export function workerRegistrationTarget(
  pageUrl: string,
  workerReference = "sw.js"
): WorkerRegistrationTarget {
  const worker = new URL(workerReference, pageUrl);
  return {
    scriptUrl: worker.href,
    directoryScope: scopePathFromUrl(new URL(".", worker).href)
  };
}

/**
 * Maps a browser-visible pathname into the content node's logical root.
 * Returns null when the URL is outside this registration's application scope.
 */
export function logicalPathForScope(pathname: string, scopePath: string): string | null {
  if (scopePath === "/") return pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (!pathname.startsWith(scopePath)) return null;
  const rest = pathname.slice(scopePath.length);
  return rest ? `/${rest}` : "/";
}

/** Maps one logical content-node pathname into the browser registration scope. */
export function scopedPathForLogical(pathname: string, scopePath: string): string {
  const logical = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return scopePath === "/" ? `/${logical}` : `${scopePath}${logical}`;
}

/**
 * Resolves an app-frame target and guarantees that it remains in `scopeUrl`.
 * Root-relative inputs are logical app paths, so `/chat.html` under a
 * `/bucket/` registration becomes `/bucket/chat.html`.
 */
export function appPathWithinScope(value: string, scopeUrl: string): string {
  const scope = new URL(scopeUrl);
  const scopePath = scopePathFromUrl(scope.href);
  try {
    const target = new URL(value, scope);
    if (target.origin !== scope.origin) return scopePath;
    const pathname =
      logicalPathForScope(target.pathname, scopePath) !== null
        ? target.pathname
        : scopedPathForLogical(target.pathname, scopePath);
    return pathname + target.search + target.hash;
  } catch {
    return scopePath;
  }
}

/**
 * Selects a persisted shell only when it belongs to both this worker's file
 * directory and its application scope. IndexedDB is origin-wide, so this
 * prevents a stale bootstrap from another bucket on a shared origin from
 * becoming the recovery target.
 */
export function shellPathForWorker(
  candidate: string | undefined,
  workerUrl: string,
  scopeUrl: string
): string {
  const worker = new URL(workerUrl);
  const loaderDirectory = scopePathFromUrl(new URL(".", worker).href);
  const applicationScope = scopePathFromUrl(scopeUrl);
  const fallback = `${loaderDirectory}index.html`;
  if (!candidate?.startsWith("/")) return fallback;

  try {
    const target = new URL(candidate, worker.origin);
    if (target.origin !== worker.origin) return fallback;
    if (logicalPathForScope(target.pathname, loaderDirectory) === null) return fallback;
    if (logicalPathForScope(target.pathname, applicationScope) === null) return fallback;
    return target.pathname;
  } catch {
    return fallback;
  }
}

/**
 * Rewrites a same-origin redirect returned by the logical app into the
 * browser-visible registration scope. Every valid result is made absolute;
 * cross-origin targets retain their destination without scope rewriting.
 */
export function locationWithinScope(
  value: string,
  requestUrl: string,
  logicalRequestPath: string,
  scopeUrl: string
): string {
  const scopePath = scopePathFromUrl(scopeUrl);

  try {
    const browserRequest = new URL(requestUrl);
    const logicalRequest = new URL(browserRequest.href);
    logicalRequest.pathname = logicalRequestPath;
    const target = new URL(value, logicalRequest);
    if (target.origin !== browserRequest.origin) return target.href;
    if (scopePath === "/") return target.href;
    const pathname =
      logicalPathForScope(target.pathname, scopePath) !== null
        ? target.pathname
        : scopedPathForLogical(target.pathname, scopePath);
    target.pathname = pathname;
    return target.href;
  } catch {
    return value;
  }
}
