# Static bucket upload

Export either the preferred `YURIRTC_FIREBASE_*` release variables or the
compatible `FIREBASE_*` aliases, then upload with:

```bash
deploy/bucket/upload.sh gs://bucket/optional-prefix
deploy/bucket/upload.sh s3://bucket/optional-prefix
```

The uploader runs a fresh release build and verifies both npm package payloads
before it transfers either file. It fails without complete Firebase release
configuration, so stale placeholder or test artifacts cannot be uploaded.

The same bytes work at an origin root, a bucket path, or any nested prefix.
See `docs/DEPLOYMENT.md` for Firebase configuration and hosting details.
