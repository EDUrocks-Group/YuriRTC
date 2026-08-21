# Compatibility

YuriRTC treats the identifiers existing deployments depend on as compatibility contracts. Names that reach browsers, storage, or the wire must stay stable across compatible releases even when newer branding would read better.

## Published loader paths

A deployment's loader package is imported directly by static pages and immutable CDN URLs. Do not rename the package or move these published paths in a compatible release:

```text
LOADER_PACKAGE@VERSION/dist/bundle/client.js
LOADER_PACKAGE@VERSION/dist/bundle/sw.js
LOADER_PACKAGE@VERSION/dist/bundle/sw-stub.js
LOADER_PACKAGE@VERSION/dist/assets/rot13.woff
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

The generated static shell references the loader through the `latest` npm dist-tag on both CDNs rather than an exact version. The service-worker registration uses `updateViaCache: "none"`, so a routine update check re-fetches the imported worker bundle and an npm publish reaches deployed carriers on its own. A bucket update must still upload the generated `index.html` and `sw.js` together whenever the shell itself changes.

New source may use the `YuriRTCClient` and `YuriRTCConfig` exports. `LoaderClient` remains an exact alias of the same constructor and `LoaderConfig` remains a type alias for existing consumers; `boot`, `classify`, and `classifyRequest` retain their established names and behavior.

## Content-node environment variables

Deployments configure the node with these names. Command-line flags override environment configuration.

| Name | Purpose |
| --- | --- |
| `YURIRTC_PUBLIC_IP` | Public IPv4 address advertised in ICE candidates |
| `YURIRTC_BIND_IP` | Local address used by UDP/TCP listeners |
| `YURIRTC_PORTS` | Comma-separated ports opened for both UDP and TCP |
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

The public connection diagnostic deliberately contains only `{ transport, portClass }`, where `transport` is `udp`, `tcp`, or `unknown`, and `portClass` is `443`, `standard`, or `unknown`. It does not contain a candidate, address, candidate type, or exact non-443 port.

No TURN service or TURN-over-TLS fallback is part of the supported configuration. Networks that block every direct candidate cannot connect unless a future, separately reviewed relay feature is released.

## Wire-change rollout pattern

A wire-version transition follows this order:

1. Deploy and canary a transition content node that accepts both the current and the new wire version.
2. Publish the loader version that speaks the new wire.
3. Verify both configured CDN URLs resolve the `latest` dist-tag to that version.
4. Build and publish the static carrier, then upload its `index.html` and `sw.js` as a pair when static hosting also needs the new shell bytes.
5. Validate the real Firebase, CDN, service-worker, and RTC path.
6. Deploy and canary the final single-version content node.

Rolling back a wire change reverses the same order: restore the saved transition-node binary and verify its service health first, then deliberately move the loader's `latest` dist-tag and restore the prior generated pair together if needed. Never replace only one bucket object or point a new page client at an older worker; a browser-only dist-tag rollback cannot make an old loader compatible with a single-version node.
