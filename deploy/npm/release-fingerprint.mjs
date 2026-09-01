import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

function digest(label, inputs) {
  const hash = createHash("sha256").update(`carrier-release-fingerprint-v1:${label}\0`);
  for (const input of inputs) {
    hash.update(String(input.byteLength));
    hash.update("\0");
    hash.update(input);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function bundledCarrierSourceNotice(loaderVersion) {
  return [
    `This carrier bundles YuriRTC loader ${loaderVersion}.`,
    "YuriRTC is licensed under GNU AGPL-3.0-only; see LICENSE.",
    "Corresponding source: https://github.com/EDUrocks-Group/YuriRTC",
    "The embedded ROT13 font is covered by the SIL Open Font License in FONT-LICENSE.txt.",
    ""
  ].join("\n");
}

/** Opaque stamps that prove ignored build products match their exact sources. */
export async function carrierReleaseFingerprints(mode = "release", variant = "cdn") {
  if (variant !== "cdn" && variant !== "bundled") {
    throw new Error(`unsupported carrier fingerprint variant ${variant}`);
  }
  const commonInputs = await Promise.all([
    readFile(resolve(HERE, "build.mjs")),
    readFile(resolve(HERE, "release-fingerprint.mjs")),
    readFile(resolve(HERE, "src/index.html")),
    readFile(resolve(HERE, "src/integrity-loader.mjs")),
    readFile(resolve(HERE, "src/sw.js")),
    readFile(resolve(HERE, "manifest-public-key.json")),
    readFile(resolve(HERE, "package.json")),
    readFile(resolve(ROOT, "packages/loader/package.json")),
    readFile(resolve(ROOT, "package-lock.json"))
  ]);
  const inputs = variant === "bundled"
    ? commonInputs.concat(await Promise.all([
        readFile(resolve(ROOT, "packages/loader/dist/bundle/client.js")),
        readFile(resolve(ROOT, "packages/loader/dist/bundle/sw.js")),
        readFile(resolve(ROOT, "packages/loader/dist/assets/rot13.woff")),
        readFile(resolve(ROOT, "packages/loader/dist/assets/OFL.txt")),
        readFile(resolve(ROOT, "LICENSE"))
      ]))
    : commonInputs;
  const label = variant === "bundled" ? `${mode}:bundled` : mode;
  return {
    index: digest(`${label}:index`, inputs),
    worker: digest(`${label}:worker`, inputs)
  };
}
