#!/usr/bin/env bash
# Self-hosted/local verification gate. It never reads release credentials,
# publishes packages, or writes the tracked/per-deployment carrier outputs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# A caller may have sourced .env.release before invoking this script. Strip
# every release credential before any repository-controlled build or test runs.
unset YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY
unset NPM_LOADER_TOKEN NPM_INTEGRITY_TOKEN NPM_TOKEN NODE_AUTH_TOKEN
# Never fall back to a runner/operator ~/.npmrc that may contain registry
# credentials. The verification graph only installs public dependencies.
export NPM_CONFIG_USERCONFIG=/dev/null

if [[ "${GITHUB_ACTIONS:-}" == "true" && -e "$ROOT/.env.release" ]]; then
  echo ".env.release must not be present in a GitHub Actions workspace" >&2
  exit 1
fi

# Exercise the same loader/worker bundle in Chromium, Firefox, and WebKit.
# Callers may narrow this comma-separated list for a quick diagnostic run.
export YURIRTC_BROWSER_E2E_ENGINES="${YURIRTC_BROWSER_E2E_ENGINES:-chromium,firefox,webkit}"

npm run build -w @advwebrec/grainloading
npm run typecheck
node --test deploy/test/ci-key-isolation.test.mjs
npm test
(
  cd content-node
  go test -count=1 ./...
  go test -race -count=1 ./...
  go vet ./...
  YURIRTC_BROWSER_E2E=1 go test -count=1 -run TestBrowserV3EndToEnd -v
)
(
  cd third_party/pion-sctp
  go test -count=1 ./...
  go test -race -count=1 ./...
  go vet ./...
)

npm run verify:package -w @advwebrec/grainloading
env -u NPM_CONFIG_USERCONFIG node deploy/build-ci-artifacts.mjs

echo "local CI passed; explicitly test-only artifacts are in build/ci/test-only"
