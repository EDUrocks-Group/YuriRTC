/**
 * Public entry for the page. The bucket's `index.html` loads this from jsDelivr
 * and calls `boot()`.
 */

import {
  YuriRTCClient,
  type ConnectionDiagnostics,
  type ConnectionOptions
} from "./client.js";
import { resolveConfig, type YuriRTCConfig } from "./config.js";
import {
  appPathWithinScope,
  logicalPathForScope,
  scopePathFromUrl,
  scopedPathForLogical,
  workerRegistrationTarget
} from "./scope.js";
import { appPathFromShellLocation } from "./shell.js";
import { retryDelayMs } from "./retry.js";
import {
  clearRoutePreference,
  readRoutePreference,
  rememberTcpPreference
} from "./adaptive-transport.js";

export { YuriRTCClient, YuriRTCClient as LoaderClient } from "./client.js";
export { CarriedWebSocket } from "./websocket.js";

/**
 * Where the shell publishes its websocket opener for the framed app.
 *
 * A fixed name because the app is built and deployed separately and has to
 * find it; it is non-enumerable and read-only so it is neither discoverable by
 * enumeration nor replaceable by page script.
 */
export const YURIRTC_SOCKET_OPENER = "__yuriRTCOpenWebSocket";
export type { ConnectionDiagnostics, ConnectionOptions } from "./client.js";
export type { GoodputMonitorOptions } from "./adaptive-transport.js";
export type { YuriRTCConfig, LoaderConfig } from "./config.js";
export { classify, classifyRequest } from "./routing.js";
export type { Classification, RequestClass, CachePolicy } from "./routing.js";

export interface BootOptions extends YuriRTCConfig {
  onDiagnostics?: (diagnostics: ConnectionDiagnostics) => void;
  /**
   * Path to the worker stub, resolved against the page. Relative by default, so
   * the loader runs from whatever directory it was uploaded to.
   */
  swUrl?: string;
  /**
   * Where to mount the app frame. When given, the loader page stays put and
   * hosts the site in an iframe instead of navigating to it.
   *
   * This is the difference between one connection per session and one per page
   * load: navigating away unloads the page, and the RTCPeerConnection with it.
   */
  mount?: string | Element;
  /** What the frame loads. The service worker answers it over the transport. */
  appPath?: string;
  /**
   * Scope to claim. By default this is the worker's directory, which works on
   * object-store path URLs that cannot send `Service-Worker-Allowed`. At an
   * origin-root deployment that directory is still `/`.
   *
   * Set this explicitly only when the worker response grants a wider scope.
   */
  scope?: string;
}

const NETWORK_STATE_EVENT = "yurirtc:network-state";
const RECONNECT_REQUEST_EVENT = "yurirtc:reconnect-request";

type NetworkStateDetail =
  | { state: "testing" }
  | { state: "connected"; route: ConnectionDiagnostics["route"] }
  | { state: "disconnected"; attempt: number; retryInMs: number }
  | { state: "unavailable" };

function dispatchNetworkState(detail: NetworkStateDetail): void {
  window.dispatchEvent(new CustomEvent(NETWORK_STATE_EVENT, { detail }));
}

/**
 * Registration failures are opaque by default ("an error occurred"), and the
 * two real causes need opposite fixes. Say which one it is.
 */
function describeRegistrationFailure(error: unknown, swUrl: string, scope: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const dir = new URL(".", swUrl).pathname;
  const atRoot = dir === "/";

  if (/scope/i.test(detail) && !atRoot) {
    return (
      `Cannot claim scope "${scope}" from ${swUrl}.\n\n` +
      `A service worker may only control its own directory (${dir}) unless the ` +
      `server sends "Service-Worker-Allowed: ${scope}" with the worker script.\n\n` +
      `For V5, remove the explicit scope to use the worker's directory. ` +
      `Otherwise add that header or serve the loader from the origin root — on ` +
      `an object store that means the bucket subdomain (bucket.s3.amazonaws.com, ` +
      `bucket.storage.googleapis.com).\n\n` +
      `Original error: ${detail}`
    );
  }

  return (
    `Service worker registration failed for ${swUrl}.\n\n` +
      `Check that the file exists at that exact URL and is served with a ` +
      `JavaScript content type. Also make sure an old cached worker response is ` +
      `not masking the uploaded file.\n\n` +
    `Original error: ${detail}`
  );
}

export async function boot(options: BootOptions): Promise<YuriRTCClient> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("service workers unavailable; the loader cannot function");
  }

  const config = resolveConfig(options);

  // Resolve relative to this page, not the origin root, so the loader works
  // from whatever path it was uploaded to.
  const worker = workerRegistrationTarget(location.href, options.swUrl);
  const swUrl = worker.scriptUrl;
  const scope = options.scope ?? worker.directoryScope;

  // A *classic* worker. The stub uses importScripts so it can try more than one
  // CDN — a module worker rejects top-level await ("ServiceWorker cannot be
  // started") and cannot make a static import conditional.
  //
  // updateViaCache "none" makes update checks revalidate the same-origin stub
  // and its immutable, version-pinned imported worker bundle.
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(swUrl, {
      scope,
      updateViaCache: "none"
    });
  } catch (error) {
    throw new Error(describeRegistrationFailure(error, swUrl, scope));
  }
  await navigator.serviceWorker.ready;

  // Object stores cannot add COOP/COEP to the bootstrap object. Once the
  // worker is active, reload the shell exactly once so it can synthesize those
  // headers on the navigation response. The isolated top-level context is
  // required before a nested SAB game frame can itself become isolated.
  const isolationKey = "__edurocks_isolation_reload__";
  if (globalThis.crossOriginIsolated === false) {
    let alreadyReloaded = false;
    try {
      alreadyReloaded = sessionStorage.getItem(isolationKey) === registration.scope;
      if (!alreadyReloaded) sessionStorage.setItem(isolationKey, registration.scope);
    } catch {
      // Storage can be unavailable in hardened/private contexts. Avoid a reload
      // loop there; the rest of the site remains usable without SAB support.
      alreadyReloaded = true;
    }
    if (!alreadyReloaded) {
      location.reload();
      await new Promise<never>(() => undefined);
    }
  } else {
    try {
      sessionStorage.removeItem(isolationKey);
    } catch {
      /* optional cleanup only */
    }
  }

  // Persistence is Window-only — it is `undefined` in ServiceWorkerGlobalScope,
  // so it has to happen here. Expect `false` on a fresh origin: Chrome gates it
  // on engagement heuristics a just-opened bucket URL cannot have.
  void navigator.storage?.persist?.().catch(() => false);

  // Only this page is the permanent shell. YuriRTCClients injected into app
  // documents deliberately do not get to replace its canonical recovery path.
  let client = new YuriRTCClient(config, location.pathname);
  let activeClient = client;

  /**
   * The one capability the framed app is handed directly.
   *
   * Everything else the app does reaches the carrier through the service
   * worker, which cannot help with a websocket: a handshake is not a fetch, so
   * no worker ever sees one. The app runs in a same-origin frame below this
   * shell, so it can reach this function on `parent` and open a socket that
   * travels the data channel like everything else.
   *
   * Deliberately a single function rather than the client itself. The app has
   * no business reconnecting, closing, or inspecting the transport that hosts
   * it, and handing over the whole object would let it do all three.
   */
  Object.defineProperty(window, YURIRTC_SOCKET_OPENER, {
    value: (url: string, protocols?: string | string[]) => {
      // The deployment prefix comes off first, exactly as it does for fetches.
      // Below a directory -- an object-store path deployment such as
      // /learnmathedu@2.1.3/ -- the app asks for a socket at
      // /learnmathedu@2.1.3/apiv2/wonderlands/, and the node judges that
      // against its own namespace and refuses to dial anything outside /apiv2.
      // The app cannot map this itself: the scope is the shell's, not its own.
      const scopePath = scopePathFromUrl(new URL(scope, location.href).href);
      let target: URL;
      try {
        target = new URL(url, location.href);
      } catch {
        return activeClient.openWebSocket(url, protocols);
      }
      const logical = logicalPathForScope(target.pathname, scopePath);
      const mapped = logical === null ? url : `${logical}${target.search}`;

      return activeClient.openWebSocket(mapped, protocols);
    },
    writable: false,
    configurable: false,
    enumerable: false
  });

  let mountedFrame: HTMLIFrameElement | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let connecting = false;
  let everConnected = false;
  let initialAttemptFailed = false;
  let connectPromise: Promise<ConnectionDiagnostics> | null = null;
  let routeStorage: Storage | undefined;
  try {
    // A measured slow-UDP result remains useful on the next browser session.
    // The value is short-lived and contains only "auto"/"tcp", never an IP or
    // candidate. localStorage avoids paying for a new route race every tab.
    routeStorage = globalThis.localStorage;
  } catch {
    /* private/hardened contexts may reject even reading the Storage property */
  }
  const routePreferenceKey = `yurirtc:route:${config.firebase.projectId}`;
  const rememberedRoute = readRoutePreference(routeStorage, routePreferenceKey);
  let preferredTransport: NonNullable<ConnectionOptions["transport"]> =
    rememberedRoute ?? "auto";
  let adaptiveFallbackAttempted = false;
  let adaptiveFallbackPending = false;
  let adaptiveReplacement: Promise<void> | null = null;
  let routeNetworkEpoch = 0;
  const observedClients = new WeakSet<YuriRTCClient>();

  const resetRouteStateForNetworkChange = (clearPending: boolean): void => {
    routeNetworkEpoch += 1;
    preferredTransport = "auto";
    adaptiveFallbackAttempted = false;
    if (clearPending) adaptiveFallbackPending = false;
    clearRoutePreference(routeStorage, routePreferenceKey);
  };

  const ensureMountedFrame = (): HTMLIFrameElement | null => {
    if (mountedFrame || !options.mount) return mountedFrame;
    const requestedAppPath = appPathFromShellLocation(
      location.href,
      options.appPath ?? new URL(registration.scope).pathname
    );
    mountedFrame = mountApp(
      options.mount,
      appPathWithinScope(requestedAppPath, registration.scope),
      registration.scope
    );
    return mountedFrame;
  };

  const clearRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const connectTransport = (
    reconnecting: boolean,
    reloadApp = reconnecting
  ): Promise<ConnectionDiagnostics> => {
    if (connectPromise) return connectPromise;
    connecting = true;
    const requestedTransport = preferredTransport;
    connectPromise = (async () => {
      try {
        // One initial ICE connection avoids doubling signaling plus a pair of
        // 1 MiB probes on every new session. The existing goodput monitor still
        // warms and promotes a TCP route when real application traffic proves
        // UDP is slow, and that result is remembered for the next boot.
        if (reconnecting) activeClient.retireRoute();
        const delegated = activeClient !== client;
        const diagnostics = await activeClient.connect(delegated ? undefined : registration, {
          transport: requestedTransport
        });
        // The permanent shell owns the sole SW MessagePort. A replacement RTC
        // route receives requests through that original router, so reconnecting
        // a delegated route reattaches the shell only after SCTP is open.
        if (delegated) await client.attach(registration);
        const restored = everConnected;
        // The original boot() promise has already rejected after an initial
        // failure, so no outer continuation remains to mount the app. A later
        // successful Try Again must complete that work itself.
        if (initialAttemptFailed && !mountedFrame) ensureMountedFrame();
        options.onDiagnostics?.(diagnostics);
        dispatchNetworkState({ state: "connected", route: diagnostics.route });
        retryAttempt = 0;
        everConnected = true;
        if (restored && reloadApp && mountedFrame) {
          reloadMountedFrame(mountedFrame, registration.scope);
        }
        return diagnostics;
      } catch (error) {
        // A network can allow UDP while blocking passive ICE/TCP. Fall back to
        // normal ICE after one failed forced attempt instead of retrying TCP in
        // a permanent loop.
        if (requestedTransport === "tcp") {
          preferredTransport = "auto";
          clearRoutePreference(routeStorage, routePreferenceKey);
        }
        throw error;
      }
    })().finally(() => {
      connecting = false;
      connectPromise = null;
      if (adaptiveFallbackPending) queueMicrotask(runAdaptiveFallback);
    });
    return connectPromise;
  };

  const scheduleRetry = (allowBeforeFirstConnection = false): void => {
    if ((!everConnected && !allowBeforeFirstConnection) || connecting || retryTimer !== null) return;
    retryAttempt += 1;
    const retryInMs = retryDelayMs(retryAttempt);
    dispatchNetworkState({ state: "disconnected", attempt: retryAttempt, retryInMs });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (navigator.onLine === false) {
        scheduleRetry(allowBeforeFirstConnection);
        return;
      }
      dispatchNetworkState({ state: "testing" });
      void connectTransport(true).catch(() => {
        if (everConnected) scheduleRetry();
        else if (allowBeforeFirstConnection) dispatchNetworkState({ state: "unavailable" });
      });
    }, retryInMs);
  };

  function runAdaptiveFallback(): void {
    if (
      !adaptiveFallbackPending ||
      adaptiveFallbackAttempted ||
      connecting ||
      adaptiveReplacement ||
      navigator.onLine === false
    ) return;
    adaptiveFallbackPending = false;
    adaptiveFallbackAttempted = true;
    clearRetry();
    dispatchNetworkState({ state: "testing" });
    const previous = activeClient;
    const replacement = new YuriRTCClient(config, location.pathname);
    const replacementEpoch = routeNetworkEpoch;
    let promoted = false;
    adaptiveReplacement = (async () => {
      // Warm TCP without touching the worker's only MessagePort. Once open,
      // the original client delegates only newly allocated request ids to it;
      // credits/cancels for old ids continue to the UDP route until it drains.
      const diagnostics = await replacement.connect(undefined, { transport: "tcp" });
      if (replacementEpoch !== routeNetworkEpoch || navigator.onLine === false) {
        replacement.retireRoute();
        return;
      }
      previous.adoptSuccessor(replacement);
      activeClient = replacement;
      observeClient(replacement);
      promoted = true;
      preferredTransport = "tcp";
      rememberTcpPreference(routeStorage, routePreferenceKey);
      try {
        options.onDiagnostics?.(diagnostics);
      } catch (error) {
        console.warn("[YuriRTC] diagnostics callback failed", error);
      }
      dispatchNetworkState({ state: "connected", route: diagnostics.route });

      let removeDrained = (): void => undefined;
      removeDrained = previous.onDrained(() => {
        removeDrained();
        previous.retireTransport();
      });
    })().catch(() => {
      if (promoted) return;
      // Passive ICE/TCP is not universal. The established UDP route remains
      // untouched, and the remembered preference is cleared for the next boot.
      replacement.retireRoute();
      preferredTransport = "auto";
      clearRoutePreference(routeStorage, routePreferenceKey);
      dispatchNetworkState({ state: "connected", route: { transport: "udp", portClass: "unknown" } });
    }).finally(() => {
      adaptiveReplacement = null;
    });
  }

  function observeClient(candidate: YuriRTCClient): void {
    if (observedClients.has(candidate)) return;
    observedClients.add(candidate);
    candidate.onAdaptiveTcpSuggested(() => {
      if (
        candidate !== activeClient ||
        adaptiveFallbackAttempted ||
        adaptiveFallbackPending
      ) return;
      adaptiveFallbackPending = true;
      queueMicrotask(runAdaptiveFallback);
    });
    candidate.onDisconnect(() => {
      // A drained predecessor may close after promotion. Only the route which
      // owns new work is allowed to start the global reconnect schedule.
      if (candidate === activeClient && !connecting && !adaptiveReplacement) scheduleRetry();
    });
  }

  const onReconnectRequest = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    event.preventDefault();
    clearRetry();
    retryAttempt = 0;
    if (navigator.onLine === false) {
      scheduleRetry(!everConnected);
      return;
    }
    dispatchNetworkState({ state: "testing" });
    void connectTransport(true).catch(() => {
      if (everConnected) scheduleRetry();
      else dispatchNetworkState({ state: "unavailable" });
    });
  };
  window.addEventListener(RECONNECT_REQUEST_EVENT, onReconnectRequest);
  window.addEventListener("offline", () => {
    resetRouteStateForNetworkChange(true);
  });
  window.addEventListener("online", () => {
    resetRouteStateForNetworkChange(false);
    if (adaptiveFallbackPending) {
      runAdaptiveFallback();
      return;
    }
    if (retryTimer === null || connecting) return;
    clearRetry();
    dispatchNetworkState({ state: "testing" });
    void connectTransport(true).catch(() => {
      if (everConnected) scheduleRetry();
      else dispatchNetworkState({ state: "unavailable" });
    });
  });
  // Chromium exposes NetworkInformation for Wi-Fi/cellular transitions that
  // need not produce an offline event. Firefox and Safari simply omit it, so
  // their standards-based online/offline behavior remains unchanged.
  const networkInformation = (navigator as Navigator & {
    connection?: Pick<EventTarget, "addEventListener"> & {
      type?: string;
      effectiveType?: string;
    };
  }).connection;
  let networkSignature = networkInformation
    ? `${networkInformation.type ?? ""}:${networkInformation.effectiveType ?? ""}`
    : "";
  networkInformation?.addEventListener("change", () => {
    const nextSignature =
      `${networkInformation.type ?? ""}:${networkInformation.effectiveType ?? ""}`;
    if (nextSignature === networkSignature) return;
    networkSignature = nextSignature;
    resetRouteStateForNetworkChange(true);
  });

  observeClient(client);
  dispatchNetworkState({ state: "testing" });
  try {
    await connectTransport(false);
  } catch (error) {
    initialAttemptFailed = true;
    dispatchNetworkState({ state: "unavailable" });
    throw error;
  }

  // No reload, and nothing to prefetch.
  //
  // The frame is a *new* client, so the already-activated worker controls it
  // from its first request — no claim, no reload, and the transport this page
  // holds is never torn down. Every bootstrap problem the navigation model had
  // came from unloading the one page that owned the connection.
  if (options.mount) {
    ensureMountedFrame();
  }

  return client;
}

/** Reload only the contained app, never the permanent top-level carrier. */
function reloadMountedFrame(frame: HTMLIFrameElement, scopeUrl: string): void {
  try {
    const child = frame.contentWindow;
    if (!child) return;
    const current = new URL(child.location.href);
    const scope = new URL(scopeUrl);
    if (current.origin !== scope.origin) return;
    if (logicalPathForScope(current.pathname, scopePathFromUrl(scope.href)) === null) return;
    child.location.reload();
  } catch {
    // Cross-origin frames are deliberately outside YuriRTC's virtual origin.
  }
}

function mountApp(target: string | Element, src: string, scopeUrl: string): HTMLIFrameElement {
  const container =
    typeof target === "string" ? document.querySelector(target) : target;
  if (!container) throw new Error(`mount target not found: ${String(target)}`);

  const frame = document.createElement("iframe");
  frame.setAttribute("title", "YuriRTC");
  // The site needs these; without them games and clipboard actions break.
  frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen; autoplay; gamepad");
  frame.setAttribute("allowfullscreen", "");
  frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:#fff";

  // A programmatic Location assignment can bypass both link rewriting and the
  // directory-scoped service worker. Keep the permanent shell as a final
  // containment boundary: if an old page reaches a same-origin logical-root
  // URL, put it back under this deployment prefix and replace the poisoned
  // history entry so Back/Forward cannot return to the object-store XML page.
  const scope = new URL(scopeUrl);
  const scopePath = scopePathFromUrl(scope.href);
  const containNavigation = (): void => {
    try {
      const child = frame.contentWindow;
      if (!child) return;
      const current = new URL(child.location.href);
      if (current.origin !== scope.origin) return;
      if (logicalPathForScope(current.pathname, scopePath) !== null) return;
      current.pathname =
        current.pathname === scopePath.slice(0, -1)
          ? scopePath
          : scopedPathForLogical(current.pathname, scopePath);
      child.location.replace(current.href);
    } catch {
      // A deliberately cross-origin destination is outside our virtual root
      // and is not readable by the shell; leave it untouched.
    }
  };
  frame.addEventListener("load", containNavigation);
  window.addEventListener("pageshow", containNavigation);
  frame.src = src;
  container.replaceChildren(frame);
  return frame;
}
