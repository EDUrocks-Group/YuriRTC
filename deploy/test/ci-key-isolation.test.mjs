import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

async function repositoryFile(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

test("self-hosted verification workflow has no repository secrets", async () => {
  const workflow = await repositoryFile(".github/workflows/ci.yml");
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /Refuse release credentials in the CI workspace/);
  assert.match(workflow, /build\/ci\/test-only/);
});

test("local CI strips release credentials and never sources the release file", async () => {
  const gate = await repositoryFile("deploy/ci-local.sh");
  assert.doesNotMatch(gate, /source\s+[^\n]*\.env\.release/);
  assert.match(gate, /unset YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY/);
  assert.match(gate, /NPM_CONFIG_USERCONFIG=\/dev\/null/);
  assert.match(gate, /GOTOOLCHAIN=go1\.25\.13/);
  assert.match(gate, /govulncheck@v1\.7\.0/);
  assert.match(gate, /node deploy\/build-ci-artifacts\.mjs/);
  assert.doesNotMatch(gate, /npm pack/);
});

test("CI artifact signing is ephemeral and production signing is local-only", async () => {
  const [testBuilder, releaseBuilder] = await Promise.all([
    repositoryFile("deploy/build-ci-artifacts.mjs"),
    repositoryFile("deploy/build-release-artifacts.sh")
  ]);
  assert.match(testBuilder, /generateKeyPairSync/);
  assert.match(testBuilder, /YURIRTC_BROWSER_E2E_BUILD:\s*"1"/);
  assert.match(testBuilder, /DO_NOT_PUBLISH\.txt/);
  assert.match(testBuilder, /carrier-bundled/);
  assert.match(testBuilder, /--bundled-loader/);
  assert.match(releaseBuilder, /GITHUB_ACTIONS/);
  assert.match(releaseBuilder, /YURIRTC_RELEASE_ARTIFACTS_OK/);
  assert.match(releaseBuilder, /build:release:bundled/);
  assert.match(releaseBuilder, /verify:bundled/);
});

test("npm release is staged, source-pinned, credential-scoped, and canaried", async () => {
  const release = await repositoryFile("deploy/release.sh");
  assert.doesNotMatch(release, /(?:^|\n)\s*(?:npm|npm_for_token[^\n]*)\s+publish\b/m);
  assert.match(release, /npm@\$NPM_STAGE_VERSION" stage publish/);
  assert.doesNotMatch(release, /stage list "\$name@\$version"/);
  assert.match(release, /stage_listing_has_version/);
  assert.match(release, /private_file "\$ENV_FILE"/);
  assert.match(release, /private_file "\$AUTH_CONFIG"/);
  assert.match(release, /git status --porcelain --untracked-files=normal/);
  assert.match(release, /git rev-parse origin\/main/);
  assert.match(release, /YURIRTC_CONTENT_NODE_CANARY_OK/);
  for (const asset of ["client.js", "sw.js", "sw-stub.js", "rot13.woff"]) {
    assert.match(release, new RegExp(`dist/(?:bundle|assets)/${asset.replace(".", "\\.")}`));
  }
  assert.match(release, /YURIRTC_CANARY_PROTOCOL=udp npm run test:prod-canary/);
  assert.match(release, /YURIRTC_CANARY_PROTOCOL=tcp npm run test:prod-canary/);
  assert.doesNotMatch(release, /learnmathedu/);
});
