// Build the browser-facing YuriRTC artifacts published as @advwebrec/grainloading.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "dist");
const BUNDLE_DIR = resolve(DIST, "bundle");
const TYPE_DIR = resolve(DIST, "types");
const ASSET_DIR = resolve(DIST, "assets");

if (process.argv.includes("--clean")) {
  await rm(DIST, { recursive: true, force: true });
  process.exit(0);
}

const packageJson = JSON.parse(await readFile(resolve(HERE, "package.json"), "utf8"));
const version = String(packageJson.version);
const seed = createHash("sha256").update(`yurirtc-loader:${version}`).digest().readUInt32BE(0);

await Promise.all([
  mkdir(BUNDLE_DIR, { recursive: true }),
  mkdir(TYPE_DIR, { recursive: true }),
  mkdir(ASSET_DIR, { recursive: true })
]);

const obfuscation = {
  compact: true,
  simplify: true,
  target: "browser",
  seed,
  identifierNamesGenerator: "hexadecimal",
  reservedNames: [
    "^boot$",
    "^YuriRTCClient$",
    "^LoaderClient$",
    "^classify$",
    "^classifyRequest$"
  ],
  stringArray: true,
  stringArrayThreshold: 0.82,
  stringArrayEncoding: ["base64"],
  stringArrayCallsTransform: true,
  // Rotation is a *runtime* loop, not a build-time transform: the emitted
  // prologue shifts the array until a checksum of decoded entries matches, and
  // the decoder's cache is keyed on `index + array[0]`, so every iteration
  // re-decodes from scratch. Measured at ~50ms for client.js and ~10ms for
  // sw.js on a development machine, paid on every service-worker cold start
  // and twice on a first visit because of the cross-origin-isolation reload.
  // On the low-end Chromebooks this deploys to it is several times worse.
  //
  // These default to true, so they must be written as explicit false.
  // Shuffle and index shift are build-time and stay: the array still ships in
  // a scrambled order behind base64 and the call wrapper. What is given up is
  // the weak anti-tamper behaviour where a patched global spins the loop
  // forever.
  stringArrayRotate: false,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  renameGlobals: false,
  transformObjectKeys: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  sourceMap: false
};

function obscure(code) {
  return JavaScriptObfuscator.obfuscate(code, obfuscation).getObfuscatedCode();
}

async function bundle(entryPoint, format, outputName) {
  const result = await build({
    entryPoints: [resolve(HERE, entryPoint)],
    bundle: true,
    format,
    target: "es2022",
    platform: "browser",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    write: false,
    define: {
      __YURIRTC_LOADER_VERSION__: JSON.stringify(version)
    },
    outfile: outputName
  });
  const javascript = result.outputFiles.find((file) => file.path.endsWith(".js"));
  if (!javascript) throw new Error(`esbuild produced no JavaScript for ${entryPoint}`);
  if (outputName === "client.js") {
    if (javascript.text.includes("@latest")) {
      throw new Error("client bundle retained the unbundled @latest fallback");
    }
    if (!javascript.text.includes(version)) {
      throw new Error(`client bundle did not embed loader version ${version}`);
    }
  }
  // The proxy engine goes ahead of the worker it shares, and only in the worker.
  const prelude = outputName === "sw.js" ? await roxxieWorkerSection() : "";
  await writeFile(resolve(BUNDLE_DIR, outputName), `${prelude}${obscure(javascript.text)}\n`, "utf8");
}

/**
 * The proxy engine's half of the service worker, and the shim that gives it
 * first refusal on the requests it owns.
 *
 * Under the static deployment this worker is the only worker a page has: the
 * shell registers it, and the guard turns the site's own registration into a
 * no-op that hands back this one. A site that proxies therefore cannot install
 * its request handling separately -- so it travels here, exactly as it travels
 * inside the site's combined worker on every other deployment.
 *
 * Order and stopImmediatePropagation are both load-bearing. The loader's own
 * fetch handler answers every same-origin request that is not one of its static
 * assets, and a second respondWith on one event throws. Registering the
 * engine's listener first lets it claim proxied requests, and stopping
 * propagation keeps the loader from ever seeing them.
 *
 * It claims the proxied prefix on its own rather than waiting to be told which
 * prefix it owns. Being told is still preferred, but that answer only exists
 * while a tab has registered: a worker the browser restarted to deliver a
 * request has no tabs yet, and a section that stayed inert until told would
 * decline that request and let it reach the carrier. Not obfuscated again: it
 * arrives already built, and the engine's injected half looks its own globals
 * up by name.
 */
async function roxxieWorkerSection() {
  const root = resolve(HERE, "vendor/roxxie");
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  const source = await readFile(resolve(root, "controller.sw.js"));
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== manifest.files["controller.sw.js"]) {
    throw new Error("vendored proxy engine worker does not match its pin");
  }

  // The engine ships with a sourceMappingURL pointing at a map that is not
  // published. It would 404 for anyone with devtools open, and verify-package
  // rejects it outright -- a released bundle must not reference sources that
  // are not in the package.
  const engine = source.toString("utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, "").trimEnd();

  return `${engine}
;(() => {
  // The proxied-page prefix, resolved against this worker's own scope so the
  // two-file deployment -- which lives under a directory such as
  // /learnmathedu@2.1.4/ -- gets the same answer the page does.
  const PROXIED_PREFIX = new URL("apiv2/wonderlands/w/", self.registration.scope).pathname;

  function controllerClaims(event) {
    try {
      return self.$scramjetController.shouldRoute(event);
    } catch {
      return false;
    }
  }

  function isProxiedRequest(event) {
    let url;
    try {
      url = new URL(event.request.url);
    } catch {
      return false;
    }
    return url.origin === self.location.origin && url.pathname.startsWith(PROXIED_PREFIX);
  }

  self.addEventListener("fetch", event => {
    // Claimed by prefix as well as by the controller's answer. The engine keeps
    // its tabs in a module-level array that a tab fills once, by handing over a
    // message port. The browser terminates an idle worker and restarts it to
    // deliver the next request, with that array empty, and only asks the tabs
    // to re-register 100ms later -- so the first request after every restart
    // was declined here and went to the carrier instead, where the content node
    // forwards /apiv2 to the API and Express answers
    // "Cannot GET /wonderlands/w/...". One dead click after an idle pause, then
    // working again, is this and nothing else.
    //
    // This makes the section no longer inert on a deployment that does not
    // proxy, but only for a path that belongs to the proxy by construction and
    // that such a deployment never requests.
    if (!controllerClaims(event) && !isProxiedRequest(event)) return;
    event.stopImmediatePropagation();
    event.respondWith(routeWhenReady(event));
  });

  async function routeWhenReady(event) {
    if (!(await controllerReady(event))) return withResourcePolicy(failurePage());
    try {
      const response = await self.$scramjetController.route(event);
      return withResourcePolicy(await readableFailure(event, response));
    } catch {
      return withResourcePolicy(failurePage());
    }
  }

  // Waits for a tab to hand this worker a port again, asking repeatedly: a tab
  // ignores the request during the first five seconds of a proxy session, and a
  // backgrounded one may answer late, so a single broadcast can be missed.
  //
  // The asking is shared. A restarted worker is typically handed a whole page's
  // worth of proxied subresources at once, and giving each its own 40Hz loop
  // and its own 750ms broadcast meant fifty requests produced thousands of
  // wakeups per second and a matchAll flood -- on the weakest machines this
  // ships to, while they were already busy. One campaign now drives the timer
  // and the broadcasts for every waiter; readiness is still evaluated per
  // event, so a request the controller genuinely declines still gets the
  // failure page rather than somebody else's answer.
  let waiting = 0;
  let campaign = null;
  let tickPromise = null;
  let releaseTick = null;

  function tick() {
    if (!tickPromise) {
      tickPromise = new Promise(resolve => { releaseTick = resolve; });
    }
    return tickPromise;
  }

  function advanceTick() {
    const release = releaseTick;
    tickPromise = null;
    releaseTick = null;
    if (release) release();
  }

  function startCampaign() {
    if (campaign) return;
    campaign = (async () => {
      try {
        let nextAsk = 0;
        while (waiting > 0) {
          if (Date.now() >= nextAsk) {
            await askClientsToRevive();
            nextAsk = Date.now() + 750;
          }
          await new Promise(resolve => setTimeout(resolve, 25));
          advanceTick();
        }
      } finally {
        campaign = null;
        // Anything parked on the final tick must not wait for a campaign that
        // has just stopped running.
        advanceTick();
      }
    })();
  }

  async function controllerReady(event) {
    if (controllerClaims(event)) return true;

    const deadline = Date.now() + 8000;
    waiting += 1;
    try {
      while (Date.now() < deadline) {
        startCampaign();
        await tick();
        if (controllerClaims(event)) return true;
      }
      return false;
    } finally {
      waiting -= 1;
    }
  }

  async function askClientsToRevive() {
    try {
      const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      for (const client of windows) client.postMessage({ $controller$swrevive: {} });
    } catch {
      // Nothing to ask; the wait runs out and the visitor gets the failure page
      // rather than the API's 404.
    }
  }

  // Proxied responses skip the loader entirely, so they never pass through the
  // place that stamps these on everything else it synthesizes. Two headers are
  // needed and for different reasons: a document framed by a page that carries
  // COEP must carry it too, which Chrome reports as
  // coep-frame-resource-needs-coep-header, and a resource fetched by such a
  // document needs CORP. Without them a proxied page fails outright as
  // ERR_BLOCKED_BY_RESPONSE. credentialless matches what the shell sets, and
  // keeps third-party embeds inside the proxied page loadable.
  // The engine reports its own faults by resolving with a 500 whose body starts
  // "Internal Service Worker Error:" -- which is what a visitor saw after a
  // mistyped address. Matched on that exact shape so a site's own 500 still
  // reaches the reader, and only for documents: a failed image or script should
  // stay failed rather than have prose substituted for it.
  async function readableFailure(event, response) {
    if (!response || response.status !== 500) return response;
    if (event.request.destination !== "document" && event.request.mode !== "navigate") return response;
    let text = "";
    try {
      text = await response.clone().text();
    } catch {
      return response;
    }
    return text.startsWith("Internal Service Worker Error:") ? failurePage() : response;
  }

  function failurePage() {
    const body = '<!doctype html><meta charset="utf-8">'
      + '<title>Page could not be opened</title>'
      + '<style>body{margin:0;min-height:100vh;display:grid;place-content:center;justify-items:center;gap:10px;'
      + 'padding:40px;text-align:center;font:16px/1.55 system-ui,sans-serif;background:#151216;color:#eee0e4}'
      + 'p{margin:0;max-width:34rem;color:#d7c2c8}</style>'
      + '<h1 style="margin:0;font-size:1.4rem">This page could not be opened</h1>'
      + '<p>The site did not respond, or refused the connection. Check the address and try again.</p>';
    return new Response(body, {
      status: 502,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
  }

  function withResourcePolicy(response) {
    if (!response) return response;
    if (response.headers.has("Cross-Origin-Resource-Policy")
      && response.headers.has("Cross-Origin-Embedder-Policy")) return response;
    // A body cannot be attached to these, and an opaque response cannot be read.
    if (response.status === 0 || response.status === 204 || response.status === 304) return response;
    if (response.type === "opaque" || response.type === "opaqueredirect") return response;
    const headers = new Headers(response.headers);
    if (!headers.has("Cross-Origin-Resource-Policy")) {
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
    }
    if (!headers.has("Cross-Origin-Embedder-Policy")) {
      headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    }
    try {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return response;
    }
  }
})();
`;
}

// The service worker stays classic so its same-origin stub can use the
// synchronous importScripts fallback between CDNs.
await bundle("src/sw.ts", "iife", "sw.js");
await bundle("src/index.ts", "esm", "client.js");

const compatibilityPackage = "@advwebrec/grainloading";
const workerSources = [
  `https://unpkg.com/${compatibilityPackage}@${version}/dist/bundle/sw.js`,
  `https://cdn.jsdelivr.net/npm/${compatibilityPackage}@${version}/dist/bundle/sw.js`
];
const stubSource = `
var sources=${JSON.stringify(workerSources)};
var loaded=false;
for(var i=0;i<sources.length;i+=1){
  try{importScripts(sources[i]);loaded=true;break;}
  catch(error){console.warn("[YuriRTC] worker source unreachable",sources[i],error);}
}
if(!loaded)throw new Error("YuriRTC: no worker source reachable");
`;
await writeFile(resolve(BUNDLE_DIR, "sw-stub.js"), `${obscure(stubSource)}\n`, "utf8");

await Promise.all([
  copyFile(resolve(HERE, "types/index.d.ts"), resolve(TYPE_DIR, "index.d.ts")),
  copyFile(resolve(HERE, "assets/rot13.woff"), resolve(ASSET_DIR, "rot13.woff")),
  copyFile(resolve(HERE, "assets/OFL.txt"), resolve(ASSET_DIR, "OFL.txt"))
]);

for (const relative of [
  "bundle/sw.js",
  "bundle/client.js",
  "bundle/sw-stub.js",
  "types/index.d.ts",
  "assets/rot13.woff"
]) {
  const { size } = await stat(resolve(DIST, relative));
  console.log(`${relative.padEnd(25)} ${(size / 1024).toFixed(1)} KB`);
}
