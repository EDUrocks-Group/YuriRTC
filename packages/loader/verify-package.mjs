import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const HERE = import.meta.dirname;
const expected = new Set([
  "README.md",
  "package.json",
  "dist/bundle/client.js",
  "dist/bundle/sw.js",
  "dist/bundle/sw-stub.js",
  "dist/types/index.d.ts",
  "dist/assets/rot13.woff",
  "dist/assets/OFL.txt"
]);

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
for (const name of ["YuriRTCConfig", "LoaderConfig", "YuriRTCClient", "LoaderClient"]) {
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
