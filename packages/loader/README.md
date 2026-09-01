# YuriRTC browser transport

This package is YuriRTC's browser client and service worker, published as
`@advwebrec/grainloading`. Existing carriers select an immutable version through the
separately signed `shaintloadingcheckpak` pointer.

The published package contains only obfuscated browser bundles, a self-contained
type declaration, and the ROT13 display font. Readable TypeScript lives in the
YuriRTC source repository. Obfuscation is a distribution deterrent, not a
security boundary.

New TypeScript consumers should use `YuriRTCClient` and `YuriRTCConfig`.
`LoaderClient` and `LoaderConfig` remain compatibility aliases for existing
integrations.

The loader implements YuriRTC wire protocol v3. It negotiates the interactive
lane first, then establishes all four lanes before the initial application
waterfall. Lanes 1-3 retire after 15 seconds without asset work and reopen on
demand. The transport uses 128 KiB frames, streams Fetch request bodies through
transferable streams, and bounds both directions with consumption-driven
credits. A loader that changes the wire version must be published only after a
compatible content node is deployed.

Lane 0 carries navigations, API/mutation traffic, and carried WebSockets. Lane
1 is reserved for small render-critical scripts, styles, fonts, and documents.
Normal and incremental assets use lanes 2 and 3 with one active start per lane
and FIFO admission, so a large game payload cannot occupy every ordered stream
ahead of bootstrap files. The lanes share one ICE/DTLS/SCTP association and
congestion window; they separate scheduling and SCTP stream ordering rather
than creating four network connections.

When a restarted worker discovers several controlled tabs, the first completed
attachment becomes the carrier and later responders remain live standbys. Wake
discovery never crosses into pages still controlled by a predecessor worker, so
an in-place upgrade cannot cancel that older worker's valid transfers.

Without an unexpired session preference, the loader connects ordinary ICE and
forced TCP in parallel. Once both are ready, each receives the same private,
incompressible 1 MiB probe. TCP is selected only when it is at least 15 percent
faster; if only one route connects, that route is used. An older node that does
not return the exact probe marker safely leaves ordinary ICE selected. The
result is remembered for ten minutes and cleared after a network change.

On a selected UDP route, the page aggregates response bytes across concurrent
GETs after the first body frame arrives. If at least 8 MiB over at least four
seconds remains below 15 Mbit/s, it warms one TCP-only connection without
detaching UDP. Once TCP is ready, new requests use it while existing HTTP
requests and carried WebSockets drain on their original route; the predecessor
is retired only after that drain. A failed warm-up leaves the working UDP route
untouched. The thresholds can be tuned, or the behavior disabled, without
changing the wire:

```ts
transport: {
  adaptiveTcp: {
    enabled: true,
    minBytes: 8 * 1024 * 1024,
    minSampleMs: 4_000,
    maxGoodputMbps: 15
  }
}
```

Candidate filtering uses standard SDP and `RTCIceCandidateInit` data and does
not patch browser APIs, so the baseline and forced-route paths remain usable in
Chrome, Firefox, and Safari. Browsers that cannot report a selected pair keep
ordinary ICE behavior and simply skip the optional goodput recommendation.

A self-contained carrier may set `recovery.clientUrls` to durable module URLs.
The loader persists those ahead of its own `import.meta.url` and the two npm CDN
fallbacks, allowing service-worker-injected documents to recover from a
same-origin `client.js` even when the first client was imported from a temporary
inline Blob.

For eligible complete static GET responses, a capable browser sends
`x-yurirtc-accept-wire-encoding: gzip`; the node marks compressed transport
bytes with `x-yurirtc-wire-encoding: gzip`. These are private YuriRTC hop
headers, not HTTP `Accept-Encoding` or `Content-Encoding`, and the loader strips
them after decompression. Browsers without `DecompressionStream("gzip")` omit
the capability. Range, API, SSE, already-compressed media, and `no-transform`
responses remain unencoded.

The service worker also gives unknown static paths conservative, bounded cache
reuse instead of assuming EDUrocks-specific names. It sends `If-None-Match`
and `If-Modified-Since` for stored validator-backed responses, combines a 304
with the stored body, and can use that body as an offline fallback. It never
admits authenticated, ranged/partial, event-stream, `no-store`, `private`, or
`Vary: *` responses; a 404, 410, or newly non-storable answer invalidates an
older fallback.

The font in `dist/assets/rot13.woff` is derived from Google Sans and is licensed
under the SIL Open Font License 1.1; its license text is shipped beside it as
`dist/assets/OFL.txt`.

“Google” and “Google Sans” are trademarks of Google LLC. The font is exposed to
the shell under the distinct CSS family name `YuriRTCDisplay`; this project is
not endorsed by Google LLC.
