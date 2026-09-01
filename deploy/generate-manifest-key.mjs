import { generateKeyPairSync } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const environmentPath = resolve(ROOT, ".env.release");
const publicPath = resolve(ROOT, "deploy/npm/manifest-public-key.json");
const current = await readFile(environmentPath, "utf8").catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
if (/^export YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY=/m.test(current)) {
  throw new Error(".env.release already contains a manifest signing key; refusing to replace it");
}
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateValue = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
const publicValue = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
await appendFile(
  environmentPath,
  `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}export YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY='${privateValue}'\n`,
  { encoding: "utf8", mode: 0o600 }
);
await writeFile(
  publicPath,
  `${JSON.stringify({ algorithm: "ECDSA-P256-SHA256", spki: publicValue }, null, 2)}\n`,
  "utf8"
);
console.log(`generated manifest signing key; committed public key: ${publicValue}`);
