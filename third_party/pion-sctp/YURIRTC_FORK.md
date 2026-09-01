# YuriRTC Pion SCTP fork

This directory is a complete source copy of `github.com/pion/sctp` v1.11.1.
`content-node/go.mod` selects it with a local `replace`, so a clean checkout
builds the exact transport code without fetching a private fork or relying on
an uncommitted module cache.

YuriRTC-specific changes are intentionally limited to:

- RFC 9438 CUBIC congestion avoidance with the original Reno controller kept
  as the zero-value fallback;
- RFC 7053 Immediate-SACK requests during CUBIC's low-window recovery;
- one owned message copy shared by all of its DATA fragments, instead of one
  separately allocated payload per fragment;
- direct DATA serialization into a bounded, process-wide packet-buffer pool,
  eliminating steady-state packet marshal allocations while preserving the
  synchronous `net.Conn.Write` ownership boundary; and
- focused controller, compatibility, I-bit, allocation, and benchmark tests.

The existing Pion API cannot select a controller through WebRTC. The fork
therefore reserves `CwndCAStepUseCUBIC` as an internal compatibility selector
for `SettingEngine.SetSCTPCwndCAStep`; ordinary numeric CA steps still select
Reno exactly as upstream callers expect.

Before updating the upstream base, diff this directory against the proposed
Pion tag, reapply only the changes above, and run:

```bash
(cd third_party/pion-sctp && go test -race ./... && go vet ./...)
(cd content-node && go test -race ./... && go vet ./...)
./content-node/wan-regression.sh --full
```

The upstream MIT license and notices are retained in this directory.
