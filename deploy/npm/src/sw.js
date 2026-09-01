// The verified client adds its signed immutable version to this same-origin
// stub's registration URL. Service workers must be same-origin, so this tiny
// bridge validates that version and then imports the matching worker bundle.
// Worker bytes are deliberately outside the carrier's client-integrity check.
var workerCdnBases = __YURIRTC_WORKER_CDN_BASES__;
var loaderVersion = new URL(self.location.href).searchParams.get("yurirtc-loader");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(loaderVersion || "")) {
  throw new Error("YuriRTC: no valid pinned worker version");
}

var loaded = false;
for (var index = 0; index < workerCdnBases.length; index += 1) {
  try {
    importScripts(workerCdnBases[index] + "@" + loaderVersion + "/dist/bundle/sw.js");
    loaded = true;
    break;
  } catch (error) {
    console.warn("[YuriRTC] worker source unreachable", workerCdnBases[index], error);
  }
}
if (!loaded) throw new Error("YuriRTC: no worker source reachable");
