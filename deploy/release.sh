#!/usr/bin/env bash
# Build, verify, and publish both compatibility NPM packages.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Local, git-ignored production configuration. Explicit environment variables
# still win because the file only exports values via its own assignments and
# the defaults below never overwrite a value that is already set.
if [[ -f "$ROOT/.env.release" && -z "${YURIRTC_FIREBASE_API_KEY:-}" ]]; then
  # shellcheck source=/dev/null
  source "$ROOT/.env.release"
fi

: "${YURIRTC_FIREBASE_API_KEY:=${FIREBASE_API_KEY:-}}"
: "${YURIRTC_FIREBASE_PROJECT_ID:=${FIREBASE_PROJECT_ID:-}}"
: "${YURIRTC_FIREBASE_DATABASE_URL:=${FIREBASE_DATABASE_URL:-}}"
export YURIRTC_FIREBASE_API_KEY YURIRTC_FIREBASE_PROJECT_ID YURIRTC_FIREBASE_DATABASE_URL

if [[ -z "$YURIRTC_FIREBASE_API_KEY" || -z "$YURIRTC_FIREBASE_PROJECT_ID" || -z "$YURIRTC_FIREBASE_DATABASE_URL" ]]; then
  echo "set the three YURIRTC_FIREBASE_* release variables" >&2
  exit 1
fi

npm run typecheck
npm test
(
  cd content-node
  go test -count=1 ./...
  go test -race -count=1 ./...
  go vet ./...
  YURIRTC_BROWSER_E2E=1 go test -count=1 -run TestBrowserV3EndToEnd -v
)
npm run build:release
npm run verify:release

if [[ "${YURIRTC_CONTENT_NODE_CANARY_OK:-}" != "1" ]]; then
  echo "refusing npm publication until a production node compatible with this loader is deployed and canaried" >&2
  echo "set YURIRTC_CONTENT_NODE_CANARY_OK=1 only after matching-wire checks pass; use a transition node before a future wire change" >&2
  exit 1
fi

LOADER_VERSION="$(node -p "require('./packages/loader/package.json').version")"
STATIC_VERSION="$(node -p "require('./deploy/npm/package.json').version")"

# npm versions are immutable. If a prior run published a package and then
# stopped while CDN caches converged, resume only when that exact version still
# owns `latest`; otherwise require an operator to resolve the tag deliberately.
publish_or_resume_latest() {
  local workspace="$1"
  local package_name="$2"
  local package_version="$3"
  local versions_json
  local latest_version

  versions_json="$(npm view "$package_name" versions --json)"
  if node -e '
    const published = JSON.parse(process.argv[1]);
    const versions = Array.isArray(published) ? published : [published];
    process.exit(versions.includes(process.argv[2]) ? 0 : 1);
  ' "$versions_json" "$package_version"; then
    latest_version="$(npm view "$package_name" dist-tags.latest)"
    if [[ "$latest_version" != "$package_version" ]]; then
      echo "$package_name@$package_version already exists but latest is $latest_version; refusing to retag automatically" >&2
      exit 1
    fi
    echo "resuming verified release of $package_name@$package_version"
    return
  fi

  npm publish -w "$workspace" --access public
}

publish_or_resume_latest \
  @edurocks-group/loader \
  @edurocks-group/loader \
  "$LOADER_VERSION"

verification_dir="$(mktemp -d)"
verification_index=0
cleanup_verification_dir() {
  rm -rf -- "$verification_dir"
}
trap cleanup_verification_dir EXIT

CURL_RELEASE_ARGS=(
  --fail
  --location
  --max-redirs 5
  --silent
  --show-error
  --connect-timeout 5
  --max-time 20
  --retry 2
  --retry-delay 1
  --retry-max-time 20
  --retry-all-errors
)

# npm metadata and tarballs can become visible at different times after a
# successful publish. Resolve the immutable version and prove that its tarball
# can be downloaded before asking either CDN to converge on it.
NPM_VISIBILITY_ATTEMPTS=60
NPM_VISIBILITY_INTERVAL_SECONDS=5
CDN_READY_ATTEMPTS=72
CDN_READY_INTERVAL_SECONDS=5

wait_for_npm_tarball() {
  local package_name="$1"
  local package_version="$2"
  local destination="$3"
  local tarball_url
  local attempt

  for ((attempt = 1; attempt <= NPM_VISIBILITY_ATTEMPTS; attempt++)); do
    tarball_url="$(npm view "$package_name@$package_version" dist.tarball 2>/dev/null || true)"
    if [[ "$tarball_url" == https://* ]] && \
       curl "${CURL_RELEASE_ARGS[@]}" --output "$destination" "$tarball_url" && \
       tar -tzf "$destination" >/dev/null 2>&1; then
      return
    fi
    if ((attempt < NPM_VISIBILITY_ATTEMPTS)); then
      sleep "$NPM_VISIBILITY_INTERVAL_SECONDS"
    fi
  done

  echo "npm did not make $package_name@$package_version and its exact tarball visible in time" >&2
  exit 1
}

verify_loader_tarball() {
  local archive="$1"
  local package_path
  local local_path
  local index
  local -a expected_paths=(
    package/README.md
    package/dist/assets/OFL.txt
    package/dist/assets/rot13.woff
    package/dist/bundle/client.js
    package/dist/bundle/sw-stub.js
    package/dist/bundle/sw.js
    package/dist/types/index.d.ts
    package/package.json
  )
  local -a actual_paths

  mapfile -t actual_paths < <(tar -tzf "$archive" | LC_ALL=C sort)
  if (( ${#actual_paths[@]} != ${#expected_paths[@]} )); then
    echo "published loader tarball has an unexpected file count" >&2
    exit 1
  fi
  for ((index = 0; index < ${#expected_paths[@]}; index++)); do
    if [[ "${actual_paths[index]}" != "${expected_paths[index]}" ]]; then
      echo "published loader tarball has an unexpected file list" >&2
      exit 1
    fi
  done

  for package_path in "${expected_paths[@]}"; do
    local_path="${package_path#package/}"
    if ! tar -xOzf "$archive" "$package_path" | \
         cmp -s "packages/loader/$local_path" -; then
      echo "published loader tarball differs from the verified local file: $local_path" >&2
      exit 1
    fi
  done
}

loader_tarball="$verification_dir/loader-$LOADER_VERSION.tgz"
wait_for_npm_tarball \
  @edurocks-group/loader \
  "$LOADER_VERSION" \
  "$loader_tarball"
verify_loader_tarball "$loader_tarball"

# The carrier fetches latest/package.json to resolve an immutable worker URL,
# while its client and font remain on @latest. Purge every moving jsDelivr path
# together so a v3 client can never be paired with a stale v2 worker decision.
for asset in \
  package.json \
  dist/bundle/client.js \
  dist/bundle/sw.js \
  dist/assets/rot13.woff; do
  curl "${CURL_RELEASE_ARGS[@]}" \
    "https://purge.jsdelivr.net/npm/@edurocks-group/loader@latest/$asset" \
    >/dev/null
done

cdn_package_version() {
  local downloaded
  local metadata
  local content_type
  local cors
  downloaded="$(mktemp "$verification_dir/package.XXXXXX")"
  metadata="$(curl "${CURL_RELEASE_ARGS[@]}" \
    --output "$downloaded" \
    --write-out $'%{content_type}\n%header{access-control-allow-origin}' \
    "$1")" || return 1
  content_type="${metadata%%$'\n'*}"
  cors="${metadata#*$'\n'}"
  [[ "$content_type" =~ ^application/json($|\;) ]] || return 1
  [[ "$cors" == "*" ]] || return 1
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const version = JSON.parse(input).version;
      if (typeof version !== "string" || version.length === 0) process.exit(1);
      process.stdout.write(version);
    });
  ' <"$downloaded"
}

latest_ready=0
for ((attempt = 1; attempt <= CDN_READY_ATTEMPTS; attempt++)); do
  jsdelivr_version="$(cdn_package_version \
    "https://cdn.jsdelivr.net/npm/@edurocks-group/loader@latest/package.json" || true)"
  unpkg_version="$(cdn_package_version \
    "https://unpkg.com/@edurocks-group/loader@latest/package.json" || true)"
  if [[ "$jsdelivr_version" == "$LOADER_VERSION" && "$unpkg_version" == "$LOADER_VERSION" ]]; then
    latest_ready=1
    break
  fi
  if ((attempt < CDN_READY_ATTEMPTS)); then
    sleep "$CDN_READY_INTERVAL_SECONDS"
  fi
done
if [[ "$latest_ready" != "1" ]]; then
  echo "both CDNs did not resolve @latest to loader $LOADER_VERSION" >&2
  exit 1
fi

verify_cdn_asset_once() {
  local url="$1"
  local expected_file="$2"
  local expected_kind="$3"
  local downloaded="$verification_dir/asset-$verification_index"
  local metadata
  local content_type
  local cors
  verification_index=$((verification_index + 1))

  metadata="$(curl "${CURL_RELEASE_ARGS[@]}" \
    --output "$downloaded" \
    --write-out $'%{content_type}\n%header{access-control-allow-origin}' \
    "$url")"
  content_type="${metadata%%$'\n'*}"
  cors="${metadata#*$'\n'}"

  if ! cmp -s "$expected_file" "$downloaded"; then
    return 1
  fi
  case "$expected_kind" in
    javascript)
      if [[ ! "$content_type" =~ ^(application|text)/(javascript|x-javascript)($|\;) ]]; then
        return 1
      fi
      ;;
    font)
      if [[ ! "$content_type" =~ ^(font/woff|application/(font-woff|octet-stream))($|\;) ]]; then
        return 1
      fi
      ;;
    *)
      echo "unknown CDN asset kind $expected_kind" >&2
      exit 1
      ;;
  esac
  if [[ "$cors" != "*" ]]; then
    return 1
  fi
}

verify_all_cdn_assets_once() {
  local base
  for base in \
    "https://cdn.jsdelivr.net/npm/@edurocks-group/loader" \
    "https://unpkg.com/@edurocks-group/loader"; do
    verify_cdn_asset_once \
      "$base@latest/dist/bundle/client.js" \
      packages/loader/dist/bundle/client.js \
      javascript || return 1
    verify_cdn_asset_once \
      "$base@latest/dist/bundle/sw.js" \
      packages/loader/dist/bundle/sw.js \
      javascript || return 1
    verify_cdn_asset_once \
      "$base@$LOADER_VERSION/dist/bundle/sw.js" \
      packages/loader/dist/bundle/sw.js \
      javascript || return 1
    verify_cdn_asset_once \
      "$base@latest/dist/assets/rot13.woff" \
      packages/loader/dist/assets/rot13.woff \
      font || return 1
  done
}

assets_ready=0
for ((attempt = 1; attempt <= CDN_READY_ATTEMPTS; attempt++)); do
  if verify_all_cdn_assets_once; then
    assets_ready=1
    break
  fi
  if ((attempt < CDN_READY_ATTEMPTS)); then
    sleep "$CDN_READY_INTERVAL_SECONDS"
  fi
done
if [[ "$assets_ready" != "1" ]]; then
  echo "both CDNs did not serve all exact release bytes with valid MIME and CORS in time" >&2
  exit 1
fi

publish_or_resume_latest learnmathedu learnmathedu "$STATIC_VERSION"

static_tarball="$verification_dir/learnmathedu-$STATIC_VERSION.tgz"
static_extract="$verification_dir/learnmathedu-$STATIC_VERSION"
mkdir "$static_extract"
wait_for_npm_tarball learnmathedu "$STATIC_VERSION" "$static_tarball"
tar -xzf "$static_tarball" -C "$static_extract" package/index.html package/sw.js
if ! cmp -s deploy/npm/index.html "$static_extract/package/index.html" || \
   ! cmp -s deploy/npm/sw.js "$static_extract/package/sw.js"; then
  echo "published learnmathedu@$STATIC_VERSION does not match the verified local carrier" >&2
  exit 1
fi

echo "published @edurocks-group/loader@$LOADER_VERSION and learnmathedu@$STATIC_VERSION"
echo "both CDNs resolve @latest to loader $LOADER_VERSION and serve its client, worker, and font"
