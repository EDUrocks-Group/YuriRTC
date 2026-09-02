# Firebase signaling rules

These project-neutral rules implement YuriRTC's two compatible signaling legs:

- authenticated, per-user Realtime Database branches;
- unlisted Firestore capability documents.

The loader reuses an anonymous RTDB identity and refreshes its token locally,
so enable anonymous authentication but do not build reporting around one new
account per connection. If the project is upgraded to Identity Platform, enable
automatic cleanup for anonymous accounts as a backstop for identities whose
browser storage is cleared. Firestore's `expireAt` TTL policy should remain
enabled; the node normally removes records from event-driven timers, and TTL is
the recovery mechanism when no node observes an abandoned offer.

App Check enforcement is intentionally not part of these generic templates.
A public FOSS carrier can run on arbitrary operator domains, while the web
provider requires a deployment-specific domain registration and token flow.
Operators with a fixed domain fleet may add App Check to their own deployment,
but must update both raw REST signaling clients before enforcing it.

Select a project locally with `firebase use` or `--project`; no production
project identifier is stored in this repository. After deployment, verify the
effective behavior with:

```bash
YURIRTC_FIREBASE_API_KEY=... \
YURIRTC_FIREBASE_PROJECT_ID=... \
YURIRTC_FIREBASE_DATABASE_URL=https://... \
node deploy/firebase/tools/verify-rules.mjs
```
