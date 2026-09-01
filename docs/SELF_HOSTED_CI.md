# Self-hosted CI and release setup

GitHub Actions is configured to run on a Linux x64 self-hosted runner. The
runner performs every build and test on the host; GitHub stores the workflow
definition and the resulting non-publishing artifacts.

Install Node.js 22.14 or newer, Go from `content-node/go.mod`, the Playwright Chromium,
Firefox, and WebKit browser binaries (plus their Linux system dependencies),
`iproute2`, and a GitHub Actions self-hosted runner carrying the `self-hosted`,
`linux`, and `x64` labels. Run it under a dedicated unprivileged OS account that
cannot read the release operator's `.env.release`, home directory, npm config,
or any production signing/npm credential. User and network namespaces must be
enabled for the isolated WAN regression workflow. Do not add Firebase, npm, or
manifest-signing values as Actions secrets: verification uses synthetic public
Firebase configuration and a fresh ephemeral P-256 key, and npm is forced to an
empty user config.

Both workflows skip pull requests whose head branch belongs to a fork. This is
intentional: checked-out pull-request code can execute arbitrary commands and
must never run on a persistent self-hosted machine. Review an external change,
move it to a trusted same-repository branch, and then run the workflow there.

Generate the signing key once with `node deploy/generate-manifest-key.mjs`.
Commit only `deploy/npm/manifest-public-key.json`; keep the generated private
key in the release operator's `.env.release`, outside the runner account's read
permissions. Changing the key requires rebuilding and redeploying the carrier
because its public half is the trust anchor.

Run the exact workflow locally with:

```bash
npm ci
node node_modules/playwright-core/cli.js install chromium firefox webkit
./deploy/ci-local.sh
```

The gate builds and verifies the loader and an explicitly test-only signed
pointer, runs JavaScript and Go unit/race/vet tests (including the pinned SCTP
fork), exercises clean-install and worker-upgrade browser paths, covers
signature/hash/CDN error UI, and writes artifacts under `build/ci/test-only`.
That evidence contains both `carrier/` (signed-CDN) and `carrier-bundled/`
(inline loader plus same-origin recovery files).
Those artifacts carry an ephemeral public key, synthetic Firebase config, and a
marker that the production verifier rejects. The gate never publishes, creates
a production-signable pointer, or modifies `deploy/npm/deployments`.

Production-signed artifacts are a separate, explicit local operator action:

```bash
YURIRTC_RELEASE_ARTIFACTS_OK=1 ./deploy/build-release-artifacts.sh
```

The script first runs the credential-free CI gate, then exposes the production
private key only to the signed-pointer build child. It refuses to run inside
GitHub Actions and does not publish.

The browser transport gate defaults to both carrier variants in all three
engines and over both UDP and TCP.
For a focused local diagnosis, narrow either comma-separated matrix before
starting the gate:

```bash
YURIRTC_BROWSER_E2E_ENGINES=firefox \
YURIRTC_BROWSER_E2E_PROTOCOLS=tcp \
./deploy/ci-local.sh
```

The separate `YuriRTC WAN transport regression` workflow runs the quick
delay/loss matrix on transport pull requests. Start its full high-RTT,
burst-loss, reorder, and parallel-lane matrix manually before a transport
release.

Publishing is an explicit operator action after the compatible content-node
canary succeeds:

```bash
YURIRTC_CONTENT_NODE_CANARY_OK=1 ./deploy/release.sh
```

That script releases only `@advwebrec/grainloading` and
`shaintloadingcheckpak`, using their separate staging credentials from
`.env.release`. It invokes a pinned npm CLI version that supports staged
publishing (npm 11.15 or newer); it never uses a direct, unattended
`npm publish`.

The guarded release is deliberately resumable and requires two human approval
steps. Use the same command for every pass:

1. The first pass runs the complete gate, stages `@advwebrec/grainloading`,
   prints the staged release information, and stops.
2. Review and approve that staged loader on the npmjs.com website. npm requires the
   approving maintainer to complete a 2FA challenge.
3. Run the same command again. It recognizes and verifies the published loader
   and both immutable CDN copies, builds the signed pointer, stages
   `shaintloadingcheckpak`, and stops.
4. Review and approve the staged pointer on the npmjs.com website with 2FA.
5. Run the same command a final time. It recognizes both published versions,
   verifies the pointer's registry and CDN bytes, and completes.

An interrupted run can be restarted with that same command. The script resumes
an already-staged or already-published expected version and refuses an
inconsistent published version or `latest` tag instead of silently replacing
it.

Each staging credential must have the package/scope access needed to stage its
package. Do not rely on **Bypass 2FA** for publication: npm's
[Dual-Use Content Policy](https://docs.npmjs.com/policies/dual-use/) prohibits
direct unattended publishing of declared dual-use packages, while npm's
[staged publishing workflow](https://docs.npmjs.com/staged-publishing/) defers
mandatory 2FA to the human approval step. A bypass-capable credential may
submit a stage, but it cannot bypass staged approval.
