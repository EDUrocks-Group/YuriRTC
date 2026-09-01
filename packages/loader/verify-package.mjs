import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../..");
const expectedDeclaredFiles = [
  "DISCLOSURE",
  "LICENSE",
  "dist/bundle/client.js",
  "dist/bundle/sw.js",
  "dist/bundle/sw-stub.js",
  "dist/types/index.d.ts",
  "dist/assets/rot13.woff",
  "dist/assets/OFL.txt"
];
const expected = new Set([
  "README.md",
  "package.json",
  ...expectedDeclaredFiles
]);

const packageMetadata = JSON.parse(await readFile(resolve(HERE, "package.json"), "utf8"));
if (packageMetadata.license !== "AGPL-3.0-only") {
  throw new Error("loader package must declare AGPL-3.0-only");
}
if (JSON.stringify(packageMetadata.contentPolicy) !== JSON.stringify({ class: "dual-use" })) {
  throw new Error("loader package must declare npm dual-use content metadata");
}
const expectedRepository = {
  type: "git",
  url: "git+https://github.com/EDUrocks-Group/YuriRTC.git",
  directory: "packages/loader"
};
if (JSON.stringify(packageMetadata.repository) !== JSON.stringify(expectedRepository)) {
  throw new Error("loader package repository metadata is missing or incorrect");
}
if (
  packageMetadata.homepage !== "https://github.com/EDUrocks-Group/YuriRTC#readme" ||
  packageMetadata.bugs?.url !== "https://github.com/EDUrocks-Group/YuriRTC/issues"
) {
  throw new Error("loader package homepage or issue tracker metadata is missing or incorrect");
}
if (
  JSON.stringify([...packageMetadata.files].sort()) !==
  JSON.stringify([...expectedDeclaredFiles].sort())
) {
  throw new Error("loader package files allowlist is missing required compliance artifacts");
}

const [packageLicense, repositoryLicense, disclosure] = await Promise.all([
  readFile(resolve(HERE, "LICENSE")),
  readFile(resolve(ROOT, "LICENSE")),
  readFile(resolve(HERE, "DISCLOSURE"), "utf8")
]);
if (!packageLicense.equals(repositoryLicense)) {
  throw new Error("loader LICENSE must exactly match the repository AGPL license");
}
const normalizedDisclosure = disclosure.toLowerCase();
for (const required of [
  "dual-use",
  "webrtc",
  "service worker",
  "authorized",
  "https://github.com/edurocks-group/yurirtc"
]) {
  if (!normalizedDisclosure.includes(required)) {
    throw new Error(`loader DISCLOSURE is missing required context: ${required}`);
  }
}

const packed = spawnSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: HERE, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
);
if (packed.status !== 0) {
  throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
}
const report = JSON.parse(packed.stdout)[0];
const files = new Set(report.files.map((entry) => entry.path));
for (const file of expected) {
  if (!files.has(file)) throw new Error(`npm package is missing ${file}`);
}
for (const file of files) {
  if (!expected.has(file)) throw new Error(`npm package contains unexpected file ${file}`);
  if (file.endsWith(".map") || file.includes("/test/") || file.includes("/src/")) {
    throw new Error(`npm package exposes build source: ${file}`);
  }
}

const clientPath = resolve(HERE, "dist/bundle/client.js");
const client = await import(`${pathToFileURL(clientPath).href}?verify=${Date.now()}`);
for (const name of ["boot", "YuriRTCClient", "LoaderClient", "classify", "classifyRequest"]) {
  if (!(name in client)) throw new Error(`client bundle lost public export ${name}`);
}
if (client.LoaderClient !== client.YuriRTCClient) {
  throw new Error("LoaderClient is no longer the YuriRTCClient compatibility alias");
}

const declarations = await readFile(resolve(HERE, "dist/types/index.d.ts"), "utf8");
for (const name of [
  "YuriRTCConfig",
  "LoaderConfig",
  "clientUrls",
  "GoodputMonitorOptions",
  "ConnectionOptions",
  "YuriRTCClient",
  "LoaderClient",
  "onAdaptiveTcpSuggested"
]) {
  if (!declarations.includes(name)) throw new Error(`public declarations lost ${name}`);
}

for (const file of ["dist/bundle/sw.js", "dist/bundle/sw-stub.js"]) {
  const source = await readFile(resolve(HERE, file), "utf8");
  new vm.Script(source, { filename: file });
  if (source.includes("sourceMappingURL")) throw new Error(`${file} contains a source map reference`);
}

const font = await readFile(resolve(HERE, "dist/assets/rot13.woff"));
const fontHash = createHash("sha256").update(font).digest("hex");
if (fontHash !== "94f4eb3f78b78c6aa70f9c0a9c846a9e0ed430151d35a62aa758aea78a98e2d5") {
  throw new Error(`unexpected ROT13 font hash ${fontHash}`);
}
const fontLicense = await readFile(resolve(HERE, "dist/assets/OFL.txt"), "utf8");
if (
  !fontLicense.includes("Copyright 2025 The Google Sans Project Authors") ||
  !fontLicense.includes("SIL OPEN FONT LICENSE Version 1.1")
) {
  throw new Error("ROT13 font license notice does not match the bundled font");
}

console.log(`verified ${files.size} publish files and the obfuscated runtime exports`);
