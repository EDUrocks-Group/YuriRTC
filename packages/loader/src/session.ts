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

const STORE = "cookies";
export interface StoredCookie {
  name: string;
  value: string;
  path?: string;
  expiresAt?: number;
}
let namespace = "/";
let memoryOnly = false;
const memory = new Map<string, StoredCookie>();
function openJar(scope: string) {
  return sharedIdb({
    name: `yurirtc-session:${scope}`, version: 1, store: STORE,
    upgrade(db) { db.createObjectStore(STORE, { keyPath: ["path", "name"] }); }
  });
}
let jar = openJar(namespace);
/** Scope isolation avoids accidental token reuse between hosted deployments.
 * This is not a security boundary against scripts on the same origin. */
export async function configureSession(scope: string, storage: "persistent" | "memory" = "persistent"): Promise<void> {
  const changedScope = scope !== namespace;
  if (changedScope) { namespace = scope; jar = openJar(scope); memory.clear(); }
  const nextMemory = storage === "memory";
  if (nextMemory !== memoryOnly || changedScope) {
    memoryOnly = nextMemory;
    memory.clear();
    if (nextMemory) await jar.commit("readwrite", store => store.clear()).catch(() => undefined);
  }
}

export function cookiePathMatches(path: string, cookiePath: string): boolean {
  return path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path[cookiePath.length] === "/"));
}

/**
 * Parses one `Set-Cookie` value. Deliberately minimal: we only need the pair
 * and the expiry. Path is enforced in the virtual API namespace. Domain refers to the backend
 * host; SameSite, Secure and HttpOnly cannot be reproduced by IndexedDB.
 */
export function parseSetCookie(header: string, requestPath = "/"): StoredCookie | null {
  const parts = header.split(";");
  const pair = parts[0]?.trim();
  if (!pair) return null;
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;

  const cookie: StoredCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    path: requestPath.slice(0, requestPath.lastIndexOf("/")) || "/"
  };

  for (const attribute of parts.slice(1)) {
    const [rawKey, ...rest] = attribute.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "max-age") {
      const seconds = Number(value);
      if (/^-?\d+$/.test(value) && Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
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
export async function applySetCookie(header: string, requestPath = "/"): Promise<void> {
  const cookie = parseSetCookie(header, requestPath);
  if (!cookie) return;
  const key = JSON.stringify([cookie.path, cookie.name]);
  if (memoryOnly) {
    if (isExpired(cookie)) memory.delete(key); else memory.set(key, cookie);
    return;
  }
  // commit, not request: this is the write that persists the login `sid`, and
  // a request's success fires while its transaction is still uncommitted. A
  // worker killed in that window would roll the login back silently.
  if (isExpired(cookie)) {
    await jar.commit("readwrite", (store) => store.delete([cookie.path ?? "/", cookie.name]));
    return;
  }
  await jar.commit("readwrite", (store) => store.put(cookie));
}

/** Serialised for a `Cookie:` request header, or undefined when the jar is empty. */
export async function cookieHeader(requestPath = "/"): Promise<string | undefined> {
  const all = memoryOnly ? [...memory.values()] : await jar.request<StoredCookie[]>("readonly", (store) => store.getAll());
  const now = Date.now();
  const live = all.filter((cookie) => !isExpired(cookie, now) && cookiePathMatches(requestPath, cookie.path ?? "/"));

  // Opportunistically reap what expired while we were not looking. One
  // transaction for the whole sweep rather than one per dead cookie.
  if (!memoryOnly && all.some(cookie => isExpired(cookie, now))) {
    await jar.commit("readwrite", (store) => {
      for (const cookie of all) {
        if (isExpired(cookie, now)) store.delete([cookie.path ?? "/", cookie.name]);
      }
    });
  }

  if (live.length === 0) return undefined;
  return live.sort((a, b) => (b.path?.length ?? 1) - (a.path?.length ?? 1)).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export async function clearSession(): Promise<void> {
  memory.clear();
  // Handed to event.waitUntil by the logout message; resolve on commit so the
  // worker is kept alive until the jar is actually empty.
  await jar.commit("readwrite", (store) => store.clear());
}
