import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import vm from "node:vm";
import { carrierReleaseFingerprints } from "./release-fingerprint.mjs";

const HERE = import.meta.dirname;
const artifactArgument = process.argv.indexOf("--artifact-dir");
if (artifactArgument >= 0 && !process.argv[artifactArgument + 1]) {
  throw new Error("--artifact-dir requires a directory");
}
const artifactDirectory = artifactArgument >= 0
  ? resolve(process.cwd(), process.argv[artifactArgument + 1])
  : HERE;
const artifactsOnly = process.argv.includes("--artifacts-only");
const expected = new Set(["README.md", "package.json", "index.html", "sw.js"]);
let files = expected;
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
const fingerprints = await carrierReleaseFingerprints();
if (!html.includes(fingerprints.index) || !worker.includes(fingerprints.worker)) {
  throw new Error("static package contains stale generated artifacts; rebuild index.html and sw.js");
}
if (/@edurocks-group\/loader@(?!latest)|sourceMappingURL|learnmathedu|EDUrocks over YuriTCP|YuriRTC|Starting|Loading|Connecting|Network Censorship Level|Reconnect now|No network route available/.test(html + worker)) {
  throw new Error("static package contains a pinned, mapped, or plaintext runtime");
}
if (/(?:\d{1,3}\.){3}\d{1,3}|candidate:/i.test(html + worker)) {
  throw new Error("static package exposes a network address or ICE candidate string");
}
new vm.Script(worker, { filename: "sw.js" });
console.log(`verified ${files.size} static publish files`);
