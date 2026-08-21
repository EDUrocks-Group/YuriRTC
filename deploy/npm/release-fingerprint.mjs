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

/** Opaque stamps that prove both ignored build products match their sources. */
export async function carrierReleaseFingerprints(mode = "release") {
  const inputs = await Promise.all([
    readFile(resolve(HERE, "build.mjs")),
    readFile(resolve(HERE, "release-fingerprint.mjs")),
    readFile(resolve(HERE, "src/index.html")),
    readFile(resolve(HERE, "src/sw.js")),
    readFile(resolve(HERE, "package.json")),
    readFile(resolve(ROOT, "packages/loader/package.json")),
    readFile(resolve(ROOT, "package-lock.json"))
  ]);
  return {
    index: digest(`${mode}:index`, inputs),
    worker: digest(`${mode}:worker`, inputs)
  };
}
