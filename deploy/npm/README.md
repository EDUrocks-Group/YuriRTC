# YuriRTC static carrier

This package's npm name is a distribution coordinate retained for existing CDN
and deployment links. The package contains the two path-portable files a
static host needs: `index.html` and `sw.js`.

Build a non-deployable placeholder artifact with `npm run build`. A release
build requires these environment variables:

- `YURIRTC_FIREBASE_API_KEY`
- `YURIRTC_FIREBASE_PROJECT_ID`
- `YURIRTC_FIREBASE_DATABASE_URL`

The former `FIREBASE_*` spellings remain accepted as compatibility aliases.
The resulting JavaScript is obfuscated, visible DOM copy is ROT13-encoded, and
the sole display font follows the YuriRTC loader package's `latest` tag. The
release gate verifies that both CDNs serve the exact font bytes before the
carrier package is published.

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
