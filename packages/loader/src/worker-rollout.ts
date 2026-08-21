import { PROTOCOL_VERSION } from "@yurirtc/protocol";

/** A short grace lets an update finish without pairing different wire versions. */
export const WORKER_UPGRADE_GRACE_MS = 5_000;

export class WorkerProtocolMismatchError extends Error {
  override name = "WorkerProtocolMismatchError";

  constructor() {
    super(`service worker protocol does not match YuriRTC v${PROTOCOL_VERSION}`);
  }
}

export function isCurrentWorkerProtocol(value: unknown): value is typeof PROTOCOL_VERSION {
  return value === PROTOCOL_VERSION;
}

/**
 * Rejects a page/worker MessagePort before either side can persist or use it.
 * Closing the transferred endpoint also makes a rejected port collectable.
 */
export function acceptWorkerAttachProtocol(value: unknown, port: MessagePort): boolean {
  if (isCurrentWorkerProtocol(value)) return true;
  port.close();
  return false;
}

/** First installs may claim their bootstrap page; upgrades must leave old pages alone. */
export function shouldClaimClientsOnActivate(
  activeWorkerAtStartup: ServiceWorker | null
): boolean {
  return activeWorkerAtStartup === null;
}

/**
 * Waits for a worker other than `previous` to become activated.
 *
 * `navigator.serviceWorker.ready` can resolve to the old active worker while a
 * newly fetched version is still installing. Watching both the registration
 * and every candidate closes the updatefound/statechange race without polling.
 */
export function waitForActivatedWorker(
  registration: ServiceWorkerRegistration,
  previous: ServiceWorker | null,
  timeoutMs = WORKER_UPGRADE_GRACE_MS
): Promise<ServiceWorker> {
  return new Promise<ServiceWorker>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watched = new Set<ServiceWorker>();

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      registration.removeEventListener("updatefound", check);
      for (const worker of watched) worker.removeEventListener("statechange", check);
      watched.clear();
    };
    const finish = (worker?: ServiceWorker): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (worker) resolve(worker);
      else reject(new Error(`YuriRTC v${PROTOCOL_VERSION} service worker update timed out`));
    };
    const check = (): void => {
      if (settled) return;
      const candidates = [
        registration.active,
        registration.waiting,
        registration.installing
      ];
      for (const worker of candidates) {
        if (!worker || worker === previous) continue;
        if (!watched.has(worker)) {
          watched.add(worker);
          worker.addEventListener("statechange", check);
        }
        if (worker.state === "activated") {
          finish(worker);
          return;
        }
      }
    };

    registration.addEventListener("updatefound", check);
    timer = setTimeout(() => finish(), Math.max(0, timeoutMs));
    (timer as unknown as { unref?: () => void }).unref?.();
    check();
  });
}
