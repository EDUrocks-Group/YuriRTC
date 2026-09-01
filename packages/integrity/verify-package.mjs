import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  base64url,
  fromBase64url,
  publicKeyFromBase64url,
  verifyManifest
} from "./manifest-crypto.mjs";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../..");
const manifestOnlyIndex = process.argv.indexOf("--manifest-only");
const manifestOnly = manifestOnlyIndex >= 0;
const manifestPath = manifestOnly
  ? process.argv[manifestOnlyIndex + 1]
  : resolve(HERE, "loader.json");
if (!manifestPath || (manifestOnly && manifestPath.startsWith("--"))) {
  throw new Error("usage: verify-package.mjs [--manifest-only PATH]");
}
const expectedDeclaredFiles = ["DISCLOSURE", "LICENSE", "loader.json"];
const expectedLicense = `MIT License

Copyright (c) 2026 EDUrocks Group

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const [
  manifest,
  publicConfiguration,
  loaderPackage,
  client,
  integrityPackage,
  packageLicense,
  disclosure
] = await Promise.all([
  readFile(resolve(manifestPath), "utf8").then(JSON.parse),
  readFile(resolve(ROOT, "deploy/npm/manifest-public-key.json"), "utf8").then(JSON.parse),
  readFile(resolve(ROOT, "packages/loader/package.json"), "utf8").then(JSON.parse),
  readFile(resolve(ROOT, "packages/loader/dist/bundle/client.js")),
  readFile(resolve(HERE, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(HERE, "LICENSE"), "utf8"),
  readFile(resolve(HERE, "DISCLOSURE"), "utf8")
]);
if (integrityPackage.license !== "MIT") {
  throw new Error("integrity package must declare the MIT license");
}
if (JSON.stringify(integrityPackage.contentPolicy) !== JSON.stringify({ class: "dual-use" })) {
  throw new Error("integrity package must declare npm dual-use content metadata");
}
const expectedRepository = {
  type: "git",
  url: "git+https://github.com/EDUrocks-Group/YuriRTC.git",
  directory: "packages/integrity"
};
if (JSON.stringify(integrityPackage.repository) !== JSON.stringify(expectedRepository)) {
  throw new Error("integrity package repository metadata is missing or incorrect");
}
if (
  integrityPackage.homepage !== "https://github.com/EDUrocks-Group/YuriRTC#readme" ||
  integrityPackage.bugs?.url !== "https://github.com/EDUrocks-Group/YuriRTC/issues"
) {
  throw new Error("integrity package homepage or issue tracker metadata is missing or incorrect");
}
if (
  JSON.stringify([...integrityPackage.files].sort()) !==
  JSON.stringify([...expectedDeclaredFiles].sort())
) {
  throw new Error("integrity package files allowlist is missing required compliance artifacts");
}
if (packageLicense !== expectedLicense) {
  throw new Error("integrity LICENSE does not match the expected MIT notice");
}
const normalizedDisclosure = disclosure.toLowerCase();
for (const required of [
  "dual-use",
  "signed manifest",
  "webrtc",
  "authorized",
  "https://github.com/edurocks-group/yurirtc"
]) {
  if (!normalizedDisclosure.includes(required)) {
    throw new Error(`integrity DISCLOSURE is missing required context: ${required}`);
  }
}
if (!verifyManifest(manifest, publicKeyFromBase64url(publicConfiguration.spki))) {
  throw new Error("loader.json has an invalid digital signature");
}
const payload = JSON.parse(fromBase64url(manifest.payload, "manifest payload").toString("utf8"));
const expectedHash = createHash("sha256").update(client).digest("base64url");
if (
  payload.schema !== 1 ||
  payload.loader?.package !== "@advwebrec/grainloading" ||
  payload.loader?.version !== loaderPackage.version ||
  payload.loader?.sha256 !== expectedHash
) {
  throw new Error("loader.json does not identify the exact local loader build");
}
const expectedUrls = [
  `https://cdn.jsdelivr.net/npm/@advwebrec/grainloading@${loaderPackage.version}/dist/bundle/client.js`,
  `https://unpkg.com/@advwebrec/grainloading@${loaderPackage.version}/dist/bundle/client.js`
];
if (JSON.stringify(payload.loader.urls) !== JSON.stringify(expectedUrls)) {
  throw new Error("loader.json does not contain both immutable loader CDN URLs");
}

if (!manifestOnly) {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: HERE,
    encoding: "utf8"
  });
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const files = JSON.parse(packed.stdout)[0].files.map(({ path }) => path).sort();
  if (JSON.stringify(files) !== JSON.stringify(["DISCLOSURE", "LICENSE", "loader.json", "package.json"])) {
    throw new Error(`integrity package contains unexpected files: ${files.join(", ")}`);
  }
}
console.log(`verified signed pointer for @advwebrec/grainloading@${payload.loader.version} (${base64url(client).length} encoded bytes checked)`);
