# YuriRTC manual port tester (local-only)

A developer harness for answering, from a given network: **"does the content
node reach me on port _N_ over UDP / TCP?"**

Normally the carrier lets ICE pick whichever of the node's advertised
`UDP+TCP × {443,80,5228,5229,5230,5223,2197,53,123,49152,445}` routes works
first. This page instead lets you **pin one port + protocol** and test each
route by itself, so you can build up a matrix of what a network actually
permits.

## Not published

This lives under `tools/` on purpose. It is **not** in the `learnmathedu`
package (`files: ["index.html","sw.js"]`) or the loader package, so it is never
bundled, obfuscated, or published to npm or anywhere else.

## Run

WebRTC and the Firebase signaling calls need a secure context; `localhost`
counts, `file://` does not.

```bash
node tools/port-tester/serve.mjs        # → http://localhost:8787/port-test.html
```

Open the printed URL in Chrome.

## How it pins a route

The node advertises its server candidates twice — embedded in the answer SDP
and as an explicit candidate list. Before booting the transport, the page
patches `RTCPeerConnection.prototype.setRemoteDescription` and `.addIceCandidate`
so that, for one test, every **server** candidate that is not the selected
`port + protocol` is stripped from the SDP and rejected from `addIceCandidate`.
ICE is then left with exactly one server endpoint:

- it connects on that route → **connected** (the "Route used" column is read
  back from the selected ICE candidate pair, confirming the real port), or
- nothing pairs → **failed** (that route is blocked/closed from here).

Your browser's own local candidates are never filtered. No service worker and
no app iframe are involved — it uses `YuriRTCClient.connect()` with no
registration, which the client explicitly supports for exactly this kind of
single-file diagnostic.

## Controls

- **UDP / TCP** — protocol for the port grid.
- **Port grid** — click a port to pin+test that one route.
- **Test port** — pin+test an arbitrary custom port.
- **Run all (current protocol)** — walk every known port sequentially.
- **Discover offered routes** — connect unpinned and list every server
  candidate seen; each becomes a clickable chip to re-test.
- Results (with the read-back route, latency, and signaling backend) persist in
  `localStorage`; **Clear results** resets them.

The config baked into the page is the public Firebase **web** config that
already ships in the carrier (`.env.release`). To point the tester at a
different deployment, edit the `config` / `LOADER_VERSION` constants at the top
of the `<script>` in `port-test.html`.
