import { createHash, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  base64url,
  loaderDescriptor,
  privateKeyFromBase64url,
  publicKeyFromBase64url,
  signManifest,
  verifyManifest
} from "./manifest-crypto.mjs";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../..");
const outputArgument = process.argv.indexOf("--out-file");
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) {
  throw new Error("--out-file requires a file path");
}
const outputFile = outputArgument >= 0
  ? resolve(process.cwd(), process.argv[outputArgument + 1])
  : resolve(HERE, "loader.json");
const testManifestPublicKey = process.argv.includes("--test-manifest-public-key");
if (testManifestPublicKey && process.env.YURIRTC_BROWSER_E2E_BUILD !== "1") {
  throw new Error("--test-manifest-public-key is restricted to YURIRTC_BROWSER_E2E_BUILD=1");
}
const testPublicKey = testManifestPublicKey
  ? process.env.YURIRTC_TEST_MANIFEST_PUBLIC_KEY
  : undefined;
if (testManifestPublicKey && !testPublicKey) {
  throw new Error("--test-manifest-public-key requires YURIRTC_TEST_MANIFEST_PUBLIC_KEY");
}
if (!process.env.YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY) {
  try {
    process.loadEnvFile(resolve(ROOT, ".env.release"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const privateKeyEncoded = process.env.YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY;
if (!privateKeyEncoded) {
  throw new Error("YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY is required to build loader.json");
}

const [loaderPackage, client, publicConfiguration] = await Promise.all([
  readFile(resolve(ROOT, "packages/loader/package.json"), "utf8").then(JSON.parse),
  readFile(resolve(ROOT, "packages/loader/dist/bundle/client.js")),
  testPublicKey
    ? Promise.resolve({ spki: testPublicKey })
    : readFile(resolve(ROOT, "deploy/npm/manifest-public-key.json"), "utf8").then(JSON.parse)
]);
const privateKey = privateKeyFromBase64url(privateKeyEncoded);
const publicKey = publicKeyFromBase64url(publicConfiguration.spki);
const derivedPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" });
if (base64url(derivedPublic) !== publicConfiguration.spki) {
  throw new Error("manifest private key does not match the carrier's committed public key");
}

const sha256 = createHash("sha256").update(client).digest("base64url");
const manifest = signManifest(loaderDescriptor(String(loaderPackage.version), sha256), privateKey);
if (!verifyManifest(manifest, publicKey)) {
  throw new Error("generated loader manifest failed its own signature verification");
}
await writeFile(outputFile, `${JSON.stringify(manifest)}\n`, "utf8");
console.log(`built signed @advwebrec/grainloading@${loaderPackage.version} pointer (${sha256})`);
