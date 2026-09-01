import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium, firefox, webkit } from "playwright-core";

const exchangeUrl = process.env.YURIRTC_E2E_EXCHANGE_URL;
const carrierDir = process.env.YURIRTC_E2E_CARRIER_DIR;
const carrierVariant = (process.env.YURIRTC_E2E_CARRIER_VARIANT ?? "cdn").trim().toLowerCase();
assert.ok(carrierVariant === "cdn" || carrierVariant === "bundled",
  "YURIRTC_E2E_CARRIER_VARIANT must be cdn or bundled");
const bundledCarrier = carrierVariant === "bundled";
const repositoryRoot = process.env.YURIRTC_E2E_REPOSITORY_ROOT;
const pointerPath = process.env.YURIRTC_E2E_POINTER_PATH;
const manifestPublicKey = process.env.YURIRTC_E2E_MANIFEST_PUBLIC_KEY;
const firestoreBaseUrl = process.env.YURIRTC_E2E_FIRESTORE_BASE_URL;
const iceHost = process.env.YURIRTC_E2E_ICE_HOST;
assert.ok(
  exchangeUrl && carrierDir && repositoryRoot && manifestPublicKey && firestoreBaseUrl && iceHost,
  "browser E2E environment is incomplete"
);
assert.match(iceHost, /^(?:\d{1,3}\.){3}\d{1,3}$/, "browser E2E ICE host must be IPv4");
const forcedProtocol = (process.env.YURIRTC_E2E_PROTOCOL ?? "all").trim().toLowerCase();
assert.ok(
  forcedProtocol === "all" || forcedProtocol === "udp" || forcedProtocol === "tcp",
  "YURIRTC_E2E_PROTOCOL must be all, udp, or tcp"
);
const configureUrl = new URL(exchangeUrl);
configureUrl.pathname = "/configure";
configureUrl.search = "";
configureUrl.searchParams.set("protocol", forcedProtocol);
const configured = await fetch(configureUrl, { method: "POST" });
assert.equal(configured.status, 204, `could not configure ${forcedProtocol} browser E2E signaling`);
const browserName = (process.env.YURIRTC_E2E_BROWSER ?? "chromium").trim().toLowerCase();
const browserTypes = { chromium, firefox, webkit };
assert.ok(browserName in browserTypes, "YURIRTC_E2E_BROWSER must be chromium, firefox, or webkit");
const browserType = browserTypes[browserName];
const browserTimeoutMs = Number(process.env.YURIRTC_E2E_TIMEOUT_MS ?? 90_000);
assert.ok(Number.isFinite(browserTimeoutMs) && browserTimeoutMs >= 5_000,
  "YURIRTC_E2E_TIMEOUT_MS must be at least 5000");

const requestLabel = (request) => {
  const url = new URL(request.url());
  const path = url.pathname.replace(/[0-9a-f]{32}/g, "<capability>");
  return `${request.method()} ${url.origin}${path}`;
};

const loaderPackage = JSON.parse(
  await readFile(join(repositoryRoot, "packages", "loader", "package.json"), "utf8")
);
const loaderVersion = String(loaderPackage.version);
const [indexHtml, workerStub, clientBundle, workerBundle, displayFont, signedPointer, durableClient] = await Promise.all([
  readFile(join(carrierDir, "index.html")),
  readFile(join(carrierDir, "sw.js")),
  readFile(join(repositoryRoot, "packages", "loader", "dist", "bundle", "client.js")),
  readFile(join(repositoryRoot, "packages", "loader", "dist", "bundle", "sw.js")),
  readFile(join(repositoryRoot, "packages", "loader", "dist", "assets", "rot13.woff")),
  readFile(pointerPath || join(repositoryRoot, "packages", "integrity", "loader.json")),
  bundledCarrier ? readFile(join(carrierDir, "client.js")) : Promise.resolve(null)
]);
if (bundledCarrier) {
  assert.deepEqual(durableClient, clientBundle,
    "bundled carrier recovery client must match the current loader bundle");
}

const previousWorker = String.raw`
const record = (name) => fetch("/upgrade-observation?event=" + encodeURIComponent(name), {
  method: "POST",
  cache: "no-store",
  keepalive: true
}).catch(() => undefined);

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.t === "bootstrap" || data?.bootstrap) {
    event.waitUntil(record("bootstrap"));
  }
  if (data?.t !== "attach" || !event.ports[0]) return;

  const port = event.ports[0];
  port.onmessage = (message) => {
    if (message.data?.t === "ready") void record("ready");
    if (message.data?.t === "bootstrap" || message.data?.bootstrap) void record("bootstrap");
  };
  port.start();
  port.postMessage({ t: "attached", protocolVersion: 2 });
  event.source?.postMessage({ t: "wake" });

  // Arm and request the replacement only after v3 has genuinely probed this
  // active worker. That makes the mismatch/update race deterministic.
  event.waitUntil((async () => {
    await Promise.all([record("attach"), record("wake")]);
    const armed = await fetch("/arm-v3", { method: "POST", cache: "no-store" });
    if (!armed.ok) throw new Error("could not arm v3 worker");
    await self.registration.update();
  })());
});
`;

// The real v3 bundle still registers all of its own lifecycle handlers. This
// extra wait keeps the previously installed worker active long enough for the browser test to
// observe an installing replacement instead of testing only the settled state.
const delayedV3WorkerPrefix = String.raw`
self.addEventListener("install", (event) => {
  event.waitUntil(new Promise((resolve) => setTimeout(resolve, 1500)));
});
`;

const upgradePageHtml = Buffer.from(String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>YuriRTC worker upgrade test</title></head>
<body><output id="result" data-status="running">running</output>
<script type="module">
const result = document.getElementById("result");
const lifecycle = [];
let overlapObserved = false;
try {
  const registration = await navigator.serviceWorker.register("/upgrade-sw.js", {
    scope: "/",
    updateViaCache: "none"
  });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener(
      "controllerchange", resolve, { once: true }
    ));
  }
  const previousActive = registration.active;
  if (!previousActive) throw new Error("previous worker did not activate");

  registration.addEventListener("updatefound", () => {
    const replacement = registration.installing;
    if (!replacement) return;
    lifecycle.push(replacement.state);
    replacement.addEventListener("statechange", () => lifecycle.push(replacement.state));
    setTimeout(() => {
      if (
        registration.active === previousActive &&
        registration.installing === replacement &&
        replacement.state === "installing"
      ) {
        overlapObserved = true;
      }
    }, 250);
  });

  const { YuriRTCClient } = await import("/upgrade-client.js");
  const client = new YuriRTCClient({
    firebase: {
      apiKey: "browser-e2e-public-key",
      projectId: "browser-e2e-project",
      databaseUrl: "https://browser-e2e.invalid"
    },
    cache: {},
    signal: { firestore: { baseUrl: ${JSON.stringify(firestoreBaseUrl)} } }
  }, "/upgrade.html");
  const diagnostics = await client.connect(registration);
  if (!overlapObserved) throw new Error("previous-active/new-installing overlap was not observed");
  window.__yurirtcUpgrade = { client, registration, diagnostics, lifecycle };
  result.dataset.status = "connected";
  result.dataset.lifecycle = lifecycle.join(",");
  result.textContent = "connected";
} catch (error) {
  result.dataset.status = "error";
  result.textContent = String(error) + "\n" + String(error?.stack ?? "");
}
</script></body></html>`);

const carrierRequests = [];
const upgradeCarrierRequests = [];
const upgradeObservations = { attach: 0, wake: 0, ready: 0, bootstrap: 0 };
let upgradeArmed = false;
let upgradeV3Responses = 0;
let localWorkerRequests = 0;
let externalWorkerRequests = 0;
const requested = {
  pointer: 0,
  client: 0,
  recoveryClient: 0,
  worker: 0,
  font: 0,
  icons: 0,
  firestore: 0
};
const unexpectedRequests = [];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/yurirtc-e2e/loader.json") {
    requested.pointer += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(signedPointer);
    return;
  }
  if (url.pathname === "/yurirtc-e2e/client.js") {
    requested.client += 1;
    response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    response.end(clientBundle);
    return;
  }
  if (url.pathname === "/yurirtc-e2e/rot13.woff") {
    requested.font += 1;
    response.writeHead(200, { "Content-Type": "font/woff" });
    response.end(displayFont);
    return;
  }
  if (url.pathname === "/yurirtc-e2e/icons.css") {
    requested.icons += 1;
    response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    response.end(".material-symbols-rounded{font-family:system-ui}");
    return;
  }
  const isUpgradeHarnessRequest =
    url.pathname === "/arm-v3" || url.pathname.startsWith("/upgrade");
  (isUpgradeHarnessRequest ? upgradeCarrierRequests : carrierRequests).push(url.pathname);
  // Always revalidate the carrier without forcing Firefox to propagate a
  // no-store cache mode to every fetch made by the transported child frame.
  response.setHeader("Cache-Control", "no-cache");
  if (url.pathname === "/upgrade.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(upgradePageHtml);
    return;
  }
  if (url.pathname === "/upgrade-sw.js") {
    response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    if (!upgradeArmed) {
      response.end(previousWorker);
      return;
    }
    upgradeV3Responses += 1;
    response.end(Buffer.concat([Buffer.from(delayedV3WorkerPrefix), workerBundle]));
    return;
  }
  if (url.pathname === "/upgrade-client.js") {
    response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    response.end(clientBundle);
    return;
  }
  if (url.pathname === "/upgrade-observation" && request.method === "POST") {
    const event = url.searchParams.get("event");
    if (event in upgradeObservations) upgradeObservations[event] += 1;
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/arm-v3" && request.method === "POST") {
    upgradeArmed = true;
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(indexHtml);
    return;
  }
  if (url.pathname === "/sw.js") {
    response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    response.end(workerStub);
    return;
  }
  if (url.pathname === "/client.js" && bundledCarrier) {
    requested.recoveryClient += 1;
    response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    response.end(durableClient);
    return;
  }
  if (url.pathname === `/npm/@advwebrec/grainloading@${loaderVersion}/dist/bundle/sw.js`) {
    localWorkerRequests += 1;
    requested.worker += 1;
    response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    response.end(workerBundle);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404, { "Content-Type": "application/xml; charset=utf-8" });
  response.end(`<Error><Code>StaticCarrierOnly</Code><Path>${url.pathname}</Path></Error>`);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;

const executableCandidates = [
  process.env.YURIRTC_E2E_EXECUTABLE_PATH,
  ...(browserName === "chromium" ? [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ] : []),
  browserType.executablePath()
].filter(Boolean);
let executablePath;
for (const candidate of [...new Set(executableCandidates)]) {
  try {
    await access(candidate, fsConstants.X_OK);
    executablePath = candidate;
    break;
  } catch {
    // Try the next installed browser.
  }
}
assert.ok(executablePath, `no ${browserName} executable is available for the browser E2E`);

const launchOptions = {
  executablePath,
  headless: true,
  // A carrier E2E override should leave no external request. Blackhole any
  // regression through the local server instead of allowing a test to contact
  // production CDNs or Firebase.
  proxy: { server: origin, bypass: `127.0.0.1,localhost,${iceHost}` }
};
if (browserName === "firefox") {
  // Firefox deliberately rejects loopback ICE candidates by default. This
  // test's node and browser share 127.0.0.1; production peers use routable
  // addresses and do not need either preference.
  launchOptions.firefoxUserPrefs = {
    "media.peerconnection.ice.loopback": true,
    "media.peerconnection.ice.obfuscate_host_addresses": false
  };
}
const browser = await browserType.launch(launchOptions);

const observeRequest = (request) => {
  const url = new URL(request.url());
  if (url.origin === origin) return;
  const signalBase = new URL(firestoreBaseUrl);
  if (url.origin === signalBase.origin && url.pathname.startsWith(`${signalBase.pathname}/`)) {
    requested.firestore += 1;
    return;
  }
  if (
    (url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com") &&
    url.pathname.includes("/dist/bundle/sw.js")
  ) {
    externalWorkerRequests += 1;
  }
  unexpectedRequests.push(requestLabel(request));
};

let context;
try {
  const upgradeContext = await browser.newContext({ serviceWorkers: "allow" });
  upgradeContext.setDefaultTimeout(browserTimeoutMs);
  upgradeContext.on("request", observeRequest);
  const upgradePage = await upgradeContext.newPage();
  const upgradePageErrors = [];
  const upgradeConsoleErrors = [];
  const upgradeRequestFailures = [];
  upgradePage.on("pageerror", (error) => upgradePageErrors.push(String(error)));
  upgradePage.on("console", (message) => {
    if (message.type() === "error") upgradeConsoleErrors.push(message.text());
  });
  upgradePage.on("requestfailed", (request) => {
    upgradeRequestFailures.push(
      `${requestLabel(request)}: ${request.failure()?.errorText ?? "request failed"}`
    );
  });

  let upgradeSummary;
  try {
    await upgradePage.goto(`${origin}/upgrade.html`, { waitUntil: "domcontentloaded" });
    await upgradePage.waitForFunction(() => {
      const result = document.querySelector("#result");
      return result && result.dataset.status !== "running";
    });
    const upgradeOutcome = await upgradePage.locator("#result").evaluate((element) => ({
      status: element.dataset.status,
      text: element.textContent,
      lifecycle: element.dataset.lifecycle
    }));
    assert.equal(
      upgradeOutcome.status,
      "connected",
      JSON.stringify({
        message: upgradeOutcome.text || "previous-to-current worker upgrade failed without a message",
        requestFailures: upgradeRequestFailures,
        unexpectedRequests,
        requested
      })
    );

    // A newly-created frame is assigned the replacement active worker, while
    // the carrier page intentionally remains under the previous worker until its next load. Its
    // navigation therefore proves the v3 fetch bridge is live without tearing
    // down the page that owns the RTCPeerConnection.
    const probe = await upgradePage.evaluate(() => new Promise((resolve, reject) => {
      const frame = document.createElement("iframe");
      const timer = setTimeout(() => reject(new Error("upgrade probe timed out")), 15_000);
      frame.addEventListener("load", () => {
        clearTimeout(timer);
        try {
          resolve({
            text: frame.contentDocument?.body?.textContent ?? "",
            controlled: Boolean(frame.contentWindow?.navigator.serviceWorker.controller)
          });
        } catch (error) {
          reject(error);
        }
      }, { once: true });
      frame.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("upgrade probe navigation failed"));
      }, { once: true });
      frame.src = "/upgrade-probe.txt?through=v3";
      document.body.append(frame);
    }));
    assert.equal(probe.controlled, true, "the v3 probe frame had no service-worker controller");
    assert.equal(
      probe.text.trim(),
      "YuriRTC v3 service-worker request ok",
      "the activated v3 worker did not serve the probe through YuriRTC"
    );

    // Give an erroneous late port message time to reach the previous worker's
    // observation endpoint before asserting the negative guarantees.
    await upgradePage.waitForTimeout(100);
    assert.equal(upgradeObservations.attach, 1, "the new client did not probe the active previous worker");
    assert.equal(upgradeObservations.wake, 1, "the previous worker did not queue its global wake");
    assert.equal(upgradeObservations.ready, 0, "the new client sent ready to the previous worker");
    assert.equal(upgradeObservations.bootstrap, 0, "the new client leaked bootstrap data to the previous worker");
    assert.equal(upgradeArmed, true, "the in-place v3 update was not armed");
    assert.ok(upgradeV3Responses > 0, "the browser never fetched the v3 replacement worker");
    assert.ok(
      upgradeOutcome.lifecycle?.includes("installing"),
      `the delayed replacement never entered installing: ${upgradeOutcome.lifecycle}`
    );
    assert.ok(
      !upgradeCarrierRequests.includes("/upgrade-probe.txt"),
      "the v3 probe escaped to the static carrier"
    );
    assert.equal(upgradePageErrors.length, 0, upgradePageErrors.join("\n"));
    assert.equal(upgradeConsoleErrors.length, 0, upgradeConsoleErrors.join("\n"));
    assert.deepEqual(unexpectedRequests, [], "an external upgrade request escaped the E2E mocks");
    assert.ok(
      upgradeCarrierRequests.includes("/upgrade-client.js"),
      "the actual v3 client bundle was not loaded for the upgrade"
    );
    assert.ok(requested.firestore >= 2, "the upgraded v3 client did not use real signaling");

    const upgradeRoute = await upgradePage.evaluate(async () => {
      const state = window.__yurirtcUpgrade;
      const stats = await state.client.pc.getStats();
      return {
        diagnostics: state.diagnostics,
        candidates: [...stats.values()]
          .filter((report) => report.type === "local-candidate" || report.type === "remote-candidate")
          .map((report) => ({
            id: report.id,
            type: report.type,
            protocol: report.protocol,
            candidateType: report.candidateType,
            tcpType: report.tcpType
          }))
      };
    });

    upgradeSummary = {
      status: "ok",
      lifecycle: upgradeOutcome.lifecycle,
      observations: { ...upgradeObservations },
      replacementFetches: upgradeV3Responses,
      route: upgradeRoute
    };
  } finally {
    await upgradeContext.close();
  }

  // The existing large-transfer scenario stays a clean first-install run in a
  // separate browser profile, so upgrade state cannot weaken its assertions.
  Object.assign(requested, {
    pointer: 0,
    client: 0,
    recoveryClient: 0,
    worker: 0,
    font: 0,
    icons: 0,
    firestore: 0
  });
  unexpectedRequests.length = 0;
  carrierRequests.length = 0;

  context = await browser.newContext({ serviceWorkers: "allow" });
  context.setDefaultTimeout(browserTimeoutMs);
  context.on("request", observeRequest);
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const consoleDiagnostics = [];
  const httpErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.type() === "warning") consoleDiagnostics.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.title === "learnmathedu");
  let frameElement;
  try {
    frameElement = await page.waitForSelector("iframe");
  } catch (error) {
    const snapshot = await page.locator("body").innerText().catch(() => "<unreadable>");
    const loaderError = await page.locator("[data-yurirtc-loader-error]").evaluate((element, expected) => ({
      error: element.dataset.yurirtcLoaderError,
      stage: element.dataset.yurirtcLoaderIntegrityStage,
      reason: element.dataset.yurirtcLoaderIntegrityReason,
      secure: window.isSecureContext,
      subtle: Boolean(window.crypto?.subtle),
      keyMatches: document.documentElement.dataset.yurirtcTestManifestPublicKey === expected.key,
      manifestMatches: element.dataset.yurirtcLoaderManifestFingerprint === expected.fingerprint
    }), {
      key: manifestPublicKey,
      fingerprint: createHash("sha256").update(signedPointer).digest("base64url")
    }).catch(() => undefined);
    const directSignatureCheck = await page.evaluate(async ({ pointerText, expectedKey }) => {
      const decode = (value) => {
        const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
          "===".slice((value.length + 3) % 4);
        return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
      };
      const envelope = JSON.parse(pointerText);
      const key = await crypto.subtle.importKey(
        "spki",
        decode(expectedKey),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      return crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        decode(envelope.signature.value),
        decode(envelope.payload)
      );
    }, {
      pointerText: signedPointer.toString("utf8"),
      expectedKey: manifestPublicKey
    }).catch(() => undefined);
    throw new Error(`loader did not mount its frame: ${JSON.stringify({
      snapshot,
      loaderError,
      directSignatureCheck,
      pageErrors,
      consoleErrors,
      consoleDiagnostics,
      httpErrors,
      requested,
      unexpectedRequests,
      carrierRequests
    })}`, { cause: error });
  }
  const frame = await frameElement.contentFrame();
  assert.ok(frame, "the real loader did not mount its transported application frame");
  await frame.waitForFunction(() => {
    const result = document.querySelector("#result");
    return result?.dataset.phase === "cache-ready" || result?.dataset.status === "error";
  }, undefined, { timeout: 120_000 });
  const cacheReady = await frame.locator("#result").evaluate((element) => ({
    status: element.dataset.status,
    phase: element.dataset.phase,
    failurePhase: element.dataset.failurePhase,
    text: element.textContent
  }));
  assert.notEqual(cacheReady.status, "error", cacheReady.text || "fixture failed before cache check");

  // No request routing is installed in this context, because Playwright turns
  // off the browser HTTP cache whenever any route handler exists.
  await frame.evaluate(() => dispatchEvent(new Event("yurirtc-cache-e2e-start")));
  await frame.waitForFunction(() => {
    const result = document.querySelector("#result");
    return result?.dataset.phase === "cache-complete" || result?.dataset.status === "error";
  }, undefined, { timeout: 120_000 });
  const cachePhase = await frame.locator("#result").evaluate((element) => ({
    status: element.dataset.status,
    phase: element.dataset.phase,
    failurePhase: element.dataset.failurePhase,
    text: element.textContent
  }));
  assert.notEqual(
    cachePhase.status,
    "error",
    `transport fixture failed during ${cachePhase.failurePhase ?? cachePhase.phase}: ${cachePhase.text}`
  );
  await frame.evaluate(() => dispatchEvent(new Event("yurirtc-cache-e2e-finish")));
  await frame.waitForFunction(() => {
    const result = document.querySelector("#result");
    return result?.dataset.phase === "upload" || result?.dataset.status === "error";
  }, undefined, { timeout: 120_000 });
  const firstPhase = await frame.locator("#result").evaluate((element) => ({
    status: element.dataset.status,
    phase: element.dataset.phase,
    failurePhase: element.dataset.failurePhase,
    text: element.textContent
  }));
  assert.notEqual(
    firstPhase.status,
    "error",
    `transport fixture failed: ${JSON.stringify({
      phase: firstPhase.failurePhase ?? firstPhase.phase,
      text: firstPhase.text,
      consoleDiagnostics,
      pageErrors,
      consoleErrors,
      httpErrors
    })}`
  );

  // Connect another real loader tab while the incumbent has a paced upload in
  // flight. The second tab must become standby, load its own transported app
  // through the winner, and leave the first transfer intact.
  const secondPage = await context.newPage();
  secondPage.on("pageerror", (error) => pageErrors.push(`second tab: ${String(error)}`));
  secondPage.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location().url;
      consoleErrors.push(`second tab: ${message.text()}${location ? ` (${location})` : ""}`);
    }
  });
  secondPage.on("response", (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
  });
  await secondPage.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  await secondPage.waitForFunction(() => document.title === "learnmathedu");
  let secondFrameElement;
  try {
    secondFrameElement = await secondPage.waitForSelector("iframe");
  } catch (error) {
    const snapshot = await secondPage.locator("body").innerText().catch(() => "<unreadable>");
    const state = await secondPage.locator("[data-yurirtc-loader-error], [data-yurirtc-network]")
      .evaluateAll((elements) => elements.map((element) => ({ ...element.dataset })))
      .catch(() => []);
    throw new Error(`standby loader did not mount its frame: ${JSON.stringify({
      snapshot,
      state,
      pageErrors,
      consoleErrors,
      consoleDiagnostics,
      httpErrors,
      requested,
      unexpectedRequests,
      carrierRequests
    })}`, { cause: error });
  }
  const secondFrame = await secondFrameElement.contentFrame();
  assert.ok(secondFrame, "the standby tab did not mount its transported application frame");

  // The first backend upload response is held until the transported standby
  // document exists. This keeps buffered Firefox/WebKit uploads in the same
  // deterministic overlap as Chromium's streaming upload without relaxing
  // the streaming receive-span assertion.
  await secondFrame.waitForSelector("#result", { timeout: 120_000 });
  const overlap = await frame.locator("#result").evaluate((element) => ({
    status: element.dataset.status,
    phase: element.dataset.phase,
    text: element.textContent
  }));
  assert.equal(overlap.status, "running", overlap.text || "the first upload completed before standby mounted");
  assert.equal(overlap.phase, "upload", `the first tab left upload during standby mount: ${overlap.phase}`);
  const gateRelease = await secondFrame.evaluate(async () => {
    const response = await fetch("/apiv2/release-upload-gate", { method: "POST" });
    return { status: response.status, text: await response.text() };
  });
  assert.equal(
    gateRelease.status,
    204,
    gateRelease.text || "the mounted standby frame could not release the first upload"
  );

  await Promise.all([frame, secondFrame].map((candidate) => candidate.waitForFunction(() => {
    const result = document.querySelector("#result");
    return result && result.dataset.status !== "running";
  }, undefined, { timeout: 120_000 })));
  const result = await frame.waitForSelector("#result");
  const secondResult = await secondFrame.waitForSelector("#result");
  const outcome = await result.evaluate((element) => ({
    status: element.dataset.status,
    text: element.textContent,
    metrics: { ...element.dataset }
  }));
  const secondOutcome = await secondResult.evaluate((element) => ({
    status: element.dataset.status,
    text: element.textContent,
    metrics: { ...element.dataset }
  }));
  assert.equal(outcome.status, "ok", outcome.text || "transport fixture failed without a message");
  assert.equal(
    secondOutcome.status,
    "ok",
    secondOutcome.text || "standby-tab transport fixture failed without a message"
  );
  const metrics = outcome.metrics;
  const selectedProtocol = await page.locator("[data-yurirtc-network]").evaluate(
    (element) => element.dataset.yurirtcNetworkTier?.split("-")[0] ?? "unknown"
  );
  if (forcedProtocol !== "all") {
    assert.equal(
      selectedProtocol,
      forcedProtocol,
      `browser selected the wrong ICE transport: ${JSON.stringify(upgradeSummary?.route)}`
    );
  }

  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(
    consoleErrors.length,
    0,
    JSON.stringify({ consoleErrors, httpErrors })
  );
  if (bundledCarrier) {
    const durableModule = await page.evaluate(async (url) => {
      const loaded = await import(url);
      return {
        client: typeof loaded.YuriRTCClient,
        legacyClient: typeof loaded.LoaderClient,
        boot: typeof loaded.boot
      };
    }, `${origin}/client.js`);
    assert.deepEqual(durableModule, {
      client: "function",
      legacyClient: "function",
      boot: "function"
    }, "the bundled same-origin recovery module lost its loader exports");
    assert.equal(requested.client, 0, "bundled carrier fetched the resolver client fixture");
    assert.equal(requested.pointer, 0, "bundled carrier fetched the signed CDN pointer");
    assert.equal(requested.worker, 0, "bundled carrier fetched the CDN worker route");
    assert.equal(requested.font, 0, "bundled carrier fetched the loader font route");
    assert.ok(requested.recoveryClient > 0,
      "transported documents did not use the durable same-origin recovery client");
    const persisted = await page.evaluate(() => new Promise((resolve, reject) => {
      const opened = indexedDB.open("edurocks-loader-config", 1);
      opened.onerror = () => reject(opened.error ?? new Error("bootstrap database open failed"));
      opened.onsuccess = () => {
        const database = opened.result;
        const request = database.transaction("config", "readonly").objectStore("config").get("current");
        request.onerror = () => reject(request.error ?? new Error("bootstrap read failed"));
        request.onsuccess = () => {
          database.close();
          resolve(request.result);
        };
      };
    }));
    assert.equal(
      persisted?.clientUrls?.[0],
      `${origin}/client.js`,
      "bundled recovery did not persist its same-origin client ahead of blob/CDN sources"
    );
  } else {
    assert.ok(requested.client >= 2, "both real loader tabs did not request the client bundle");
    assert.ok(requested.pointer >= 2, "both real loader tabs did not request the signed pointer");
    assert.ok(requested.worker > 0, "the real worker bundle was not requested");
    assert.equal(requested.recoveryClient, 0, "CDN carrier requested the bundled recovery client");
    assert.ok(
      carrierRequests.includes(`/npm/@advwebrec/grainloading@${loaderVersion}/dist/bundle/sw.js`),
      "the deterministic same-origin worker bundle was not requested"
    );
    assert.ok(requested.font > 0, "the real display font was not requested");
  }
  assert.equal(externalWorkerRequests, 0, "the browser E2E worker escaped to a production CDN");
  assert.ok(requested.icons > 0, "the hosted Material Symbols stylesheet was not requested");
  assert.ok(requested.firestore >= 4, "both real loader tabs did not exchange signaling offers");
  assert.deepEqual(unexpectedRequests, [], "an external request escaped the deterministic E2E mocks");
  assert.ok(carrierRequests.includes("/index.html"), "the generated carrier was not served");
  assert.ok(carrierRequests.includes("/sw.js"), "the generated worker stub was not served");
  assert.ok(
    carrierRequests.every((path) =>
      path === "/index.html" ||
      path === "/sw.js" ||
      (bundledCarrier && path === "/client.js") ||
      path === "/favicon.ico" ||
      path === `/npm/@advwebrec/grainloading@${loaderVersion}/dist/bundle/sw.js`
    ),
    `application traffic escaped the service worker: ${JSON.stringify(carrierRequests)}`
  );

  process.stdout.write(JSON.stringify({
    status: "ok",
    browserName,
    carrierVariant,
    title: await page.title(),
    forcedProtocol,
    selectedProtocol,
    upgrade: upgradeSummary,
    metrics,
    standbyMetrics: secondOutcome.metrics,
    requests: requested
  }));
} finally {
  await context?.close();
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
