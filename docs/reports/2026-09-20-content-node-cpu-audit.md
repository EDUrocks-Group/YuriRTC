# Content-node CPU audit — 2026-09-20

The best immediate candidates are remembering unsuccessful compression attempts,
precompressing large immutable assets, and reusing a rotating server certificate.
For sustained transfers, the largest measured opportunity is below YuriRTC's
application framing: packet writes, cancellation machinery and DTLS buffers.

This follow-up changes **benchmark instrumentation and documentation only**.
It does not enable these candidates in production. Previous task changes remain
in the working tree. Measurements below were collected during this investigation
on September 18; the report was completed September 20. No deployment occurred.

## What was measured

Real Pion-to-Pion transfers through the actual node handler, 64 MiB per request,
64 response credits, batches of eight, five measured iterations per protocol.
The benchmark also performs its one-iteration calibration and setup. CPU profiles
include those phases. Machine: Xeon E5-2667 v4, Go 1.25.13, seven Go execution
threads. The local client competes for the same CPU; these are not capacity
estimates for a dedicated production server.

Server transport creation and offer handling now carry a `side=server` pprof
label. Descendant goroutines inherit it, allowing the server's samples to be
separated from the in-process client. Shared GC/scheduler work may remain
unattributed; this is **server-labelled CPU**, not complete process accounting.
Heap profiles cannot be separated using these labels. This follows the
[Go profiling-label contract](https://pkg.go.dev/runtime/pprof#Do).

| Current path | Measured throughput | Server-labelled CPU samples | Syscalls, flat share | Application `StreamBody`, cumulative share |
| --- | ---: | ---: | ---: | ---: |
| UDP | 282.8 Mbps | 17.20 CPU-seconds | 29.30% | 3.55% |
| TCP | 258.2 Mbps | 12.06 CPU-seconds | 38.23% | 3.73% |

Percentages use server-labelled samples as denominator. Cumulative categories
contain their callees and must not be added together. `StreamBody` queues data;
most transmission happens asynchronously below it. Syscalls include more than
network sends, but `sendto` alone accounts for 26.40% on UDP and `write` for
32.59% on TCP. The results do not show that forcing TCP saves CPU on all networks.

Existing good decisions: direct reads into pooled 128 KiB frames, bounded
backpressure without a busy-poll timer, batched credits, one SCTP association,
shared gzip cache builds, pooled gzip workspaces, and aggregate health logging
once per minute. Tuning JSON headers or the per-frame counters is unlikely to
beat eliminating work performed for each roughly MTU-sized network packet.

## Recommended implementation order

### 1. Remember the decision not to compress an unchanged asset

[`wireGzipCache.load`](../../content-node/static_wire.go) only stores successful
compressed results. An eligible WASM/text asset that fails the savings test is
read and compressed again for every subsequent request. This work precedes the
response headers. Concurrent requests share a flight; later requests do not.

An audit-only benchmark uses the existing implementation on deterministic,
entropy-heavy 2 MiB data, then compares a remembered rejection:

| Repeated request preparation | Time per operation, three runs | Allocations |
| --- | ---: | ---: |
| Current rejected compression | 17.24–18.23 ms | about 4.68 MB / 13–14 allocations |
| Prototype rejection lookup | 86–96 ns | zero |

These are elapsed microbenchmark times, not whole-request CPU percentages.
Both alternatives choose the same original uncompressed representation. The
prototype is deliberately a one-key map, not a deployable cache. Production
should store `use=false` against the existing path/size/mtime identity in a
bounded LRU, evict stale identities, cap entry count as well as bytes, and never
cache read errors or cancellations. The first request still pays the probe cost.

This removes repeated preparation work without changing transmitted bytes or
flow control. Benefit depends on the actual asset corpus; the fixture does not
establish how many production assets are incompressible. Also add a path index
if insertion profiles warrant it: `storeLocked` currently scans all entries to
remove prior identities of one path.

### 2. Precompress popular immutable large files during deployment

Files above 32 MiB are gzip-streamed for each request. Results above the 8 MiB
compressed-entry limit also do not remain in the memory cache. Encoder pooling
from the previous task saves setup but does not eliminate compression itself.

Generate gzip sidecars at build/deploy time for suitable WASM, JSON, JS and text.
Select them through a trusted manifest tying the sidecar to the original content
hash, length and encoding. Keep original range semantics, `no-transform`, HEAD,
validators and client wire-encoding negotiation. Publish original and sidecar
atomically. Stream the precompressed bytes using bounded reads; do not load all
large assets into RAM. Preserve a dynamic fallback when the sidecar is absent.

This moves repeatable CPU work off the request path while preserving compressed
wire delivery. Measure disk throughput and first-byte latency; simply disabling
gzip would reduce CPU but can make slow-network users substantially slower.
No sidecar performance gain was measured in this follow-up.

### 3. Reuse a rotating certificate for connection creation

[`answerOffer`](../../content-node/main.go) passes an empty certificate list.
The pinned Pion implementation consequently generates a P-256 key and signs a
certificate per new peer. Pion supports supplying a certificate through
[`Configuration.Certificates`](https://pkg.go.dev/github.com/pion/webrtc/v4@v4.2.18#Configuration).

| Local peer creation plus close | Time per operation | Allocated bytes |
| --- | ---: | ---: |
| Fresh certificate | 0.694–0.743 ms | about 44.3 KB |
| Reused certificate | 0.129–0.134 ms | about 26.4 KB |

The median reduction is approximately 82% for this specific local operation,
about 0.61 ms saved per new connection. It is **not** an 82% reduction in full
handshake time or ongoing connection CPU. A reconnect storm benefits more than
a long-lived game session.

Generate at startup, rotate before expiry, supply an immutable certificate to
new peers, and let existing peers retain the old one. Keep each connection's
DTLS session keys and fingerprint verification. Certificate reuse creates a
shared server identity/key lifetime; rotation and private-key ownership need
explicit treatment. The benchmark does not exercise network handshakes with
reuse, so browser/reconnect coverage is still required before enabling it.

### 4. Remove per-packet cancellation goroutine churn in Pion

The pinned [DTLS `Conn.Write`](https://github.com/pion/dtls/blob/v3.1.5/conn.go)
calls `contextWithClose`, which starts a goroutine and creates channels for each
write. The downstream [transport `WriteToContext`](https://github.com/pion/transport/blob/v4.0.2/netctx/packetconn.go)
starts another goroutine, a channel and a wait group. This happens for network
packets, not just once per 128 KiB application frame.

The DTLS context constructor and its watcher consume about 5.52% of labelled
UDP samples and 3.98% of TCP samples combined. This excludes other scheduler/GC
costs and is not a promised recoverable percentage. `WriteToContext` cumulative
cost includes the socket write and cannot all be attributed to its watcher.

Prototype connection-lifetime cancellation machinery or an appropriate
context-aware fast path in Pion. Preserve deadline changes, concurrent close,
blocked writes and reads, partial writes and teardown. Replacing the watcher
with an arbitrary `context.AfterFunc` is not automatically cheaper: custom
contexts can still require a bridging goroutine. Prefer an upstream change or
a small reviewed patch with dedicated cancellation/race tests.

### 5. Reduce DTLS buffer copies, then batch already-ready packets

The checked-in SCTP fork already pools packet buffers and serializes DATA
straight into them. Downstream, `ApplicationData.Marshal` copies the payload,
`RecordLayer.Marshal` copies it again with a header, and AEAD allocates the
ciphertext output. Record marshaling accounts for about 4.13% of labelled UDP
CPU and 6.22% for TCP, including its allocation/copy callees. AEAD encryption
is another overlapping call-chain category, not something to disable.

An application-data-specific marshal-into-buffer path can avoid intermediate
copies while preserving AEAD authentication, unique nonces, replay protection
and the retransmission buffer's ownership. Pooling must release buffers only
after synchronous transport consumption, including error and cancellation paths.
This requires dependency work and byte-level/round-trip/race tests.

For syscalls, investigate UDP batch sends and TCP vectored/coalesced writes for
packets already ready in SCTP's outbound batch. Keep UDP datagram boundaries
and ICE-TCP record framing. Flush interactive traffic immediately; do not add a
fixed wait to fill a batch. Bound batch size and preserve pacing/fairness so
CPU savings do not create bursts, loss or head-of-line delays. This spans
SCTP/DTLS/ICE; it is not a one-line socket option. No gain is claimed yet.

## Protect user speed while testing

Use server CPU-seconds per delivered GiB, allocations per delivered GiB, p50/p95
first-byte latency and completed-transfer Mbps together. Separate idle peers,
new handshakes, active downloads, uploads and small WebSocket/API messages.
There is no single meaningful fixed CPU cost per connection.

The active-transfer profiles do not measure idle-peer capacity or production
traffic mixes. ICE currently retains its keepalive/consent machinery; stretching
those timers or closing idle peers aggressively could make resume/reconnect
slower. Changing credit windows, turning off compression/encryption, inflating
MTU, or increasing GC thresholds blindly is not an established speed-preserving
CPU optimization.

For each production candidate, compare baseline/candidate in alternating runs
on an otherwise idle server with the client on a separate host. Cover low and
high RTT, random/burst loss, concurrent peers, interactive traffic during bulk
transfer, all three Playwright engines, and both UDP/TCP. Retain byte-integrity,
backpressure, cancellation and reconnect assertions. The earlier 300 ms lossy
UDP case already misses its throughput target; do not hide that baseline issue.
Require a repeatable CPU reduction with no meaningful throughput or tail-latency
regression before promotion. The current measurements cannot certify that for
unimplemented candidates.

## Reproduce and review

- Added [`cpu_audit_test.go`](../../content-node/cpu_audit_test.go): isolated
  certificate and negative-compression decision benchmarks.
- Updated [`loopback_bench_test.go`](../../content-node/loopback_bench_test.go):
  server goroutine profiling labels; production transport is unchanged.
- Saved [benchmark results and profile summaries](2026-09-20-content-node-cpu-results.txt).
- Go tests including the race detector passed. Real UDP and TCP benchmarks
  passed. No new browser run was needed for these test-only changes; browser
  interoperability for the proposed runtime changes remains to be tested.

```sh
cd content-node
GOCACHE=/tmp/yurirtc-go-cache go test -race ./...
go test -run '^$' -bench 'BenchmarkPeerCertificateReuse|BenchmarkRejectedCompressionDecision' -benchtime=1s -count=3
# Repeat this profile command with tcp in place of udp:
go test -run '^$' -bench '^BenchmarkLoopbackDownload/udp/64MiB-credit64-refill8$' -benchtime=5x -cpuprofile=/tmp/node-udp.prof -o /tmp/node-cpu-audit.test
go tool pprof -top -relative_percentages -tagfocus=side=server /tmp/node-cpu-audit.test /tmp/node-udp.prof
```
