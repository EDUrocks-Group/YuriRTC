# Static bucket deployment

A deployment of the carrier is nothing more than a URL that serves two files,
`index.html` and `sw.js`, from one directory. Standing up another one is
routine, so there are two scripts: one fills a bucket that already exists, and
one makes the bucket too.

Both run a fresh release build and verify the artifacts before transferring
anything, so a placeholder or stale build cannot reach a bucket. A release
build needs the three `YURIRTC_FIREBASE_*` values; `new-bucket.sh` also reads
them from a `.env.release` file at the repository root when present.

## Filling a bucket that exists

```bash
deploy/bucket/upload.sh gs://bucket/optional-prefix
deploy/bucket/upload.sh s3://bucket/optional-prefix
```

Uses `gsutil` or the AWS CLI, whichever the target scheme implies.

## Creating a bucket that already serves the carrier

```bash
deploy/bucket/new-bucket.sh --remote NAME [options]
```

Buckets are addressed through [rclone](https://rclone.org), so any provider it
speaks — S3, R2, B2, GCS — works through one code path and one credential
store. Configure a remote once with `rclone config`, then:

```bash
# one bucket, name generated
deploy/bucket/new-bucket.sh --remote my-s3

# several at once, each with its own generated name
deploy/bucket/new-bucket.sh --remote my-s3 --count 3

# a chosen name, the pair in a subdirectory
deploy/bucket/new-bucket.sh --remote my-s3 --name my-bucket --prefix releases/stable

# see what would happen without touching anything
deploy/bucket/new-bucket.sh --remote my-s3 --count 2 --dry-run
```

| Option | Purpose |
| --- | --- |
| `--remote NAME` | rclone remote holding the credentials, or `$YURIRTC_BUCKET_REMOTE` |
| `--name NAME` | bucket name; generated from `--name-prefix` when omitted |
| `--name-prefix TEXT` | prefix for generated names (default `yurirtc`) |
| `--prefix PATH` | directory inside the bucket; both files share it |
| `--count N` | create N buckets in one run |
| `--public-base URL` | base URL the files are served from, when it cannot be derived |
| `--no-build` | upload the artifacts already in `deploy/npm` |
| `--keep-private` | skip the public-read request and the reachability check |
| `--dry-run` | print what would happen, change nothing |

The script refuses to adopt a bucket that already exists, uploads each file
with the content type and `no-cache` policy the browser needs, and then
**fetches the result** rather than assuming it: a bucket that was created and
filled but is not readable looks like a success and serves nobody. When the
fetch fails it names the provider's usual cause and leaves the objects in
place, so only the access grant has to be repeated.

It exits non-zero if any bucket in the run failed, which makes it usable from
other scripts.

### Credentials

Creating a bucket needs more than uploading into one. On S3 the identity needs
`s3:CreateBucket`, plus `s3:PutBucketPolicy` and
`s3:PutBucketPublicAccessBlock` for the result to be publicly readable; a
credential scoped to object management alone can run `upload.sh` but not
`new-bucket.sh`, and the script says so when that is the case.

### Public URLs

The served URL is derived only where it is certain — AWS S3 path-style
addressing, using the remote's region. Anything else, including R2 custom
domains, B2, and any CDN in front of a bucket, needs `--public-base` so the
reported link is one the script actually checked rather than one it guessed.

## After creating one

Link people to the exact `index.html` object, never the directory: object
stores answer a directory URL with a listing, a redirect, or an XML error. The
worker's scope is the directory it is served from, which is why both files must
stay side by side.

A new loader release reaches every deployed bucket on its own, because the
carrier resolves the loader through its `latest` npm tag at runtime. Re-upload
the pair only when the carrier's own bytes change. See `docs/DEPLOYMENT.md` for
Firebase configuration, hosting requirements, and validation.
