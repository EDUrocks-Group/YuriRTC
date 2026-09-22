# CDN, cache and session configuration

## CDN order

Manifest pointers, signed client downloads, recovery clients, fonts and classic
worker bundles use:

1. `https://unpkg.com/`
2. `https://cdn.jsdelivr.net/npm/`
3. `https://esm.sh/` with `?raw`
4. `https://unpkg.toolforge.org/`
5. `https://s4.zstatic.net/npm/`

`packages/protocol/src/cdn.ts` defines the shared order. esm.sh must serve raw
files: its normal module transformation changes the signed bytes and breaks a
classic worker. Client downloads still require the manifest's ECDSA signature
and exact SHA-256. The worker remains version-pinned; its `importScripts` bytes
are not authenticated by the client's hash. CDN failures advance to the next
source. The signed fetch path has a 15-second per-attempt timeout.

New carriers accept the previously published two-source manifest and derive the
five immutable URLs from its authenticated package/version/hash. Old carriers
only accept the old manifest URL list. Deploy upgraded carriers before publishing
a five-source pointer, and publish changed loader bytes under a new immutable
package version. This change does not publish packages or alter live deployments.

## RTDB rollout

Deploy `deploy/firebase/database.rules.json`, then the content node, then the
loader. New exchanges write only
`/signal/<uid>/sessions/<random-32-hex-id>/offer`, and stream the adjacent
`answer`. Only the owning authenticated UID can write offers. Only the admin
node can write answers. The node retains support for legacy `/signal/<uid>/offer`
records, and legacy cleanup preserves the new sessions subtree.

Firebase deletes empty arrays. The client normalizes a missing/null `candidates`
field to `[]`; complete ICE candidates are already embedded in SDP.

## Response headers and cache tags

All headers below travel as normal protocol-v3 response header pairs. API
responses remain outside the asset cache, even if they request caching.

| Header | Meaning |
| --- | --- |
| `Cache-Control: no-store` | Do not store; remove an existing representation when observed. |
| `Cache-Control: private` | Do not store in YuriRTC's shared asset cache. |
| `Cache-Control: no-cache` | Storage is permitted, but reuse requires validation. |
| `Cache-Control: public, max-age=3600` | Reuse fresh bytes for one hour. |
| `Cache-Control: must-revalidate` | Do not serve stale bytes after transport failure. |
| `X-YuriRTC-Cache: no-store` | Explicit transport-cache opt-out, regardless of path policy. |
| `X-YuriRTC-Cache: cache` | Opt a normally excluded static payload into bounded, validator-backed storage. |
| `Cache-Tag: images, game:example` | Tags used by targeted invalidation. |

`no-store`, privacy restrictions, request `credentials`/authorization policy,
ranges, SSE and non-GET handling cannot be overridden by the opt-in header.
Cache tags use letters, digits, `_`, `.`, `:`, and `-`, with at most 32 tags of
64 characters each. Tags label content; they are not authorization credentials.

For static files, pass `--cache-rules /path/to/cache-rules.json` (or
`YURIRTC_CACHE_RULES`) to the content node:

```json
[
  {
    "prefix": "/filestorage/logn/",
    "cacheControl": "public, max-age=3600",
    "tags": ["images"]
  },
  {
    "prefix": "/filestorage/gn/example/manifest.json",
    "cache": "cache",
    "cacheControl": "public, max-age=300",
    "tags": ["game:example"]
  },
  {
    "prefix": "/private-assets/",
    "cache": "no-store"
  }
]
```

The longest matching literal prefix wins. Use a trailing `/` for directory
rules. Rules load once at startup; invalid configuration stops startup. Restart
the node after changing them. Opt-out also emits standard `Cache-Control:
no-store`. Backend API headers are forwarded, but API bodies are never cached.

Existing path defaults remain: hashed `/a/` resources are immutable, generic
static files require validation, browser image destinations are cacheable, and
large game fetch payloads under `/filestorage/` stay outside CacheStorage unless
explicitly opted in. Games can retain their own OPFS strategy. Cache writes are
optional and quota-bounded; responses larger than the 8 MiB staging ceiling are
not retained even with opt-in. Never depend on CacheStorage for durable user data.

The cache consumes bytes only as the foreground reads. Cancellation does not
leave a background copy downloading. Worker lifetime covers pending cache
commits. Invalidations advance a generation so an older in-flight response
cannot refill the cache after a clear. Targeted invalidation retains unrelated
entries and their quota accounting.

## EDUrocks unified-worker messages

The transport worker preserves `GET_VERSION`, `SKIP_WAITING`, `CLEAR_CACHE`,
`CLEAR_ALL_CACHE`, and the `site-version` build handoff. Existing clear messages
reply with `"CLEARED"` after deleting YuriRTC/EDUrocks cache namespaces. Session
cookies and games' OPFS storage are separate from these asset caches.

For tags or exact URLs, send a message from the controlled page (or forward the
unified worker's command through that page) to the active transport worker:

```js
const channel = new MessageChannel();
channel.port1.onmessage = ({ data }) => {
  console.log(data); // { ok: true } after invalidation finishes
  channel.port1.close();
};
navigator.serviceWorker.controller.postMessage({
  type: "INVALIDATE_CACHE",
  tags: ["game:example"],
  // Optional alternative/additional selector: exact scoped URL, including query.
  urls: ["./assets/cover.png"]
}, [channel.port2]);
```

Relative URLs resolve against registration scope. Only URLs inside that scope
are accepted. Tags and URLs are an OR match. Empty arrays match nothing; omit
selectors and use `CLEAR_CACHE` to clear all asset caches. CacheStorage is shared
by origin, so same-origin applications must coordinate cache namespaces/tags.
This repository does not update the separate EDUrocks5 vendored worker snapshot.

## Cookie storage

A synthesized service-worker Response cannot install a browser-managed HttpOnly
cookie. Encrypting a token with a key stored beside it in IndexedDB would not
protect it from same-origin script. YuriRTC therefore makes no HttpOnly claim.

Persistent jars now use the deployment scope in their database name and enforce
cookie path boundaries, expiry, deletion and Fetch `credentials: "omit"`.
Changing from the former shared jar requires users to log in again. Persistent
session cookies remain persisted until logout/deletion; this is not native
browser session-cookie behavior. `Domain` refers to the backend host rather than
the carrier and is not reproduced; neither are SameSite or HttpOnly semantics.

To avoid writing new cookie tokens to disk:

```js
await boot({
  // ...existing Firebase/cache/signal options...
  session: { storage: "memory" }
});
```

For the generated carrier, build with `YURIRTC_SESSION_STORAGE=memory`.
Memory mode clears the current scoped persistent jar when enabled and keeps
new tokens only in the worker's memory. Worker termination, restart or update
loses that session and requires login again. Same-origin malicious script can
still issue authenticated requests; memory mode is not an XSS defense. Use a
separate trusted HTTPS origin with native server-set HttpOnly cookies if that
security boundary is required.

## CPU-efficient delivery and offline compression

The content node now remembers both successful compression and the decision to
send an asset uncompressed. Decisions share the source path/size/mtime identity;
read failures and canceled builds are not cached. The cache is bounded by
64 MiB of compressed bytes **and** 4,096 entries, including negative decisions.

To avoid per-request gzip work on large or frequently evicted assets, generate
private sidecars as part of an immutable site release:

```sh
# Build from the repository, including the checked-in Pion replacements.
mkdir -p build
(cd content-node && go build -o ../build/content-node .)
build/content-node --root /srv/releases/site-v42 --precompress-out /srv/releases/gzip-v42
# Add this option to the content node's usual Firebase/network/backend options:
build/content-node --root /srv/releases/site-v42 --precompressed-dir /srv/releases/gzip-v42 ...
```

`YURIRTC_PRECOMPRESSED_DIR` is the environment alternative. Generate as the
service user or arrange read permissions for that user: private output files are
mode 0600. The directory must be outside the publicly served root. The generator
uses offline gzip level 9, skips formats that are already compressed, and only
includes files that save at least 64 bytes. It writes content-addressed `.gz`
files and atomically replaces `manifest.json` last. Old unreferenced files are
left alone; remove retired release directories through your normal retention
process.

Startup verifies original and gzip SHA-256 hashes and decompresses every sidecar
to verify its original bytes and length. This costs startup I/O and CPU once per
release; requests only check file identity, size and timestamp. Missing or invalid
configured manifests fail startup rather than silently serving unchecked data.
After startup, a changed/missing source or sidecar falls back to normal handling.
Keep verified releases immutable: do not rewrite file contents in place while
preserving their timestamps. Deploy a new release directory and restart the node
when changing content. No request-time hashing or automatic production rollout
is added.

Original URLs, content lengths, validators and decoded bytes remain unchanged.
Range requests, HEAD, clients without private wire-gzip support, and
`Cache-Control: no-transform` keep their original handling. Large precompressed
responses stream through the existing bounded transport.

Server certificates are shared within the peer registry and refreshed daily for
new connections, or before expiry. Startup warms the certificate. Existing peers
keep their original identity and independent DTLS session keys. Certificates and
keys remain process-local; no key is written to disk by this cache.

The DTLS/transport patches and bounded ready-packet batching are enabled by the
checked-in Go module replacements. They add no batching timer, change no cipher,
and retain the current flow-control windows and MTU. See
[the CPU implementation report](reports/2026-09-22-cpu-implementation.md) for
measurements and remaining limitations.
