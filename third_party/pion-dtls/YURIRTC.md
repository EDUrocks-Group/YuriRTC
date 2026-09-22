# YuriRTC DTLS fork

Complete source snapshot of github.com/pion/dtls/v3 v3.1.5, retaining upstream
MIT licensing and tests. Selected only by content-node/go.mod. Local changes:

- One cancelable application-write context per connection/deadline generation;
  expiry and close retain their distinct errors, and resetting an expired
  deadline creates a fresh generation.
- Application-data records marshal into one owned buffer, removing the separate
  payload-copy allocation. Handshake/CID/cryptographic semantics are retained.
- Synchronous WriteBatch accepts at most eight ready records per write-lock
  acquisition. It introduces no fill timer, preserves DTLS record boundaries,
  and only coalesces records when they fit the existing MTU. Large data packets
  still use individual socket writes; this is not UDP sendmmsg batching.
- compactRawPackets avoids copying records that cannot be coalesced.
- Focused context generation, ownership, and batch record tests.

No cipher, replay check, nonce, SCTP flow-control window, or UDP MTU was weakened.
The transport fork's context.AfterFunc path is important: a custom deadline
context alone would reintroduce per-packet bridging goroutines.

Validate using the content node's dependency graph and pinned toolchain:

```sh
cd content-node
go test -race github.com/pion/dtls/v3/... github.com/pion/transport/v4/netctx/...
go test -race ./...
YURIRTC_BROWSER_E2E=1 YURIRTC_BROWSER_E2E_ENGINES=chromium,firefox,webkit go test -count=1 -run TestBrowserV3EndToEnd -v
```

Rebase by comparing against the exact upstream tag, retaining only these patches,
then rerun dependency, browser and WAN tests plus CPU/throughput comparisons.
