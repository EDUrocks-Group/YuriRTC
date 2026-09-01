import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, webcrypto } from "node:crypto";
import test from "node:test";
import {
  continueUnverified,
  LoaderResolutionError,
  resolveLoader,
  validatePayload,
  verifyEnvelope
} from "../src/integrity-loader.mjs";
import {
  base64url,
  loaderDescriptor,
  signManifest
} from "../../../packages/integrity/manifest-crypto.mjs";

const client = new TextEncoder().encode("export const boot = () => 'ok';");
const digest = createHash("sha256").update(client).digest("base64url");
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = base64url(publicKey.export({ format: "der", type: "spki" }));
const manifest = signManifest(loaderDescriptor("0.5.1", digest), privateKey);
const manifestText = JSON.stringify(manifest);
const descriptor = loaderDescriptor("0.5.1", digest);
const shortAttempt = { attemptTimeoutMs: 20 };

const response = (body, status = 200) => new Response(body, {
  status,
  headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }
});

function fetchScenario({ pointers = [manifestText], loaders = [client] } = {}) {
  let pointerIndex = 0;
  let loaderIndex = 0;
  return async (url) => {
    if (url.endsWith("loader.json")) {
      const value = pointers[pointerIndex++];
      if (value instanceof Error) throw value;
      return response(value, value === undefined ? 404 : 200);
    }
    const value = loaders[loaderIndex++];
    if (value instanceof Error) throw value;
    return response(value, value === undefined ? 404 : 200);
  };
}

function release(version, bytes = client) {
  const sha256 = createHash("sha256").update(bytes).digest("base64url");
  const releaseDescriptor = {
    package: "@advwebrec/grainloading",
    version,
    urls: [
      `https://cdn.jsdelivr.net/npm/@advwebrec/grainloading@${version}/dist/bundle/client.js`,
      `https://unpkg.com/@advwebrec/grainloading@${version}/dist/bundle/client.js`
    ],
    sha256
  };
  return {
    descriptor: releaseDescriptor,
    manifestText: JSON.stringify(signManifest(releaseDescriptor, privateKey))
  };
}

function memoryVersionStore(initialValue) {
  let value = initialValue;
  const writes = [];
  return {
    get value() {
      return value;
    },
    writes,
    getItem() {
      return value ?? null;
    },
    setItem(key, nextValue) {
      writes.push({ key, value: nextValue });
      value = nextValue;
    }
  };
}

function chunkedResponse(chunks, onCancel) {
  let index = 0;
  return response(new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
        return;
      }
      controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    }
  }, { highWaterMark: 0 }));
}

test("validates only immutable @advwebrec/grainloading CDN URLs", () => {
  assert.deepEqual(validatePayload({ schema: 1, loader: descriptor }), descriptor);
  assert.throws(
    () => validatePayload({ schema: 1, loader: { ...descriptor, urls: ["https://evil.invalid/x"] } }),
    /expected immutable CDN URLs/
  );
  assert.throws(
    () => validatePayload({ schema: 1, loader: { ...descriptor, version: "1.2.3-01" } }),
    /version is invalid/
  );
  const prerelease = release("1.2.3-beta.2+build.7").descriptor;
  assert.deepEqual(validatePayload({ schema: 1, loader: prerelease }), prerelease);
});

test("verifies a signed P-256 manifest using browser WebCrypto", async () => {
  const result = await verifyEnvelope(manifestText, spki, webcrypto);
  assert.equal(result.verified, true);
  const tampered = JSON.parse(manifestText);
  tampered.signature.value = `${tampered.signature.value[0] === "A" ? "B" : "A"}${tampered.signature.value.slice(1)}`;
  assert.equal((await verifyEnvelope(JSON.stringify(tampered), spki, webcrypto)).verified, false);
});

test("uses the second manifest CDN and the second matching loader CDN", async () => {
  const wrong = new TextEncoder().encode("rewritten");
  const result = await resolveLoader({
    publicKeySpki: spki,
    cryptoApi: webcrypto,
    fetchImpl: fetchScenario({
      pointers: [new Error("blocked"), manifestText],
      loaders: [wrong, client]
    })
  });
  assert.equal(new TextDecoder().decode(result.bytes), new TextDecoder().decode(client));
  assert.match(result.url, /^https:\/\/unpkg\.com\//);
});

test("distinguishes total CDN failure from downloaded hash mismatches", async () => {
  await assert.rejects(
    resolveLoader({
      publicKeySpki: spki,
      cryptoApi: webcrypto,
      fetchImpl: fetchScenario({ pointers: [new Error("blocked"), new Error("blocked")] })
    }),
    (error) => error instanceof LoaderResolutionError && error.code === "cdn-unavailable"
  );

  const wrong = new TextEncoder().encode("rewritten");
  await assert.rejects(
    resolveLoader({
      publicKeySpki: spki,
      cryptoApi: webcrypto,
      fetchImpl: fetchScenario({ loaders: [wrong, wrong] })
    }),
    (error) => error.code === "integrity-failure" && error.bytes.byteLength === wrong.byteLength
  );
});

test("invalid signatures retain only schema-validated URLs for explicit continuation", async () => {
  const tampered = structuredClone(manifest);
  tampered.signature.value = `${tampered.signature.value.slice(0, -2)}AA`;
  let failure;
  try {
    await resolveLoader({
      publicKeySpki: spki,
      cryptoApi: webcrypto,
      fetchImpl: fetchScenario({ pointers: [JSON.stringify(tampered), JSON.stringify(tampered)] })
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "integrity-failure");
  assert.equal(failure.reason, "signature-invalid");
  assert.deepEqual(failure.descriptor, descriptor);
  const bytes = await continueUnverified(failure, fetchScenario({ loaders: [client] }));
  assert.equal(createHash("sha256").update(bytes).digest("base64url"), digest);
});

test("malformed signed payloads never provide continuation URLs", async () => {
  const malformed = JSON.stringify({ schema: 1, payload: "e30", signature: manifest.signature });
  await assert.rejects(
    resolveLoader({
      publicKeySpki: spki,
      cryptoApi: webcrypto,
      fetchImpl: fetchScenario({ pointers: [malformed, malformed] })
    }),
    (error) => error.code === "integrity-failure" && error.descriptor === undefined
  );
});

test("a never-resolving manifest fetch is aborted before using the fallback CDN", { timeout: 1_000 }, async () => {
  let pointerAttempts = 0;
  let firstAborted = false;
  const result = await resolveLoader({
    publicKeySpki: spki,
    cryptoApi: webcrypto,
    ...shortAttempt,
    fetchImpl: async (url, options) => {
      if (!url.endsWith("loader.json")) return response(client);
      pointerAttempts += 1;
      if (pointerAttempts === 1) {
        options.signal.addEventListener("abort", () => {
          firstAborted = true;
        }, { once: true });
        return new Promise(() => {});
      }
      return response(manifestText);
    }
  });
  assert.equal(firstAborted, true);
  assert.equal(pointerAttempts, 2);
  assert.deepEqual(result.bytes, client);
});

test("a never-resolving loader body is cancelled before using the fallback CDN", { timeout: 1_000 }, async () => {
  let loaderAttempts = 0;
  let bodyCancelled = false;
  const stalledBody = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      bodyCancelled = true;
    }
  });
  const result = await resolveLoader({
    publicKeySpki: spki,
    cryptoApi: webcrypto,
    ...shortAttempt,
    fetchImpl: async (url) => {
      if (url.endsWith("loader.json")) return response(manifestText);
      loaderAttempts += 1;
      return loaderAttempts === 1 ? response(stalledBody) : response(client);
    }
  });
  assert.equal(bodyCancelled, true);
  assert.equal(loaderAttempts, 2);
  assert.deepEqual(result.bytes, client);
});

test("chunked manifest and loader bodies are cancelled as soon as they exceed their limits", async () => {
  let manifestCancelled = false;
  let manifestAttempts = 0;
  const manifestResult = await resolveLoader({
    publicKeySpki: spki,
    cryptoApi: webcrypto,
    fetchImpl: async (url) => {
      if (!url.endsWith("loader.json")) return response(client);
      manifestAttempts += 1;
      if (manifestAttempts === 1) {
        return chunkedResponse(
          [new Uint8Array(40 * 1024), new Uint8Array(40 * 1024)],
          () => {
            manifestCancelled = true;
          }
        );
      }
      return response(manifestText);
    }
  });
  assert.equal(manifestCancelled, true);
  assert.equal(manifestAttempts, 2);
  assert.deepEqual(manifestResult.bytes, client);

  let loaderCancelled = false;
  let loaderAttempts = 0;
  const loaderResult = await resolveLoader({
    publicKeySpki: spki,
    cryptoApi: webcrypto,
    fetchImpl: async (url) => {
      if (url.endsWith("loader.json")) return response(manifestText);
      loaderAttempts += 1;
      if (loaderAttempts === 1) {
        return chunkedResponse(
          [new Uint8Array(5 * 1024 * 1024), new Uint8Array(5 * 1024 * 1024)],
          () => {
            loaderCancelled = true;
          }
        );
      }
      return response(client);
    }
  });
  assert.equal(loaderCancelled, true);
  assert.equal(loaderAttempts, 2);
  assert.deepEqual(loaderResult.bytes, client);
});

test("a verified newer loader blocks a later signed rollback without downloading it", async () => {
  const store = memoryVersionStore();
  const newer = release("2.0.0");
  await resolveLoader({
    publicKeySpki: spki,
    cryptoApi: webcrypto,
    versionStore: store,
    fetchImpl: fetchScenario({ pointers: [newer.manifestText], loaders: [client] })
  });
  assert.equal(store.value, "2.0.0");

  const older = release("1.9.9");
  let loaderRequests = 0;
  await assert.rejects(
    resolveLoader({
      publicKeySpki: spki,
      cryptoApi: webcrypto,
      versionStore: store,
      fetchImpl: async (url) => {
        if (url.endsWith("loader.json")) return response(older.manifestText);
        loaderRequests += 1;
        return response(client);
      }
    }),
    (error) => error instanceof LoaderResolutionError &&
      error.code === "integrity-failure" &&
      error.reason === "manifest-replay" &&
      error.descriptor.version === "1.9.9"
  );
  assert.equal(loaderRequests, 0);
  assert.equal(store.value, "2.0.0");
});

test("SemVer precedence accepts equal builds, newer prereleases, and a stable release", async () => {
  const store = memoryVersionStore("1.2.3-beta.2+build.7");
  for (const version of [
    "1.2.3-beta.2+build.1",
    "1.2.3-beta.10",
    "1.2.3"
  ]) {
    const candidate = release(version);
    const result = await resolveLoader({
      publicKeySpki: spki,
      cryptoApi: webcrypto,
      versionStore: store,
      fetchImpl: fetchScenario({ pointers: [candidate.manifestText], loaders: [client] })
    });
    assert.equal(result.descriptor.version, version);
  }
  assert.equal(store.value, "1.2.3");

  const prerelease = release("1.2.3-rc.99");
  await assert.rejects(
    resolveLoader({
      publicKeySpki: spki,
      cryptoApi: webcrypto,
      versionStore: store,
      fetchImpl: fetchScenario({ pointers: [prerelease.manifestText] })
    }),
    (error) => error.reason === "manifest-replay"
  );
});

test("the highest version is persisted only after matching loader bytes verify", async () => {
  const store = memoryVersionStore("3.0.0");
  const candidate = release("3.1.0");
  const wrong = new TextEncoder().encode("rewritten");
  await assert.rejects(
    resolveLoader({
      publicKeySpki: spki,
      cryptoApi: webcrypto,
      versionStore: store,
      fetchImpl: fetchScenario({
        pointers: [candidate.manifestText],
        loaders: [wrong, wrong]
      })
    }),
    (error) => error.reason === "loader-hash"
  );
  assert.equal(store.value, "3.0.0");
  assert.equal(store.writes.length, 0);

  await resolveLoader({
    publicKeySpki: spki,
    cryptoApi: webcrypto,
    versionStore: store,
    fetchImpl: fetchScenario({ pointers: [candidate.manifestText], loaders: [client] })
  });
  assert.equal(store.value, "3.1.0");
  assert.equal(store.writes.length, 1);
});

test("loader resolution remains available when version storage throws", async () => {
  const unavailableStore = {
    getItem() {
      throw new DOMException("storage disabled", "SecurityError");
    },
    setItem() {
      throw new DOMException("storage disabled", "SecurityError");
    }
  };
  const result = await resolveLoader({
    publicKeySpki: spki,
    cryptoApi: webcrypto,
    versionStore: unavailableStore,
    fetchImpl: fetchScenario()
  });
  assert.deepEqual(result.bytes, client);
});
