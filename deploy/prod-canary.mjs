import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  installCanaryProtocolFilter,
  normalizeCanaryProtocol
} from "./prod-canary-protocol.mjs";
import {
  fromBase64url,
  publicKeyFromBase64url,
  verifyManifest
} from "../packages/integrity/manifest-crypto.mjs";

const carrierDir = process.argv[2];
assert.ok(carrierDir, "usage: node deploy/prod-canary.mjs CARRIER_DIR [EXPECTED_LOADER_VERSION]");

const repositoryLoader = JSON.parse(
  await readFile(new URL("../packages/loader/package.json", import.meta.url), "utf8")
);
const expectedLoaderVersion = process.argv[3] ?? String(repositoryLoader.version);
assert.match(expectedLoaderVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const publicConfiguration = JSON.parse(
  await readFile(new URL("./npm/manifest-public-key.json", import.meta.url), "utf8")
);
const manifestPublicKey = publicKeyFromBase64url(publicConfiguration.spki);
// Both moving pointer URLs must carry a valid signature over the expected
// immutable loader version before the browser canary runs.
for (const source of [
  "https://cdn.jsdelivr.net/npm/shaintloadingcheckpak@latest/loader.json",
  "https://unpkg.com/shaintloadingcheckpak@latest/loader.json"
]) {
  const hostname = new URL(source).hostname;
  const response = await fetch(source, { redirect: "follow" });
  assert.ok(response.ok, `signed pointer request failed: ${hostname}`);
  const manifest = await response.json();
  assert.equal(verifyManifest(manifest, manifestPublicKey), true, `${hostname} pointer signature is invalid`);
  const { loader } = JSON.parse(fromBase64url(manifest.payload).toString("utf8"));
  assert.equal(
    loader.version,
    expectedLoaderVersion,
    `${hostname} points to ${loader.version}, expected ${expectedLoaderVersion}`
  );
}

const forcedProtocol = normalizeCanaryProtocol(process.env.YURIRTC_CANARY_PROTOCOL);
const canaryTimeoutMs = Number(process.env.YURIRTC_CANARY_TIMEOUT_MS ?? 120_000);
assert.ok(
  Number.isInteger(canaryTimeoutMs) && canaryTimeoutMs >= 5_000 && canaryTimeoutMs <= 300_000,
  "YURIRTC_CANARY_TIMEOUT_MS must be an integer from 5000 through 300000"
);

const [indexHtml, serviceWorker] = await Promise.all([
  readFile(join(carrierDir, "index.html")),
  readFile(join(carrierDir, "sw.js"))
]);

const carrierRequests = { index: 0, worker: 0, favicon: 0, other: 0 };
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    carrierRequests.index += 1;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(indexHtml);
    return;
  }
  if (url.pathname === "/sw.js") {
    carrierRequests.worker += 1;
    response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    response.end(serviceWorker);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    carrierRequests.favicon += 1;
    response.writeHead(204);
    response.end();
    return;
  }
  carrierRequests.other += 1;
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("static canary carrier only");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;

const chromeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  chromium.executablePath()
].filter(Boolean);
let executablePath;
for (const candidate of [...new Set(chromeCandidates)]) {
  try {
    await access(candidate, fsConstants.X_OK);
    executablePath = candidate;
    break;
  } catch {
    // Try the next installed browser.
  }
}
assert.ok(executablePath, "no Chromium executable is available");

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: "allow" });
context.setDefaultTimeout(canaryTimeoutMs);
const cdnRequests = { client: 0, worker: 0, font: 0, metadata: 0 };
const workerVersions = new Set();
const firebaseRequests = { auth: 0, firestore: 0, rtdb: 0 };
const successfulRequests = { cdn: 0, firebase: 0, other: 0 };
const cancelledRequests = { cdn: 0, firebase: 0, other: 0 };
const failedRequests = { cdn: 0, firebase: 0, other: 0 };
const requestKinds = new WeakMap();

// Record only coarse categories. Firebase URLs can contain the public API key,
// per-session identifiers, and signaling capabilities, so neither the URL nor
// its path/query is retained or printed by this production canary.
const classifyRequest = (requestUrl) => {
  const url = new URL(requestUrl);
  const cdn = url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com";
  if (cdn) {
    const path = url.pathname.replace(/^\/npm\//, "/");
    const prefix = "/@advwebrec/grainloading@";
    if (path === "/shaintloadingcheckpak@latest/loader.json") cdnRequests.metadata += 1;
    if (path === `${prefix}${expectedLoaderVersion}/dist/bundle/client.js`) cdnRequests.client += 1;
    if (path === `${prefix}${expectedLoaderVersion}/dist/assets/rot13.woff`) cdnRequests.font += 1;
    const worker = path.match(/^\/@advwebrec\/grainloading@([^/]+)\/dist\/bundle\/sw\.js$/);
    if (worker) {
      cdnRequests.worker += 1;
      workerVersions.add(worker[1]);
    }
    return "cdn";
  }
  if (url.hostname === "identitytoolkit.googleapis.com") {
    firebaseRequests.auth += 1;
    return "firebase";
  }
  if (url.hostname === "firestore.googleapis.com") {
    firebaseRequests.firestore += 1;
    return "firebase";
  }
  if (url.hostname.endsWith(".firebaseio.com") ||
      url.hostname.endsWith(".firebasedatabase.app")) {
    firebaseRequests.rtdb += 1;
    return "firebase";
  }
  return "other";
};

context.on("request", (request) => {
  requestKinds.set(request, classifyRequest(request.url()));
});
context.on("response", (response) => {
  if (!response.ok()) return;
  successfulRequests[requestKinds.get(response.request()) ?? "other"] += 1;
});
context.on("requestfailed", (request) => {
  const kind = requestKinds.get(request) ?? "other";
  const errorText = request.failure()?.errorText ?? "";
  // The loader deliberately aborts the losing Firebase signaling leg and CDN
  // fallback after a verified winner. Browser engines surface those expected
  // AbortController cancellations as request failures even though boot succeeds.
  if (/abort|cancel/i.test(errorText)) {
    cancelledRequests[kind] += 1;
    return;
  }
  failedRequests[kind] += 1;
});

const page = await context.newPage();
await page.addInitScript(installCanaryProtocolFilter, { forcedProtocol });
let pageErrorCount = 0;
page.on("pageerror", () => {
  pageErrorCount += 1;
});

try {
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => {
      const network = document.querySelector("[data-yurirtc-network]");
      return network?.dataset.yurirtcNetworkState === "connected";
    });
  } catch (error) {
    const state = await page.evaluate(() => {
      const network = document.querySelector("[data-yurirtc-network]");
      return {
        networkState: network?.dataset.yurirtcNetworkState ?? "missing",
        networkTier: network?.dataset.yurirtcNetworkTier ?? "",
        title: document.title
      };
    });
    throw new Error(
      `carrier did not connect: state=${state.networkState}, ` +
      `tier=${state.networkTier || "none"}, title=${state.title || "none"}`,
      { cause: error }
    );
  }
  const frameElement = await page.waitForSelector("iframe");
  const frame = await frameElement.contentFrame();
  assert.ok(frame, "transported application iframe was not attached");
  await frame.waitForFunction(() => document.readyState === "complete" && Boolean(document.body));
  await page.evaluate(() => document.fonts.ready);

  const result = await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const network = document.querySelector("[data-yurirtc-network]");
    const frame = document.querySelector("iframe");
    return {
      title: document.title,
      controllerActive: Boolean(navigator.serviceWorker.controller),
      registrationCount: registrations.length,
      networkState: network?.dataset.yurirtcNetworkState ?? "legacy",
      networkTier: network?.dataset.yurirtcNetworkTier ?? "",
      frameReady: Boolean(frame?.contentDocument?.body?.childNodes.length),
      frameBytes: frame?.contentDocument?.documentElement?.outerHTML.length ?? 0
    };
  });
  assert.ok(result.controllerActive, "canary page has no active service-worker controller");
  assert.ok(result.frameReady, "transported application body was not populated");
  assert.ok(result.frameBytes > 0, "transported application response was empty");
  assert.equal(pageErrorCount, 0, `canary page emitted ${pageErrorCount} errors`);
  assert.equal(result.title, "learnmathedu");
  assert.equal(result.networkState, "connected");
  if (forcedProtocol !== "all") {
    assert.ok(
      result.networkTier === `${forcedProtocol}-standard` ||
        result.networkTier === `${forcedProtocol}-443`,
      `forced ${forcedProtocol} canary reported network tier ${result.networkTier || "unknown"}`
    );
  }
  assert.ok(cdnRequests.client > 0, "published loader client was not fetched from a live CDN");
  assert.ok(cdnRequests.worker > 0, "immutable worker was not fetched from a live CDN");
  assert.ok(cdnRequests.font > 0, "published loader font was not fetched from a live CDN");
  assert.deepEqual([...workerVersions], [expectedLoaderVersion]);
  assert.ok(
    firebaseRequests.auth + firebaseRequests.firestore + firebaseRequests.rtdb > 0,
    "no request reached the real Firebase signaling services"
  );
  assert.ok(successfulRequests.firebase > 0, "no Firebase signaling response succeeded");
  assert.equal(failedRequests.cdn, 0, "a live CDN request failed");
  assert.equal(failedRequests.firebase, 0, "a real Firebase signaling request failed");
  assert.equal(carrierRequests.other, 0, "application traffic escaped to the static carrier");
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    loaderVersion: expectedLoaderVersion,
    forcedProtocol,
    result,
    cdnRequests,
    firebaseRequests,
    successfulRequests,
    cancelledRequests,
    carrierRequests,
    failedRequests
  })}\n`);
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
