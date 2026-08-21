# YuriRTC browser transport

This package is YuriRTC's browser client and service worker. Its npm name is a
distribution coordinate and stays unchanged across releases so existing bucket
pages and installed workers continue to update.

The published package contains only obfuscated browser bundles, a self-contained
type declaration, and the ROT13 display font. Readable TypeScript lives in the
YuriRTC source repository. Obfuscation is a distribution deterrent, not a
security boundary.

New TypeScript consumers should use `YuriRTCClient` and `YuriRTCConfig`.
`LoaderClient` and `LoaderConfig` remain compatibility aliases for existing
integrations.

The loader implements YuriRTC wire protocol v3. It keeps one interactive
channel open, opens three asset channels only while needed, uses 128 KiB frames,
streams Fetch request bodies through transferable streams, and bounds both
directions with consumption-driven credits. A loader that changes the wire
version must be published only after a compatible content node is deployed.

When a restarted worker discovers several controlled tabs, the first completed
attachment becomes the carrier and later responders remain live standbys. Wake
discovery never crosses into pages still controlled by a predecessor worker, so
an in-place upgrade cannot cancel that older worker's valid transfers.

The font in `dist/assets/rot13.woff` is derived from Google Sans and is licensed
under the SIL Open Font License 1.1; its license text is shipped beside it as
`dist/assets/OFL.txt`.

“Google” and “Google Sans” are trademarks of Google LLC. The font is exposed to
the shell under the distinct CSS family name `YuriRTCDisplay`; this project is
not endorsed by Google LLC.
