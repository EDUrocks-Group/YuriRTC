import { createHash, createPublicKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { minify as minifyHtml } from "html-minifier-terser";
import { build as bundleWithEsbuild } from "esbuild";
import {
  bundledCarrierSourceNotice,
  carrierReleaseFingerprints
} from "./release-fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const release = process.argv.includes("--release");
const bundledLoader = process.argv.includes("--bundled-loader");
const outputArgument = process.argv.indexOf("--out-dir");
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) {
  throw new Error("--out-dir requires a directory");
}
const testWorkerCdnArgument = process.argv.indexOf("--test-worker-cdn-base");
if (testWorkerCdnArgument >= 0 && !process.argv[testWorkerCdnArgument + 1]) {
  throw new Error("--test-worker-cdn-base requires a root-relative URL");
}
const testWorkerCdnBase = testWorkerCdnArgument >= 0
  ? process.argv[testWorkerCdnArgument + 1]
  : undefined;
const testFirestoreArgument = process.argv.indexOf("--test-firestore-base-url");
if (testFirestoreArgument >= 0 && !process.argv[testFirestoreArgument + 1]) {
  throw new Error("--test-firestore-base-url requires a root-relative URL");
}
const testFirestoreBaseUrl = testFirestoreArgument >= 0
  ? process.argv[testFirestoreArgument + 1]
  : undefined;
const testLocalAssetArgument = process.argv.indexOf("--test-local-asset-base");
if (testLocalAssetArgument >= 0 && !process.argv[testLocalAssetArgument + 1]) {
  throw new Error("--test-local-asset-base requires a root-relative URL");
}
const testLocalAssetBase = testLocalAssetArgument >= 0
  ? process.argv[testLocalAssetArgument + 1]
  : undefined;
const browserE2EBuild = process.env.YURIRTC_BROWSER_E2E_BUILD === "1";
if (testWorkerCdnBase && !browserE2EBuild) {
  throw new Error("--test-worker-cdn-base is restricted to YURIRTC_BROWSER_E2E_BUILD=1");
}
if (testWorkerCdnBase && testWorkerCdnBase !== "/npm/@advwebrec/grainloading") {
  throw new Error("--test-worker-cdn-base must use the fixed browser-E2E package path");
}
if (testFirestoreBaseUrl && !browserE2EBuild) {
  throw new Error("--test-firestore-base-url is restricted to YURIRTC_BROWSER_E2E_BUILD=1");
}
if (testFirestoreBaseUrl) {
  let valid = testFirestoreBaseUrl === "/firestore";
  try {
    const parsed = new URL(testFirestoreBaseUrl);
    valid ||= parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.pathname === "/firestore" &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    // Only the fixed root-relative path is accepted without an absolute URL.
  }
  if (!valid) {
    throw new Error("--test-firestore-base-url must use the fixed path on a loopback origin");
  }
}
if (testLocalAssetBase && !browserE2EBuild) {
  throw new Error("--test-local-asset-base is restricted to YURIRTC_BROWSER_E2E_BUILD=1");
}
if (testLocalAssetBase && testLocalAssetBase !== "/yurirtc-e2e") {
  throw new Error("--test-local-asset-base must use the fixed browser-E2E path");
}
const outputDirectory = outputArgument >= 0
  ? resolve(process.cwd(), process.argv[outputArgument + 1])
  : bundledLoader
    ? resolve(HERE, "bundled")
    : HERE;
await mkdir(outputDirectory, { recursive: true });
const shellPackage = JSON.parse(await readFile(resolve(HERE, "package.json"), "utf8"));
const loaderPackage = JSON.parse(
  await readFile(resolve(ROOT, "packages/loader/package.json"), "utf8")
);
const loaderVersion = String(loaderPackage.version);
const committedManifestPublicKey = JSON.parse(
  await readFile(resolve(HERE, "manifest-public-key.json"), "utf8")
).spki;
const testManifestPublicKey = process.argv.includes("--test-manifest-public-key");
if (testManifestPublicKey && !browserE2EBuild) {
  throw new Error("--test-manifest-public-key is restricted to YURIRTC_BROWSER_E2E_BUILD=1");
}
const testPublicKey = testManifestPublicKey
  ? process.env.YURIRTC_TEST_MANIFEST_PUBLIC_KEY
  : undefined;
if (testManifestPublicKey && !testPublicKey) {
  throw new Error("--test-manifest-public-key requires YURIRTC_TEST_MANIFEST_PUBLIC_KEY");
}
if (
  (testWorkerCdnBase || testFirestoreBaseUrl || testLocalAssetBase || testPublicKey) &&
  outputArgument < 0
) {
  throw new Error("browser-E2E overrides require --out-dir");
}
const browserE2EOnly = Boolean(
  testPublicKey || testWorkerCdnBase || testFirestoreBaseUrl || testLocalAssetBase
);
function validatedManifestPublicKey(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} must be unpadded base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) {
    throw new Error(`${label} must use canonical base64url encoding`);
  }
  let key;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    throw new Error(`${label} must contain a DER SubjectPublicKeyInfo key`);
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error(`${label} must contain an ECDSA P-256 public key`);
  }
  return value;
}
const manifestPublicKey = validatedManifestPublicKey(
  testPublicKey || committedManifestPublicKey,
  testPublicKey ? "YURIRTC_TEST_MANIFEST_PUBLIC_KEY" : "manifest-public-key.json spki"
);
const releaseFingerprints = await carrierReleaseFingerprints(
  browserE2EOnly ? "browser-e2e-only" : release ? "release" : "development",
  bundledLoader ? "bundled" : "cdn"
);
const loaderDist = resolve(ROOT, "packages/loader/dist");
const bundledInputs = bundledLoader
  ? await Promise.all([
      readFile(resolve(loaderDist, "bundle/client.js")),
      readFile(resolve(loaderDist, "bundle/sw.js")),
      readFile(resolve(loaderDist, "assets/rot13.woff")),
      readFile(resolve(ROOT, "LICENSE")),
      readFile(resolve(loaderDist, "assets/OFL.txt"))
    ])
  : undefined;
function environment(primary, legacy, placeholder) {
  return process.env[primary] || process.env[legacy] || placeholder;
}

const firebase = {
  apiKey: environment(
    "YURIRTC_FIREBASE_API_KEY",
    "FIREBASE_API_KEY",
    "__YURIRTC_FIREBASE_API_KEY__"
  ),
  projectId: environment(
    "YURIRTC_FIREBASE_PROJECT_ID",
    "FIREBASE_PROJECT_ID",
    "__YURIRTC_FIREBASE_PROJECT_ID__"
  ),
  databaseUrl: environment(
    "YURIRTC_FIREBASE_DATABASE_URL",
    "FIREBASE_DATABASE_URL",
    "__YURIRTC_FIREBASE_DATABASE_URL__"
  )
};

if (release) {
  for (const [name, value] of Object.entries(firebase)) {
    if (value.startsWith("__YURIRTC_")) {
      throw new Error(`release build is missing Firebase ${name}`);
    }
  }
  if (!/^https:\/\//.test(firebase.databaseUrl)) {
    throw new Error("Firebase databaseUrl must be an absolute HTTPS URL");
  }
}

const token = (label) =>
  `_${createHash("sha256")
    .update(`yurirtc-shell:${shellPackage.version}:${loaderVersion}:${label}`)
    .digest("base64url")
    .replace(/[-_]/g, "")
    .slice(0, 9)}`;
const tokens = Object.fromEntries(
  [
    "app",
    "boot",
    "done",
    "card",
    "spinner",
    "spin",
    "brand",
    "phase",
    "hint",
    "network",
    "networkLabel",
    "networkTrack",
    "networkSegment",
    "networkValue",
    "screenIcon",
    "screenTitle",
    "screenBody",
    "retryStatus",
    "action",
    "actions",
    "secondaryAction",
    "plain",
    "loaderLink",
    "font"
  ]
    .map((name) => [name, token(name)])
);
const bundledClientElementId = token("bundled-client");
const bundledDescriptor = bundledInputs
  ? {
      version: loaderVersion,
      sha256: createHash("sha256").update(bundledInputs[0]).digest("base64url"),
      clientElementId: bundledClientElementId,
      clientPath: "client.js",
      urls: []
    }
  : null;

const seed = createHash("sha256")
  .update(`yurirtc-static:${shellPackage.version}:${loaderVersion}`)
  .digest()
  .readUInt32BE(0);
const obfuscation = {
  compact: true,
  simplify: true,
  target: "browser",
  seed,
  identifierNamesGenerator: "hexadecimal",
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ["base64"],
  stringArrayCallsTransform: true,
  // Rotation adds a decoder/checksum loop to every page startup. Shuffle,
  // index shift, base64 encoding, call transforms, minification, and opaque
  // identifiers retain the carrier's source transformation without that
  // extra browser-runtime work.
  stringArrayRotate: false,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  stringArrayWrappersType: "function",
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
const obscure = (source) =>
  JavaScriptObfuscator.obfuscate(source, obfuscation).getObfuscatedCode();
const jsonForScript = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

async function bundleCarrier(source) {
  const result = await bundleWithEsbuild({
    stdin: {
      contents: source,
      loader: "js",
      resolveDir: resolve(HERE, "src"),
      sourcefile: "carrier-entry.mjs"
    },
    bundle: true,
    format: "esm",
    target: ["es2022"],
    platform: "browser",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    write: false
  });
  return obscure(result.outputFiles[0].text);
}

async function buildIndex() {
  let html = await readFile(resolve(HERE, "src/index.html"), "utf8");
  html = html
    .replace("__YURIRTC_MANIFEST_PUBLIC_KEY__", jsonForScript(manifestPublicKey))
    .replace("__YURIRTC_TEST_ASSET_BASE__", jsonForScript(testLocalAssetBase ?? null))
    .replace("__YURIRTC_BUNDLED_LOADER__", jsonForScript(bundledDescriptor))
    .replace(
      "__YURIRTC_ICON_STYLESHEET__",
      testLocalAssetBase
        ? `${testLocalAssetBase}/icons.css`
        : "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400,0,0"
    )
    .replace("__YURIRTC_CONFIG__", jsonForScript({
      firebase,
      cache: {},
      signal: testFirestoreBaseUrl
        ? { firestore: { baseUrl: testFirestoreBaseUrl } }
        : {}
    }))
    .replace("__YURIRTC_TOKENS__", jsonForScript(tokens));
  if (/__YURIRTC_(?:CONFIG|TOKENS|MANIFEST_PUBLIC_KEY|TEST_ASSET_BASE|BUNDLED_LOADER|ICON_STYLESHEET)__/.test(html)) {
    throw new Error("index source still contains an unresolved build placeholder");
  }

  const modulePattern = /(<script\b[^>]*\btype=["']module["'][^>]*>)([\s\S]*?)(<\/script>)/i;
  const moduleMatch = html.match(modulePattern);
  if (!moduleMatch) throw new Error("index source has no inline module");
  const carrierModule = await bundleCarrier(moduleMatch[2]);
  // Obfuscated output can legitimately contain `$&`, `$\`` or `$'`. A string
  // replacement would interpret those sequences and splice cleartext source or
  // surrounding HTML back into the generated carrier. A callback inserts the
  // transformed module literally.
  html = html.replace(
    modulePattern,
    (_match, openingTag, _source, closingTag) => `${openingTag}${carrierModule}${closingTag}`
  );

  let output = await minifyHtml(html, {
    collapseWhitespace: true,
    minifyCSS: true,
    minifyJS: false,
    removeAttributeQuotes: true,
    removeComments: true,
    removeRedundantAttributes: true,
    sortAttributes: true
  });
  if (!output.includes("<head>")) throw new Error("minified index lost its head element");
  const bundledFontStyle = bundledInputs
    ? `<style>@font-face{font-family:'${tokens.font}';src:url(data:font/woff;base64,${bundledInputs[2].toString("base64")}) format('woff');font-style:normal;font-weight:100 900;font-display:block}</style>`
    : "";
  const bundledClientPayload = bundledInputs
    ? `<script id="${bundledClientElementId}" type="application/octet-stream">${bundledInputs[0].toString("base64")}</script>`
    : "";
  output = output.replace(
    "<head>",
    `<head><meta name="${token("build-stamp")}" content="${releaseFingerprints.index}">${bundledFontStyle}${bundledClientPayload}`
  );
  for (const plaintext of [
    "YuriRTC",
    "Starting",
    "Loading",
    "Connecting",
    "Could not connect",
    "Network Censorship Level",
    "Route unknown",
    "Connection interrupted",
    "Reconnect now",
    "No network route available"
  ]) {
    if (output.includes(plaintext)) throw new Error(`index output leaked display copy: ${plaintext}`);
  }
  const testMarker = browserE2EOnly
    ? "\n<!--YURIRTC_BROWSER_E2E_ONLY-->"
    : "";
  await writeFile(resolve(outputDirectory, "index.html"), `${output}${testMarker}\n`, "utf8");
  return Buffer.byteLength(output);
}

async function buildWorker() {
  if (bundledInputs) {
    const workerSource = bundledInputs[1].toString("utf8").trimEnd();
    if (!workerSource || workerSource.includes("sourceMappingURL")) {
      throw new Error("bundled loader worker is empty or references a source map");
    }
    const testMarker = browserE2EOnly
      ? "\n/*YURIRTC_BROWSER_E2E_ONLY*/"
      : "";
    const output = `${workerSource}\n/*${releaseFingerprints.worker}*/${testMarker}`;
    await writeFile(resolve(outputDirectory, "sw.js"), `${output}\n`, "utf8");
    return Buffer.byteLength(output);
  }
  const cdnBases = testWorkerCdnBase ? [testWorkerCdnBase] : [
    `https://cdn.jsdelivr.net/npm/@advwebrec/grainloading`,
    `https://unpkg.com/@advwebrec/grainloading`
  ];
  // No version is substituted: the stub imports the moving `@latest` bundle so
  // an uploaded copy keeps receiving loader updates. A version baked in here is
  // what silently froze every carrier once the resolver that was meant to
  // override it turned out to be unrunnable in a service worker.
  const source = (await readFile(resolve(HERE, "src/sw.js"), "utf8"))
    .replace("__YURIRTC_WORKER_CDN_BASES__", jsonForScript(cdnBases));
  if (/__YURIRTC_WORKER_[A-Z_]+__/.test(source)) {
    throw new Error("worker source still contains a build placeholder");
  }
  const testMarker = browserE2EOnly
    ? "\n/*YURIRTC_BROWSER_E2E_ONLY*/"
    : "";
  const output = `${obscure(source)}\n/*${releaseFingerprints.worker}*/${testMarker}`;
  await writeFile(resolve(outputDirectory, "sw.js"), `${output}\n`, "utf8");
  return Buffer.byteLength(output);
}

const [indexBytes, workerBytes] = await Promise.all([buildIndex(), buildWorker()]);
if (bundledInputs) {
  await Promise.all([
    writeFile(resolve(outputDirectory, "client.js"), bundledInputs[0]),
    writeFile(resolve(outputDirectory, "LICENSE"), bundledInputs[3]),
    writeFile(resolve(outputDirectory, "FONT-LICENSE.txt"), bundledInputs[4]),
    writeFile(
      resolve(outputDirectory, "SOURCE.txt"),
      bundledCarrierSourceNotice(loaderVersion),
      "utf8"
    )
  ]);
}
console.log(
  `built YuriRTC ${bundledLoader ? "bundled " : ""}carrier index.html (${indexBytes} bytes) and sw.js (${workerBytes} bytes)` +
    (release ? " [release]" : " [placeholder config]")
);
