# YuriRTC static carrier

This package's npm name is a distribution coordinate retained for existing CDN
and deployment links. The package contains the two path-portable files a
static host needs: `index.html` and `sw.js`.

The release pipeline also produces `bundled/`, a CDN-independent loader
variant for networks that cannot reach jsDelivr or unpkg. Its `index.html`
contains the exact current loader client and display font inline; `sw.js` is
the full same-version loader worker, and the colocated `client.js` is the
durable recovery module used by transported documents. Upload all six files in
that directory together. `LICENSE`, `FONT-LICENSE.txt`, and `SOURCE.txt` carry
the notices required by the bundled AGPL loader and font.

Build a non-deployable placeholder artifact with `npm run build`. A release
build requires these environment variables:

- `YURIRTC_FIREBASE_API_KEY`
- `YURIRTC_FIREBASE_PROJECT_ID`
- `YURIRTC_FIREBASE_DATABASE_URL`

The former `FIREBASE_*` spellings remain accepted as compatibility aliases.
The resulting JavaScript is heavily minified and obfuscated, visible DOM copy
remains ROT13-encoded, and UI icons use Google's hosted Material Symbols
stylesheet without glow effects. The carrier verifies the ECDSA-signed
`shaintloadingcheckpak` pointer and SHA-256 of the immutable `@advwebrec/grainloading`
client before execution. Signature or hash failures require a three-second
explicit continuation; complete CDN failure shows the support message.

## Carrier network-state API

The loader reports connection state without exposing ICE candidates or network
addresses:

```js
window.dispatchEvent(new CustomEvent("yurirtc:network-state", {
  detail: {
    state: "connected",
    route: { transport: "udp", portClass: "standard" }
  }
}));
```

`state` is `testing`, `connected`, `disconnected`, or `unavailable`. A classified
connected route uses `udp` or `tcp` and a `portClass` of `standard` (a configured
non-443 port) or `443`. A disconnected update may include bounded numeric
`attempt` and `retryInMs` values so the carrier can display automatic retry
feedback. Every other field is ignored and must never be rendered or logged.

When Chrome has connected but has not yet exposed the selected pair in stats,
the loader may report `unknown` for either coarse field. The carrier reveals the
application with a neutral “route unknown” value and no selected tier; it never
falls back to displaying candidate details.

The reconnect button emits a cancelable `yurirtc:reconnect-request` event whose
detail is exactly `{ reason: "manual" }`. Automatic retry remains owned by the
loader; it should emit `testing` when the next attempt begins. A loader that
handles the manual request must call `preventDefault()` on the event. If no
handler accepts it, the carrier safely reloads its own path as a fallback.

Release builds stamp both generated files with opaque source fingerprints.
`verify:package` rejects a stale pair, a placeholder/development build, or files
built before the current loader/package versions. Rebuild with the production
Firebase web configuration before verification and upload `index.html` and
`sw.js` together.

`npm run build:release:bundled` creates the alternate carrier under `bundled/`,
and `npm run verify:bundled` verifies its inline client, durable client, full
worker, font, notices, loader version, and source fingerprints. “Current” means
the loader version in this checkout at build time; the bundled carrier does not
follow an npm dist-tag after upload, so rebuild and redeploy it for each loader
release. The normal npm package remains the signed-CDN two-file carrier and is
unchanged by this alternate artifact.
