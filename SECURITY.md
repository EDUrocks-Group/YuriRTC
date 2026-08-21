# Security policy

## Supported versions

Security fixes target the current source tree and the latest published YuriRTC-compatible loader release. Older published loader versions remain available for deployment compatibility, but they do not receive guaranteed backports.

Keep each deployment's `index.html`, same-origin `sw.js`, and pinned loader version as one tested release unit. Mixing these artifacts can recreate bugs that are fixed in the complete release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's private **Report a vulnerability** or Security Advisory flow when it is available. If it is not available, contact a maintainer through a private channel listed on the repository owner's profile and ask for a secure reporting route.

Include:

- the affected commit or npm version;
- browser, operating system, and hosting shape;
- a minimal reproduction using example hosts and sanitized configuration;
- expected and observed behavior;
- impact and any known preconditions.

Do not send live service-account files, access tokens, session material, private keys, user data, or production database exports. Revoke an exposed credential before reporting it.

Allow maintainers time to reproduce and coordinate a fix before public disclosure. No bug bounty or response-time commitment is implied by this policy.

## Security boundaries

YuriRTC relies on several separate controls:

- WebRTC DTLS protects the browser-to-node data channel in transit.
- Firebase rules restrict client signaling operations; the content node uses server credentials.
- The service worker contains same-origin application requests within its deployment scope and forwards them through the selected transport.
- Application and API code remain responsible for authentication, authorization, validation, and output encoding.
- The content root is trusted deployment input. YuriRTC does not sandbox arbitrary HTML served from that root.

The following are not secrets:

- Firebase web API keys and client project identifiers;
- npm package names and versioned CDN URLs;
- the content node's intentionally public listening address and ports;
- obfuscated JavaScript and ROT13 display strings.

Client SDP and ICE candidate records can contain network metadata and should not be enumerable or retained unnecessarily. Even public configuration may become operationally sensitive when combined with other data, so reports and logs should contain only what is necessary.

## High-value report areas

Reports are especially useful when they demonstrate:

- a Firebase rule bypass or signaling record enumeration;
- a same-origin request escaping a directory-scoped deployment;
- unsafe service-worker scope expansion or cross-deployment state reuse;
- request smuggling, response splitting, or forbidden header propagation;
- content-root path traversal;
- protocol frames bypassing size, flow-control, or lifecycle limits;
- authentication or session confusion across peers;
- script injection into generated or transported HTML;
- a credential redirect or log path that discloses server credentials.

Reversing npm obfuscation, decoding ROT13 copy, discovering public Firebase web configuration, and denial of service based only on sending ordinary traffic at high volume are not vulnerabilities by themselves. A report is still relevant if it demonstrates a specific amplification, resource leak, authorization failure, or limit bypass.

## Deployment hardening

Before exposing a content node:

1. Deploy and verify the repository's Firebase rules and indexes.
2. Store server credentials outside the repository with permissions limited to the service account running the node.
3. Bind only the intended address; do not use an all-interface wildcard as a shortcut.
4. Open only the configured UDP and TCP ICE ports.
5. Run the node as an unprivileged, dedicated account. Grant only the capability needed to bind low ports when low ports are selected.
6. Mount or copy the content root read-only where practical.
7. Keep the optional API backend on a private or loopback listener unless it has its own access controls.
8. Apply operating-system and dependency security updates, then rerun the full test and release-verification suites.
9. Monitor connection failures, signaling denials, malformed frames, resource use, and repeated peer churn without recording application bodies or session secrets.

Obfuscation must never replace any item in this checklist.
