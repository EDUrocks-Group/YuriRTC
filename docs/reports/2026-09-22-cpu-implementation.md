# CPU implementation — 2026-09-22

This implements the follow-up to the September 20 CPU audit. Changes are local;
no content server, Firebase rules, npm packages, or carriers were deployed.

## Implemented

1. **Bounded negative compression caching.** Successful decisions to send the
   original representation are retained by source identity, so later requests
   do not repeat an unsuccessful gzip probe. Errors and canceled builds are
   excluded. Both positive and negative entries share a 4,096-entry limit;
   compressed bytes retain the 64 MiB limit. A path index replaces the scan over
   all entries when one file's identity changes.
2. **Verified offline sidecars.** `--precompress-out` generates content-addressed
   gzip files and atomically publishes a manifest outside the public site root.
   `--precompressed-dir` / `YURIRTC_PRECOMPRESSED_DIR` enables startup verification
   of original hashes, gzip hashes, and decoded bytes. Requests stream verified
   sidecars without hashing/compression. Identity changes trigger normal handling.
   Ranges, HEAD, validators, private wire negotiation, and no-transform remain.
3. **Rotating certificate reuse.** The peer registry shares an immutable
   certificate, warmed at startup and refreshed daily for new peers or before
   expiry. Existing peers retain their identities and independent session keys.
4. **Less DTLS allocation and scheduling.** Application writes reuse one
   cancellation context per deadline generation. Packet-context I/O registers
   cancellation callbacks instead of creating a watcher goroutine per packet.
   Racing callbacks complete before socket deadlines are reset. Application-data
   records marshal into one owned buffer rather than an intermediate payload
   copy plus a record copy.
5. **Bounded ready-packet batching.** SCTP detects the optional synchronous DTLS
   WriteBatch method and submits at most eight already-ready packets together.
   There is no batch-fill timer or new queue. DTLS retains record boundaries and
   only combines records when the existing MTU allows. Records too large to
   combine are not recopied. Errors terminate the association and release buffers.

The batching optimization amortizes record preparation/locking and can combine
small ready records. It does **not** implement Linux sendmmsg or enlarge DTLS/UDP
packets to force fewer syscalls. Large records still produce separate writes.
That deeper socket work remains a possible future improvement, not an enabled
or measured feature of this change.

The two new dependency snapshots preserve exact upstream code/licenses and tests:
[Pion DTLS v3.1.5](../../third_party/pion-dtls/YURIRTC.md) and
[Pion transport v4.0.2](../../third_party/pion-transport/YURIRTC.md). The existing
[SCTP fork](../../third_party/pion-sctp/YURIRTC_FORK.md) adds the optional batch call.
CI exercises the modified dependencies and WAN workflow paths include them.

## Paired CPU and throughput measurements

The saved pre-change test executable and candidate executable ran the same
64 MiB, 64-credit, refill-eight loopback benchmark with five measured iterations
per protocol. CPU profiles also include benchmark calibration/setup. Runs were
sequential, with UDP before/after and TCP after/before to vary ordering. The
client runs on the same host. Results are local software measurements, not a
prediction of production bandwidth or a guarantee on every network.

| Protocol | Server-labelled CPU before → after | Reduction | Transfer Mbps before → after |
| --- | ---: | ---: | ---: |
| UDP | 12.90 → 9.81 CPU-seconds | 24.0% | 403.9 → 454.6 |
| TCP | 13.70 → 10.59 CPU-seconds | 22.7% | 316.0 → 429.1 |

The workload is identical per pair. Labels exclude the client but do not capture
all shared scheduler/GC work. Both endpoints use the selected dependency graph,
so use the browser tests to check interoperability rather than treating the
Pion client as a browser. Earlier shorter runs also improved throughput, but
background test activity makes those unsuitable for precise effect sizes.
These figures describe the combined packet changes; they do not attribute a
percentage saving independently to batching, context reuse, or marshaling.

## Request-preparation measurements

These isolate local preparation, excluding the network and startup verification.
Three one-second runs per alternative used the same input bytes. The sidecar
fixture is 45,600,000 bytes (43.49 MiB) of repetitive JSON; its benefit is not a
prediction for already-compressed games or production asset distributions.

| Operation | Baseline | Implemented path |
| --- | ---: | ---: |
| Repeat rejected gzip probe, 2 MiB | 16.7–17.5 ms; 4.68 MB allocated | 49–111 ns; zero allocated |
| Large asset preparation/consumption, 43.49 MiB | Dynamic gzip: 53.8–89.8 ms | Verified sidecar: 0.105–0.130 ms |
| Local peer creation plus close | Fresh certificate: 0.482–0.687 ms | Reused certificate: 0.123–0.131 ms |

Sidecars keep compressed delivery and reduce encoded size on this fixture by
using offline level-9 compression. The benchmark discards transmitted bytes;
it is not an end-to-end download-speed multiplier. Certificate measurements
exclude the network handshake. Host activity affected the ranges; use these as
work-elimination evidence rather than precise production estimates.

## Deployment

Normal server rebuilds enable the cache, certificate, and packet-path changes.
Offline sidecars require generating and selecting an immutable sidecar release;
see [configuration and commands](../CACHE-AND-CDNS.md#cpu-efficient-delivery-and-offline-compression).
Startup verification reads/decompresses the configured assets once and may add
startup time for large releases. Avoid in-place file edits preserving timestamps;
publish new immutable release directories and restart the node.

## Verification

- Go content-node and modified dependency tests passed with the race detector.
- Focused cancellation/reset, concurrent certificate reuse/rotation, negative
  cache bounds/error handling, sidecar corruption/fallback, and HTTP semantics
  tests passed. `go vet` passed for the node and changed dependency packages.
- All 12 Playwright combinations passed: Chromium/Firefox/WebKit, UDP/TCP,
  signed-CDN/bundled carriers. The fixture now generates and verifies sidecars
  before running gzip byte-integrity, upload, cache, upgrade and ownership checks.
- All nine existing full WAN thresholds passed without changing any thresholds.
  The browser and WAN integration runs shared this host; their timing is not
  controlled enough to assert a precise latency improvement.

| WAN scenario | Mbps | Existing minimum |
| --- | ---: | ---: |
| UDP clean, 128 ms | 47.47 | 35 |
| UDP random loss, 128 ms | 14.41 | 14 |
| TCP random loss, 128 ms | 35.81 | 14 |
| UDP clean, 300 ms | 22.57 | 14 |
| UDP random loss, 300 ms | 19.16 | 14 |
| UDP burst loss, 128 ms | 5.40 | 4 |
| TCP burst loss, 128 ms | 35.08 | 20 |
| UDP reordering, 128 ms | 47.28 | 14 |
| UDP three lanes with random loss, 128 ms | 21.87 | 20 |

The 128 ms random-loss UDP result differed noticeably from the previous audit,
so a sequential before/after/after/before comparison repeated that exact netem
case after the other checks finished. Baseline results were 14.07 and 40.64 Mbps;
candidate results were 32.15 and 26.97 Mbps. The wide baseline variation prevents
attributing individual-run differences to this patch. These runs do not establish
a consistent regression, but neither they nor any finite matrix guarantee the
same performance on every network. Keep production CPU/GiB and p95 latency
monitoring during rollout.

[Saved results](2026-09-22-cpu-results.txt) include benchmark outputs, labelled
CPU summaries, WAN results, browser case counts and race-test output.
Reproduce the key checks from `content-node`:

```sh
env GOCACHE=/tmp/yurirtc-go-cache go test -race ./... github.com/pion/dtls/v3/... github.com/pion/transport/v4/netctx/... github.com/pion/sctp/...
env GOCACHE=/tmp/yurirtc-go-cache go vet ./... github.com/pion/dtls/v3 github.com/pion/transport/v4/netctx github.com/pion/sctp
env GOCACHE=/tmp/yurirtc-go-cache YURIRTC_BROWSER_E2E=1 YURIRTC_BROWSER_E2E_ENGINES=chromium,firefox,webkit go test -count=1 -run TestBrowserV3EndToEnd -v
env GOCACHE=/tmp/yurirtc-go-cache go test -run '^$' -bench 'BenchmarkRejectedCompressionDecision|BenchmarkLargePrecompressedAsset|BenchmarkPeerCertificateReuse' -benchtime=1s -count=3
cd ..
env GOCACHE=/tmp/yurirtc-go-cache ./content-node/wan-regression.sh --full
```
