/**
 * The service worker as a cookie jar.
 *
 * A `Set-Cookie` header on a service-worker-synthesized `Response` is ignored by
 * the browser, so the login flow would break silently: the backend sets `sid`,
 * we hand the browser a Response carrying it, the browser discards it, and every
 * later request is unauthenticated.
 *
 * So the SW keeps the session itself. It sees `Set-Cookie` as ordinary frame
 * data, which means `httpOnly` is not an obstacle — and equally means the
 * browser's cookie protections no longer apply to this token. That is a real
 * downgrade, recorded here so it is not forgotten: any script on the origin can
 * read this store.
 */

import { sharedIdb } from "./idb.js";

const DB_NAME = "edurocks-session";
const STORE = "cookies";
const DB_VERSION = 1;

export interface StoredCookie {
  name: string;
  value: string;
  /** ms since epoch; undefined means session-lifetime. */
  expiresAt?: number;
}

/**
 * One connection for the jar. `cookieHeader()` runs on every `/apiv2` request,
 * and reopening the database each time put a disk round trip in front of every
 * API call.
 */
const jar = sharedIdb({
  name: DB_NAME,
  version: DB_VERSION,
  store: STORE,
  upgrade: (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: "name" });
    }
  }
});

/**
 * Parses one `Set-Cookie` value. Deliberately minimal: we only need the pair
 * and the expiry. `Domain`, `Path`, `SameSite`, `Secure`, and `HttpOnly` are all
 * meaningless here — there is exactly one origin and we are the jar.
 */
export function parseSetCookie(header: string): StoredCookie | null {
  const parts = header.split(";");
  const pair = parts[0]?.trim();
  if (!pair) return null;
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;

  const cookie: StoredCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim()
  };

  for (const attribute of parts.slice(1)) {
    const [rawKey, ...rest] = attribute.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
    } else if (key === "expires" && cookie.expiresAt === undefined) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) cookie.expiresAt = parsed;
    }
  }
  return cookie;
}

export function isExpired(cookie: StoredCookie, now = Date.now()): boolean {
  return cookie.expiresAt !== undefined && cookie.expiresAt <= now;
}

/**
 * Applies a `Set-Cookie`. Logout arrives as a `Set-Cookie` with an expiry in the
 * past (`res.clearCookie`), which lands here as a delete rather than a store.
 */
export async function applySetCookie(header: string): Promise<void> {
  const cookie = parseSetCookie(header);
  if (!cookie) return;
  // commit, not request: this is the write that persists the login `sid`, and
  // a request's success fires while its transaction is still uncommitted. A
  // worker killed in that window would roll the login back silently.
  if (isExpired(cookie)) {
    await jar.commit("readwrite", (store) => store.delete(cookie.name));
    return;
  }
  await jar.commit("readwrite", (store) => store.put(cookie));
}

/** Serialised for a `Cookie:` request header, or undefined when the jar is empty. */
export async function cookieHeader(): Promise<string | undefined> {
  const all = await jar.request<StoredCookie[]>("readonly", (store) => store.getAll());
  const now = Date.now();
  const live = all.filter((cookie) => !isExpired(cookie, now));

  // Opportunistically reap what expired while we were not looking. One
  // transaction for the whole sweep rather than one per dead cookie.
  if (live.length !== all.length) {
    await jar.commit("readwrite", (store) => {
      for (const cookie of all) {
        if (isExpired(cookie, now)) store.delete(cookie.name);
      }
    });
  }

  if (live.length === 0) return undefined;
  return live.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export async function clearSession(): Promise<void> {
  // Handed to event.waitUntil by the logout message; resolve on commit so the
  // worker is kept alive until the jar is actually empty.
  await jar.commit("readwrite", (store) => store.clear());
}
