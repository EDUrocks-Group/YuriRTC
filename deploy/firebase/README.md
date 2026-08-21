# Firebase signaling rules

These project-neutral rules implement YuriRTC's two compatible signaling legs:

- authenticated, per-user Realtime Database branches;
- unlisted Firestore capability documents.

Select a project locally with `firebase use` or `--project`; no production
project identifier is stored in this repository. After deployment, verify the
effective behavior with:

```bash
YURIRTC_FIREBASE_API_KEY=... \
YURIRTC_FIREBASE_PROJECT_ID=... \
YURIRTC_FIREBASE_DATABASE_URL=https://... \
node deploy/firebase/tools/verify-rules.mjs
```
