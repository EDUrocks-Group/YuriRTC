# Deployment

This guide describes a generic YuriRTC deployment. Replace every example value with your own configuration, keep server credentials outside the repository, and test the complete flow before directing users to it.

## 1. Build and verify

Use the locked JavaScript dependency graph and run both language test suites:

```bash
npm ci
npm run typecheck
npm test
npm run build

(cd content-node && go test ./...)
```

Before a production rollout, run the real local browser-to-node path as well:

```bash
npm run test:e2e
```

It uses local test signaling rather than the production Firebase project, but
otherwise runs the generated carrier, service worker, loader, Chrome WebRTC,
the Go content handler, multi-frame downloads, streaming API uploads, and a
two-tab carrier/standby election while one upload remains in flight.

The ordinary build may use placeholder browser configuration and is suitable for source validation only. Build and verify deployable artifacts after choosing the Firebase client configuration in step 4.

## 2. Configure Firebase

Create a Firebase project for the deployment, then enable:

- Cloud Firestore in Native mode;
- Realtime Database;
- the authentication provider required by the RTDB signaling leg, normally anonymous authentication.

The generic configuration is under `deploy/firebase`:

```text
firebase.json
firestore.rules
firestore.indexes.json
database.rules.json
```

Deploy it explicitly to the intended project:

```bash
(
  cd deploy/firebase
  firebase deploy \
    --project "example-project" \
    --only database,firestore:rules,firestore:indexes
)
```

The Firestore index template enables TTL for signaling records. Confirm the TTL policy is active after deployment; TTL deletion is asynchronous, so the content node also removes completed/stale records.

Verify the rules against a non-production project before launch:

```bash
FB_API_KEY="example-public-web-key" \
FB_PROJECT="example-project" \
FB_DB_URL="https://example-project-default-rtdb.example-region.firebasedatabase.app" \
node deploy/firebase/tools/verify-rules.mjs
```

The web API key and client project identifiers are public configuration. Restrict the key to the required Firebase APIs and expected web origins where the provider supports it. Never use a service-account key in browser configuration.

Create a least-privilege server identity that can observe and answer the signaling records. Prefer workload identity or the platform's Application Default Credentials. If a JSON credential file is unavoidable, store it outside the checkout and make it readable only by the content-node account.

## 3. Build the content node

```bash
mkdir -p build
(cd content-node && go build -trimpath -o ../build/yurirtc-content-node .)
```

Configure it with YuriRTC environment names:

```ini
YURIRTC_PUBLIC_IP=203.0.113.10
YURIRTC_BIND_IP=203.0.113.10
YURIRTC_PORTS=443,80,5228,5229,5230,5223,2197,53,123,49152,445
YURIRTC_ROOT=/var/lib/yurirtc/site
YURIRTC_BACKEND=http://127.0.0.1:1801
YURIRTC_PROJECT=example-project
YURIRTC_DATABASE_URL=https://example-project-default-rtdb.example-region.firebasedatabase.app
GOOGLE_APPLICATION_CREDENTIALS=/etc/yurirtc/service-account.json
```

`203.0.113.10` is a documentation-only address. `YURIRTC_DATABASE_URL` must be copied from the Firebase console; do not construct it from the project name because RTDB host formats vary.

The default port set opens each listed port over both UDP and TCP, and ICE uses whichever pair reaches the visitor. List ports least to most likely to be filtered: every host candidate on one address carries the same ICE priority whatever its port, so the order is what decides which the browser tries first, and it paces parallel checks rather than sequencing fallbacks. Change the set when a port is already owned on the selected bind address; binding is all-or-nothing, so one conflict stops the node from starting. A common deployment gives the content node its own address so low ports do not conflict with a conventional web server. Each port costs two listening sockets and four more candidates in every offer, and the host firewall must permit each one over both protocols.

Generic Linux examples are provided in `deploy/systemd/content-node.service`, `deploy/systemd/node.env.example`, and `deploy/sysctl/90-yurirtc-content-node.conf`. Review all paths, identities, limits, ports, and kernel settings for the target host before installing them; they are templates rather than an unattended installer.

Run the process as a dedicated unprivileged account. If it binds ports below 1024, grant only the operating-system capability required to bind low ports instead of running the whole service as root. Limit the firewall to the selected UDP/TCP ports and administrative access from trusted networks. The optional API backend should normally remain on loopback or a private network.

Configuration uses the `YURIRTC_*` names; see [Compatibility](COMPATIBILITY.md).

YuriRTC advertises direct ICE candidates only. Do not add TURN credentials or assume a TURN listener exists.

## 4. Build the two static files

The static shell needs public Firebase web configuration at release-build time:

```bash
export YURIRTC_FIREBASE_API_KEY="example-public-web-key"
export YURIRTC_FIREBASE_PROJECT_ID="example-project"
export YURIRTC_FIREBASE_DATABASE_URL="https://example-project-default-rtdb.example-region.firebasedatabase.app"

npm run build:release

npm run verify:release
```

Keep the selected values in the environment through npm publication because the static carrier's prepack hook rebuilds and revalidates the release.

`verify:release` fails if an npm tarball includes source maps, readable compiled JavaScript, compiled tests, or an unexpected file. It also verifies that the browser bundles retain their required public exports and that the generated carrier and worker stub follow the loader's `latest` tag.

The outputs are:

```text
deploy/npm/index.html
deploy/npm/sw.js
```

The build reads the current loader package version for release fingerprints, emits `@latest` client/font URLs, and obfuscates the shell and worker stub; the worker stub imports the moving `@latest` bundle so a published loader reaches deployed carriers on its own. It does not compile a bucket name or path prefix.

Do not edit generated files. Do not publish or upload the readable source templates in their place.

## 5. Publish npm compatibility packages

Use a new loader version for every byte change; npm versions are immutable.
After a production content node compatible with the loader being released is
deployed and its wire canary is healthy, run the guarded release workflow with
the Firebase variables from step 4 still exported. A same-wire loader release
is compatible with the deployed node. A wire change must deploy and canary a
backward-compatible transition node before publishing its loader:

```bash
YURIRTC_CONTENT_NODE_CANARY_OK=1 ./deploy/release.sh
```

The script repeats every local test and package check, publishes the loader,
waits for the exact npm tarball and for both CDNs to serve the exact verified
loader bytes with usable MIME and CORS headers, and only then publishes
the static carrier package. npm and CDN visibility waits are bounded but allow
several minutes for normal registry and cache convergence. The workflow is
resumable after convergence failures without attempting to overwrite an
immutable npm version or automatically moving a dist-tag.

Before uploading the bucket files, fetch the `@latest` client/font URLs and the resolved-version `sw.js` URL from both configured CDNs. Verify successful JavaScript/font content types and cross-origin access headers. Never upload an `index.html` until `latest` resolves to the loader version you just published on both CDNs.

## 6. Upload to static hosting

Upload both files to the same directory. Required metadata:

| File | Content-Type | Cache-Control |
| --- | --- | --- |
| `index.html` | `text/html; charset=utf-8` | `no-cache` |
| `sw.js` | `text/javascript; charset=utf-8` | `no-cache` |

Example GCS upload to a directory-shaped object prefix:

```bash
gsutil -h "Content-Type:text/html; charset=utf-8" \
  -h "Cache-Control:no-cache" \
  cp deploy/npm/index.html gs://example-bucket/releases/stable/index.html

gsutil -h "Content-Type:text/javascript; charset=utf-8" \
  -h "Cache-Control:no-cache" \
  cp deploy/npm/sw.js gs://example-bucket/releases/stable/sw.js
```

Example S3 upload:

```bash
aws s3 cp deploy/npm/index.html \
  s3://example-bucket/releases/stable/index.html \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache"

aws s3 cp deploy/npm/sw.js \
  s3://example-bucket/releases/stable/sw.js \
  --content-type "text/javascript; charset=utf-8" \
  --cache-control "no-cache"
```

Make the two objects readable through the intended distribution policy. Link users to the exact object:

```text
https://storage.googleapis.com/example-bucket/releases/stable/index.html
https://s3.example-region.amazonaws.com/example-bucket/releases/stable/index.html
```

Do not assume the directory URL will resolve to `index.html`; REST object endpoints often return a listing, redirect, XML error, or access denial instead.

The service worker can normally control only its own directory. Keep `sw.js` beside `index.html` and allow the shell to derive the directory scope. Do not force `/` scope on a path-style deployment unless the hosting response deliberately grants it with `Service-Worker-Allowed`.

## 7. End-to-end validation

Test with a clean browser profile and with an upgraded profile that already has the previous worker installed.

Confirm:

1. `index.html` and `sw.js` return 200 with the expected content types and cache policy.
2. The service-worker script URL is the sibling of the current page and its scope ends at the containing directory.
3. The page reloads at most once to establish synthesized cross-origin isolation headers.
4. Firestore or RTDB signaling produces an answer and the RTC data channel opens.
5. The censorship indicator reports the selected coarse UDP/TCP and standard/443 route class without rendering or logging a candidate, address, or exact non-443 port.
6. The application frame loads, signs in, makes API calls, opens chat/event streams, and loads static assets.
7. Navigation, Back, Forward, refresh, forms, programmatic fetch/XHR, dynamic image/script URLs, and application history stay inside the virtual deployment root.
8. No same-origin application request reaches an object-store root and returns an XML error page.
9. Blocking either npm CDN independently still permits the other configured source to load.
10. Visible loader copy renders correctly through the versioned font without a plaintext/ciphertext flash.
11. A forced transport loss shows the disconnected view, retries with bounded jitter, and restores only the contained application; blocking every route shows the unavailable view and its manual retry remains functional.

Test both an origin-root URL and at least one nested or path-style URL. Keep browser network logs sanitized when attaching them to an issue.

After npm and the content node are live, the production canary serves the
verified local carrier on loopback but deliberately uses its embedded public
Firebase configuration, the real npm CDNs, and the production RTC node:

```bash
npm run test:prod-canary
YURIRTC_CANARY_PROTOCOL=udp npm run test:prod-canary
YURIRTC_CANARY_PROTOCOL=tcp npm run test:prod-canary
```

It prints only coarse counts and states; it does not print Firebase query
parameters, signaling capabilities, API keys, or application URLs. The optional
protocol setting filters the production node's answer inside Chrome and verifies
that the reported coarse route uses the requested transport. During a wire
transition, run the default and both forced routes before retiring the
transition node and again after the final single-version restart.

## 8. Capacity validation

The repository includes an opt-in capacity harness in the content-node tests. Its `YURIRTC_CAPACITY_*` variables control a generator and measurement server.

Run capacity tests only in an isolated environment with explicit resource and traffic limits. A concurrency result applies to the tested CPU, memory, file-descriptor limits, kernel buffers, network, signaling quota, candidate protocol, application response mix, and session duration. YuriRTC does not claim a universal maximum-user figure from a short synthetic run.

## 9. Release ordering and rollback

A wire-version transition uses this order:

1. Deploy the backward-compatible transition content node and verify its service health.
2. Deploy and verify Firebase rules/indexes.
3. Publish the loader that speaks the new wire.
4. Confirm both CDNs resolve `latest` to that version, then build and verify the static carrier package.
5. Upload `index.html` and `sw.js` together.
6. Complete clean-profile and upgrade-profile validation.
7. Run the real Firebase/CDN production canary.
8. Deploy the final single-version content node and repeat its health, wire, and production canaries.

`deploy/release.sh` enforces the local clean-profile and upgrade-profile browser
gates and refuses npm publication unless
`YURIRTC_CONTENT_NODE_CANARY_OK=1` is set. Set that flag only after a production
node compatible with the candidate loader has passed its health and matching
wire canaries. A deployed same-wire node satisfies that gate for same-wire
loader releases; a protocol change requires its transition node first. The
script then publishes the loader, purges
and verifies both CDNs' `latest` resolution and immutable worker, and publishes
the static carrier.

A single-version node rejects every older wire version, so a browser-only
dist-tag rollback cannot restore an old loader against it. To roll a wire
change back, first restore the saved transition-node binary and verify that
service, then deliberately move the loader's `latest` dist-tag. Restore the
previous generated pair together if its shell bytes also changed; never
replace only one object. Keep transition-node backups until the rollback
window is formally closed.
