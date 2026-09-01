#!/usr/bin/env bash
# Verify and stage only the immutable loader and its signed pointer package.
# Each package requires a separate human 2FA approval before the next pass.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

private_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "$label must be a regular, non-symlink file: $path" >&2
    exit 1
  fi
  local owner mode mode_value
  owner="$(stat -c '%u' "$path")"
  mode="$(stat -c '%a' "$path")"
  mode_value=$((8#$mode))
  if [[ "$owner" != "$(id -u)" || $((mode_value & 022)) -ne 0 ]]; then
    echo "$label must be owned by the current user and not writable by group or others: $path" >&2
    exit 1
  fi
}

ENV_FILE="$ROOT/.env.release"
AUTH_CONFIG="$ROOT/deploy/npmrc.publish"
private_file "$ENV_FILE" ".env.release"
private_file "$AUTH_CONFIG" "npm publish configuration"

expected_npmrc=$'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}'
if [[ "$(<"$AUTH_CONFIG")" != "$expected_npmrc" ]]; then
  echo "deploy/npmrc.publish must contain only the pinned npm registry and NPM_TOKEN reference" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"
: "${NPM_LOADER_TOKEN:?save NPM_LOADER_TOKEN in .env.release}"
: "${NPM_INTEGRITY_TOKEN:?save NPM_INTEGRITY_TOKEN in .env.release}"
: "${YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY:?set the manifest signing private key}"

# Even if the env file exported its values, no repository-controlled test or
# loader build receives either publication credential or the signing key.
export -n NPM_LOADER_TOKEN NPM_INTEGRITY_TOKEN \
  YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY 2>/dev/null || true
unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG

if [[ "${YURIRTC_CONTENT_NODE_CANARY_OK:-}" != "1" ]]; then
  echo "refusing publication until the compatible production content node has passed its canary" >&2
  echo "set YURIRTC_CONTENT_NODE_CANARY_OK=1 only after that check succeeds" >&2
  exit 1
fi

# Public releases must be reconstructable from the exact source already pushed
# to the repository. Ignored build products and .env.release do not affect this
# check.
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "refusing release from a dirty or untracked source tree" >&2
  exit 1
fi
if ! git rev-parse --verify origin/main >/dev/null 2>&1 || \
   [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "refusing release until the exact source commit is pushed to origin/main" >&2
  exit 1
fi

env -u YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY \
  -u NPM_LOADER_TOKEN -u NPM_INTEGRITY_TOKEN \
  -u NPM_TOKEN -u NODE_AUTH_TOKEN -u NPM_CONFIG_USERCONFIG \
  ./deploy/ci-local.sh

LOADER_NAME="@advwebrec/grainloading"
POINTER_NAME="shaintloadingcheckpak"
LOADER_VERSION="$(node -p "require('./packages/loader/package.json').version")"
POINTER_VERSION="$(node -p "require('./packages/integrity/package.json').version")"
NPM_STAGE_VERSION="11.19.1"
VERIFY_DIRECTORY="$(mktemp -d)"
cleanup() {
  rm -rf -- "$VERIFY_DIRECTORY"
}
trap cleanup EXIT

npm_for_token() {
  local token="$1"
  shift
  NPM_TOKEN="$token" NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" npm "$@"
}

npm_stage_for_token() {
  local token="$1"
  shift
  NPM_TOKEN="$token" NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" \
    npx --yes "npm@$NPM_STAGE_VERSION" "$@"
}

npm_public() {
  # Registry visibility checks need no credential. Bypass an operator-level
  # ~/.npmrc so a stale registry override or unrelated token cannot influence
  # the release decision.
  NPM_CONFIG_USERCONFIG=/dev/null \
    NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    npm "$@"
}

loader_account="$(npm_for_token "$NPM_LOADER_TOKEN" whoami)"
pointer_account="$(npm_for_token "$NPM_INTEGRITY_TOKEN" whoami)"
echo "authenticated loader publisher as $loader_account"
echo "authenticated integrity publisher as $pointer_account"

version_exists() {
  npm_public view "$1@$2" version --json >/dev/null 2>&1
}

require_live_latest() {
  local name="$1"
  local version="$2"
  local latest
  latest="$(npm_public view "$name" dist-tags.latest)"
  if [[ "$latest" != "$version" ]]; then
    echo "$name@$version exists but latest is $latest; refusing to retag automatically" >&2
    exit 1
  fi
}

stage_listing_has_version() {
  local expected_version="$1"
  node -e '
    const expected = process.argv[1];
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const containsVersion = (entry) => {
        if (entry === expected) return true;
        if (typeof entry === "string" && entry.endsWith(`@${expected}`)) return true;
        if (Array.isArray(entry)) return entry.some(containsVersion);
        if (entry && typeof entry === "object") {
          return Object.values(entry).some(containsVersion);
        }
        return false;
      };
      process.exit(containsVersion(value) ? 0 : 1);
    });
  ' "$expected_version"
}

stage_and_pause() {
  local directory="$1"
  local name="$2"
  local version="$3"
  local token="$4"
  local sign_pointer="$5"
  local listing

  listing="$(npm_stage_for_token "$token" stage list "$name" --json)"
  if ! stage_listing_has_version "$version" <<<"$listing"; then
    echo "staging $name@$version for required human 2FA approval"
    if [[ "$sign_pointer" == "1" ]]; then
      (
        cd "$directory"
        YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY="$YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY" \
          NPM_TOKEN="$token" NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" \
          npx --yes "npm@$NPM_STAGE_VERSION" stage publish . --access public
      )
    else
      (
        cd "$directory"
        NPM_TOKEN="$token" NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" \
          npx --yes "npm@$NPM_STAGE_VERSION" stage publish . --access public
      )
    fi
    listing="$(npm_stage_for_token "$token" stage list "$name" --json)"
    if ! stage_listing_has_version "$version" <<<"$listing"; then
      echo "npm accepted the stage command but did not list $name@$version" >&2
      exit 1
    fi
  fi

  echo "pending staged package:"
  printf '%s\n' "$listing"
  echo "approve $name@$version with 2FA in the npm website Staged Packages tab, then rerun this command"
  exit 20
}

CURL_ARGS=(
  --fail --location --silent --show-error
  --connect-timeout 5 --max-time 30
  --retry 3 --retry-delay 1 --retry-all-errors
)

wait_for_tarball() {
  local name="$1"
  local version="$2"
  local output="$3"
  local url attempt
  for ((attempt = 1; attempt <= 60; attempt += 1)); do
    url="$(npm_public view "$name@$version" dist.tarball 2>/dev/null || true)"
    if [[ "$url" == https://* ]] && \
       curl "${CURL_ARGS[@]}" --output "$output" "$url" && \
       tar -tzf "$output" >/dev/null; then
      return
    fi
    if ((attempt < 60)); then sleep 5; fi
  done
  echo "timed out waiting for $name@$version tarball" >&2
  exit 1
}

verify_tarball_exact() {
  local archive="$1"
  local local_directory="$2"
  shift 2
  local -a expected actual
  local relative
  mapfile -t expected < <(printf 'package/%s\n' "$@" | LC_ALL=C sort)
  mapfile -t actual < <(tar -tzf "$archive" | LC_ALL=C sort)
  if [[ "${actual[*]}" != "${expected[*]}" ]]; then
    echo "published tarball has an unexpected file list" >&2
    printf 'expected: %s\n' "${expected[*]}" >&2
    printf 'actual:   %s\n' "${actual[*]}" >&2
    exit 1
  fi
  for relative in "$@"; do
    if ! tar -xOzf "$archive" "package/$relative" | \
         cmp -s "$local_directory/$relative" -; then
      echo "published bytes differ from $local_directory/$relative" >&2
      exit 1
    fi
  done
}

wait_for_exact_cdn_asset() {
  local url="$1"
  local expected_file="$2"
  local kind="$3"
  local downloaded="$VERIFY_DIRECTORY/cdn-${RANDOM}"
  local metadata content_type cors attempt
  for ((attempt = 1; attempt <= 72; attempt += 1)); do
    metadata="$(curl "${CURL_ARGS[@]}" \
      --output "$downloaded" \
      --write-out $'%{content_type}\n%header{access-control-allow-origin}' \
      "$url" 2>/dev/null || true)"
    content_type="${metadata%%$'\n'*}"
    cors="${metadata#*$'\n'}"
    if cmp -s "$expected_file" "$downloaded" && [[ "$cors" == "*" ]]; then
      case "$kind" in
        javascript)
          [[ "$content_type" =~ ^(application|text)/(javascript|x-javascript)($|\;) ]] && return
          ;;
        font)
          [[ "$content_type" =~ ^(font/woff|application/(font-woff|octet-stream))($|\;) ]] && return
          ;;
        json)
          [[ "$content_type" =~ ^application/json($|\;) ]] && return
          ;;
      esac
    fi
    if ((attempt < 72)); then sleep 5; fi
  done
  echo "$url did not serve the exact verified bytes with the required MIME and CORS headers" >&2
  exit 1
}

if ! version_exists "$LOADER_NAME" "$LOADER_VERSION"; then
  stage_and_pause packages/loader "$LOADER_NAME" "$LOADER_VERSION" "$NPM_LOADER_TOKEN" 0
fi
require_live_latest "$LOADER_NAME" "$LOADER_VERSION"

loader_tarball="$VERIFY_DIRECTORY/loader-$LOADER_VERSION.tgz"
wait_for_tarball "$LOADER_NAME" "$LOADER_VERSION" "$loader_tarball"
verify_tarball_exact "$loader_tarball" packages/loader \
  DISCLOSURE LICENSE README.md package.json \
  dist/bundle/client.js dist/bundle/sw.js dist/bundle/sw-stub.js \
  dist/types/index.d.ts dist/assets/rot13.woff dist/assets/OFL.txt

for base in \
  "https://cdn.jsdelivr.net/npm/$LOADER_NAME@$LOADER_VERSION" \
  "https://unpkg.com/$LOADER_NAME@$LOADER_VERSION"; do
  wait_for_exact_cdn_asset "$base/dist/bundle/client.js" packages/loader/dist/bundle/client.js javascript
  wait_for_exact_cdn_asset "$base/dist/bundle/sw.js" packages/loader/dist/bundle/sw.js javascript
  wait_for_exact_cdn_asset "$base/dist/bundle/sw-stub.js" packages/loader/dist/bundle/sw-stub.js javascript
  wait_for_exact_cdn_asset "$base/dist/assets/rot13.woff" packages/loader/dist/assets/rot13.woff font
done
echo "verified live loader $LOADER_NAME@$LOADER_VERSION on npm, jsDelivr, and unpkg"

if ! version_exists "$POINTER_NAME" "$POINTER_VERSION"; then
  pointer_listing="$(npm_stage_for_token "$NPM_INTEGRITY_TOKEN" stage list "$POINTER_NAME" --json)"
  if ! stage_listing_has_version "$POINTER_VERSION" <<<"$pointer_listing"; then
    # Sign only after every immutable loader runtime asset is live on both CDNs.
    YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY="$YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY" \
      npm run build -w "$POINTER_NAME"
    npm run verify:package -w "$POINTER_NAME"
  fi
  stage_and_pause packages/integrity "$POINTER_NAME" "$POINTER_VERSION" "$NPM_INTEGRITY_TOKEN" 1
fi
require_live_latest "$POINTER_NAME" "$POINTER_VERSION"

pointer_tarball="$VERIFY_DIRECTORY/$POINTER_NAME-$POINTER_VERSION.tgz"
wait_for_tarball "$POINTER_NAME" "$POINTER_VERSION" "$pointer_tarball"

# The ECDSA signature is intentionally fresh on each signing build. Compare the
# immutable metadata and license bytes exactly, then validate the published
# manifest cryptographically and use it as the CDN byte authority.
for relative in DISCLOSURE LICENSE package.json; do
  if ! tar -xOzf "$pointer_tarball" "package/$relative" | \
       cmp -s "packages/integrity/$relative" -; then
    echo "published bytes differ from packages/integrity/$relative" >&2
    exit 1
  fi
done
mapfile -t pointer_paths < <(tar -tzf "$pointer_tarball" | LC_ALL=C sort)
expected_pointer_paths=(
  package/DISCLOSURE package/LICENSE package/loader.json package/package.json
)
if [[ "${pointer_paths[*]}" != "${expected_pointer_paths[*]}" ]]; then
  echo "published pointer tarball has an unexpected file list" >&2
  exit 1
fi
tar -xOzf "$pointer_tarball" package/loader.json >"$VERIFY_DIRECTORY/published-loader.json"
node packages/integrity/verify-package.mjs \
  --manifest-only "$VERIFY_DIRECTORY/published-loader.json"

curl "${CURL_ARGS[@]}" \
  "https://purge.jsdelivr.net/npm/$POINTER_NAME@latest/loader.json" >/dev/null || true
for url in \
  "https://cdn.jsdelivr.net/npm/$POINTER_NAME@latest/loader.json" \
  "https://unpkg.com/$POINTER_NAME@latest/loader.json"; do
  wait_for_exact_cdn_asset "$url" "$VERIFY_DIRECTORY/published-loader.json" json
done

# The public carrier now resolves the new pointer. Exercise default routing and
# both forced transport paths against the production content node.
npm run test:prod-canary
YURIRTC_CANARY_PROTOCOL=udp npm run test:prod-canary
YURIRTC_CANARY_PROTOCOL=tcp npm run test:prod-canary

echo "published and verified $LOADER_NAME@$LOADER_VERSION"
echo "published and verified $POINTER_NAME@$POINTER_VERSION"
echo "production default, UDP, and TCP canaries passed"
