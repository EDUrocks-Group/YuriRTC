import { packageUrls } from "@yurirtc/protocol";
/**
 * Where the loader bundles are fetched from at runtime.
 *
 * Release bundles replace `__YURIRTC_LOADER_VERSION__` at build time so an
 * injected recovery carrier always imports the exact client version that
 * created it. Keeping client and worker versions together is more important
 * than following a mutable dist-tag.
 *
 * The `latest` fallback exists only when this TypeScript module runs unbundled
 * in unit tests. It must not survive the public loader build.
 *
 * The ordered mirrors provide redundancy: whichever one a
 * network permits is the one that gets used.
 */

export const PACKAGE = "@advwebrec/grainloading";

declare const __YURIRTC_LOADER_VERSION__: string;
export const DISTRIBUTION_VERSION =
  typeof __YURIRTC_LOADER_VERSION__ === "string" && __YURIRTC_LOADER_VERSION__
    ? __YURIRTC_LOADER_VERSION__
    : "latest";

export const CDN_BASES = packageUrls(PACKAGE, DISTRIBUTION_VERSION, "dist/bundle");
export const clientUrls = (): string[] => packageUrls(PACKAGE, DISTRIBUTION_VERSION, "dist/bundle/client.js");
export const swUrls = (): string[] => packageUrls(PACKAGE, DISTRIBUTION_VERSION, "dist/bundle/sw.js");

/**
 * Imports the first source that works.
 *
 * A blocked or slow CDN must degrade to the other one rather than taking the
 * page down.
 */
export async function importFirst<T>(urls: readonly string[]): Promise<T> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      return (await import(/* @vite-ignore */ url)) as T;
    } catch (error) {
      failures.push(`${url}: ${String(error)}`);
    }
  }
  throw new Error(`no loader source reachable — ${failures.join("; ")}`);
}
