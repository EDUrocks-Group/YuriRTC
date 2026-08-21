import assert from "node:assert/strict";
import test from "node:test";

import {
  appPathWithinScope,
  locationWithinScope,
  logicalPathForScope,
  scopedPathForLogical,
  scopePathFromUrl,
  shellPathForWorker,
  workerRegistrationTarget
} from "../src/scope.js";

const ORIGIN = "https://storage.example";
const PREFIX_SCOPE = `${ORIGIN}/edurpu/`;
const NESTED_SCOPE = `${ORIGIN}/edurpu/releases/v5/`;

test("worker URL and default scope follow the bootstrap page directory", () => {
  assert.deepEqual(workerRegistrationTarget(`${ORIGIN}/index.html`), {
    scriptUrl: `${ORIGIN}/sw.js`,
    directoryScope: "/"
  });
  assert.deepEqual(workerRegistrationTarget(`${ORIGIN}/edurpu/index.html`), {
    scriptUrl: `${ORIGIN}/edurpu/sw.js`,
    directoryScope: "/edurpu/"
  });
  assert.deepEqual(
    workerRegistrationTarget(`${ORIGIN}/edurpu/releases/v5/index.html?source=bookmark`),
    {
      scriptUrl: `${ORIGIN}/edurpu/releases/v5/sw.js`,
      directoryScope: "/edurpu/releases/v5/"
    }
  );
});

test("an explicitly relative worker keeps its own directory as the default scope", () => {
  assert.deepEqual(
    workerRegistrationTarget(`${ORIGIN}/edurpu/releases/v5/index.html`, "../sw.js?v=5"),
    {
      scriptUrl: `${ORIGIN}/edurpu/releases/sw.js?v=5`,
      directoryScope: "/edurpu/releases/"
    }
  );
});

test("registration scopes are normalized to directory paths", () => {
  assert.equal(scopePathFromUrl(`${ORIGIN}/`), "/");
  assert.equal(scopePathFromUrl(PREFIX_SCOPE), "/edurpu/");
  assert.equal(scopePathFromUrl(`${ORIGIN}/edurpu`), "/edurpu/");
});

test("prefixed browser paths map to logical content-node paths", () => {
  assert.equal(logicalPathForScope("/", "/"), "/");
  assert.equal(logicalPathForScope("/apiv2/chat?ignored", "/"), "/apiv2/chat?ignored");
  assert.equal(logicalPathForScope("/edurpu/", "/edurpu/"), "/");
  assert.equal(logicalPathForScope("/edurpu/apiv2/chat", "/edurpu/"), "/apiv2/chat");
  assert.equal(logicalPathForScope("/edurpu2/apiv2/chat", "/edurpu/"), null);
  assert.equal(logicalPathForScope("/apiv2/chat", "/edurpu/"), null);
  assert.equal(
    logicalPathForScope(
      "/edurpu/releases/v5/filestorage/logo.svg",
      "/edurpu/releases/v5/"
    ),
    "/filestorage/logo.svg"
  );
});

test("logical paths map back into the browser registration scope", () => {
  assert.equal(scopedPathForLogical("/", "/"), "/");
  assert.equal(scopedPathForLogical("/chat", "/"), "/chat");
  assert.equal(scopedPathForLogical("/", "/edurpu/"), "/edurpu/");
  assert.equal(scopedPathForLogical("/chat", "/edurpu/"), "/edurpu/chat");
  assert.equal(
    scopedPathForLogical("/chat", "/edurpu/releases/v5/"),
    "/edurpu/releases/v5/chat"
  );
});

test("mounted app paths cannot escape a directory-scoped worker", () => {
  assert.equal(appPathWithinScope("/", PREFIX_SCOPE), "/edurpu/");
  assert.equal(
    appPathWithinScope("/chat?room=one#latest", PREFIX_SCOPE),
    "/edurpu/chat?room=one#latest"
  );
  assert.equal(
    appPathWithinScope("/edurpu/chat?room=one", PREFIX_SCOPE),
    "/edurpu/chat?room=one"
  );
  assert.equal(appPathWithinScope("../escape", PREFIX_SCOPE), "/edurpu/escape");
  assert.equal(appPathWithinScope("https://attacker.example/", PREFIX_SCOPE), "/edurpu/");
  assert.equal(appPathWithinScope("/chat", `${ORIGIN}/`), "/chat");
  assert.equal(
    appPathWithinScope("/chat?room=nested", NESTED_SCOPE),
    "/edurpu/releases/v5/chat?room=nested"
  );
});

test("persisted shell paths cannot cross buckets on a shared origin", () => {
  const worker = `${ORIGIN}/edurpu/sw.js`;
  assert.equal(
    shellPathForWorker("/edurpu/shell.html", worker, PREFIX_SCOPE),
    "/edurpu/shell.html"
  );
  assert.equal(
    shellPathForWorker("/another-bucket/index.html", worker, PREFIX_SCOPE),
    "/edurpu/index.html"
  );
  assert.equal(
    shellPathForWorker("/edurpu2/index.html", worker, PREFIX_SCOPE),
    "/edurpu/index.html",
    "directory names with the same prefix are not part of this bucket"
  );
  assert.equal(
    shellPathForWorker("//attacker.example/index.html", worker, PREFIX_SCOPE),
    "/edurpu/index.html"
  );
  assert.equal(
    shellPathForWorker(
      "/edurpu/releases/v5/index.html",
      `${ORIGIN}/edurpu/releases/v5/sw.js`,
      NESTED_SCOPE
    ),
    "/edurpu/releases/v5/index.html"
  );
  assert.equal(
    shellPathForWorker(
      "/edurpu/releases/v4/index.html",
      `${ORIGIN}/edurpu/releases/v5/sw.js`,
      NESTED_SCOPE
    ),
    "/edurpu/releases/v5/index.html"
  );
});

test("a wider granted app scope still keeps recovery in the loader directory", () => {
  assert.equal(
    shellPathForWorker("/other/index.html", `${ORIGIN}/edurpu/sw.js`, `${ORIGIN}/`),
    "/edurpu/index.html"
  );
  assert.equal(
    shellPathForWorker("/index.html", `${ORIGIN}/sw.js`, `${ORIGIN}/`),
    "/index.html"
  );
});

test("same-origin redirects are rebased into a directory scope", () => {
  const request = `${ORIGIN}/edurpu/apiv2/session?attempt=1`;
  assert.equal(
    locationWithinScope("/login?next=chat#form", request, "/apiv2/session", PREFIX_SCOPE),
    `${ORIGIN}/edurpu/login?next=chat#form`
  );
  assert.equal(
    locationWithinScope("../login", request, "/apiv2/session", PREFIX_SCOPE),
    `${ORIGIN}/edurpu/login`
  );
  assert.equal(
    locationWithinScope("/edurpu/login", request, "/apiv2/session", PREFIX_SCOPE),
    `${ORIGIN}/edurpu/login`,
    "already-scoped redirects must not be prefixed twice"
  );
  assert.equal(
    locationWithinScope("https://attacker.example/login", request, "/apiv2/session", PREFIX_SCOPE),
    "https://attacker.example/login"
  );
  assert.equal(
    locationWithinScope(
      "/login",
      `${ORIGIN}/edurpu/releases/v5/apiv2/session`,
      "/apiv2/session",
      NESTED_SCOPE
    ),
    `${ORIGIN}/edurpu/releases/v5/login`
  );
});

test("root-scoped and cross-origin redirects resolve to absolute URLs", () => {
  assert.equal(
    locationWithinScope("../login", `${ORIGIN}/apiv2/session`, "/apiv2/session", `${ORIGIN}/`),
    `${ORIGIN}/login`
  );
  assert.equal(
    locationWithinScope(
      "//attacker.example/login",
      `${ORIGIN}/apiv2/session`,
      "/apiv2/session",
      `${ORIGIN}/`
    ),
    "https://attacker.example/login"
  );
});
