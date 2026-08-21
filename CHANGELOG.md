# Changelog

This project records user-visible transport, compatibility, deployment, and security changes here. Version numbers for the published npm packages may advance independently.

## Unreleased

### Licensing

- Released the project as free software under the GNU Affero General Public
  License, version 3 (`LICENSE`). The bundled font remains under the SIL Open
  Font License 1.1 and third-party components retain their own notices.

### Transport performance

- Raised the carried-websocket credit window from 16 to 64 messages. One credit
  is one message regardless of size, so the old window was a hard
  messages-per-round-trip ceiling on message-dense socket traffic; the node
  accepts both windows, and its relay pump now honours the shared association
  watermarks so the larger window cannot queue unbounded socket bytes onto one
  lane.
- Moved node-side websocket relay writes off the lane's frame-delivery
  goroutine and behind a bounded per-socket ring. A stalled upstream write can
  no longer freeze every request, upload chunk, and credit frame sharing that
  lane, and a browser-initiated close now completes a clean upstream close
  handshake instead of racing an abrupt teardown.
- Raised the node's per-lane buffered-amount wake threshold to a quarter of the
  bulk high-water mark so paused bulk writers refill the shared send queue
  before it drains nearly empty, keeping high bandwidth-delay routes full
  between refills.
- Sent Critical (render-blocking) requests on the interactive lane while the
  lazy bulk lanes are still opening, saving a data-channel handshake round trip
  on every cold asset waterfall; Normal and Bulk requests still wait for the
  bulk lanes.
- Read non-SSE proxied API response bodies in full 128 KiB frames instead of
  32 KiB, quartering per-byte framing, credit, and scheduling overhead for
  large API responses.
- Removed the peer session mutex from the per-frame send path (lock-free lane
  reads, one request lookup per streamed file) and deepened the ICE-TCP mux
  read queue for burst tolerance on TCP-only networks.

## Protocol v3

- Stream request bodies from the intercepted Fetch request into the carrier
  instead of waiting for a complete `arrayBuffer()` copy before upload begins.
- Add node-issued request credits so the browser, RTC send queue, content-node
  ingress queue, and backend reader form one bounded backpressure chain.
- Version the page-to-service-worker attachment handshake and never claim
  pages still controlled by a predecessor worker during an upgrade, so a
  moving `latest` tag cannot pair new client code with a stale worker.
- Persist recovery bootstrap URLs only after the worker confirms the current
  protocol, and coalesce worker wakeups across the entire upgrade handshake so
  a queued wake cannot replace an attachment already in progress.
- Ignore only the bounded, already-credited tail of a server-rejected upload
  and reserve global ingress capacity before granting request credits, avoiding
  both peer-wide false violations and nondeterministic overload rejection.
- Add a release-grade local Chrome-to-Go E2E covering the generated carrier,
  real service worker and bundles, local signaling, multi-frame downloads, and
  a deliberately paced streaming upload that detects eager buffering.
- Enforce the 128 KiB receive-frame limit in the browser, fail malformed
  response metadata without leaking request state, and deliver response frames
  to the service worker by transfer with payload offsets rather than copies.
- Bound overload and terminal-error responses per peer and by aggregate SCTP
  buffered bytes so a failing or abusive client cannot grow the node's outbound
  queue without limit.
- Raise the node's SCTP receive window to 4 MiB and return upload credits in
  quarter-window batches. A real 100 ms delayed-link upload improved by about
  35% while retaining the existing 16-frame per-request and global reservations.
- Refill browser response credits every eight consumed frames without changing
  the sixteen-frame adaptive sampling interval, and increase the page-side RTC
  send queue watermarks to 2 MiB/1 MiB.
- Add production canaries that can force either UDP or TCP and verify the route
  selected by the published loader, while leaving application iframe WebRTC
  untouched.

### Changed

- Named the project and runtime YuriRTC while keeping every published
  identifier existing deployments depend on unchanged.
- Consolidated the public static deployment into a single carrier workspace
  whose build emits only `index.html` and the same-origin `sw.js` stub.
- Made the generated static shell path-independent for origin-root, directory,
  and object-store path-style hosting.
- Applied the YuriRTC Material 3 loading theme and a single npm-distributed
  display font; visible shell copy is stored as ROT13.
- Obfuscated the published loader bundles, static shell JavaScript, and worker
  stub while excluding readable JavaScript, source maps, and tests from the
  public npm tarball.
- Pointed the generated shell and worker stub at the loader's `latest` npm
  dist-tag on both CDNs instead of an exact version, and registered the worker
  with `updateViaCache: "none"` so update checks re-fetch the imported bundle.
  Publishing a new loader version now reaches deployed carriers without
  re-uploading the bucket pair.
- Added a Material 3 network-censorship indicator for the selected coarse
  route: UDP on a standard port, UDP on 443, TCP on a standard port, or TCP on
  443. Raw candidates, addresses, and exact non-443 ports are not exposed to
  the page UI or application console.
- Added explicit unavailable and disconnected views, manual reconnect, bounded
  exponential retry with jitter, and recovery that reloads only the contained
  application rather than the permanent carrier.

### Performance

- Held one IndexedDB connection per database instead of opening and closing one
  for every operation, released on `versionchange` or a force-close so another
  context is never blocked.
- Replaced the per-write metadata scan and `navigator.storage.estimate()` call
  with a running in-memory LRU total, seeded by one table read per worker
  lifetime, resynced on a bounded schedule, and reserved across in-flight
  writes so concurrent responses see each other.
- Coalesced cache-hit recency updates into one transaction. A hundred-cover
  grid now costs one database open, one quota reading, one cache open, and --
  served warm -- a single additional transaction for the whole page.
- Stopped copying every cacheable byte twice: response chunks are retained by
  reference and joined off the JavaScript heap, since the worker already owns
  the transferred wire frames outright.
- Reused a confirmed carrier for a bounded window so ordinary subresources no
  longer ask the browser process whether the carrying page still exists.
  Requests whose routing a stale answer could change still check every time.
- Anchored the markup rebase scan on the only byte that can begin a rewrite
  rather than testing every byte of every document.
- Removed the obfuscator's string-array rotation, measured at 63ms of blocking
  startup for the client bundle and paid again on the cross-origin-isolation
  reload. Shuffle and index shift are retained.
- Shared one readiness campaign in the proxy section instead of giving every
  queued request its own poll and broadcast.
- Stopped the carrier's boot spinner animating and dropped the network
  indicator's backdrop filter once the application is mounted.

### Fixed

- Pointed both browser end-to-end harnesses at the `@latest` worker path the
  carrier stub actually imports, restoring real end-to-end transport coverage.

### Security

- Hop-by-hop headers, wire-form length/encoding headers, and `Set-Cookie` are
  not copied directly into synthesized browser responses.
- Same-origin root-relative `fetch`, cloned `Request`, XHR, EventSource,
  beacon, dynamic resource, form, history, and navigation targets are rebased
  into the loader's virtual root. Rebuilt `Request` objects preserve their
  method, body, headers, credentials, integrity, redirect mode, and referrer
  policy.
- JavaScript obfuscation and ROT13 are treated as deterrence rather than
  access control throughout the public-release guidance.
