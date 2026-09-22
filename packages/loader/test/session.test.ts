import assert from "node:assert/strict";
import test from "node:test";
import { parseSetCookie, cookiePathMatches, configureSession, applySetCookie, cookieHeader, clearSession } from "../src/session.js";

test("cookie paths enforce boundaries and default to the virtual request directory", () => {
 assert.equal(parseSetCookie("sid=a; HttpOnly; Secure", "/apiv2/auth/login")?.path, "/apiv2/auth");
 assert.equal(cookiePathMatches("/apiv2/auth/me", "/apiv2/auth"), true);
 assert.equal(cookiePathMatches("/apiv2/authentication", "/apiv2/auth"), false);
 assert.equal(parseSetCookie("sid=a; Max-Age=0; Expires=Wed, 01 Jan 2030 00:00:00 GMT")?.expiresAt! <= Date.now(), true);
});

test("memory mode isolates scopes, paths, deletion and logout without storing tokens", async () => {
 await configureSession("https://example.test/one/", "memory");
 await applySetCookie("sid=secret; Path=/apiv2/auth; HttpOnly", "/apiv2/auth/login");
 assert.equal(await cookieHeader("/apiv2/auth/me"), "sid=secret");
 assert.equal(await cookieHeader("/apiv2/other"), undefined);
 await applySetCookie("sid=gone; Path=/apiv2/auth; Max-Age=0");
 assert.equal(await cookieHeader("/apiv2/auth/me"), undefined);
 await applySetCookie("sid=secret; Path=/");
 await configureSession("https://example.test/two/", "memory");
 assert.equal(await cookieHeader("/apiv2"), undefined);
 await clearSession().catch(() => undefined);
});
