import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import { carrierReleaseFingerprints } from "../release-fingerprint.mjs";

const HERE = new URL("..", import.meta.url).pathname;
const manifestPublicKey = JSON.parse(
  await readFile(join(HERE, "manifest-public-key.json"), "utf8")
).spki;

test("release build emits opaque, syntactically valid, signed-pointer carrier files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "yurirtc-static-test-"));
  try {
    const built = spawnSync(
      "node",
      ["build.mjs", "--release", "--out-dir", temporary],
      {
        cwd: HERE,
        encoding: "utf8",
        env: {
          ...process.env,
          YURIRTC_FIREBASE_API_KEY: "test-public-api-key",
          YURIRTC_FIREBASE_PROJECT_ID: "example-project",
          YURIRTC_FIREBASE_DATABASE_URL: "https://example-project.firebaseio.test"
        }
      }
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);

    const html = await readFile(join(temporary, "index.html"), "utf8");
    const worker = await readFile(join(temporary, "sw.js"), "utf8");
    const fingerprints = await carrierReleaseFingerprints();
    assert.match(html, new RegExp(fingerprints.index));
    assert.match(worker, new RegExp(fingerprints.worker));
    assert.match(html, /<title>yrneazngurqh<\/title>/);
    assert.doesNotMatch(
      html,
      /YuriRTC|Starting|Loading|Connecting|Network Censorship Level|Route unknown|Connection interrupted|Reconnect now|No network route available|test-public-api-key/
    );
    assert.doesNotMatch(html, /body\{visibility:hidden\}/);
    assert.doesNotMatch(html, /sourceMappingURL/);
    assert.doesNotMatch(html, /(?:\d{1,3}\.){3}\d{1,3}|candidate:/i);
    assert.doesNotMatch(worker, /sourceMappingURL/);
    // Obfuscation encodes every string, so latest-tracking is proven at
    // runtime: the worker vm check below captures the real importScripts URLs,
    // and the browser e2e only fulfills the @latest CDN paths.
    assert.doesNotMatch(html, /<div\b/i, "boot markup must be created inside the obfuscated module");

    const moduleSource = html.match(/<script\b[^>]*type=module[^>]*>([\s\S]*?)<\/script>/i)?.[1];
    assert.ok(moduleSource, "built index must contain its module");
    const modulePath = join(temporary, "carrier.mjs");
    await writeFile(modulePath, moduleSource, "utf8");
    const checked = spawnSync("node", ["--check", modulePath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);

    const attempted = [];
    const context = {
      atob,
      console: { warn() {} },
      URL,
      self: { location: { href: "https://carrier.test/sw.js?yurirtc-loader=0.5.1" } },
      importScripts(url) {
        attempted.push(url);
        if (attempted.length === 1) throw new Error("first CDN unavailable");
      }
    };
    vm.runInNewContext(worker, context, { filename: "sw.js" });
    // Both CDNs are tried in order for the immutable worker version supplied
    // by the already verified page client.
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every((url) =>
      url.endsWith("/@advwebrec/grainloading@0.5.1/dist/bundle/sw.js")
    ));
    assert.ok(attempted[0].startsWith("https://cdn.jsdelivr.net/"), attempted[0]);
    assert.ok(attempted[1].startsWith("https://unpkg.com/"), attempted[1]);

    const verified = spawnSync(
      "node",
      ["verify-package.mjs", "--artifacts-only", "--artifact-dir", temporary],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);

    await writeFile(join(temporary, "sw.js"), `${worker}\n/*YURIRTC_BROWSER_E2E_ONLY*/\n`, "utf8");
    const testWired = spawnSync(
      "node",
      ["verify-package.mjs", "--artifacts-only", "--artifact-dir", temporary],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.notEqual(testWired.status, 0, "verifier must reject a browser-E2E-only worker");
    assert.match(`${testWired.stderr}\n${testWired.stdout}`, /browser-E2E-only source/);
    await writeFile(join(temporary, "sw.js"), worker, "utf8");

    await writeFile(
      join(temporary, "index.html"),
      html.replace(fingerprints.index, "0".repeat(fingerprints.index.length)),
      "utf8"
    );
    const stale = spawnSync(
      "node",
      ["verify-package.mjs", "--artifacts-only", "--artifact-dir", temporary],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.notEqual(stale.status, 0, "verifier must reject a stale generated carrier");
    assert.match(`${stale.stderr}\n${stale.stdout}`, /stale generated artifacts/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("bundled release pins the current loader inline and as durable same-origin files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "yurirtc-bundled-static-test-"));
  try {
    const built = spawnSync(
      "node",
      ["build.mjs", "--release", "--bundled-loader", "--out-dir", temporary],
      {
        cwd: HERE,
        encoding: "utf8",
        env: {
          ...process.env,
          YURIRTC_FIREBASE_API_KEY: "test-public-api-key",
          YURIRTC_FIREBASE_PROJECT_ID: "example-project",
          YURIRTC_FIREBASE_DATABASE_URL: "https://example-project.firebaseio.test"
        }
      }
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);

    const [html, worker, client, sourceClient, sourceWorker, font, license, sourceNotice] =
      await Promise.all([
        readFile(join(temporary, "index.html"), "utf8"),
        readFile(join(temporary, "sw.js"), "utf8"),
        readFile(join(temporary, "client.js")),
        readFile(join(HERE, "../../packages/loader/dist/bundle/client.js")),
        readFile(join(HERE, "../../packages/loader/dist/bundle/sw.js"), "utf8"),
        readFile(join(HERE, "../../packages/loader/dist/assets/rot13.woff")),
        readFile(join(temporary, "LICENSE")),
        readFile(join(temporary, "SOURCE.txt"), "utf8")
      ]);
    const fingerprints = await carrierReleaseFingerprints("release", "bundled");
    assert.match(html, new RegExp(fingerprints.index));
    assert.equal(worker, `${sourceWorker.trimEnd()}\n/*${fingerprints.worker}*/\n`);
    assert.deepEqual(client, sourceClient);
    assert.deepEqual(license, await readFile(join(HERE, "../../LICENSE")));
    assert.match(sourceNotice, /GNU AGPL-3\.0-only/);

    const encodedClient = html.match(
      /<script\b(?=[^>]*\btype=(?:["']?application\/octet-stream["']?))[^>]*>([A-Za-z0-9+/=]+)<\/script>/i
    )?.[1];
    assert.ok(encodedClient, "bundled index must contain its inline client payload");
    assert.deepEqual(Buffer.from(encodedClient, "base64"), sourceClient);
    const encodedFont = html.match(/data:font\/woff;base64,([A-Za-z0-9+/=]+)/i)?.[1];
    assert.ok(encodedFont, "bundled index must contain its display font");
    assert.deepEqual(Buffer.from(encodedFont, "base64"), font);
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net|unpkg\.com|shaintloadingcheckpak/i);

    const moduleSource = html.match(/<script\b[^>]*type=module[^>]*>([\s\S]*?)<\/script>/i)?.[1];
    assert.ok(moduleSource, "bundled index must contain its module");
    const checked = spawnSync(
      "node",
      ["--input-type=module", "--check"],
      { encoding: "utf8", input: moduleSource }
    );
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);

    const verified = spawnSync(
      "node",
      [
        "verify-package.mjs",
        "--artifacts-only",
        "--bundled-loader",
        "--artifact-dir",
        temporary
      ],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);

    const replacement = `${encodedClient[0] === "A" ? "B" : "A"}${encodedClient.slice(1)}`;
    await writeFile(join(temporary, "index.html"), html.replace(encodedClient, replacement), "utf8");
    const tampered = spawnSync(
      "node",
      [
        "verify-package.mjs",
        "--artifacts-only",
        "--bundled-loader",
        "--artifact-dir",
        temporary
      ],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.notEqual(tampered.status, 0, "verifier must reject a rewritten inline loader");
    assert.match(`${tampered.stderr}\n${tampered.stdout}`, /inline loader does not match/);

    await writeFile(join(temporary, "index.html"), html, "utf8");
    await writeFile(join(temporary, "client.js"), Buffer.concat([sourceClient, Buffer.from("\n")]));
    const staleRecovery = spawnSync(
      "node",
      [
        "verify-package.mjs",
        "--artifacts-only",
        "--bundled-loader",
        "--artifact-dir",
        temporary
      ],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.notEqual(staleRecovery.status, 0, "verifier must reject a stale recovery client");
    assert.match(`${staleRecovery.stderr}\n${staleRecovery.stdout}`, /client\.js does not match/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("worker CDN override is restricted to the deterministic browser E2E", () => {
  const environment = { ...process.env };
  delete environment.YURIRTC_BROWSER_E2E_BUILD;
  const built = spawnSync(
    "node",
    ["build.mjs", "--test-worker-cdn-base", "/npm/@advwebrec/grainloading"],
    { cwd: HERE, encoding: "utf8", env: environment }
  );
  assert.notEqual(built.status, 0);
  assert.match(`${built.stderr}\n${built.stdout}`, /restricted to YURIRTC_BROWSER_E2E_BUILD=1/);
});

test("every browser E2E override marks real output and the verifier rejects it", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "yurirtc-static-e2e-test-"));
  try {
    const built = spawnSync(
      "node",
      [
        "build.mjs",
        "--release",
        "--out-dir",
        temporary,
        "--test-worker-cdn-base",
        "/npm/@advwebrec/grainloading",
        "--test-firestore-base-url",
        "/firestore",
        "--test-local-asset-base",
        "/yurirtc-e2e",
        "--test-manifest-public-key"
      ],
      {
        cwd: HERE,
        encoding: "utf8",
        env: {
          ...process.env,
          YURIRTC_BROWSER_E2E_BUILD: "1",
          YURIRTC_FIREBASE_API_KEY: "test-public-api-key",
          YURIRTC_FIREBASE_PROJECT_ID: "example-project",
          YURIRTC_FIREBASE_DATABASE_URL: "https://example-project.firebaseio.test",
          YURIRTC_TEST_MANIFEST_PUBLIC_KEY: manifestPublicKey
        }
      }
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);

    const [html, worker] = await Promise.all([
      readFile(join(temporary, "index.html"), "utf8"),
      readFile(join(temporary, "sw.js"), "utf8")
    ]);
    assert.match(html, /YURIRTC_BROWSER_E2E_ONLY/);
    assert.match(worker, /YURIRTC_BROWSER_E2E_ONLY/);

    const verified = spawnSync(
      "node",
      ["verify-package.mjs", "--artifacts-only", "--artifact-dir", temporary],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.notEqual(verified.status, 0);
    assert.match(`${verified.stderr}\n${verified.stdout}`, /browser-E2E-only source/);

    await Promise.all([
      writeFile(
        join(temporary, "index.html"),
        html.replace("\n<!--YURIRTC_BROWSER_E2E_ONLY-->", ""),
        "utf8"
      ),
      writeFile(
        join(temporary, "sw.js"),
        worker.replace("\n/*YURIRTC_BROWSER_E2E_ONLY*/", ""),
        "utf8"
      )
    ]);
    const stripped = spawnSync(
      "node",
      ["verify-package.mjs", "--artifacts-only", "--artifact-dir", temporary],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.notEqual(stripped.status, 0, "removing test-only comments must not create a publishable carrier");
    assert.match(`${stripped.stderr}\n${stripped.stdout}`, /stale generated artifacts/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("manifest public-key overrides must be canonical P-256 SPKI", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "yurirtc-invalid-key-test-"));
  try {
    const built = spawnSync(
      "node",
      [
        "build.mjs",
        "--out-dir",
        temporary,
        "--test-local-asset-base",
        "/yurirtc-e2e",
        "--test-manifest-public-key"
      ],
      {
        cwd: HERE,
        encoding: "utf8",
        env: {
          ...process.env,
          YURIRTC_BROWSER_E2E_BUILD: "1",
          YURIRTC_TEST_MANIFEST_PUBLIC_KEY: `not-a-key\";globalThis.injected=true//`
        }
      }
    );
    assert.notEqual(built.status, 0);
    assert.match(`${built.stderr}\n${built.stdout}`, /must be unpadded base64url/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ROT13 source copy decodes to the intended visible labels", () => {
  const rot13 = (value) => value.replace(/[A-Za-z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
  });
  assert.equal(rot13("LhevEGP"), "YuriRTC");
  assert.equal(rot13("Fgnegvat"), "Starting");
  assert.equal(rot13("Pbaarpgvat"), "Connecting");
  assert.equal(rot13("Pbaarpgrq · Ebhgr haxabja"), "Connected · Route unknown");
  assert.equal(rot13("Argjbex Prafbefuvc Yriry"), "Network Censorship Level");
  assert.equal(rot13("Lbhe pbaarpgvba jnf vagreehcgrq"), "Your connection was interrupted");
  assert.equal(rot13("Erpbaarpg abj"), "Reconnect now");
  assert.equal(rot13("Ab argjbex ebhgr ninvynoyr"), "No network route available");
  assert.equal(rot13("Ybnqre vagrtevgl pbhyq abg or irevsvrq."), "Loader integrity could not be verified.");
  assert.equal(rot13("Ybnqre haninvynoyr"), "Loader unavailable");
});
