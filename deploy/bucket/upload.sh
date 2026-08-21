#!/usr/bin/env bash
# Upload YuriRTC's two static carrier files to a GCS or S3 prefix.
set -euo pipefail

TARGET="${1:?usage: deploy/bucket/upload.sh gs://bucket/prefix | s3://bucket/prefix}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SOURCE="$ROOT/deploy/npm"
TARGET="${TARGET%/}"

# Always replace any placeholder, test, or stale carrier before uploading.
# The release builder accepts the preferred YURIRTC_FIREBASE_* variables and
# the legacy FIREBASE_* aliases, and fails closed when required values are
# absent.
cd "$ROOT"
npm run build:release
npm run verify:release

for name in index.html sw.js; do
  if [[ ! -f "$SOURCE/$name" ]]; then
    echo "release build did not produce $SOURCE/$name" >&2
    exit 1
  fi
done

case "$TARGET" in
  gs://*)
    gsutil \
      -h "Content-Type:text/html; charset=utf-8" \
      -h "Cache-Control:no-cache, max-age=0, must-revalidate" \
      cp "$SOURCE/index.html" "$TARGET/index.html"
    gsutil \
      -h "Content-Type:text/javascript; charset=utf-8" \
      -h "Cache-Control:no-cache, max-age=0, must-revalidate" \
      cp "$SOURCE/sw.js" "$TARGET/sw.js"
    ;;
  s3://*)
    aws s3 cp "$SOURCE/index.html" "$TARGET/index.html" \
      --content-type "text/html; charset=utf-8" \
      --cache-control "no-cache, max-age=0, must-revalidate"
    aws s3 cp "$SOURCE/sw.js" "$TARGET/sw.js" \
      --content-type "text/javascript; charset=utf-8" \
      --cache-control "no-cache, max-age=0, must-revalidate"
    ;;
  *)
    echo "unsupported target: expected gs:// or s3://" >&2
    exit 1
    ;;
esac

echo "uploaded index.html and sw.js to $TARGET/"
