# YuriRTC transport audit — 2026-09-18

This is a local source review and measured test run, not a production rollout or
a guarantee about every network. The published CDN probe uses release 0.5.3;
local changes need a new immutable release version before publication.

## Changes implemented

- RTDB uses one fresh exchange path per attempt under the authenticated UID.
  Writes match the offer-only rules, simultaneous tabs cannot overwrite each
  other's offers/answers, and empty candidate arrays removed by Firebase are
  normalized correctly. Legacy node cleanup preserves new session subtrees.
- One shared CDN order supplies the manifest, client, recovery, font and worker
  URLs: UNPKG, jsDelivr, esm.sh raw, Toolforge, ZStatic. Signature/hash checks and
  the explicit integrity-failure screen remain in place. Legacy two-source
  manifests are accepted by upgraded carriers.
- Scoped cookie jars, path filtering, expiry/deletion and credentials omission;
  optional worker-memory-only storage avoids durable new tokens. This cannot
  provide native HttpOnly or prevent same-origin script from issuing requests.
- Static response cache rules and HTTP-style headers, cache tags, targeted
  invalidation, generation-safe clears, and worker lifetime for pending writes.
  Explicit freshness/revalidation directives also govern image reuse. Opted-in
  game metadata can cache without duplicating large OPFS payloads by default.
- Reused gzip encoder workspaces remove repeated DEFLATE setup/allocation on
  compression cache misses and large streamed responses. No transport window,
  congestion-control safety bound or protocol version was relaxed.

Configuration and rollout order: [CACHE-AND-CDNS.md](../CACHE-AND-CDNS.md).

## Encoder microbenchmark

Intel Xeon E5-2667 v4, Go 1.25.13, roughly 1.12 MB of repeated game-manifest-like
JSON per operation, gzip BestSpeed, identical input and output behavior. Three
runs per alternative, two seconds each, in the same process:

| Encoder | Throughput | Allocated per operation |
| --- | --- | --- |
| Fresh workspace | 350–356 MB/s | 1,207,075 bytes; 19 allocations |
| Pooled workspace | 486–555 MB/s | 0–1,316 amortized bytes; 0 rounded allocations |

The median throughput improvement is about 43%. This is compression CPU
throughput, not a 43% increase in network bandwidth. `sync.Pool` can discard
workspaces during GC; the amortized allocation is not a hard zero guarantee.

## Real transport benchmarks

The initial real Pion-to-Pion loopback sweep used 64 MiB files, multiple credit
windows and refill batches, three iterations and two repeats. Approximate ranges
were 270–362 Mbps for UDP and 202–257 Mbps for TCP. These isolate the software
transport ceiling; they do not include browser rendering, disk cold starts or a
WAN. Ordinary uncompressed transfer is not expected to benefit from gzip pooling.

The WAN matrix used separate unprivileged network namespaces, Linux netem, a
100 Mbps ceiling, and real ICE/DTLS/SCTP, request framing and flow control.
Each final case transferred 64 MiB (three files for the parallel case).

| Scenario | Measured Mbps | Existing minimum | Result |
| --- | ---: | ---: | --- |
| UDP, clean, 128 ms RTT | 46.84 | 35 | pass |
| UDP, 0.01% random loss, 128 ms | 23.60 | 14 | pass |
| TCP, 0.1% random loss, 128 ms | 35.28 | 14 | pass |
| UDP, clean, 300 ms | 22.09 | 14 | pass |
| UDP, 0.01% random loss, 300 ms | 12.95 | 14 | **below threshold** |
| UDP, burst loss, 128 ms | 6.28 | 4 | pass |
| TCP, burst loss, 128 ms | 38.16 | 20 | pass |
| UDP, reordering, 128 ms | 46.10 | 14 | pass |
| UDP, three lanes, 0.01% loss, 128 ms | 24.44 | 20 | pass |

The exact netem settings/seeds are in `content-node/wan-regression.sh`. A shorter
16 MiB preliminary run also missed the lossy 300 ms UDP threshold (13.54 Mbps).
The standard-size run therefore does not support calling this matrix fully
passing. These are separate runs with different loss patterns by protocol where
shown; only the paired burst cases use the same impairment settings. Development
work shared the host, so small differences are not statistically controlled.

## Browser transfer measurements

The final Playwright run downloaded and verified 12 MiB through the real service
worker and Go node. These are local transfers, with ranges across the CDN and
bundled carriers; they are smoke measurements, not WAN capacity estimates.

| Browser | UDP Mbps | TCP Mbps |
| --- | ---: | ---: |
| chromium | 114.5–162.9 | 124.1–132.5 |
| firefox | 114.0–119.8 | 112.6–132.1 |
| webkit | 145.9–147.8 | 130.4–134.2 |

The tiny image fixture loaded cold in 4.5–13.0 ms and warm in 0.0–1.0 ms.
Warm timing may include the browser decoded-image cache; this is not a benchmark
of real game artwork. Separate CacheStorage assertions and source-file removal
verify persistent reuse. Downloads, gzip decoding and 4 MiB uploads are checked
for byte integrity; startup and forced ownership handoff affect upload timings.

## Remaining speed improvements, in priority order

1. **Use freshness headers and targeted invalidation for stable images and
   game manifests.** This avoids transfer and validation RTTs entirely while
   allowing deliberate updates. Hash/version large game payload URLs and let
   their existing OPFS cache own those bytes. The supplied static cache-rule
   configuration implements this without changing application asset formats.
2. **Investigate the lossy, high-RTT UDP case.** Profile SCTP recovery, retransmit
   timers, SACK timing, congestion-window evolution and receiver-window pressure
   using the same netem seed. Keep Reno as a rollback and compare under loss,
   burst loss and reordering before changing CUBIC behavior. Raising all windows
   globally increases per-peer memory and is not a demonstrated fix.
3. **Compare a warmed TCP route before promoting it.** The existing adaptive
   fallback detects slow UDP, but successful TCP connection establishment does
   not prove TCP is faster. Reuse a bounded probe only after the slow-path signal,
   with a meaningful win margin and cancellation. Keep current requests/sockets
   on their original route; never replay application mutations.
4. **Precompress immutable large text/WASM at deployment time.** The node already
   caches small gzip representations and streams large ones. Validated sidecars
   could avoid recompressing large popular games per visitor. Tie sidecars to a
   content hash and preserve uncompressed range semantics before enabling them.
5. **Reduce network packet-path work where profiles justify it.** A 64 MiB UDP
   profile attributed 24.45% of sampled CPU to syscalls. DTLS encryption, incoming
   packet handling, record marshaling and application-data copies were major
   allocation sources (roughly 9–10% each). The profile includes both local peers
   and fixture setup, so these are investigation targets, not server-only costs.
   Four lanes share one association and bandwidth; more lanes or larger frame queues are not
   independent capacity. Profile UDP syscalls, DTLS/SCTP parsing/allocation and
   TCP/SCTP head-of-line stalls before tuning. Keep bounds for slow consumers.

No browser stack can make all networks equally fast. Available bandwidth, RTT,
loss, browser CPU, server load and storage latency remain external constraints.

## Validation and reproducibility

- TypeScript typecheck and 255 compiled unit/integrity tests passed.
- Go content-node tests and race detector passed.
- Fourteen carrier build/UI tests passed, including integrity rejection and the
  three-second explicit Continue gate.
- Playwright tests exercise all five client fallback positions and all five
  classic-worker fallback positions in Chromium, Firefox and WebKit. They also
  use real CacheStorage and IndexedDB for cookie scope/memory storage and
  invalidation during an unfinished response.
- A real Firebase Database emulator plus Playwright verified simultaneous
  authenticated RTDB exchanges and denied forged answers using the checked-in
  rules. It exposed the empty-array normalization bug that mocked tests missed.
- The full browser-to-Go matrix covers all three engines, UDP/TCP, and signed-CDN
  and bundled carriers: 12 combinations. It checks download/upload digests,
  gzip decoding, escaped filenames, image reuse, validators/304, private cache
  opt-out, tagged payload opt-in, targeted/full clears, credential omission,
  worker upgrades and standby-tab ownership during upload.
- [Live CDN browser probe](cdn-probe-2026-09-18.json) records CORS fetch results and
  SHA-256 for the published client, classic worker and font. Availability is
  time- and network-dependent. All five returned identical client, worker and font bytes in Chromium. An earlier command-line ZStatic request returned 403; that did not reproduce in the browser.

Useful commands (run from the repository root unless shown):

```sh
npm run typecheck
npm test
cd content-node
GOCACHE=/tmp/yurirtc-go-cache go test -race ./...
YURIRTC_BROWSER_E2E=1 YURIRTC_BROWSER_E2E_ENGINES=chromium,firefox,webkit go test -count=1 -run TestBrowserV3EndToEnd -v
GOCACHE=/tmp/yurirtc-go-cache go test -run '^$' -bench BenchmarkWireGzipWorkspace -benchtime=2s -count=3
cd ..
./content-node/wan-regression.sh --full
node tools/cdn-probe.mjs 0.5.3
# With a local Firebase Database emulator listening on port 19000:
YURIRTC_RTDB_EMULATOR=http://127.0.0.1:19000 node --test deploy/npm/test/transport-features.e2e.test.mjs
```

No npm publication, Firebase rule deployment, server restart, carrier upload or
EDUrocks5 vendor synchronization was performed. Memory-only sessions and static
cache rules require choosing the documented configuration when deploying.
