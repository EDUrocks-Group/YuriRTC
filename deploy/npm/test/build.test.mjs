import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import { carrierReleaseFingerprints } from "../release-fingerprint.mjs";

const HERE = new URL("..", import.meta.url).pathname;

test("release build emits opaque, syntactically valid, latest-tracking carrier files", async () => {
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
      // No XMLHttpRequest: a ServiceWorkerGlobalScope has none, which is why
      // the stub imports the moving dist-tag directly instead of resolving an
      // exact version first. Leaving it out of this scope is the assertion --
      // if the stub ever reaches for it again, this throws here.
      importScripts(url) {
        attempted.push(url);
        if (attempted.length === 1) throw new Error("first CDN unavailable");
      }
    };
    vm.runInNewContext(worker, context, { filename: "sw.js" });
    // Both CDNs are tried, in order, and each asks for @latest so a published
    // loader reaches carriers that were uploaded once and never touched again.
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every((url) =>
      url.endsWith("/@edurocks-group/loader@latest/dist/bundle/sw.js")
    ));
    assert.ok(attempted[0].startsWith("https://cdn.jsdelivr.net/"), attempted[0]);
    assert.ok(attempted[1].startsWith("https://unpkg.com/"), attempted[1]);

    const verified = spawnSync(
      "node",
      ["verify-package.mjs", "--artifacts-only", "--artifact-dir", temporary],
      { cwd: HERE, encoding: "utf8" }
    );
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);

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
});
