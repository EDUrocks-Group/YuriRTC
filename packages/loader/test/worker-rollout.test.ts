import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_VERSION } from "@yurirtc/protocol";
import {
  acceptWorkerAttachProtocol,
  shouldClaimClientsOnActivate,
  waitForActivatedWorker
} from "../src/worker-rollout.js";

test("the v3 worker closes a mismatched attach before accepting its port", () => {
  let closed = false;
  const port = { close: () => { closed = true; } } as MessagePort;

  assert.equal(acceptWorkerAttachProtocol(2, port), false);
  assert.equal(closed, true);

  closed = false;
  assert.equal(acceptWorkerAttachProtocol(PROTOCOL_VERSION, port), true);
  assert.equal(closed, false);
});

test("only a first service-worker install claims already-open clients", () => {
  assert.equal(shouldClaimClientsOnActivate(null), true);
  assert.equal(shouldClaimClientsOnActivate({} as ServiceWorker), false);
});

test("an installing replacement cannot be missed between update checks", async () => {
  const registrationEvents = new EventTarget();
  const workerEvents = new EventTarget();
  const previous = { state: "activated" } as ServiceWorker;
  const replacement = {
    state: "installing" as ServiceWorkerState,
    addEventListener: workerEvents.addEventListener.bind(workerEvents),
    removeEventListener: workerEvents.removeEventListener.bind(workerEvents)
  } as unknown as ServiceWorker & { state: ServiceWorkerState };
  const registration = {
    active: previous,
    waiting: null,
    installing: null,
    addEventListener: registrationEvents.addEventListener.bind(registrationEvents),
    removeEventListener: registrationEvents.removeEventListener.bind(registrationEvents)
  } as unknown as ServiceWorkerRegistration & {
    active: ServiceWorker | null;
    waiting: ServiceWorker | null;
    installing: ServiceWorker | null;
  };

  const activated = waitForActivatedWorker(registration, previous, 1_000);
  registration.installing = replacement;
  registrationEvents.dispatchEvent(new Event("updatefound"));
  replacement.state = "activated";
  registration.active = replacement;
  registration.installing = null;
  workerEvents.dispatchEvent(new Event("statechange"));

  assert.equal(await activated, replacement);
});
