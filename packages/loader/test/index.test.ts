import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { boot, YuriRTCClient, type ConnectionDiagnostics } from "../src/index.js";

const CONFIG = {
  firebase: { apiKey: "key", projectId: "project", databaseUrl: "https://db.invalid" },
  cache: { lruBudgetBytes: 1024, maxQuotaShare: 0.5 },
  signal: {}
};

function replaceGlobal(name: string, value: unknown): () => void {
  const prior = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (prior) Object.defineProperty(globalThis, name, prior);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

test("a successful manual retry after initial failure still mounts the app", async () => {
  const restores: Array<() => void> = [];
  const windowEvents = new EventTarget();
  const serviceWorkerEvents = new EventTarget();
  const worker = { postMessage() {} } as unknown as ServiceWorker;
  const registration = {
    scope: "https://bucket.invalid/path/",
    active: worker
  } as unknown as ServiceWorkerRegistration;
  let mounted: unknown;
  const container = {
    replaceChildren(child: unknown) {
      mounted = child;
    }
  } as unknown as Element;
  const frameEvents = new EventTarget();
  const frame = {
    style: { cssText: "" },
    contentWindow: null,
    src: "",
    setAttribute() {},
    addEventListener: frameEvents.addEventListener.bind(frameEvents)
  } as unknown as HTMLIFrameElement;
  const states: string[] = [];
  windowEvents.addEventListener("yurirtc:network-state", (event) => {
    states.push((event as CustomEvent<{ state: string }>).detail.state);
  });

  restores.push(
    replaceGlobal("window", windowEvents),
    replaceGlobal("location", {
      href: "https://bucket.invalid/path/index.html",
      pathname: "/path/index.html",
      reload() {}
    }),
    replaceGlobal("document", { createElement: () => frame }),
    replaceGlobal("crossOriginIsolated", true),
    replaceGlobal("sessionStorage", { removeItem() {} }),
    replaceGlobal("navigator", {
      onLine: true,
      storage: { persist: async () => true },
      serviceWorker: {
        controller: worker,
        ready: Promise.resolve(registration),
        register: async () => registration,
        addEventListener: serviceWorkerEvents.addEventListener.bind(serviceWorkerEvents),
        removeEventListener: serviceWorkerEvents.removeEventListener.bind(serviceWorkerEvents)
      }
    })
  );

  const originalConnect = YuriRTCClient.prototype.connect;
  let attempts = 0;
  const diagnostics: ConnectionDiagnostics = {
    route: { transport: "udp", portClass: "standard" },
    signalBackend: "test",
    signalElapsedMs: 1
  };
  YuriRTCClient.prototype.connect = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("route unavailable");
    return diagnostics;
  };

  try {
    await assert.rejects(
      boot({ ...CONFIG, swUrl: "sw.js", mount: container, appPath: "/" }),
      /route unavailable/
    );
    assert.equal(mounted, undefined);

    windowEvents.dispatchEvent(new CustomEvent("yurirtc:reconnect-request", { cancelable: true }));
    for (let attempt = 0; attempt < 20 && mounted === undefined; attempt += 1) {
      await delay(0);
    }

    assert.equal(attempts, 2);
    assert.equal(mounted, frame);
    assert.equal(states.at(-1), "connected");
  } finally {
    YuriRTCClient.prototype.connect = originalConnect;
    for (const restore of restores.reverse()) restore();
  }
});
