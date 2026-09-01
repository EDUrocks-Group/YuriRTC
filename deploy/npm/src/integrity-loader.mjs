const MANIFEST_LIMIT = 64 * 1024;
const LOADER_LIMIT = 8 * 1024 * 1024;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;
const MANIFEST_PACKAGE = "shaintloadingcheckpak";
const HIGHEST_VERSION_STORAGE_KEY = "yurirtc.loader.highest-verified-version";

export const manifestUrls = [
  `https://cdn.jsdelivr.net/npm/${MANIFEST_PACKAGE}@latest/loader.json`,
  `https://unpkg.com/${MANIFEST_PACKAGE}@latest/loader.json`
];

export class LoaderResolutionError extends Error {
  constructor(code, options = {}) {
    super(code === "cdn-unavailable" ? "loader CDN unavailable" : "loader integrity failure");
    this.name = "LoaderResolutionError";
    this.code = code;
    this.descriptor = options.descriptor;
    this.bytes = options.bytes;
    this.reason = options.reason;
    this.manifestFingerprint = options.manifestFingerprint;
  }
}

function decodeBase64url(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} is not base64url`);
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64url(value) {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function exactLoaderUrls(version) {
  return [
    `https://cdn.jsdelivr.net/npm/@advwebrec/grainloading@${version}/dist/bundle/client.js`,
    `https://unpkg.com/@advwebrec/grainloading@${version}/dist/bundle/client.js`
  ];
}

function parseSemVer(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^[0-9]+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0")) {
    return undefined;
  }
  return { core: match.slice(1, 4), prerelease };
}

function compareNumericStrings(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareSemVer(left, right) {
  const parsedLeft = parseSemVer(left);
  const parsedRight = parseSemVer(right);
  if (!parsedLeft || !parsedRight) throw new Error("cannot compare invalid semantic versions");
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const compared = compareNumericStrings(parsedLeft.core[index], parsedRight.core[index]);
    if (compared !== 0) return compared;
  }
  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    if (parsedLeft.prerelease.length === parsedRight.prerelease.length) return 0;
    return parsedLeft.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^[0-9]+$/.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericStrings(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function validatePayload(payload) {
  const loader = payload?.loader;
  if (payload?.schema !== 1 || loader?.package !== "@advwebrec/grainloading") {
    throw new Error("manifest payload has an unsupported schema or package");
  }
  if (!parseSemVer(loader.version)) {
    throw new Error("manifest loader version is invalid");
  }
  if (typeof loader.sha256 !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(loader.sha256)) {
    throw new Error("manifest loader SHA-256 is invalid");
  }
  const expectedUrls = exactLoaderUrls(loader.version);
  if (!Array.isArray(loader.urls) || loader.urls.length !== expectedUrls.length ||
      loader.urls.some((url, index) => url !== expectedUrls[index])) {
    throw new Error("manifest loader URLs are not the expected immutable CDN URLs");
  }
  return {
    package: loader.package,
    version: loader.version,
    urls: [...loader.urls],
    sha256: loader.sha256
  };
}

function decodeEnvelope(text) {
  const envelope = JSON.parse(text);
  if (envelope?.schema !== 1 || envelope?.signature?.algorithm !== "ECDSA-P256-SHA256") {
    throw new Error("manifest envelope has an unsupported schema or algorithm");
  }
  const payloadBytes = decodeBase64url(envelope.payload, "manifest payload");
  const descriptor = validatePayload(JSON.parse(new TextDecoder().decode(payloadBytes)));
  const signature = decodeBase64url(envelope.signature.value, "manifest signature");
  if (signature.byteLength !== 64) throw new Error("manifest signature has an invalid length");
  return { descriptor, payloadBytes, signature };
}

async function importVerificationKey(subtle, spki) {
  return subtle.importKey(
    "spki",
    decodeBase64url(spki, "public verification key"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

export async function verifyEnvelope(text, publicKeySpki, cryptoApi = globalThis.crypto) {
  const decoded = decodeEnvelope(text);
  const key = await importVerificationKey(cryptoApi.subtle, publicKeySpki);
  const verified = await cryptoApi.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decoded.signature,
    decoded.payloadBytes
  );
  return { ...decoded, verified };
}

function cancelBody(body, reason) {
  try {
    Promise.resolve(body?.cancel?.(reason)).catch(() => {});
  } catch {
    // Cancellation is best-effort for Response implementations without a native stream.
  }
}

function abortError() {
  const error = new Error("CDN attempt aborted");
  error.name = "AbortError";
  return error;
}

async function responseBytes(response, limit, signal) {
  if (!response?.ok) {
    cancelBody(response?.body);
    throw new Error(`HTTP ${response?.status ?? 0}`);
  }
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    cancelBody(response.body);
    throw new Error("response exceeds size limit");
  }

  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      const error = abortError();
      try {
        Promise.resolve(reader.cancel(error)).catch(() => {});
      } catch {
        // The timeout still releases this attempt even if a non-native reader cannot cancel.
      }
      rejectAbort(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      while (true) {
        const result = signal
          ? await Promise.race([reader.read(), aborted])
          : await reader.read();
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value);
        total += chunk.byteLength;
        if (total > limit) {
          try {
            Promise.resolve(reader.cancel("response exceeds size limit")).catch(() => {});
          } catch {
            // The enforced byte bound does not depend on cancellation succeeding.
          }
          throw new Error("response exceeds size limit");
        }
        chunks.push(chunk);
      }
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
    if (total === 0) throw new Error("response has an invalid size");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  if (signal?.aborted) throw abortError();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > limit) throw new Error("response has an invalid size");
  return bytes;
}

async function sha256(bytes, cryptoApi) {
  return encodeBase64url(new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes)));
}

function defaultVersionStore() {
  try {
    const storage = globalThis.localStorage;
    return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function"
      ? storage
      : undefined;
  } catch {
    return undefined;
  }
}

function readHighestVersion(store) {
  try {
    const value = store?.getItem?.(HIGHEST_VERSION_STORAGE_KEY);
    return parseSemVer(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function persistHighestVersion(store, version) {
  const current = readHighestVersion(store);
  if (current && compareSemVer(version, current) <= 0) return;
  try {
    store?.setItem?.(HIGHEST_VERSION_STORAGE_KEY, version);
  } catch {
    // localStorage can be unavailable in private/sandboxed browser contexts.
  }
}

function isReplay(version, store) {
  const highest = readHighestVersion(store);
  return highest !== undefined && compareSemVer(version, highest) < 0;
}

function timingOptions(options) {
  const timeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("attemptTimeoutMs must be a positive finite number");
  }
  return {
    timeoutMs,
    scheduleTimeout: options.scheduleTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay)),
    cancelTimeout: options.cancelTimeout ?? ((handle) => globalThis.clearTimeout(handle))
  };
}

async function fetchBytes(url, fetchImpl, limit, timing) {
  const controller = new AbortController();
  let response;
  let timeoutHandle;
  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = timing.scheduleTimeout(() => {
      try {
        controller.abort();
      } catch {
        // AbortController implementations without abort support still use the timeout race.
      }
      cancelBody(response?.body, abortError());
      reject(new Error("CDN attempt timed out"));
    }, timing.timeoutMs);
  });
  const operation = (async () => {
    response = await fetchImpl(url, {
      cache: "no-store",
      mode: "cors",
      signal: controller.signal
    });
    return responseBytes(response, limit, controller.signal);
  })();
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    timing.cancelTimeout(timeoutHandle);
  }
}

async function downloadFirst(urls, fetchImpl, accept, timing) {
  let candidate;
  for (const url of urls) {
    try {
      const bytes = await fetchBytes(url, fetchImpl, LOADER_LIMIT, timing);
      candidate ??= bytes;
      if (!accept || await accept(bytes)) return { bytes, url };
    } catch {
      // The other CDN is an independent fallback.
    }
  }
  return { bytes: candidate };
}

export async function resolveLoader({
  publicKeySpki,
  fetchImpl = globalThis.fetch,
  cryptoApi = globalThis.crypto,
  pointerUrls = manifestUrls,
  versionStore,
  attemptTimeoutMs,
  scheduleTimeout,
  cancelTimeout
}) {
  const timing = timingOptions({ attemptTimeoutMs, scheduleTimeout, cancelTimeout });
  const highestVersionStore = versionStore === undefined ? defaultVersionStore() : versionStore;
  let sawManifest = false;
  let untrustedDescriptor;
  let replayDescriptor;
  let descriptor;
  let manifestFailure = "manifest-unavailable";
  let manifestFingerprint;
  for (const url of pointerUrls) {
    try {
      const bytes = await fetchBytes(url, fetchImpl, MANIFEST_LIMIT, timing);
      sawManifest = true;
      manifestFingerprint = await sha256(bytes, cryptoApi).catch(() => undefined);
      const text = new TextDecoder().decode(bytes);
      let decoded;
      try {
        decoded = decodeEnvelope(text);
        untrustedDescriptor ??= decoded.descriptor;
      } catch {
        manifestFailure = "envelope-invalid";
        continue;
      }
      let verified;
      try {
        verified = await verifyEnvelope(text, publicKeySpki, cryptoApi);
      } catch {
        manifestFailure = cryptoApi?.subtle
          ? "verification-error"
          : "crypto-unavailable";
        continue;
      }
      if (verified.verified) {
        if (isReplay(verified.descriptor.version, highestVersionStore)) {
          replayDescriptor ??= verified.descriptor;
          manifestFailure = "manifest-replay";
          continue;
        }
        descriptor = verified.descriptor;
        break;
      }
      manifestFailure = "signature-invalid";
    } catch {
      // Try the independently hosted copy.
    }
  }

  if (!descriptor) {
    if (sawManifest) {
      throw new LoaderResolutionError("integrity-failure", {
        descriptor: replayDescriptor ?? untrustedDescriptor,
        reason: replayDescriptor ? "manifest-replay" : manifestFailure,
        manifestFingerprint
      });
    }
    throw new LoaderResolutionError("cdn-unavailable");
  }

  const downloaded = await downloadFirst(
    descriptor.urls,
    fetchImpl,
    async (bytes) => await sha256(bytes, cryptoApi) === descriptor.sha256,
    timing
  );
  if (downloaded.url) {
    if (isReplay(descriptor.version, highestVersionStore)) {
      throw new LoaderResolutionError("integrity-failure", {
        descriptor,
        reason: "manifest-replay"
      });
    }
    persistHighestVersion(highestVersionStore, descriptor.version);
    return { descriptor, bytes: downloaded.bytes, url: downloaded.url };
  }
  if (downloaded.bytes) {
    throw new LoaderResolutionError("integrity-failure", {
      descriptor,
      bytes: downloaded.bytes,
      reason: "loader-hash"
    });
  }
  throw new LoaderResolutionError("cdn-unavailable", { descriptor });
}

export async function continueUnverified(error, fetchImpl = globalThis.fetch, options = {}) {
  if (error?.bytes instanceof Uint8Array && error.bytes.byteLength > 0) return error.bytes;
  if (error?.descriptor) {
    const downloaded = await downloadFirst(
      error.descriptor.urls,
      fetchImpl,
      undefined,
      timingOptions(options)
    );
    if (downloaded.bytes) return downloaded.bytes;
  }
  throw new LoaderResolutionError("cdn-unavailable");
}

export async function importClientBytes(bytes) {
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    return await import(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function fontUrlsFor(descriptor) {
  return descriptor.urls.map((url) =>
    url.replace("/dist/bundle/client.js", "/dist/assets/rot13.woff")
  );
}
