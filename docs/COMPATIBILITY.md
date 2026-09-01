# Compatibility

YuriRTC treats the identifiers existing deployments depend on as compatibility contracts. Names that reach browsers, storage, or the wire must stay stable across compatible releases even when newer branding would read better.

## Published loader paths

A deployment resolves a signed pointer from `shaintloadingcheckpak@latest/loader.json`; that pointer names immutable files in `@advwebrec/grainloading`. Do not rename either package or move these published paths in a compatible release:

```text
@advwebrec/grainloading@VERSION/dist/bundle/client.js
@advwebrec/grainloading@VERSION/dist/bundle/sw.js
@advwebrec/grainloading@VERSION/dist/bundle/sw-stub.js
@advwebrec/grainloading@VERSION/dist/assets/rot13.woff
shaintloadingcheckpak@VERSION/loader.json
```

Package names are distribution coordinates, not product branding.

## Runtime compatibility

A compatible release preserves:

- the loader's public JavaScript exports;
- Firestore and RTDB signaling paths and record shapes;
- service-worker message shapes used by transported applications;
- existing cache, IndexedDB, session, and injection marker identities where changing them would strand installed deployments;
- relative worker registration and scope-derived logical paths;
- existing build-version messages and cache invalidation behavior.

Compatibility strings with an older prefix may therefore remain in storage keys, markers, wire values, or aliases. They should not be used for new user-facing branding.

The wire protocol is v3. The content node accepts only v3 lanes and validates every request head against the protocol version; a peer speaking any other wire version is rejected at attach. A future wire change must ship through an explicitly backward-compatible transition node before the loader that speaks it is published (see the rollout pattern below).

The page and service worker also exchange their protocol version before the page identifies itself as the active carrier. A mismatched attachment is closed without routing requests, and an upgrading worker does not claim pages still controlled by its predecessor. Those pages keep their existing controller until navigation or reload; newly loaded pages attach only after the new worker activates. This predecessor-worker isolation remains required for upgrades even when both releases use the same wire version.

A restarted worker wakes only pages it currently controls. If several tabs respond, the first READY attachment wins and the others remain connected as standbys; they do not replace the incumbent or cancel its active requests. A stalled winner expires before the longer fetch-acquisition deadline, allowing a standby a complete attachment/bootstrap turn.

The static shell follows only the signed pointer package's `latest` tag. Its signed payload contains the exact loader version, both permitted CDN URLs, and the expected SHA-256. The carrier embeds only the public verification key. The same signed version is placed on the worker-stub registration URL, and the stub imports that exact `@advwebrec/grainloading` worker version. A bucket update is needed only when shell, bootstrap, UI, or public-key bytes change.

New source may use the `YuriRTCClient` and `YuriRTCConfig` exports. `LoaderClient` remains an exact alias of the same constructor and `LoaderConfig` remains a type alias for existing consumers; `boot`, `classify`, and `classifyRequest` retain their established names and behavior.

### Backward-compatible transport headers

The current performance extensions stay inside protocol v3 by using ordinary
request/response header pairs. These private names are compatibility contracts:

| Header | Direction | Meaning |
| --- | --- | --- |
| `x-yurirtc-accept-wire-encoding: gzip` | loader to node | The loader can explicitly decompress YuriRTC wire gzip |
| `x-yurirtc-wire-encoding: gzip` | node to loader | This response body is gzip only on the YuriRTC hop |
| `x-yurirtc-route-probe: 1048576` | both | A bounded internal 1 MiB route measurement, not a hosted path |

These are deliberately not `Accept-Encoding` or `Content-Encoding`. The loader
removes them before constructing a site-visible `Response`, and the content
node removes them before proxying `/apiv2/`. DTLS remains the encrypted
transport; gzip changes only the bytes carried inside it. A loader without
`DecompressionStream` does not request gzip.

The node compresses only eligible complete static GET responses of at least
1 KiB. It excludes Range/206, HEAD bodies, APIs, SSE, already-compressed media,
unknown binary types, and requests carrying `Cache-Control: no-transform`.
The absence of the response marker always means the original bytes.

### Universal static cache semantics

Hashed `/a/` assets retain `public, max-age=31536000, immutable`. Other static
files receive `Date`, weak `ETag`, `Last-Modified`, `Accept-Ranges`, and
`public, max-age=0, must-revalidate`. The service worker may retain those
representations within its configured LRU budget, sends `If-None-Match` and
`If-Modified-Since` when online, and reuses the stored body on `304 Not
Modified`. Offline fallback may use the stale stored representation.

This generic path covers arbitrary files hosted by YuriRTC, but it does not
override explicit safety boundaries. `/apiv2/`, EDUrocks game payloads already
managed in OPFS, authenticated requests, Range/206, SSE, `no-store`, `private`,
and `Vary: *` responses are not admitted to the generic cache. A `404`, `410`,
or newly private/non-storable response invalidates an older fallback.

## Content-node environment variables

Deployments configure the node with these names. Command-line flags override environment configuration.

| Name | Purpose |
| --- | --- |
| `YURIRTC_PUBLIC_IP` | Public IPv4 address advertised in ICE candidates |
| `YURIRTC_BIND_IP` | Local address used by UDP/TCP listeners |
| `YURIRTC_PORTS` | Comma-separated ports opened for both UDP and TCP |
| `YURIRTC_SCTP_CONGESTION_CONTROL` | Sender controller: `cubic` (default) or `reno` |
| `YURIRTC_ROOT` | Static application content root |
| `YURIRTC_BACKEND` | Optional HTTP backend used for `/apiv2/` |
| `YURIRTC_PROJECT` | Firebase project ID |
| `YURIRTC_DATABASE_URL` | Complete Firebase Realtime Database URL |
| `YURIRTC_CREDENTIALS` | Optional server credential-file path |

`GOOGLE_APPLICATION_CREDENTIALS` remains unchanged because it is a standard Google Application Default Credentials variable. Preexisting deployments may configure the same values under older environment prefixes that the node continues to accept; preferred `YURIRTC_*` values win when both forms are present.

The static release build reads:

| Name | Purpose |
| --- | --- |
| `YURIRTC_FIREBASE_API_KEY` | Public Firebase web API key |
| `YURIRTC_FIREBASE_PROJECT_ID` | Firebase project ID |
| `YURIRTC_FIREBASE_DATABASE_URL` | Complete Firebase Realtime Database URL |

These are public browser configuration, not server credentials. The ordinary development build may emit placeholders; `build:release` rejects missing release values.

The opt-in capacity harness uses the same `YURIRTC_CAPACITY_*` prefix for `MODE`, `BIND_IP`, `PUBLIC_IP`, `PORTS`, `HTTP`, `DURATION`, `URL`, `USERS`, `RATE`, `HOLD`, `PROTOCOL`, and `REMOTE_PORT`.

## Browser requirements

YuriRTC requires:

- a secure context;
- service workers;
- WebRTC data channels;
- `MessageChannel`, transferable `ReadableStream` support, IndexedDB, and the Cache API;
- JavaScript with the ES2022 features emitted by the release build.

Current evergreen Chromium, Firefox, and Safari releases are the intended browser class. SharedArrayBuffer support additionally depends on the browser honoring the synthesized cross-origin isolation headers. Browsers that do not support `Cross-Origin-Embedder-Policy: credentialless` may run the ordinary application but cannot be assumed to support isolated game/content paths.

Wire gzip is optional per browser. If `DecompressionStream("gzip")` is
unavailable, the loader omits the capability header and the node sends the
ordinary uncompressed representation.

`file://` deployments are unsupported. Plain HTTP is unsupported except for browser-recognized loopback development origins.

## Hosting shapes

| Hosting shape | Supported | Notes |
| --- | --- | --- |
| `https://host.example/index.html` | Yes | Worker scope is `/` |
| `https://host.example/prefix/index.html` | Yes | Worker and app remain under `/prefix/` |
| `https://storage.googleapis.com/bucket/index.html` | Yes | Scope is the bucket path on the shared origin |
| `https://s3.region.amazonaws.com/bucket/index.html` | Yes | Use the exact regional endpoint that serves the object |
| Nested release directory | Yes | Upload both files to the same directory |
| URL that redirects to an HTML/XML listing | No | Link to the exact `index.html` object |
| Worker in a different directory or origin | No | A service worker must be same-origin and normally cannot claim a parent scope |

The shell calculates its base from `location.href`; it does not need a bucket or prefix build option. A host may grant a wider scope with `Service-Worker-Allowed`, but portable deployments should use the worker's own directory.

Object-store path endpoints share an origin among multiple buckets. Browser storage quotas, IndexedDB, and caches are origin-scoped, not bucket-scoped. YuriRTC namespaces its recovery state and validates that persisted shell paths remain within the current worker directory, but an operator should still prefer a dedicated origin when strict storage isolation is required.

## Transport compatibility

The content node listens on each configured port over both UDP and TCP and advertises direct ICE candidates. ICE chooses the usable candidate pair. TCP is a direct ICE fallback and can suffer head-of-line blocking; it is not a TURN relay.

With no unexpired session preference, the loader opens ordinary ICE and forced
TCP candidates in parallel, then requests one 1 MiB deterministic,
non-compressible, `no-store` probe from each. When both routes connect and
support the probe, TCP wins only when its measured transfer is at least 15
percent faster; when only one connects, that route wins without delaying
startup for a comparison. A missing exact response marker—what an older node
returns—keeps ordinary ICE. The result is remembered in `sessionStorage` for
ten minutes and is cleared on offline/network reset or a failed forced-TCP
connection. Each content-node peer session accepts only one valid probe;
invalid and repeated requests receive `400` and `429` respectively.

The loader also watches sustained application goodput on a selected UDP route.
When it recommends TCP, a second connection is established without detaching
the working route. New request IDs move to TCP after it opens; existing HTTP
requests, uploads, credits, cancellation, and carried WebSockets remain on UDP
until they drain. The predecessor is then retired. A failed TCP warm-up leaves
UDP untouched, and no POST, upload, or WebSocket operation is replayed. This
make-before-break policy uses the same protocol-v3 frames on both routes.

The protocol-v3 lane scheduler keeps four ordered/reliable data channels on one
ICE/DTLS/SCTP association:

| Lane | Normal role |
| --- | --- |
| 0 | Navigations, API/mutations, carried WebSockets, and other interactive control work |
| 1 | Reserved small critical files such as scripts, styles, fonts, and documents |
| 2 | One active normal or incremental asset at a time |
| 3 | One active normal or incremental asset at a time |

All four are established before the first application waterfall. Asset lanes
1-3 close after 15 seconds idle to release node receive buffers and reopen on
demand. Normal and bulk starts wait FIFO when lanes 2 and 3 are occupied; a
critical request can still use lane 1. These streams avoid cross-asset ordered
head-of-line blocking, but they deliberately share one SCTP congestion window
and are not independent network paths.

The public connection diagnostic deliberately contains only `{ transport, portClass }`, where `transport` is `udp`, `tcp`, or `unknown`, and `portClass` is `443`, `standard`, or `unknown`. It does not contain a candidate, address, candidate type, or exact non-443 port.

No TURN service or TURN-over-TLS fallback is part of the supported configuration. Networks that block every direct candidate cannot connect unless a future, separately reviewed relay feature is released.

## Backward-compatible node-first rollout

The gzip, validator, cache, probe, route-selection, lane-scheduling, and SCTP
allocation changes do not change protocol v3. Roll them out in this order:

1. Build, test, deploy, and canary the new content node first.
2. Leave existing loaders and carriers in place while node health and old-loader traffic are checked; old loaders never opt into gzip or the probe.
3. Build and test the new loader against that deployed node in Chromium, Firefox, and WebKit over UDP and TCP.
4. Publish the immutable loader only after those checks pass, verify both CDNs, and then publish the signed pointer.
5. Rebuild or upload a carrier pair only if its own shell or worker-stub bytes changed.

The reverse order is not the supported rollout. Although an older node returns
ordinary static bytes when it does not recognize gzip and cannot produce the
exact probe marker, it predates the node-side stripping of private transport
headers from API requests. Node-first keeps old and new browsers safe throughout
the transition and makes rollback a loader-pointer operation while retaining a
compatible node.

## Wire-change rollout pattern

A wire-version transition follows this order:

1. Deploy and canary a transition content node that accepts both the current and the new wire version.
2. Publish the loader version that speaks the new wire.
3. Verify both configured CDNs serve that exact loader, then publish a newly signed pointer version.
4. Upload a new `index.html` and `sw.js` pair only when the static shell itself changed.
5. Validate the real Firebase, CDN, service-worker, and RTC path.
6. Deploy and canary the final single-version content node.

Rolling back a wire change reverses the same order: restore the saved transition-node binary and verify its service health first, then publish a new signed-pointer version naming the previous immutable loader. Restore the prior generated pair together only if shell bytes also changed.
