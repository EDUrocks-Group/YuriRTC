/** Query parameter used by a recovery redirect to preserve a deep link. */
export const APP_PATH_PARAM = "__edurocks_app";

/**
 * The permanent shell passes `/` in its static bootstrap. A worker recovery
 * redirect can override that with the same-origin route that was requested.
 */
export function appPathFromShellLocation(locationHref: string, fallback: string): string {
  try {
    const shell = new URL(locationHref);
    const requested = shell.searchParams.get(APP_PATH_PARAM);
    if (!requested) return fallback;

    const app = new URL(requested, shell.origin);
    if (app.origin !== shell.origin) return fallback;
    return app.pathname + app.search + app.hash;
  } catch {
    return fallback;
  }
}
