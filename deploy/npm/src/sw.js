// The worker source tracks the loader's `latest` dist-tag, so publishing a new
// loader reaches carriers that were uploaded once to a bucket or someone else's
// host and are never touched again. `updateViaCache: "none"` on the
// registration (packages/loader/src/index.ts) is what makes an update check
// re-fetch this import rather than replay a cached copy.
//
// It previously resolved the exact version first, with a synchronous
// XMLHttpRequest, and imported that. XMLHttpRequest does not exist in a
// ServiceWorkerGlobalScope, so the call threw every time, the catch swallowed
// it, and the stub fell back to the version baked in at publish time --
// pinning every carrier to that loader forever while looking like a CDN
// serving stale code. Importing the moving URL directly is what that code was
// trying to approximate, and it needs no version resolution at all.
//
// jsDelivr is first because it serves `@latest` as content, while unpkg answers
// with a 302: Chrome keys an imported script by its request URL, so a redirect
// makes the cached entry and the update check disagree. jsDelivr caches the
// `@latest` resolution for up to a week, so a new loader reaches existing
// deployments within that window rather than immediately -- the accepted cost
// of not having to re-upload anyone's copy.
var workerCdnBases = __YURIRTC_WORKER_CDN_BASES__;

var loaded = false;
for (var index = 0; index < workerCdnBases.length; index += 1) {
  try {
    importScripts(workerCdnBases[index] + "@latest/dist/bundle/sw.js");
    loaded = true;
    break;
  } catch (error) {
    console.warn("[YuriRTC] worker source unreachable", workerCdnBases[index], error);
  }
}
if (!loaded) throw new Error("YuriRTC: no worker source reachable");
