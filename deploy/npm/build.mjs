import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { minify as minifyHtml } from "html-minifier-terser";
import { carrierReleaseFingerprints } from "./release-fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const release = process.argv.includes("--release");
const outputArgument = process.argv.indexOf("--out-dir");
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) {
  throw new Error("--out-dir requires a directory");
}
const outputDirectory = outputArgument >= 0
  ? resolve(process.cwd(), process.argv[outputArgument + 1])
  : HERE;
await mkdir(outputDirectory, { recursive: true });
const shellPackage = JSON.parse(await readFile(resolve(HERE, "package.json"), "utf8"));
const loaderPackage = JSON.parse(
  await readFile(resolve(ROOT, "packages/loader/package.json"), "utf8")
);
const loaderVersion = String(loaderPackage.version);
// The carrier tracks the loader's `latest` dist-tag so publishing a new loader
// version reaches deployed carriers without re-uploading the bucket pair. The
// exact version remains in the obfuscation seed and release fingerprints.
const loaderDistribution = "latest";
const releaseFingerprints = await carrierReleaseFingerprints(release ? "release" : "development");

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
    "action"
  ]
    .map((name) => [name, token(name)])
);

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
  stringArrayRotate: true,
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

async function buildIndex() {
  let html = await readFile(resolve(HERE, "src/index.html"), "utf8");
  html = html
    .replaceAll("__YURIRTC_LOADER_VERSION__", loaderDistribution)
    .replace("__YURIRTC_CONFIG__", jsonForScript({ firebase, cache: {}, signal: {} }))
    .replace("__YURIRTC_TOKENS__", jsonForScript(tokens));
  if (/__YURIRTC_(?:CONFIG|TOKENS|LOADER_VERSION)__/.test(html)) {
    throw new Error("index source still contains an unresolved build placeholder");
  }

  const modulePattern = /(<script\b[^>]*\btype=["']module["'][^>]*>)([\s\S]*?)(<\/script>)/i;
  const moduleMatch = html.match(modulePattern);
  if (!moduleMatch) throw new Error("index source has no inline module");
  html = html.replace(modulePattern, `$1${obscure(moduleMatch[2])}$3`);

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
  output = output.replace(
    "<head>",
    `<head><meta name="${token("build-stamp")}" content="${releaseFingerprints.index}">`
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
  await writeFile(resolve(outputDirectory, "index.html"), `${output}\n`, "utf8");
  return Buffer.byteLength(output);
}

async function buildWorker() {
  const cdnBases = [
    `https://cdn.jsdelivr.net/npm/@edurocks-group/loader`,
    `https://unpkg.com/@edurocks-group/loader`
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
  const output = `${obscure(source)}\n/*${releaseFingerprints.worker}*/`;
  await writeFile(resolve(outputDirectory, "sw.js"), `${output}\n`, "utf8");
  return Buffer.byteLength(output);
}

const [indexBytes, workerBytes] = await Promise.all([buildIndex(), buildWorker()]);
console.log(
  `built YuriRTC carrier index.html (${indexBytes} bytes) and sw.js (${workerBytes} bytes)` +
    (release ? " [release]" : " [placeholder config]")
);
