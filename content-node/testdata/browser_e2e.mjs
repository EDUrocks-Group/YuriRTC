import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright-core";

const exchangeUrl = process.env.YURIRTC_E2E_EXCHANGE_URL;
const carrierDir = process.env.YURIRTC_E2E_CARRIER_DIR;
const repositoryRoot = process.env.YURIRTC_E2E_REPOSITORY_ROOT;
assert.ok(exchangeUrl && carrierDir && repositoryRoot, "browser E2E environment is incomplete");
const forcedProtocol = (process.env.YURIRTC_E2E_PROTOCOL ?? "all").trim().toLowerCase();
assert.ok(
  forcedProtocol === "all" || forcedProtocol === "udp" || forcedProtocol === "tcp",
  "YURIRTC_E2E_PROTOCOL must be all, udp, or tcp"
);

const candidateProtocol = (candidate) => {
  const match = String(candidate).trim().match(
    /^(?:a=)?candidate:\S+\s+\d+\s+([^\s]+)/i
  );
  return match?.[1]?.toLowerCase();
};

const forceAnswerProtocol = (answer) => {
  if (forcedProtocol === "all") return answer;
  const sdp = String(answer.sdp).replace(
    /^a=candidate:[^\r\n]*(?:\r\n|\n|$)/gim,
    (line) => candidateProtocol(line) === forcedProtocol ? line : ""
  );
  const candidates = Array.isArray(answer.candidates)
    ? answer.candidates.filter((candidate) =>
        candidateProtocol(candidate?.candidate ?? candidate) === forcedProtocol
      )
    : [];
  assert.match(
    sdp,
    new RegExp(`^a=candidate:\\S+\\s+\\d+\\s+${forcedProtocol}\\s`, "im"),
    `local answer has no ${forcedProtocol} candidate`
  );
  return { ...answer, sdp, candidates };
};

const loaderPackage = JSON.parse(
  await readFile(join(repositoryRoot, "packages", "loader", "package.json"), "utf8")
);
const loaderVersion = String(loaderPackage.version);
const [indexHtml, workerStub, clientBundle, workerBundle, displayFont] = await Promise.all([
  readFile(join(carrierDir, "index.html")),
  readFile(join(carrierDir, "sw.js")),
  readFile(join(repositoryRoot, "packages", "loader", "dist", "bundle", "client.js")),
  readFile(join(repositoryRoot, "packages", "loader", "dist", "bundle", "sw.js")),
  readFile(join(repositoryRoot, "packages", "loader", "dist", "assets", "rot13.woff"))
]);

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

  const { YuriRTCClient } = await import(
    "https://cdn.jsdelivr.net/npm/@edurocks-group/loader@latest/dist/bundle/client.js"
  );
  const client = new YuriRTCClient({
    firebase: {
      apiKey: "browser-e2e-public-key",
      projectId: "browser-e2e-project",
      databaseUrl: "https://browser-e2e.invalid"
    },
    cache: {},
    signal: {}
  }, "/upgrade.html");
  const diagnostics = await client.connect(registration);
  if (!overlapObserved) throw new Error("previous-active/new-installing overlap was not observed");
  window.__yurirtcUpgrade = { client, registration, diagnostics, lifecycle };
  result.dataset.status = "connected";
  result.dataset.lifecycle = lifecycle.join(",");
  result.textContent = "connected";
} catch (error) {
  result.dataset.status = "error";
  result.textContent = String(error && error.stack || error);
}
</script></body></html>`);

const carrierRequests = [];
const upgradeObservations = { attach: 0, wake: 0, ready: 0, bootstrap: 0 };
let upgradeArmed = false;
let upgradeV3Responses = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  carrierRequests.push(url.pathname);
  response.setHeader("Cache-Control", "no-store");
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
assert.ok(executablePath, "no Chromium executable is available for the browser E2E");

const browser = await chromium.launch({ executablePath, headless: true });
const answers = new Map();
const requested = { client: 0, worker: 0, font: 0, firestore: 0 };
const unexpectedRequests = [];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS",
  "Cache-Control": "no-store"
};

const handleRoute = async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === origin) {
    await route.continue();
    return;
  }

  const cdn = url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com";
  const path = url.pathname.replace(/^\/npm\//, "/");
  const packagePrefix = "/@edurocks-group/loader@";
  if (cdn && path === `${packagePrefix}latest/package.json`) {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      headers: cors,
      body: JSON.stringify({ version: loaderVersion })
    });
    return;
  }
  if (cdn && path === `${packagePrefix}latest/dist/bundle/client.js`) {
    requested.client += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      headers: cors,
      body: clientBundle
    });
    return;
  }
  // The carrier's stub imports the moving dist-tag directly (deploy/npm/src/sw.js
  // explains why: the version resolution it used to do relied on
  // XMLHttpRequest, which does not exist in a worker, so it threw every time and
  // pinned every carrier to its publish-time loader). Serve the path the stub
  // actually asks for, not the pinned one it no longer builds.
  if (cdn && path === `${packagePrefix}latest/dist/bundle/sw.js`) {
    requested.worker += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      headers: cors,
      body: workerBundle
    });
    return;
  }
  if (cdn && path === `${packagePrefix}latest/dist/assets/rot13.woff`) {
    requested.font += 1;
    await route.fulfill({
      status: 200,
      contentType: "font/woff",
      headers: cors,
      body: displayFont
    });
    return;
  }

  if (url.hostname === "firestore.googleapis.com") {
    requested.firestore += 1;
    const firestorePrefix =
      "/v1/projects/browser-e2e-project/databases/(default)/documents/signal/";
    assert.ok(url.pathname.startsWith(firestorePrefix), `unexpected Firestore path: ${url.pathname}`);
    assert.match(url.pathname.slice(firestorePrefix.length), /^[0-9a-f]{32}$/);
    assert.deepEqual([...url.searchParams], [["mask.fieldPaths", "answer"]]);
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors, body: "" });
      return;
    }
    const key = url.pathname;
    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      const rawOffer = body?.fields?.offer?.stringValue;
      assert.equal(typeof rawOffer, "string", "Firestore offer payload is missing");
      const exchange = await fetch(exchangeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawOffer
      });
      const exchangeBody = await exchange.text();
      assert.equal(exchange.status, 200, `local exchange failed: ${exchangeBody}`);
      answers.set(key, forceAnswerProtocol(JSON.parse(exchangeBody)));
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: cors,
        body: JSON.stringify({ fields: {} })
      });
      return;
    }
    if (request.method() === "GET") {
      const answer = answers.get(key);
      assert.ok(answer, "Firestore answer was polled before the local exchange completed");
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: cors,
        body: JSON.stringify({ fields: { answer: { stringValue: JSON.stringify(answer) } } })
      });
      return;
    }
  }

  unexpectedRequests.push(`${request.method()} ${request.url()}`);
  await route.abort("blockedbyclient");
};

let context;
try {
  const upgradeContext = await browser.newContext({ serviceWorkers: "allow" });
  upgradeContext.setDefaultTimeout(90_000);
  await upgradeContext.route("**/*", handleRoute);
  const upgradePage = await upgradeContext.newPage();
  const upgradePageErrors = [];
  const upgradeConsoleErrors = [];
  upgradePage.on("pageerror", (error) => upgradePageErrors.push(String(error)));
  upgradePage.on("console", (message) => {
    if (message.type() === "error") upgradeConsoleErrors.push(message.text());
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
      upgradeOutcome.text || "previous-to-current worker upgrade failed without a message"
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
      !carrierRequests.includes("/upgrade-probe.txt"),
      "the v3 probe escaped to the static carrier"
    );
    assert.equal(upgradePageErrors.length, 0, upgradePageErrors.join("\n"));
    assert.equal(upgradeConsoleErrors.length, 0, upgradeConsoleErrors.join("\n"));
    assert.deepEqual(unexpectedRequests, [], "an external upgrade request escaped the E2E mocks");
    assert.ok(requested.client > 0, "the actual v3 client bundle was not loaded for the upgrade");
    assert.ok(requested.firestore >= 2, "the upgraded v3 client did not use real signaling");

    upgradeSummary = {
      status: "ok",
      lifecycle: upgradeOutcome.lifecycle,
      observations: { ...upgradeObservations },
      replacementFetches: upgradeV3Responses
    };
  } finally {
    await upgradeContext.close();
  }

  // The existing large-transfer scenario stays a clean first-install run in a
  // separate browser profile, so upgrade state cannot weaken its assertions.
  answers.clear();
  Object.assign(requested, { client: 0, worker: 0, font: 0, firestore: 0 });
  unexpectedRequests.length = 0;
  carrierRequests.length = 0;

  context = await browser.newContext({ serviceWorkers: "allow" });
  context.setDefaultTimeout(90_000);
  await context.route("**/*", handleRoute);
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const httpErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.title === "learnmathedu");
  const frameElement = await page.waitForSelector("iframe");
  const frame = await frameElement.contentFrame();
  assert.ok(frame, "the real loader did not mount its transported application frame");
  await frame.waitForFunction(() => {
    const result = document.querySelector("#result");
    return result?.dataset.phase === "upload";
  }, undefined, { timeout: 120_000 });

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
  const secondFrameElement = await secondPage.waitForSelector("iframe");
  const secondFrame = await secondFrameElement.contentFrame();
  assert.ok(secondFrame, "the standby tab did not mount its transported application frame");

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
    assert.equal(selectedProtocol, forcedProtocol, "browser selected the wrong ICE transport");
  }

  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(
    consoleErrors.length,
    0,
    JSON.stringify({ consoleErrors, httpErrors })
  );
  assert.ok(requested.client >= 2, "both real loader tabs did not request the client bundle");
  assert.ok(requested.worker > 0, "the real worker bundle was not requested");
  assert.ok(requested.font > 0, "the real display font was not requested");
  assert.ok(requested.firestore >= 4, "both real loader tabs did not exchange signaling offers");
  assert.deepEqual(unexpectedRequests, [], "an external request escaped the deterministic E2E mocks");
  assert.ok(carrierRequests.includes("/index.html"), "the generated carrier was not served");
  assert.ok(carrierRequests.includes("/sw.js"), "the generated worker stub was not served");
  assert.ok(
    carrierRequests.every((path) =>
      path === "/index.html" || path === "/sw.js" || path === "/favicon.ico"
    ),
    `application traffic escaped the service worker: ${JSON.stringify(carrierRequests)}`
  );

  process.stdout.write(JSON.stringify({
    status: "ok",
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
