#!/usr/bin/env bash
# Creates object-storage buckets that already serve the static carrier.
#
# The carrier is two files that must sit in one directory, and a deployment is
# nothing more than a URL that serves them. Standing up a fresh one is
# therefore a routine act rather than a migration, which is what this exists
# for: create the bucket, upload both files with the exact metadata the browser
# needs, then prove the result actually serves before reporting it.
#
# Buckets are addressed through rclone, so any provider rclone speaks -- S3,
# R2, B2, GCS -- works through one code path and one credential store.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$ROOT/deploy/npm"

usage() {
    cat >&2 <<'USAGE'
usage: deploy/bucket/new-bucket.sh --remote NAME [options]

Creates a bucket, uploads index.html and sw.js into it, and verifies that the
result is publicly readable.

  --remote NAME       rclone remote holding the credentials (or $YURIRTC_BUCKET_REMOTE)
  --name NAME         bucket name; generated from --name-prefix when omitted
  --name-prefix TEXT  prefix for generated names (default: yurirtc)
  --prefix PATH       directory inside the bucket; the two files share it
  --count N           create N buckets in one run, each with a generated name
  --public-base URL   base URL the files will be served from, when it cannot
                      be derived (R2 custom domains, B2, a CDN in front)
  --no-build          upload the artifacts already in deploy/npm as they are
  --keep-private      skip the public-read request and the reachability check
  --dry-run           print what would happen, touch nothing
  -h, --help          this text

A release build needs the three YURIRTC_FIREBASE_* values. They are read from
.env.release at the repository root when present, or taken from the
environment.
USAGE
}

REMOTE="${YURIRTC_BUCKET_REMOTE:-}"
BUCKET_NAME=""
NAME_PREFIX="yurirtc"
OBJECT_PREFIX=""
COUNT=1
PUBLIC_BASE=""
BUILD=1
PUBLIC=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --remote) REMOTE="${2:?--remote needs a value}"; shift 2 ;;
        --name) BUCKET_NAME="${2:?--name needs a value}"; shift 2 ;;
        --name-prefix) NAME_PREFIX="${2:?--name-prefix needs a value}"; shift 2 ;;
        --prefix) OBJECT_PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
        --count) COUNT="${2:?--count needs a value}"; shift 2 ;;
        --public-base) PUBLIC_BASE="${2:?--public-base needs a value}"; shift 2 ;;
        --no-build) BUILD=0; shift ;;
        --keep-private) PUBLIC=0; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
    esac
done

if [[ -z "$REMOTE" ]]; then
    echo "no rclone remote given; pass --remote or set YURIRTC_BUCKET_REMOTE" >&2
    echo "configured remotes:" >&2
    rclone listremotes >&2 || true
    exit 2
fi
REMOTE="${REMOTE%:}"

if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || (( COUNT < 1 )); then
    echo "--count must be a positive whole number" >&2
    exit 2
fi

command -v rclone >/dev/null || { echo "rclone is not installed" >&2; exit 1; }
if ! rclone listremotes | grep -qx "$REMOTE:"; then
    echo "rclone has no remote named $REMOTE; configure it with 'rclone config'" >&2
    exit 1
fi

# A trailing slash in the object prefix would create an empty directory segment
# and put the worker one level below the page, which silently narrows its scope.
OBJECT_PREFIX="${OBJECT_PREFIX#/}"
OBJECT_PREFIX="${OBJECT_PREFIX%/}"

REMOTE_TYPE="$(rclone config show "$REMOTE" | sed -n 's/^type *= *//p' | head -1)"
REMOTE_REGION="$(rclone config show "$REMOTE" | sed -n 's/^region *= *//p' | head -1)"
REMOTE_PROVIDER="$(rclone config show "$REMOTE" | sed -n 's/^provider *= *//p' | head -1)"

# The carrier is only deployable when it was built from real browser
# configuration: a placeholder build looks identical but cannot connect, and a
# bucket is exactly where nobody would notice until users did.
if (( BUILD )); then
    if [[ -z "${YURIRTC_FIREBASE_API_KEY:-}${FIREBASE_API_KEY:-}" && -f "$ROOT/.env.release" ]]; then
        # shellcheck source=/dev/null
        source "$ROOT/.env.release"
    fi
    echo "building the carrier from the current source"
    (cd "$ROOT" && npm run build:release >/dev/null)
fi

for name in index.html sw.js; do
    [[ -f "$SOURCE/$name" ]] || {
        echo "missing $SOURCE/$name; run without --no-build, or build the carrier first" >&2
        exit 1
    }
done

# Checks the fingerprints rather than the file dates, so a stale artifact left
# behind by an earlier build cannot be uploaded as if it were this one.
(cd "$ROOT" && node deploy/npm/verify-package.mjs --artifact-dir deploy/npm --artifacts-only >/dev/null)
echo "carrier artifacts verified"

generate_name() {
    # Object-storage names are a shared global namespace, so a generated name
    # has to be unlikely to collide as well as legal: lowercase, digits and
    # hyphens only.
    local suffix
    suffix="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-8)"
    printf '%s-%s-%s' "${NAME_PREFIX}" "$(date -u +%Y%m%d)" "$suffix"
}

validate_name() {
    local name="$1"
    if [[ ! "$name" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
        echo "bucket name $name is not valid: use 3-63 lowercase letters, digits, dots or hyphens" >&2
        return 1
    fi
}

public_url_for() {
    local bucket="$1" path="$2"
    if [[ -n "$PUBLIC_BASE" ]]; then
        printf '%s/%s' "${PUBLIC_BASE%/}" "$path"
        return
    fi
    # Only the shapes that can be derived with certainty. Anything else -- a
    # custom domain, a CDN, a provider with its own URL scheme -- needs
    # --public-base, because guessing it would produce a link that looks
    # checked and is not.
    if [[ "$REMOTE_TYPE" == "s3" && ( -z "$REMOTE_PROVIDER" || "$REMOTE_PROVIDER" == "AWS" ) ]]; then
        if [[ -n "$REMOTE_REGION" && "$REMOTE_REGION" != "us-east-1" ]]; then
            printf 'https://s3.%s.amazonaws.com/%s/%s' "$REMOTE_REGION" "$bucket" "$path"
        else
            printf 'https://s3.amazonaws.com/%s/%s' "$bucket" "$path"
        fi
        return
    fi
    printf ''
}

upload_one() {
    local file="$1" destination="$2" content_type="$3"
    local -a flags=(
        --header-upload "Content-Type: $content_type"
        # Both files must be revalidated on every visit: the page carries the
        # loader's version and the worker is the update mechanism itself, so a
        # cached copy of either pins a deployment to the release it shipped on.
        --header-upload "Cache-Control: no-cache, max-age=0, must-revalidate"
    )
    if (( PUBLIC )) && [[ "$REMOTE_TYPE" == "s3" ]]; then
        flags+=(--s3-acl public-read)
    fi
    rclone copyto "$file" "$destination" "${flags[@]}"
}

created=()
failed=0

for (( index = 0; index < COUNT; index++ )); do
    if [[ -n "$BUCKET_NAME" ]]; then
        (( COUNT == 1 )) || { echo "--name cannot be combined with --count above 1" >&2; exit 2; }
        bucket="$BUCKET_NAME"
    else
        bucket="$(generate_name)"
    fi
    validate_name "$bucket"

    path_prefix=""
    [[ -n "$OBJECT_PREFIX" ]] && path_prefix="$OBJECT_PREFIX/"

    if (( DRY_RUN )); then
        echo "would create $REMOTE:$bucket and upload ${path_prefix}index.html and ${path_prefix}sw.js"
        continue
    fi

    # Never adopt a bucket that already exists: it may belong to something
    # else, and overwriting its objects would be someone else's outage.
    if rclone lsf "$REMOTE:" --dirs-only 2>/dev/null | grep -qx "$bucket/"; then
        echo "bucket $bucket already exists on $REMOTE; refusing to reuse it" >&2
        failed=1
        continue
    fi

    echo "creating $REMOTE:$bucket"
    # One attempt, and the provider's own words captured rather than printed:
    # a permission problem is the same on every retry, and three copies of it
    # buries the one line that says what to grant.
    if ! create_error="$(rclone mkdir "$REMOTE:$bucket" --retries 1 2>&1)"; then
        if [[ "$create_error" == *AccessDenied* || "$create_error" == *Forbidden* ]]; then
            cat >&2 <<PERMISSION
  $REMOTE cannot create buckets: the credentials it holds are allowed to
  manage objects but not to make a bucket to put them in.

  Grant the identity behind this remote s3:CreateBucket, and -- so the result
  can be served -- s3:PutBucketPolicy and s3:PutBucketPublicAccessBlock. Or
  point --remote at a provider where these credentials already have them.

  To fill a bucket that already exists instead, use:
    deploy/bucket/upload.sh s3://$bucket
PERMISSION
        else
            printf '  %s\n' "$create_error" >&2
        fi
        echo "could not create $bucket" >&2
        failed=1
        continue
    fi

    upload_one "$SOURCE/index.html" "$REMOTE:$bucket/${path_prefix}index.html" "text/html; charset=utf-8"
    upload_one "$SOURCE/sw.js" "$REMOTE:$bucket/${path_prefix}sw.js" "text/javascript; charset=utf-8"

    url="$(public_url_for "$bucket" "${path_prefix}index.html")"
    worker_url="$(public_url_for "$bucket" "${path_prefix}sw.js")"

    if (( ! PUBLIC )); then
        echo "uploaded to $REMOTE:$bucket/${path_prefix} (left private)"
        created+=("$REMOTE:$bucket/${path_prefix}")
        continue
    fi

    if [[ -z "$url" ]]; then
        echo "uploaded to $REMOTE:$bucket/${path_prefix}"
        echo "  pass --public-base to have the served URL checked for this provider"
        created+=("$REMOTE:$bucket/${path_prefix}")
        continue
    fi

    # A bucket that was created and filled but is not readable looks like a
    # success and serves nobody, so the URL is fetched rather than assumed.
    ok=1
    for check in "$url:text/html" "$worker_url:javascript"; do
        target="${check%:*}"
        want="${check##*:}"
        read -r status type < <(
            curl -sS -o /dev/null -L --max-time 20 \
                -w '%{http_code} %{content_type}\n' "$target" 2>/dev/null || echo "000 -"
        )
        if [[ "$status" != "200" || "$type" != *"$want"* ]]; then
            echo "  $target answered $status with content-type ${type:-none}" >&2
            ok=0
        fi
    done

    if (( ok )); then
        echo "serving: $url"
        created+=("$url")
    else
        failed=1
        cat >&2 <<REMEDY
  the objects are uploaded but not publicly readable. Most providers block
  public access on a new bucket until it is granted explicitly:

    AWS S3   turn off Block Public Access for $bucket, then attach a policy
             allowing s3:GetObject on arn:aws:s3:::$bucket/*
    R2       attach a custom domain or enable the r2.dev URL, then re-run
             with --public-base
    B2       set the bucket to public

  the upload itself does not need repeating; re-run the check with:
    curl -I $url
REMEDY
        created+=("$REMOTE:$bucket/${path_prefix} (not public)")
    fi
done

if (( DRY_RUN )); then
    exit 0
fi

if (( ${#created[@]} == 0 )); then
    echo "no deployment was created" >&2
    exit "$failed"
fi

echo
echo "created ${#created[@]} deployment(s):"
for entry in "${created[@]}"; do
    echo "  $entry"
done

# The worker's scope is the directory it is served from, so the pair only works
# where it was placed together. Linking the directory instead of the page is
# the other common way to end up with an object listing rather than the site.
echo
echo "link people to the exact index.html URL, not the directory."

exit "$failed"
