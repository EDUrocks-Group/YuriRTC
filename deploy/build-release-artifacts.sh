#!/usr/bin/env bash
# Explicit local-only production artifact build. This is intentionally separate
# from CI so repository-controlled tests never receive the production key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "production release artifacts must be built by a local release operator, not GitHub Actions" >&2
  exit 1
fi
if [[ "${YURIRTC_RELEASE_ARTIFACTS_OK:-}" != "1" ]]; then
  echo "set YURIRTC_RELEASE_ARTIFACTS_OK=1 to confirm a production-signed local build" >&2
  exit 1
fi
if [[ -f "$ROOT/.env.release" ]]; then
  # shellcheck source=/dev/null
  source "$ROOT/.env.release"
fi

: "${YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY:?set the manifest signing private key in .env.release}"
: "${YURIRTC_FIREBASE_API_KEY:=${FIREBASE_API_KEY:-}}"
: "${YURIRTC_FIREBASE_PROJECT_ID:=${FIREBASE_PROJECT_ID:-}}"
: "${YURIRTC_FIREBASE_DATABASE_URL:=${FIREBASE_DATABASE_URL:-}}"
: "${YURIRTC_FIREBASE_API_KEY:?set YURIRTC_FIREBASE_API_KEY in .env.release}"
: "${YURIRTC_FIREBASE_PROJECT_ID:?set YURIRTC_FIREBASE_PROJECT_ID in .env.release}"
: "${YURIRTC_FIREBASE_DATABASE_URL:?set YURIRTC_FIREBASE_DATABASE_URL in .env.release}"

# Even if .env.release used `export`, keep the signing key and npm credentials
# out of every child except the specifically scoped integrity command.
export -n YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY \
  NPM_LOADER_TOKEN NPM_INTEGRITY_TOKEN 2>/dev/null || true
unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG

env -u YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY \
  -u NPM_LOADER_TOKEN -u NPM_INTEGRITY_TOKEN \
  -u NPM_TOKEN -u NODE_AUTH_TOKEN -u NPM_CONFIG_USERCONFIG \
  ./deploy/ci-local.sh

npm run build -w @advwebrec/grainloading
YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY="$YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY" \
  npm run build -w shaintloadingcheckpak
YURIRTC_FIREBASE_API_KEY="$YURIRTC_FIREBASE_API_KEY" \
YURIRTC_FIREBASE_PROJECT_ID="$YURIRTC_FIREBASE_PROJECT_ID" \
YURIRTC_FIREBASE_DATABASE_URL="$YURIRTC_FIREBASE_DATABASE_URL" \
  npm run build:release -w learnmathedu
YURIRTC_FIREBASE_API_KEY="$YURIRTC_FIREBASE_API_KEY" \
YURIRTC_FIREBASE_PROJECT_ID="$YURIRTC_FIREBASE_PROJECT_ID" \
YURIRTC_FIREBASE_DATABASE_URL="$YURIRTC_FIREBASE_DATABASE_URL" \
  npm run build:release:bundled -w learnmathedu

npm run verify:package -w @advwebrec/grainloading
npm run verify:package -w shaintloadingcheckpak
npm run verify:package -w learnmathedu
npm run verify:bundled -w learnmathedu

echo "production-signed local artifacts built and verified"
echo "loader: packages/loader/dist"
echo "signed pointer: packages/integrity/loader.json"
echo "carrier: deploy/npm/index.html and deploy/npm/sw.js"
echo "bundled carrier: deploy/npm/bundled/index.html, sw.js, client.js, LICENSE, FONT-LICENSE.txt, and SOURCE.txt"
