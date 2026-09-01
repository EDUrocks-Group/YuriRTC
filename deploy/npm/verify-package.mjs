import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import vm from "node:vm";
import {
  bundledCarrierSourceNotice,
  carrierReleaseFingerprints
} from "./release-fingerprint.mjs";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../..");
const artifactArgument = process.argv.indexOf("--artifact-dir");
if (artifactArgument >= 0 && !process.argv[artifactArgument + 1]) {
  throw new Error("--artifact-dir requires a directory");
}
const artifactDirectory = artifactArgument >= 0
  ? resolve(process.cwd(), process.argv[artifactArgument + 1])
  : HERE;
const artifactsOnly = process.argv.includes("--artifacts-only");
const bundledLoader = process.argv.includes("--bundled-loader");
if (bundledLoader && !artifactsOnly) {
  throw new Error("--bundled-loader verifies a standalone artifact directory and requires --artifacts-only");
}
const expected = bundledLoader
  ? new Set(["index.html", "sw.js", "client.js", "LICENSE", "FONT-LICENSE.txt", "SOURCE.txt"])
  : new Set(["README.md", "package.json", "index.html", "sw.js"]);
let files = expected;
if (bundledLoader) {
  files = new Set((await readdir(artifactDirectory, { withFileTypes: true })).map((entry) => {
    if (!entry.isFile()) throw new Error(`bundled carrier contains unexpected directory ${entry.name}`);
    return entry.name;
  }));
  for (const path of expected) {
    if (!files.has(path)) throw new Error(`bundled carrier is missing ${path}`);
  }
  for (const path of files) {
    if (!expected.has(path)) throw new Error(`bundled carrier contains unexpected file ${path}`);
  }
}
if (!artifactsOnly) {
  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: HERE, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  files = new Set(JSON.parse(packed.stdout)[0].files.map((entry) => entry.path));
  for (const path of expected) {
    if (!files.has(path)) throw new Error(`static package is missing ${path}`);
  }
  for (const path of files) {
    if (!expected.has(path)) throw new Error(`static package contains unexpected file ${path}`);
  }
}

const html = await readFile(resolve(artifactDirectory, "index.html"), "utf8");
const worker = await readFile(resolve(artifactDirectory, "sw.js"), "utf8");
if ((html + worker).includes("YURIRTC_BROWSER_E2E_ONLY")) {
  throw new Error("static package contains browser-E2E-only source");
}
const fingerprints = await carrierReleaseFingerprints(
  "release",
  bundledLoader ? "bundled" : "cdn"
);
if (!html.includes(fingerprints.index) || !worker.includes(fingerprints.worker)) {
  throw new Error("static package contains stale generated artifacts; rebuild index.html and sw.js");
}

if (bundledLoader) {
  const [client, loaderWorker, font, license, fontLicense, sourceNotice] = await Promise.all([
    readFile(resolve(artifactDirectory, "client.js")),
    readFile(resolve(ROOT, "packages/loader/dist/bundle/sw.js")),
    readFile(resolve(ROOT, "packages/loader/dist/assets/rot13.woff")),
    readFile(resolve(artifactDirectory, "LICENSE")),
    readFile(resolve(artifactDirectory, "FONT-LICENSE.txt")),
    readFile(resolve(artifactDirectory, "SOURCE.txt"), "utf8")
  ]);
  const [sourceClient, rootLicense, sourceFontLicense, loaderPackage] = await Promise.all([
    readFile(resolve(ROOT, "packages/loader/dist/bundle/client.js")),
    readFile(resolve(ROOT, "LICENSE")),
    readFile(resolve(ROOT, "packages/loader/dist/assets/OFL.txt")),
    readFile(resolve(ROOT, "packages/loader/package.json"), "utf8").then(JSON.parse)
  ]);
  if (!client.equals(sourceClient)) {
    throw new Error("bundled carrier client.js does not match the current loader bundle");
  }
  if (!license.equals(rootLicense)) {
    throw new Error("bundled carrier LICENSE does not match YuriRTC's AGPL license");
  }
  if (!fontLicense.equals(sourceFontLicense)) {
    throw new Error("bundled carrier FONT-LICENSE.txt does not match the loader font license");
  }
  if (sourceNotice !== bundledCarrierSourceNotice(String(loaderPackage.version))) {
    throw new Error("bundled carrier SOURCE.txt is stale");
  }

  const payloads = [...html.matchAll(
    /<script\b(?=[^>]*\btype=(?:["']?application\/octet-stream["']?))[^>]*>([A-Za-z0-9+/=]+)<\/script>/gi
  )];
  if (payloads.length !== 1) {
    throw new Error("bundled carrier must contain exactly one inline loader payload");
  }
  const encodedClient = payloads[0][1];
  const inlineClient = Buffer.from(encodedClient, "base64");
  if (inlineClient.toString("base64") !== encodedClient || !inlineClient.equals(sourceClient)) {
    throw new Error("bundled carrier inline loader does not match client.js");
  }

  const fontPayloads = [...html.matchAll(/data:font\/woff;base64,([A-Za-z0-9+/=]+)/gi)];
  if (fontPayloads.length !== 1) {
    throw new Error("bundled carrier must contain exactly one inline display font");
  }
  const inlineFont = Buffer.from(fontPayloads[0][1], "base64");
  if (inlineFont.toString("base64") !== fontPayloads[0][1] || !inlineFont.equals(font)) {
    throw new Error("bundled carrier inline font does not match the loader asset");
  }

  const expectedWorker = `${loaderWorker.toString("utf8").trimEnd()}\n/*${fingerprints.worker}*/\n`;
  if (worker !== expectedWorker) {
    throw new Error("bundled carrier sw.js does not match the current full loader worker");
  }
  if (/cdn\.jsdelivr\.net|unpkg\.com|shaintloadingcheckpak/i.test(html)) {
    throw new Error("bundled carrier shell retained a public loader CDN dependency");
  }
  if (html.includes("sourceMappingURL") || client.includes(Buffer.from("sourceMappingURL"))) {
    throw new Error("bundled carrier contains a source map reference");
  }
  const inlineHash = createHash("sha256").update(inlineClient).digest("base64url");
  if (inlineHash !== createHash("sha256").update(client).digest("base64url")) {
    throw new Error("bundled carrier inline and durable client hashes differ");
  }
  new vm.Script(loaderWorker.toString("utf8"), { filename: "sw.js" });
} else {
  if (/@edurocks-group\/loader|sourceMappingURL|learnmathedu|EDUrocks over YuriTCP|YuriRTC|Starting|Loading|Connecting|Network Censorship Level|Reconnect now|No network route available/.test(html + worker)) {
    throw new Error("static package contains a pinned, mapped, or plaintext runtime");
  }
  if (/(?:\d{1,3}\.){3}\d{1,3}|candidate:/i.test(html + worker)) {
    throw new Error("static package exposes a network address or ICE candidate string");
  }
  new vm.Script(worker, { filename: "sw.js" });
}
console.log(`verified ${files.size} static publish files`);
