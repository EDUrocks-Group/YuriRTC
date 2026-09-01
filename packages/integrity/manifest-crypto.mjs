import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes
} from "node:crypto";

export const MANIFEST_SCHEMA = 1;
export const SIGNATURE_ALGORITHM = "ECDSA-P256-SHA256";

export function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function fromBase64url(value, label = "value") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} is not base64url`);
  }
  return Buffer.from(value, "base64url");
}

export function loaderDescriptor(version, sha256) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid loader version ${version}`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(sha256)) {
    throw new Error("loader SHA-256 must be unpadded base64url");
  }
  return {
    package: "@advwebrec/grainloading",
    version,
    urls: [
      `https://cdn.jsdelivr.net/npm/@advwebrec/grainloading@${version}/dist/bundle/client.js`,
      `https://unpkg.com/@advwebrec/grainloading@${version}/dist/bundle/client.js`
    ],
    sha256
  };
}

export function encodePayload(loader) {
  return Buffer.from(JSON.stringify({ schema: MANIFEST_SCHEMA, loader }), "utf8");
}

export function privateKeyFromBase64url(encoded) {
  return createPrivateKey({
    key: fromBase64url(encoded, "private signing key"),
    format: "der",
    type: "pkcs8"
  });
}

export function publicKeyFromBase64url(encoded) {
  return createPublicKey({
    key: fromBase64url(encoded, "public verification key"),
    format: "der",
    type: "spki"
  });
}

export function signManifest(loader, privateKey) {
  const payload = encodePayload(loader);
  const signature = signBytes("sha256", payload, {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return {
    schema: MANIFEST_SCHEMA,
    payload: base64url(payload),
    signature: {
      algorithm: SIGNATURE_ALGORITHM,
      value: base64url(signature)
    }
  };
}

export function verifyManifest(manifest, publicKey) {
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA) return false;
  if (manifest.signature?.algorithm !== SIGNATURE_ALGORITHM) return false;
  try {
    return verifyBytes(
      "sha256",
      fromBase64url(manifest.payload, "manifest payload"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      fromBase64url(manifest.signature.value, "manifest signature")
    );
  } catch {
    return false;
  }
}
