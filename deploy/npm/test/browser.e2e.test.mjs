import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright-core";
import {
  base64url,
  loaderDescriptor,
  signManifest
} from "../../../packages/integrity/manifest-crypto.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, "..");
const FONT_PATH = join(PACKAGE_DIR, "..", "..", "packages", "loader", "assets", "rot13.woff");
const EXPECTED_FONT_SHA256 = "94f4eb3f78b78c6aa70f9c0a9c846a9e0ed430151d35a62aa758aea78a98e2d5";
const LOADER_VERSION = "0.5.1";

const startPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>YuriRTC test app</title></head>
<body><main><h1 id="route">Start</h1><a id="next" href="route-two.html">Next</a>
<output id="asset">pending</output></main>
<script>fetch("./asset.json").then((response) => response.json()).then((value) => {
  const output = document.getElementById("asset");
  output.textContent = value.source;
  output.dataset.ready = String(value.ok);
});</script></body></html>`;

const routeTwoPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>YuriRTC second route</title></head>
<body><main><h1 id="route">Second</h1><a id="previous" href="start.html">Previous</a></main></body></html>`;

const mockWorker = `
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
const startPage = ${JSON.stringify(startPage)};
const routeTwoPage = ${JSON.stringify(routeTwoPage)};
function response(body, type) {
  return new Response(body, {
    headers: { "Content-Type": type, "Cache-Control": "no-store", "X-YuriRTC-E2E": "mock-worker" }
  });
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return;
  if (url.pathname.endsWith("/app/start.html")) {
    event.respondWith(Promise.resolve(response(startPage, "text/html; charset=utf-8")));
  } else if (url.pathname.endsWith("/app/route-two.html")) {
    event.respondWith(Promise.resolve(response(routeTwoPage, "text/html; charset=utf-8")));
  } else if (url.pathname.endsWith("/app/asset.json")) {
    event.respondWith(Promise.resolve(response(JSON.stringify({ ok: true, source: "service-worker" }), "application/json")));
  }
});
`;

const mockClient = `
function activated(registration) {
  if (registration.active && registration.active.state === "activated") return Promise.resolve();
  const worker = registration.installing || registration.waiting || registration.active;
  if (!worker) return Promise.reject(new Error("mock registration has no worker"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock service worker activation timed out")), 10000);
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") { clearTimeout(timer); resolve(); }
      if (worker.state === "redundant") { clearTimeout(timer); reject(new Error("mock service worker became redundant")); }
    });
  });
}
function controlled() {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock page was not claimed")), 10000);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
export async function boot(options) {
  await new Promise((resolve) => { window.__YURIRTC_E2E_CONTINUE__ = resolve; });
  const script = new URL(options.swUrl, location.href);
  const scope = new URL("./", script);
  const registration = await navigator.serviceWorker.register(script, { scope: scope.pathname });
  await activated(registration);
  await controlled();
  window.__YURIRTC_E2E__ = {
    appPath: options.appPath,
    scope: registration.scope,
    script: registration.active && registration.active.scriptURL
  };
  const frame = document.createElement("iframe");
  frame.id = "yurirtc-test-frame";
  frame.title = "YuriRTC deterministic test app";
  frame.src = new URL("app/start.html", scope).href;
  options.mount.replaceChildren(frame);
  options.onDiagnostics({
    route: { transport: "udp", portClass: "standard" },
    signalBackend: "mock",
    signalElapsedMs: 1
  });
}
`;
const mockClientBytes = new TextEncoder().encode(mockClient);
const testSigningKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const testPublicKey = base64url(
  testSigningKeys.publicKey.export({ format: "der", type: "spki" })
);
const mockLoaderDescriptor = loaderDescriptor(
  LOADER_VERSION,
  createHash("sha256").update(mockClientBytes).digest("base64url")
);
const mockManifest = JSON.stringify(signManifest(mockLoaderDescriptor, testSigningKeys.privateKey));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function findChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    chromium.executablePath()
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next portable location.
    }
  }
  return null;
}

function buildRelease(outputDirectory, { bundled = false } = {}) {
  const arguments_ = [
    "build.mjs",
    "--release",
    "--test-manifest-public-key",
    "--out-dir",
    outputDirectory
  ];
  if (bundled) arguments_.push("--bundled-loader");
  const result = spawnSync(
    process.execPath,
    arguments_,
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      env: {
        ...process.env,
        YURIRTC_FIREBASE_API_KEY: "browser-test-public-key",
        YURIRTC_FIREBASE_PROJECT_ID: "browser-test-project",
        YURIRTC_FIREBASE_DATABASE_URL: "https://browser-test.invalid",
        YURIRTC_BROWSER_E2E_BUILD: "1",
        YURIRTC_TEST_MANIFEST_PUBLIC_KEY: testPublicKey
      }
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function localServer(indexHtml, serviceWorker) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push(url.pathname);
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname.endsWith("/index.html")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(indexHtml);
    } else if (url.pathname.endsWith("/sw.js")) {
      response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      response.end(serviceWorker);
    } else {
      response.writeHead(404, { "Content-Type": "application/xml; charset=utf-8" });
      response.end(`<Error><Code>EscapedDeploymentPrefix</Code><Path>${url.pathname}</Path></Error>`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  };
}

async function runHostingScenario(browser, server, font, prefix) {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  context.setDefaultTimeout(15_000);
  const network = { manifest: [], client: [], font: [], worker: [], icons: [], forbidden: [], sameOrigin: [] };
  let releaseFont;
  const fontGate = new Promise((resolve) => { releaseFont = resolve; });

  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === server.origin) network.sameOrigin.push(url.pathname);
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === server.origin) {
      await route.continue();
      return;
    }
    const allowedHost = url.hostname === "unpkg.com" || url.hostname === "cdn.jsdelivr.net";
    // jsdelivr prefixes package paths with /npm/, unpkg does not. Normalize.
    const path = url.pathname.replace(/^\/npm\//, "/");
    const versionPath = `/@advwebrec/grainloading@${LOADER_VERSION}/dist/`;
    const pointerPath = "/shaintloadingcheckpak@latest/loader.json";
    if (allowedHost && path === pointerPath) {
      network.manifest.push(url.href);
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: mockManifest
      });
    } else if (allowedHost && path === `${versionPath}bundle/client.js`) {
      network.client.push(url.href);
      await route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: mockClient
      });
    } else if (allowedHost && path === `${versionPath}assets/rot13.woff`) {
      network.font.push(url.href);
      await fontGate;
      await route.fulfill({
        status: 200,
        contentType: "font/woff",
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: font
      });
    } else if (allowedHost && path === `${versionPath}bundle/sw.js`) {
      network.worker.push(url.href);
      await route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: mockWorker
      });
    } else if (url.hostname === "fonts.googleapis.com") {
      network.icons.push(url.href);
      await route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: ".material-symbols-rounded{font-family:system-ui}"
      });
    } else {
      network.forbidden.push(url.href);
      await route.abort("blockedbyclient");
    }
  });

  const page = await context.newPage();
  const pageErrors = [];
  const consoleMessages = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => consoleMessages.push(message.text()));
  const entry = `${server.origin}${prefix}index.html`;
  const serverRequestStart = server.requests.length;
  try {
    await page.goto(entry, { waitUntil: "commit" });
    const neutral = await page.waitForSelector(
      '[data-yurirtc-network][data-yurirtc-network-state="testing"]'
    );
    await page.waitForFunction(() => typeof window.__YURIRTC_E2E_CONTINUE__ === "function");
    const testingState = await neutral.evaluate((bar) => {
      const boot = document.querySelector("[data-yurirtc-view]");
      const card = boot?.firstElementChild;
      const spinner = card?.children[0];
      const phase = card?.children[2];
      return {
        tier: bar.dataset.yurirtcNetworkTier,
        value: bar.querySelector("[data-yurirtc-network-value]")?.textContent,
        ariaLabel: bar.getAttribute("aria-label"),
        segments: [...bar.querySelectorAll("[data-yurirtc-level-segment]")].map((segment) =>
          Number.parseFloat(getComputedStyle(segment).opacity)),
        bodyVisibility: getComputedStyle(document.body).visibility,
        fontReady: document.body.dataset.yurirtcFontReady ?? "",
        bootRole: boot?.getAttribute("role"),
        bootAriaLabel: boot?.getAttribute("aria-label"),
        cardBackground: card ? getComputedStyle(card).backgroundColor : "",
        spinnerDisplay: spinner ? getComputedStyle(spinner).display : "",
        phaseColor: phase ? getComputedStyle(phase).color : ""
      };
    });
    assert.equal(testingState.tier, "");
    assert.equal(testingState.value, "Grfgvat argjbex ebhgrf…");
    assert.equal(testingState.ariaLabel, "Network Censorship Level: Testing network routes…");
    assert.deepEqual(testingState.segments, [0.28, 0.28, 0.28, 0.28]);
    assert.equal(testingState.bodyVisibility, "visible");
    assert.equal(testingState.fontReady, "");
    assert.equal(testingState.bootRole, "status");
    assert.equal(testingState.bootAriaLabel, "EDUrocks over YuriRTC. Connecting…");
    assert.equal(testingState.cardBackground, "rgb(43, 37, 42)");
    assert.equal(testingState.spinnerDisplay, "block");
    assert.equal(testingState.phaseColor, "rgba(0, 0, 0, 0)");

    releaseFont();
    await page.waitForFunction(() => document.body.dataset.yurirtcFontReady === "true");
    const loadedPhaseColor = await page.evaluate(() => {
      const phase = document.querySelector("[data-yurirtc-view]")?.firstElementChild?.children[2];
      return phase ? getComputedStyle(phase).color : "";
    });
    assert.notEqual(loadedPhaseColor, "rgba(0, 0, 0, 0)");

    await page.evaluate(() => window.__YURIRTC_E2E_CONTINUE__());
    await page.waitForLoadState("domcontentloaded");
    // The shell sets its title from the ROT13 source copy, so the visible
    // title is rot13("yrneazngurqh") -- the carrier's own brand, not the
    // transport's.
    await page.waitForFunction(() => document.title === "learnmathedu");
    const frameElement = await page.waitForSelector("#yurirtc-test-frame");
    const frame = await frameElement.contentFrame();
    assert.ok(frame, "mock app iframe must be attached");
    await frame.waitForSelector('#asset[data-ready="true"]');

    const presentation = await page.evaluate(async () => {
      await document.fonts.ready;
      const boot = document.querySelector('[data-yurirtc-view]');
      const card = boot?.firstElementChild;
      const brand = card?.children[1];
      const body = getComputedStyle(document.body);
      const cardStyle = card ? getComputedStyle(card) : null;
      const root = getComputedStyle(document.documentElement);
      const canvas = document.createElement("canvas");
      const drawing = canvas.getContext("2d");
      drawing.font = `400 18px ${body.fontFamily}`;
      const customWidth = drawing.measureText("LhevEGP").width;
      drawing.font = "400 18px monospace";
      const fallbackWidth = drawing.measureText("LhevEGP").width;
      const registrations = await navigator.serviceWorker.getRegistrations();
      return {
        title: document.title,
        theme: document.querySelector('meta[name="theme-color"]')?.content,
        brand: brand?.textContent,
        bodyFont: body.fontFamily,
        bodyBackground: body.backgroundColor,
        cardBackground: cardStyle?.backgroundColor,
        cardRadius: cardStyle?.borderRadius,
        networkRadius: getComputedStyle(document.querySelector("[data-yurirtc-network]")).borderRadius,
        networkLabel: document.querySelector("[data-yurirtc-network]")?.firstElementChild?.textContent,
        networkState: document.querySelector("[data-yurirtc-network]")?.dataset.yurirtcNetworkState,
        networkTier: document.querySelector("[data-yurirtc-network]")?.dataset.yurirtcNetworkTier,
        primary: root.getPropertyValue("--primary").trim(),
        surface: root.getPropertyValue("--surface").trim(),
        fontLoaded: document.fonts.check(`400 18px ${body.fontFamily}`, "LhevEGP"),
        customWidth,
        fallbackWidth,
        boot: window.__YURIRTC_E2E__,
        registrations: registrations.map((registration) => ({
          scope: registration.scope,
          script: registration.active?.scriptURL
        })),
        controller: navigator.serviceWorker.controller?.scriptURL
      };
    });

    assert.equal(presentation.title, "learnmathedu");
    assert.equal(presentation.brand, "RQHebpxf bire LhevEGP", "DOM copy must remain ROT13 encoded");
    assert.equal(presentation.theme, "#8f1558");
    assert.equal(presentation.primary, "#ffafd0");
    assert.equal(presentation.surface, "#151216");
    assert.equal(presentation.bodyBackground, "rgb(21, 18, 22)");
    assert.equal(presentation.cardBackground, "rgb(43, 37, 42)");
    assert.equal(presentation.cardRadius, "28px");
    assert.equal(presentation.networkRadius, "22px");
    assert.equal(presentation.networkLabel, "Argjbex Prafbefuvc Yriry");
    assert.equal(presentation.networkState, "connected");
    assert.equal(presentation.networkTier, "udp-standard");
    assert.match(presentation.bodyFont, /^['\"]?_[A-Za-z0-9]{9}['\"]?$/);
    assert.equal(presentation.fontLoaded, true);
    assert.ok(Math.abs(presentation.customWidth - presentation.fallbackWidth) > 0.1,
      "the exact ROT13 display font must render instead of a fallback");

    const expectedScope = `${server.origin}${prefix}`;
    const expectedWorker = `${expectedScope}sw.js?yurirtc-loader=${LOADER_VERSION}`;
    assert.deepEqual(presentation.boot, {
      appPath: "/",
      scope: expectedScope,
      script: expectedWorker
    });
    assert.equal(presentation.controller, expectedWorker);
    assert.deepEqual(presentation.registrations, [{ scope: expectedScope, script: expectedWorker }]);
    assert.equal(frame.url(), `${expectedScope}app/start.html`);
    assert.equal(await frame.locator("#asset").textContent(), "service-worker");

    const addressSentinels = ["203.0.113.77", "198.51.100.42", "candidate:9"];
    const routeCases = [
      ["udp", "standard", "udp-standard", "HQC · Fgnaqneq cbeg", "rgb(118, 220, 145)"],
      ["udp", "443", "udp-443", "HQC · Cbeg 443 bayl", "rgb(235, 194, 72)"],
      ["tcp", "standard", "tcp-standard", "GPC · Fgnaqneq cbeg", "rgb(255, 155, 145)"],
      ["tcp", "443", "tcp-443", "GPC · Cbeg 443 bayl", "rgb(224, 93, 88)"]
    ];
    for (const [transport, portClass, tier, value, color] of routeCases) {
      await page.evaluate(({ transport, portClass }) => {
        window.dispatchEvent(new CustomEvent("yurirtc:network-state", {
          detail: {
            state: "connected",
            route: { transport, portClass },
            candidate: "candidate:9 1 UDP 1 203.0.113.77 443 typ host",
            serverIp: "198.51.100.42",
            ignored: { address: "203.0.113.77" }
          }
        }));
      }, { transport, portClass });
      await page.waitForFunction((selectedTier) => {
        const bar = document.querySelector("[data-yurirtc-network]");
        const segment = bar?.querySelector(`[data-yurirtc-level-segment="${selectedTier}"]`);
        return segment && Number(getComputedStyle(segment).opacity) > 0.99;
      }, tier);
      const observed = await page.evaluate((selectedTier) => {
        const bar = document.querySelector("[data-yurirtc-network]");
        const segment = bar.querySelector(`[data-yurirtc-level-segment="${selectedTier}"]`);
        return {
          state: bar.dataset.yurirtcNetworkState,
          tier: bar.dataset.yurirtcNetworkTier,
          value: bar.querySelector("[data-yurirtc-network-value]")?.textContent,
          activeOpacity: getComputedStyle(segment).opacity,
          activeColor: getComputedStyle(segment).backgroundColor,
          ui: `${bar.outerHTML} ${document.querySelector("[data-yurirtc-view]")?.innerHTML}`
        };
      }, tier);
      assert.equal(observed.state, "connected");
      assert.equal(observed.tier, tier);
      assert.equal(observed.value, value);
      assert.ok(Number(observed.activeOpacity) > 0.95, "selected level segment must be emphasized");
      assert.equal(observed.activeColor, color);
      for (const sentinel of addressSentinels) assert.doesNotMatch(observed.ui, new RegExp(sentinel));
    }

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("yurirtc:network-state", {
      detail: {
        state: "connected",
        route: { transport: "unknown", portClass: "unknown" },
        candidate: "candidate:9 1 UDP 1 203.0.113.77 443 typ host",
        serverIp: "198.51.100.42"
      }
    })));
    await page.waitForSelector(
      '[data-yurirtc-network-state="connected"][data-yurirtc-network-tier=""]'
    );
    await page.waitForFunction(() => [...document.querySelectorAll("[data-yurirtc-level-segment]")]
      .every((segment) => Number.parseFloat(getComputedStyle(segment).opacity) < 0.225));
    const unclassified = await page.evaluate(() => {
      const bar = document.querySelector("[data-yurirtc-network]");
      const view = document.querySelector("[data-yurirtc-view]");
      return {
        value: bar.querySelector("[data-yurirtc-network-value]")?.textContent,
        ariaLabel: bar.getAttribute("aria-label"),
        segments: [...bar.querySelectorAll("[data-yurirtc-level-segment]")].map((segment) =>
          Number.parseFloat(getComputedStyle(segment).opacity)),
        viewOpacity: Number.parseFloat(getComputedStyle(view).opacity),
        ui: `${bar.outerHTML} ${view.innerHTML}`
      };
    });
    assert.equal(unclassified.value, "Pbaarpgrq · Ebhgr haxabja");
    assert.equal(unclassified.ariaLabel, "Network Censorship Level: Connected · Route unknown");
    assert.ok(unclassified.segments.every((opacity) => opacity >= 0.219 && opacity < 0.23));
    assert.equal(unclassified.viewOpacity, 0, "unknown coarse stats must not hide a connected app");
    for (const sentinel of addressSentinels) assert.doesNotMatch(unclassified.ui, new RegExp(sentinel));

    await page.evaluate(() => {
      window.__YURIRTC_RECONNECT_EVENTS__ = [];
      window.addEventListener("yurirtc:reconnect-request", (event) => {
        window.__YURIRTC_RECONNECT_EVENTS__.push({
          detail: event.detail,
          keys: Object.keys(event.detail).sort()
        });
        event.preventDefault();
      });
      window.dispatchEvent(new CustomEvent("yurirtc:network-state", {
        detail: {
          state: "disconnected",
          attempt: 2,
          retryInMs: 4000,
          error: "candidate:9 1 TCP 1 203.0.113.77 443 typ host",
          serverIp: "198.51.100.42"
        }
      }));
    });
    await page.waitForSelector('[data-yurirtc-view="disconnected"] [data-yurirtc-reconnect]');
    const disconnected = await page.evaluate(() => {
      const view = document.querySelector('[data-yurirtc-view="disconnected"]');
      const retry = view.querySelector("[data-yurirtc-retry-status]");
      return {
        title: view.querySelector("h1")?.textContent,
        button: view.querySelector("[data-yurirtc-reconnect]")?.textContent,
        retry: retry?.textContent,
        seconds: Number(retry?.dataset.yurirtcRetrySeconds),
        ui: view.outerHTML
      };
    });
    assert.equal(disconnected.title, "Lbhe pbaarpgvba jnf vagreehcgrq");
    assert.equal(disconnected.button, "Erpbaarpg abj");
    assert.match(disconnected.retry, /^Nhgbzngvp ergel 2 va [34]f$/);
    assert.ok(disconnected.seconds >= 3 && disconnected.seconds <= 4);
    for (const sentinel of addressSentinels) assert.doesNotMatch(disconnected.ui, new RegExp(sentinel));
    await page.waitForTimeout(1100);
    const laterSeconds = await page.locator("[data-yurirtc-retry-status]").getAttribute("data-yurirtc-retry-seconds");
    assert.ok(Number(laterSeconds) < disconnected.seconds, "automatic retry feedback must count down");

    await page.locator('[data-yurirtc-view="disconnected"] [data-yurirtc-reconnect]').click();
    await page.waitForSelector('[data-yurirtc-view="connecting"]');
    const manualReconnect = await page.evaluate(() => ({
      events: window.__YURIRTC_RECONNECT_EVENTS__,
      state: document.querySelector("[data-yurirtc-network]")?.dataset.yurirtcNetworkState
    }));
    assert.deepEqual(manualReconnect.events, [{ detail: { reason: "manual" }, keys: ["reason"] }]);
    assert.equal(manualReconnect.state, "testing");

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("yurirtc:network-state", {
      detail: { state: "unavailable", diagnostic: "203.0.113.77 candidate:9" }
    })));
    await page.waitForSelector('[data-yurirtc-view="unavailable"] [data-yurirtc-reconnect]');
    const unavailable = await page.evaluate(() => {
      const view = document.querySelector('[data-yurirtc-view="unavailable"]');
      const bar = document.querySelector("[data-yurirtc-network]");
      return {
        title: view.querySelector("h1")?.textContent,
        body: view.querySelector("p")?.textContent,
        button: view.querySelector("[data-yurirtc-reconnect]")?.textContent,
        state: bar.dataset.yurirtcNetworkState,
        tier: bar.dataset.yurirtcNetworkTier,
        ui: `${view.outerHTML} ${bar.outerHTML}`
      };
    });
    assert.equal(unavailable.title, "Ab argjbex ebhgr ninvynoyr");
    assert.equal(unavailable.button, "Gel ntnva");
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.tier, "");
    for (const sentinel of addressSentinels) assert.doesNotMatch(unavailable.ui, new RegExp(sentinel));

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("yurirtc:network-state", {
      detail: { state: "connected", route: { transport: "udp", portClass: "standard" } }
    })));
    await page.waitForSelector('[data-yurirtc-network-tier="udp-standard"]');

    await frame.locator("#next").click();
    await frame.waitForURL(`${expectedScope}app/route-two.html`);
    assert.equal(page.url(), entry, "iframe navigation must not replace the carrier URL");
    assert.equal(await frame.locator("#route").textContent(), "Second");

    const back = frame.waitForURL(`${expectedScope}app/start.html`);
    await page.evaluate(() => history.back());
    await back;
    await frame.waitForSelector('#asset[data-ready="true"]');
    assert.equal(page.url(), entry);

    const forward = frame.waitForURL(`${expectedScope}app/route-two.html`);
    await page.evaluate(() => history.forward());
    await forward;
    assert.equal(page.url(), entry);

    assert.equal(network.manifest.length, 1, "the signed loader pointer should load once");
    assert.equal(network.client.length, 1, "the immutable loader client should load once");
    assert.equal(network.font.length, 1, "the immutable font should load once");
    assert.equal(network.worker.length, 1, "the immutable worker bundle should load once");
    assert.equal(network.icons.length, 1, "the hosted Material Symbols stylesheet should load once");
    assert.deepEqual(network.forbidden, [], "no Firebase or other external request may escape mocks");
    assert.ok(network.sameOrigin.length >= 5, "carrier, worker, and app requests should be observable");
    for (const pathname of network.sameOrigin) {
      assert.ok(pathname.startsWith(prefix), `same-origin request escaped ${prefix}: ${pathname}`);
    }
    for (const pathname of server.requests.slice(serverRequestStart)) {
      assert.ok(pathname.startsWith(prefix), `server request escaped ${prefix}: ${pathname}`);
    }
    assert.deepEqual(pageErrors, []);
    for (const message of consoleMessages) {
      for (const sentinel of addressSentinels) assert.doesNotMatch(message, new RegExp(sentinel));
    }
  } finally {
    releaseFont?.();
    await context.close();
  }
}

test("generated carrier is path-contained and usable in a real browser", { timeout: 60_000 }, async (t) => {
  const font = await readFile(FONT_PATH);
  assert.equal(sha256(font), EXPECTED_FONT_SHA256,
    "bundled rot13.woff must remain the exact approved YuriRTC display font");

  const executablePath = await findChromium();
  if (!executablePath) {
    t.skip("Chromium was not found; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or CHROME_PATH");
    return;
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), "yurirtc-browser-e2e-"));
  let browser;
  let server;
  try {
    buildRelease(outputDirectory);
    const [indexHtml, serviceWorker] = await Promise.all([
      readFile(join(outputDirectory, "index.html")),
      readFile(join(outputDirectory, "sw.js"))
    ]);
    server = await localServer(indexHtml, serviceWorker);
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--no-first-run",
        "--no-sandbox",
        "--host-resolver-rules=MAP unpkg.com ~NOTFOUND, MAP cdn.jsdelivr.net ~NOTFOUND"
      ]
    });

    await t.test("domain-root deployment", () =>
      runHostingScenario(browser, server, font, "/"));
    await t.test("nested bucket deployment", () =>
      runHostingScenario(browser, server, font, "/docu-store/releases/current/"));
  } finally {
    await browser?.close();
    await server?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("carrier handles loader CDN and integrity failures before execution", { timeout: 60_000 }, async (t) => {
  const executablePath = await findChromium();
  if (!executablePath) {
    t.skip("Chromium was not found; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or CHROME_PATH");
    return;
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), "yurirtc-integrity-e2e-"));
  let browser;
  let server;
  try {
    buildRelease(outputDirectory);
    const [indexHtml, serviceWorker] = await Promise.all([
      readFile(join(outputDirectory, "index.html")),
      readFile(join(outputDirectory, "sw.js"))
    ]);
    server = await localServer(indexHtml, serviceWorker);
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });

    async function scenario(mode) {
      const context = await browser.newContext({ serviceWorkers: "allow" });
      const seen = { manifest: 0, loader: 0, icons: 0 };
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === server.origin) return route.continue();
        const path = url.pathname.replace(/^\/npm\//, "/");
        if (url.hostname === "fonts.googleapis.com") {
          seen.icons += 1;
          return route.fulfill({ status: 200, contentType: "text/css", body: ".material-symbols-rounded{font-family:system-ui}" });
        }
        if (path === "/shaintloadingcheckpak@latest/loader.json") {
          seen.manifest += 1;
          if (mode === "cdn") return route.abort("blockedbyclient");
          const document = JSON.parse(mockManifest);
          if (mode === "signature") {
            document.signature.value = `${document.signature.value[0] === "A" ? "B" : "A"}${document.signature.value.slice(1)}`;
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify(document)
          });
        }
        if (path === `/@advwebrec/grainloading@${LOADER_VERSION}/dist/bundle/client.js`) {
          seen.loader += 1;
          return route.fulfill({
            status: 200,
            contentType: "application/javascript",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: `${mockClient}\n// rewritten by integrity e2e`
          });
        }
        if (path === `/@advwebrec/grainloading@${LOADER_VERSION}/dist/bundle/sw.js`) {
          return route.fulfill({
            status: 200,
            contentType: "application/javascript",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: mockWorker
          });
        }
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.goto(`${server.origin}/index.html`, { waitUntil: "commit" });
      return { context, page, seen };
    }

    await t.test("total CDN failure shows the support error", async () => {
      const { context, page, seen } = await scenario("cdn");
      try {
        const error = await page.waitForSelector('[data-yurirtc-loader-error="cdn-unavailable"]');
        const display = await error.evaluate((node) => ({
          title: node.querySelector("h1")?.textContent,
          body: node.querySelector("p")?.textContent,
          retry: node.querySelector("[data-yurirtc-loader-retry]")?.textContent,
          shadow: getComputedStyle(node.firstElementChild).boxShadow
        }));
        assert.equal(display.title, "Loader unavailable");
        assert.equal(display.body, "Loader code via CDN blocker or not available, please email allhands@edurocks.org for further help");
        assert.equal(display.retry, "Retry");
        assert.equal(display.shadow, "none");
        assert.equal(seen.manifest, 2);
        assert.equal(seen.loader, 0);
        assert.equal(seen.icons, 1);
      } finally {
        await context.close();
      }
    });

    await t.test("invalid signatures warn before requesting loader code", async () => {
      const { context, page, seen } = await scenario("signature");
      try {
        await page.waitForSelector('[data-yurirtc-loader-error="integrity"]');
        assert.equal(seen.manifest, 2);
        assert.equal(seen.loader, 0);
      } finally {
        await context.close();
      }
    });

    await t.test("hash mismatches require a three-second explicit continuation", async () => {
      const { context, page, seen } = await scenario("hash");
      try {
        const warning = await page.waitForSelector('[data-yurirtc-loader-error="integrity"]');
        const initial = await warning.evaluate((node) => ({
          title: node.querySelector("h1")?.textContent,
          body: node.querySelector("p")?.textContent,
          link: node.querySelector("a")?.href,
          disabled: node.querySelector("[data-yurirtc-loader-continue]")?.disabled,
          shadow: getComputedStyle(node.firstElementChild).boxShadow
        }));
        assert.equal(initial.title, "Loader integrity could not be verified.");
        assert.match(initial.body, /managed device.*MiTM rewriting attack.*adblocker/s);
        assert.equal(initial.link, "https://www.fortinet.com/resources/cyberglossary/man-in-the-middle-attack");
        assert.equal(initial.disabled, true);
        assert.equal(initial.shadow, "none");
        await page.waitForFunction(() => !document.querySelector("[data-yurirtc-loader-continue]")?.disabled);
        await page.locator("[data-yurirtc-loader-continue]").click();
        await page.waitForFunction(() => typeof window.__YURIRTC_E2E_CONTINUE__ === "function");
        assert.equal(seen.loader, 2, "both mismatching CDN copies must be checked before warning");
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser?.close();
    await server?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("bundled carrier detects rewritten inline loader bytes without CDN access", { timeout: 60_000 }, async (t) => {
  const executablePath = await findChromium();
  if (!executablePath) {
    t.skip("Chromium was not found; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or CHROME_PATH");
    return;
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), "yurirtc-bundled-integrity-e2e-"));
  let browser;
  let server;
  try {
    buildRelease(outputDirectory, { bundled: true });
    let indexHtml = await readFile(join(outputDirectory, "index.html"), "utf8");
    const serviceWorker = await readFile(join(outputDirectory, "sw.js"));
    const encoded = indexHtml.match(
      /<script\b(?=[^>]*\btype=(?:["']?application\/octet-stream["']?))[^>]*>([A-Za-z0-9+/=]+)<\/script>/i
    )?.[1];
    assert.ok(encoded, "bundled build lost its inline loader payload");
    const rewritten = `${encoded[0] === "A" ? "B" : "A"}${encoded.slice(1)}`;
    indexHtml = indexHtml.replace(encoded, rewritten);
    server = await localServer(indexHtml, serviceWorker);
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ serviceWorkers: "allow" });
    let npmCdnRequests = 0;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === server.origin) return route.continue();
      if (url.hostname === "fonts.googleapis.com") {
        return route.fulfill({
          status: 200,
          contentType: "text/css",
          body: ".material-symbols-rounded{font-family:system-ui}"
        });
      }
      if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com") {
        npmCdnRequests += 1;
      }
      return route.abort("blockedbyclient");
    });
    try {
      const page = await context.newPage();
      await page.goto(`${server.origin}/index.html`, { waitUntil: "commit" });
      const warning = await page.waitForSelector('[data-yurirtc-loader-error="integrity"]');
      const state = await warning.evaluate((node) => ({
        stage: node.dataset.yurirtcLoaderIntegrityStage,
        reason: node.dataset.yurirtcLoaderIntegrityReason,
        disabled: node.querySelector("[data-yurirtc-loader-continue]")?.disabled
      }));
      assert.deepEqual(state, {
        stage: "loader-hash",
        reason: "loader-hash",
        disabled: true
      });
      assert.equal(npmCdnRequests, 0, "bundled integrity handling contacted an npm CDN");
      assert.deepEqual(
        server.requests.filter((path) => path !== "/favicon.ico"),
        ["/index.html"],
        "rewritten inline bytes must fail before service-worker registration"
      );
    } finally {
      await context.close();
    }
  } finally {
    await browser?.close();
    await server?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
