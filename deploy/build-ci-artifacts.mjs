// Produce evidence that the carrier and signed-pointer paths build without
// making a production-signable artifact. The private key exists only in this
// process and in the one integrity-builder child that needs it.
import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync
} from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  base64url,
  fromBase64url,
  publicKeyFromBase64url,
  verifyManifest
} from "../packages/integrity/manifest-crypto.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "build/ci/test-only");
const CARRIER_OUTPUT = resolve(OUTPUT, "carrier");
const BUNDLED_CARRIER_OUTPUT = resolve(OUTPUT, "carrier-bundled");
const MANIFEST_OUTPUT = resolve(OUTPUT, "loader.test-only.json");
const RELEASE_CREDENTIALS = [
  "YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY",
  "NPM_LOADER_TOKEN",
  "NPM_INTEGRITY_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_CONFIG_USERCONFIG"
];

for (const name of RELEASE_CREDENTIALS) {
  if (process.env[name]) {
    throw new Error(`${name} must be absent from the test-only artifact builder`);
  }
}

function run(command, arguments_, environment) {
  const result = spawnSync(command, arguments_, {
    cwd: ROOT,
    encoding: "utf8",
    env: environment
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed\n${result.stderr || result.stdout}`
    );
  }
  if (result.stdout) process.stdout.write(result.stdout);
}

function scrubbedEnvironment() {
  const environment = { ...process.env };
  for (const name of RELEASE_CREDENTIALS) delete environment[name];
  return environment;
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

await rm(OUTPUT, { recursive: true, force: true });
await Promise.all([
  mkdir(CARRIER_OUTPUT, { recursive: true }),
  mkdir(BUNDLED_CARRIER_OUTPUT, { recursive: true })
]);

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});
const privateEncoded = base64url(
  privateKey.export({ format: "der", type: "pkcs8" })
);
const publicEncoded = base64url(
  publicKey.export({ format: "der", type: "spki" })
);
const baseEnvironment = scrubbedEnvironment();

run(
  process.execPath,
  [
    "packages/integrity/build.mjs",
    "--test-manifest-public-key",
    "--out-file",
    MANIFEST_OUTPUT
  ],
  {
    ...baseEnvironment,
    YURIRTC_BROWSER_E2E_BUILD: "1",
    YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY: privateEncoded,
    YURIRTC_TEST_MANIFEST_PUBLIC_KEY: publicEncoded
  }
);

run(
  process.execPath,
  [
    "deploy/npm/build.mjs",
    "--release",
    "--bundled-loader",
    "--out-dir",
    BUNDLED_CARRIER_OUTPUT,
    "--test-manifest-public-key"
  ],
  {
    ...baseEnvironment,
    YURIRTC_BROWSER_E2E_BUILD: "1",
    YURIRTC_FIREBASE_API_KEY: "ci-test-only-api-key",
    YURIRTC_FIREBASE_PROJECT_ID: "ci-test-only-project",
    YURIRTC_FIREBASE_DATABASE_URL: "https://ci-test-only.invalid",
    YURIRTC_TEST_MANIFEST_PUBLIC_KEY: publicEncoded
  }
);

run(
  process.execPath,
  [
    "deploy/npm/build.mjs",
    "--release",
    "--out-dir",
    CARRIER_OUTPUT,
    "--test-worker-cdn-base",
    "/npm/@advwebrec/grainloading",
    "--test-manifest-public-key"
  ],
  {
    ...baseEnvironment,
    YURIRTC_BROWSER_E2E_BUILD: "1",
    YURIRTC_FIREBASE_API_KEY: "ci-test-only-api-key",
    YURIRTC_FIREBASE_PROJECT_ID: "ci-test-only-project",
    YURIRTC_FIREBASE_DATABASE_URL: "https://ci-test-only.invalid",
    YURIRTC_TEST_MANIFEST_PUBLIC_KEY: publicEncoded
  }
);

const [manifest, loaderPackage, client] = await Promise.all([
  readFile(MANIFEST_OUTPUT, "utf8").then(JSON.parse),
  readFile(resolve(ROOT, "packages/loader/package.json"), "utf8").then(JSON.parse),
  readFile(resolve(ROOT, "packages/loader/dist/bundle/client.js"))
]);
assert.equal(
  verifyManifest(manifest, publicKeyFromBase64url(publicEncoded)),
  true,
  "ephemeral manifest must verify with its ephemeral public key"
);
const payload = JSON.parse(fromBase64url(manifest.payload, "manifest payload"));
assert.equal(payload.loader.version, String(loaderPackage.version));
assert.equal(
  payload.loader.sha256,
  createHash("sha256").update(client).digest("base64url")
);
assert.equal(
  base64url(createPrivateKey({
    key: Buffer.from(privateEncoded, "base64url"),
    format: "der",
    type: "pkcs8"
  }).export({ format: "der", type: "pkcs8" })),
  privateEncoded
);

const rejected = spawnSync(
  process.execPath,
  [
    "deploy/npm/verify-package.mjs",
    "--artifacts-only",
    "--artifact-dir",
    CARRIER_OUTPUT
  ],
  { cwd: ROOT, encoding: "utf8", env: baseEnvironment }
);
assert.notEqual(rejected.status, 0, "production verifier must reject the test carrier");
assert.match(
  `${rejected.stderr}\n${rejected.stdout}`,
  /browser-E2E-only source/,
  "test carrier must be rejected specifically for its test-only marker"
);

const bundledRejected = spawnSync(
  process.execPath,
  [
    "deploy/npm/verify-package.mjs",
    "--artifacts-only",
    "--bundled-loader",
    "--artifact-dir",
    BUNDLED_CARRIER_OUTPUT
  ],
  { cwd: ROOT, encoding: "utf8", env: baseEnvironment }
);
assert.notEqual(bundledRejected.status, 0, "production verifier must reject the test bundled carrier");
assert.match(
  `${bundledRejected.stderr}\n${bundledRejected.stdout}`,
  /browser-E2E-only source/,
  "test bundled carrier must be rejected specifically for its test-only marker"
);

const [carrierIndex, carrierWorker, bundledIndex, bundledWorker, bundledClient] = await Promise.all([
  readFile(resolve(CARRIER_OUTPUT, "index.html")),
  readFile(resolve(CARRIER_OUTPUT, "sw.js")),
  readFile(resolve(BUNDLED_CARRIER_OUTPUT, "index.html")),
  readFile(resolve(BUNDLED_CARRIER_OUTPUT, "sw.js")),
  readFile(resolve(BUNDLED_CARRIER_OUTPUT, "client.js"))
]);
assert.equal(bundledClient.equals(client), true, "bundled recovery client must match the loader build");

for (const [name, directory, index, worker, arguments_] of [
  ["test carrier", CARRIER_OUTPUT, carrierIndex, carrierWorker, []],
  ["test bundled carrier", BUNDLED_CARRIER_OUTPUT, bundledIndex, bundledWorker, ["--bundled-loader"]]
]) {
  await Promise.all([
    writeFile(
      resolve(directory, "index.html"),
      index.toString("utf8").replace("\n<!--YURIRTC_BROWSER_E2E_ONLY-->", ""),
      "utf8"
    ),
    writeFile(
      resolve(directory, "sw.js"),
      worker.toString("utf8").replace("\n/*YURIRTC_BROWSER_E2E_ONLY*/", ""),
      "utf8"
    )
  ]);
  const stripped = spawnSync(
    process.execPath,
    [
      "deploy/npm/verify-package.mjs",
      "--artifacts-only",
      ...arguments_,
      "--artifact-dir",
      directory
    ],
    { cwd: ROOT, encoding: "utf8", env: baseEnvironment }
  );
  assert.notEqual(stripped.status, 0, `${name} became publishable after removing its marker`);
  assert.match(
    `${stripped.stderr}\n${stripped.stdout}`,
    /stale generated artifacts/,
    `${name} test-only fingerprint was not bound to its build mode`
  );
  await Promise.all([
    writeFile(resolve(directory, "index.html"), index),
    writeFile(resolve(directory, "sw.js"), worker)
  ]);
}

await Promise.all([
  writeFile(
    resolve(OUTPUT, "DO_NOT_PUBLISH.txt"),
    "TEST-ONLY ARTIFACTS. Ephemeral signing key; synthetic Firebase config; production verifier rejects both carriers.\n",
    "utf8"
  ),
  writeFile(
    resolve(OUTPUT, "metadata.json"),
    `${JSON.stringify({
      schema: 1,
      testOnly: true,
      loaderVersion: String(loaderPackage.version),
      manifestPublicKey: publicEncoded,
      clientSha256: payload.loader.sha256,
      bundledCarrier: {
        indexSha256: createHash("sha256").update(bundledIndex).digest("hex"),
        workerSha256: createHash("sha256").update(bundledWorker).digest("hex"),
        clientSha256: createHash("sha256").update(bundledClient).digest("hex")
      }
    }, null, 2)}\n`,
    "utf8"
  )
]);

for (const path of await filesBelow(OUTPUT)) {
  const bytes = await readFile(path);
  assert.equal(
    bytes.includes(Buffer.from(privateEncoded)),
    false,
    `ephemeral private key leaked into ${path}`
  );
}

console.log(`built test-only CI evidence under ${OUTPUT}`);
