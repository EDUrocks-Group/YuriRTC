import assert from "node:assert/strict";
import test from "node:test";

import { classify, isRanged, requestPriority } from "../src/routing.js";
import { RequestPriority } from "@yurirtc/protocol";
import { parseSetCookie, isExpired } from "../src/session.js";
import { needsIsolation, withIsolationHeaders } from "../src/coi.js";
import {
  injectInto,
  injectIntoStream,
  rebaseRootRelativeMarkup,
  rebaseWebManifestJson,
  isHtml,
  shouldInjectDocument,
  INJECT_MARKER,
  GUARD_MARKER,
  INJECT_STATE,
  GUARD_STATE,
  bootstrapScript,
  guardScript,
  mergeBootstrap
} from "../src/inject.js";
import { clientUrls, swUrls } from "../src/sources.js";
import {
  ALWAYS_FRESH,
  CACHE_PREFIX,
  buildVersion,
  cacheNames,
  normalizeBuildVersion
} from "../src/config.js";
import { APP_PATH_PARAM, appPathFromShellLocation } from "../src/shell.js";
import { responseCanHaveBody } from "../src/bridge.js";

test("content-hashed shell assets are immutable", () => {
  assert.equal(classify("/a/BfLRUwSW.js").policy, "cache-first-immutable");
  assert.equal(classify("/a/BQhxGKeB.css").kind, "shell");
});

test("api is never cached", () => {
  assert.equal(classify("/apiv2/chat/list").cacheable, false);
  assert.equal(classify("/apiv2/ai").policy, "never");
});

test("covers and launchers are cached, payloads are not", () => {
  // One segment under gn/ is the cover art and the launcher page.
  assert.equal(classify("/filestorage/gn/100.png").kind, "cover");
  assert.equal(classify("/filestorage/gn/100.html").kind, "cover");
  // Deeper is the game bundle, which caches itself in OPFS. Caching it here
  // would store the same bytes twice against one origin quota.
  assert.equal(classify("/filestorage/gn/100/data.bin").kind, "payload");
  assert.equal(classify("/filestorage/gn/100/assets/x.png").kind, "payload");
  assert.equal(classify("/filestorage/gd/anything.bin").kind, "payload");
});

test("payloads are never cacheable regardless of extension", () => {
  assert.equal(classify("/filestorage/gd/cover-looking.png").cacheable, false);
  assert.equal(classify("/filestorage/gn/1/nested.png").cacheable, false);
});

test("routes are stale-while-revalidate", () => {
  assert.equal(classify("/").policy, "stale-while-revalidate");
  assert.equal(classify("/dashboard.html").policy, "stale-while-revalidate");
});

test("shell recovery preserves a same-origin deep link", () => {
  const shell = new URL("https://bucket.example/index.html");
  shell.searchParams.set(APP_PATH_PARAM, "/games/42.html?mode=full");
  assert.equal(
    appPathFromShellLocation(shell.href, "/"),
    "/games/42.html?mode=full"
  );

  shell.searchParams.set(APP_PATH_PARAM, "https://attacker.example/");
  assert.equal(appPathFromShellLocation(shell.href, "/"), "/");
});

test("ranged requests are detected case-insensitively", () => {
  assert.equal(isRanged([["Range", "bytes=0-1"]]), true);
  assert.equal(isRanged([["range", "bytes=0-1"]]), true);
  assert.equal(isRanged([["accept", "*/*"]]), false);
});

test("v3 scheduling keeps interaction ahead of parallel assets", () => {
  assert.equal(
    requestPriority({ method: "POST", logicalPath: "/apiv2/chat/send" }),
    RequestPriority.Interactive
  );
  assert.equal(
    requestPriority({
      method: "GET",
      mode: "navigate",
      destination: "document",
      logicalPath: "/dashboard"
    }),
    RequestPriority.Interactive
  );
  assert.equal(
    requestPriority({ method: "GET", destination: "script", logicalPath: "/a/app.js" }),
    RequestPriority.Critical
  );
  assert.equal(
    requestPriority({ method: "GET", logicalPath: "/filestorage/gn/7/game.wasm" }),
    RequestPriority.Critical,
    "WASM fetched with an empty destination still blocks game startup"
  );
  assert.equal(
    requestPriority({ method: "GET", destination: "image", logicalPath: "/cover.png" }),
    RequestPriority.Normal
  );
  assert.equal(
    requestPriority({ method: "GET", logicalPath: "/filestorage/gn/7/data.bin" }),
    RequestPriority.Bulk
  );
});

test("HEAD and null-body HTTP statuses never receive a transport stream", () => {
  assert.equal(responseCanHaveBody("GET", 200), true);
  assert.equal(responseCanHaveBody("HEAD", 200), false);
  for (const status of [101, 103, 204, 205, 304]) {
    assert.equal(responseCanHaveBody("GET", status), false, `${status} must be bodyless`);
  }
  for (const status of [204, 205, 304]) {
    assert.doesNotThrow(() =>
      new Response(responseCanHaveBody("GET", status) ? "unexpected" : null, { status })
    );
  }
});

test("set-cookie parsing keeps the pair and the expiry", () => {
  const cookie = parseSetCookie("sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax");
  assert.equal(cookie?.name, "sid");
  assert.equal(cookie?.value, "abc123");
  assert.equal(cookie?.expiresAt, undefined);
});

test("logout arrives as a past expiry and must delete", () => {
  const cookie = parseSetCookie("sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/");
  assert.ok(cookie);
  assert.equal(isExpired(cookie), true);
});

test("max-age wins over expires", () => {
  const cookie = parseSetCookie("sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600");
  assert.ok(cookie);
  assert.equal(isExpired(cookie), false);
});

test("malformed set-cookie is ignored rather than thrown", () => {
  assert.equal(parseSetCookie(""), null);
  assert.equal(parseSetCookie("=novalue"), null);
});

test("only the SAB frame is isolated", () => {
  assert.equal(needsIsolation("/g-fra-sab.html"), true);
  assert.equal(needsIsolation("/g-fra.html"), false);
  assert.equal(needsIsolation("/dashboard.html"), false);
});

test("isolation uses credentialless COEP so third-party embeds still load", () => {
  // require-corp blocks the app's cross-origin no-cors ad script outright
  // (ERR_BLOCKED_BY_RESPONSE...ByCoep); credentialless keeps
  // crossOriginIsolated while loading such embeds without credentials.
  const isolated = withIsolationHeaders(new Response("x"), true);
  assert.equal(isolated.headers.get("Cross-Origin-Embedder-Policy"), "credentialless");
  assert.equal(isolated.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(isolated.headers.get("Cross-Origin-Resource-Policy"), "same-origin");

  const plain = withIsolationHeaders(new Response("x"), false);
  assert.equal(plain.headers.get("Cross-Origin-Embedder-Policy"), null);
  assert.equal(plain.headers.get("Cross-Origin-Opener-Policy"), null);
  // CORP goes on every response regardless: isolated documents refuse
  // subresources that lack it.
  assert.equal(plain.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
});

// --- transport injection -----------------------------------------------------
// Without this the SW serves the real site to a page with no RTCPeerConnection
// in it, and the transport dies the moment it starts being used.

const BOOT = {
  clientUrls: [
    "https://unpkg.com/@edurocks-group/loader@latest/dist/bundle/client.js",
    "https://cdn.jsdelivr.net/npm/@edurocks-group/loader@latest/dist/bundle/client.js"
  ],
  config: { firebase: { apiKey: "k", projectId: "p", databaseUrl: "u" }, cache: {}, signal: {} }
} as unknown as NonNullable<Parameters<typeof injectInto>[1]>;

test("injected bootstrap prefers YuriRTCClient and retains the legacy export fallback", () => {
  const script = bootstrapScript(BOOT);
  assert.ok(script.includes("m.YuriRTCClient||m.LoaderClient"));
  assert.ok(script.includes("[YuriRTC] transport"));
});

test("injects into head when present", () => {
  const out = injectInto("<!doctype html><html><head><title>x</title></head><body>b</body></html>", BOOT);
  assert.ok(out.includes(INJECT_MARKER));
  // Must land inside head, before the existing content, so the transport is
  // establishing while the rest of the document parses.
  assert.ok(out.indexOf(INJECT_MARKER) < out.indexOf("<title>"));
});

test("falls back to body, then html, then the first content token", () => {
  const body = injectInto("<html><body>x</body></html>", BOOT);
  assert.ok(body.indexOf(INJECT_MARKER) > body.indexOf("<body>"));
  assert.ok(body.indexOf(INJECT_MARKER) < body.indexOf(">x</body>") + 1);

  const html = injectInto("<html><meta charset=utf-8></html>", BOOT);
  assert.ok(html.indexOf(INJECT_MARKER) > html.indexOf("<html>"));
  assert.ok(html.indexOf(INJECT_MARKER) < html.indexOf("<meta"));

  assert.ok(injectInto("just text", BOOT).startsWith("<script"));
});

test("does not inject into tag-looking text inside the site's context-menu script", () => {
  // Production removes optional html/head/body tags. The first apparent head
  // is therefore this string used by the about:blank context-menu action.
  const original =
    '<link rel="preload" href="rot13.woff">' +
    '<script>!function(){var n="/";window.open().document.write(\'<html><head><title>x</title></head>' +
    '<body><iframe src="\'+n+\'"></iframe></body></html>\'),window.edurocksLastBuildDate="today"}()</script>' +
    "<main>site</main>";
  const out = injectInto(original, null);

  assert.ok(out.indexOf(GUARD_MARKER) < out.indexOf('<link rel="preload"'));
  assert.ok(out.endsWith(original), "the existing script must remain byte-for-byte intact");
  assert.ok(out.includes("window.edurocksLastBuildDate"));
});

test("only exact prologue tags are injection anchors", () => {
  const decoys = '<!-- <head> --><header data-x="<head>">x</header>';
  const out = injectInto(decoys, null);
  assert.ok(out.indexOf(GUARD_MARKER) < out.indexOf("<header"));

  const document = '\ufeff  <!-- lead --><!DOCTYPE html><HTML data-x=">"><!-- h --><HeAd data-y=">">' +
    "<title>x</title></HeAd><body></body></HTML>";
  const mixed = injectInto(document, null);
  assert.ok(mixed.startsWith("\ufeff  <!-- lead --><!DOCTYPE html>"));
  assert.ok(mixed.indexOf(GUARD_MARKER) > mixed.indexOf('<HeAd data-y=">">'));
  assert.ok(mixed.indexOf(GUARD_MARKER) < mixed.indexOf("<title>"));
});

test("never injects twice", () => {
  const once = injectInto("<html><head></head></html>", BOOT);
  const twice = injectInto(once, BOOT);
  assert.equal(once, twice, "re-injecting must be a no-op");
  // Two tags when bootstrapping: the guard, then the transport.
  assert.equal(twice.split("<script").length - 1, 2);
});

test("streaming injection emits the prologue before the source finishes", async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const first = "<!doctype html><html><head>";
  const rest = "<title>x</title></head><body>streamed</body></html>";
  let finish!: () => void;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      finish = () => {
        controller.enqueue(encoder.encode(rest));
        controller.close();
      };
    }
  });

  const reader = injectIntoStream(source, BOOT).getReader();
  const initial = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("injection buffered the unfinished document")), 250)
    )
  ]);
  assert.equal(initial.done, false);

  finish();
  const pieces: Uint8Array[] = initial.value ? [initial.value] : [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    pieces.push(next.value);
  }
  const output = pieces.map((piece) => decoder.decode(piece, { stream: true })).join("") + decoder.decode();
  assert.equal(output, injectInto(first + rest, BOOT));
});

test("streaming injection preserves an UTF-8 BOM and existing bytes", async () => {
  const original = "\ufeff<!doctype html><html><head><title>x</title></head></html>";
  const source = new Response(new TextEncoder().encode(original)).body!;
  const actual = new Uint8Array(await new Response(injectIntoStream(source, null)).arrayBuffer());
  const expected = new TextEncoder().encode(injectInto(original, null));
  assert.deepEqual(actual, expected);
});

test("directory deployments rebase root-relative markup without touching external or relative URLs", () => {
  const original = [
    '<script data-manifest="/filestorage/gn/sysload-data/74.json" src = "/filestorage/gn/sysload.js"></script>',
    "<iframe src=/legacy/frame.html></iframe>",
    '<a href="/category/puzzle.html">play</a>',
    '<a href="/edurpu/already.html">same scope</a>',
    '<script src="//cdn.example/x.js"></script>',
    '<img src="relative.png">'
  ].join("");
  const rebased = rebaseRootRelativeMarkup(original, "/edurpu/");

  assert.ok(rebased.includes('data-manifest="/edurpu/filestorage/gn/sysload-data/74.json"'));
  assert.ok(rebased.includes('src = "/edurpu/filestorage/gn/sysload.js"'));
  assert.ok(rebased.includes("src=/edurpu/legacy/frame.html"));
  assert.ok(rebased.includes('href="/edurpu/category/puzzle.html"'));
  assert.ok(rebased.includes('href="/edurpu/already.html"'));
  assert.ok(rebased.includes('src="//cdn.example/x.js"'));
  assert.ok(rebased.includes('src="relative.png"'));
  assert.equal(rebaseRootRelativeMarkup(original, "/"), original);
});

test("streaming markup rebasing handles an attribute split across chunks", async () => {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("<!doctype html><iframe src = \""));
      controller.enqueue(encoder.encode("/legacy/frame.html\"></iframe>"));
      controller.close();
    }
  });
  const output = await new Response(injectIntoStream(source, null, "/edurpu/")).text();
  assert.ok(output.includes('src = "/edurpu/legacy/frame.html"'));
});

test("directory deployments rebase V4 web-manifest launch and asset URLs", () => {
  const deployedV4Manifest = JSON.stringify({
    id: "/",
    start_url: "/index.html?installed=1",
    scope: "/",
    icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
    shortcuts: [{
      url: "/ai.html#chat",
      icons: [{ src: "/icons/icon-96.png" }]
    }],
    share_target: { action: "/apiv2/share" },
    external: { url: "https://example.com/app" }
  });

  assert.deepEqual(
    JSON.parse(rebaseWebManifestJson(deployedV4Manifest, "/prefix/bucket/")),
    {
      id: "/prefix/bucket/",
      start_url: "/prefix/bucket/index.html?installed=1",
      scope: "/prefix/bucket/",
      icons: [{ src: "/prefix/bucket/icons/icon-192.png", sizes: "192x192" }],
      shortcuts: [{
        url: "/prefix/bucket/ai.html#chat",
        icons: [{ src: "/prefix/bucket/icons/icon-96.png" }]
      }],
      share_target: { action: "/prefix/bucket/apiv2/share" },
      external: { url: "https://example.com/app" }
    }
  );
  assert.equal(rebaseWebManifestJson(deployedV4Manifest, "/"), deployedV4Manifest);
  assert.equal(rebaseWebManifestJson("not-json", "/prefix/bucket/"), "not-json");
});

test("escapes < so a config value cannot close the script tag", () => {
  const evil = {
    ...BOOT,
    config: { firebase: { apiKey: "</script><script>alert(1)</script>", projectId: "p", databaseUrl: "u" },
              cache: {}, signal: {} }
  } as unknown as Parameters<typeof injectInto>[1];
  const out = injectInto("<html><head></head></html>", evil);
  assert.ok(!out.includes("</script><script>alert"), "config must not break out of the tag");
  assert.ok(out.includes("\\u003c/script"));
});

// Module scripts defer until parsing completes, but parsing blocks on the
// page's own scripts, which the SW cannot serve without this transport. A
// deferred bootstrap deadlocks the page.
test("bootstrap is a classic script so it runs during parsing", () => {
  const out = injectInto("<html><head></head></html>", BOOT);
  assert.ok(!out.includes('type="module"'), "must not be a module script");
  assert.ok(out.includes("import("), "must use dynamic import to load the client");
  assert.ok(out.includes(`self.${INJECT_STATE}=1`));
  assert.ok(out.includes(`self.${GUARD_STATE}=1`));
  assert.ok(!out.includes(`self.${INJECT_MARKER}=1`), "the script id is a named Window property");
  assert.ok(!out.includes(`self.${GUARD_MARKER}=1`), "the script id is a named Window property");
});

test("only html is treated as injectable", () => {
  assert.equal(isHtml(new Headers({ "content-type": "text/html; charset=utf-8" })), true);
  assert.equal(isHtml(new Headers({ "content-type": "application/javascript" })), false);
  assert.equal(isHtml(new Headers()), false);
});

test("text/html API payloads are not treated as navigated documents", () => {
  const response = new Response("Example#ABC123", {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
  assert.equal(shouldInjectDocument({ mode: "cors" }, response), false);
  assert.equal(shouldInjectDocument({ mode: "same-origin" }, response), false);
  assert.equal(shouldInjectDocument({ mode: "navigate" }, response), true);
});

// One blocked CDN must not leave the page without a transport.
test("injected bootstrap tries every source in order", () => {
  const out = injectInto("<html><head></head></html>", BOOT);
  assert.ok(out.includes("unpkg.com"), "first source present");
  assert.ok(out.includes("cdn.jsdelivr.net"), "fallback source present");
  assert.ok(out.indexOf("unpkg.com") < out.indexOf("cdn.jsdelivr.net"), "order preserved");
  assert.ok(out.includes(".catch(n)"), "must fall through on failure, not give up");
});

test("a temporary injected carrier cannot replace the canonical shell path", () => {
  const base = BOOT as NonNullable<typeof BOOT>;
  const canonical = { ...base, shellPath: "/index.html", siteVersion: "v5-build-a" };
  const injected = { ...base };
  assert.equal(mergeBootstrap(canonical, injected).shellPath, "/index.html");
  assert.equal(mergeBootstrap(canonical, injected).siteVersion, "v5-build-a");
  assert.equal(
    mergeBootstrap(canonical, {
      ...base,
      shellPath: "/loader.html",
      siteVersion: "v5-build-b"
    }).shellPath,
    "/loader.html",
    "a real shell may deliberately replace the canonical path"
  );
  assert.equal(
    mergeBootstrap(canonical, { ...base, siteVersion: "v5-build-b" }).siteVersion,
    "v5-build-b",
    "a newly reported site version must replace the persisted one"
  );
  assert.ok(
    injectInto("<html><head></head></html>", canonical).includes('"/index.html").connect'),
    "an injected carrier must forward, not derive, the canonical shell path"
  );
});

test("unbundled sources use latest only as their build-time fallback", () => {
  for (const u of clientUrls()) assert.match(u, /@latest\//);
  for (const u of swUrls()) assert.match(u, /@latest\//);
  // The package build replaces the fallback with its exact package version.
  // unpkg remains first so either CDN can be blocked without losing recovery.
  assert.match(clientUrls()[0]!, /unpkg\.com/);
});

// --- merged site-worker behaviour --------------------------------------------
// This worker replaces frontend-dist/sw.js, whose job was stopping users being
// left on a stale build.

test("build version accepts V4/V5 ids from the URL or embedded build", () => {
  assert.equal(buildVersion({ href: "https://x/sw.js?v=1779950869" }), "1779950869");
  assert.equal(
    buildVersion({ href: "https://x/sw.js" }, "0123456789abcdef".repeat(4)),
    "0123456789abcdef".repeat(4)
  );
  assert.equal(buildVersion({ href: "https://x/sw.js?v=%2Fbad" }, "safe-build"), "safe-build");
  // No query means no site registration yet — the loader registered it plainly.
  assert.equal(buildVersion({ href: "https://x/sw.js" }), "0");
  assert.equal(buildVersion({ href: "not a url" }), "0");
  assert.equal(normalizeBuildVersion("v5.release_1~candidate"), "v5.release_1~candidate");
  assert.equal(normalizeBuildVersion(""), null);
  assert.equal(normalizeBuildVersion("x".repeat(129)), null);
  assert.equal(normalizeBuildVersion("../../other-cache"), null);
});

test("shell and route caches are version-scoped, covers are not", () => {
  const a = cacheNames("111");
  const b = cacheNames("222");
  assert.notEqual(a.shell, b.shell, "a new build must invalidate the shell");
  assert.notEqual(a.route, b.route, "a new build must invalidate routes");
  // ~330MB of immutable game covers must survive a deploy.
  assert.equal(a.lru, b.lru);
});

test("every cache name is recognisable as ours", () => {
  for (const name of Object.values(cacheNames("1"))) {
    assert.ok(name.startsWith(CACHE_PREFIX), `${name} must be purgeable by prefix`);
  }
});

test("always-fresh paths match the site worker's list", () => {
  for (const p of ["/index.php", "/index.html", "/gxxes.json", "/style.css"]) {
    assert.ok(ALWAYS_FRESH.has(p), `${p} must never be served stale`);
  }
  assert.equal(ALWAYS_FRESH.has("/a/hashed.js"), false, "hashed assets are immutable");
});

// The served site ships its own service worker bootstrap. Left alone it
// registers a different script URL for the same scope, replacing the worker
// that is serving it, and reloads on the resulting controllerchange.
test("every served document is guarded, transport or not", () => {
  const withBoot = injectInto("<html><head></head></html>", BOOT);
  const withoutBoot = injectInto("<html><head></head></html>", null);
  assert.ok(withBoot.includes(GUARD_MARKER), "guard present when bootstrapping");
  assert.ok(withoutBoot.includes(GUARD_MARKER), "guard present in a frame too");
  // A frame whose parent holds the transport must not open a second one.
  assert.ok(withBoot.includes(INJECT_MARKER));
  assert.ok(!withoutBoot.includes(INJECT_MARKER));
});

test("the guard neutralises registration, not the whole API", () => {
  const out = injectInto("<html><head></head></html>", null);
  assert.ok(out.includes('"register"'), "register must be replaced");
  assert.ok(out.includes('"getRegistrations"'), "getRegistrations must be replaced");
  // It hands back the running worker rather than pretending there is none,
  // so the site's own code keeps working.
  assert.ok(out.includes("c.ready"));
});

test("the guard forwards a versioned same-origin site registration", async () => {
  const posted: unknown[] = [];
  const registration = {
    active: {
      scriptURL: "https://bucket.example/edurpu/sw.js",
      postMessage: (message: unknown) => posted.push(message)
    }
  };
  const serviceWorker = {
    ready: Promise.resolve(registration),
    controller: null
  };
  const source = guardScript()
    .replace(/^<script[^>]*>/, "")
    .replace(/<\/script>$/, "");
  const scope: Record<string, unknown> = {};
  const run = new Function("self", "navigator", "location", "URL", source);
  run(
    scope,
    { serviceWorker },
    {
      href: "https://bucket.example/edurpu/app.html",
      origin: "https://bucket.example"
    },
    URL
  );

  const guardedRegister = serviceWorker as typeof serviceWorker & {
    register: (url: string) => Promise<typeof registration>;
  };
  assert.equal(await guardedRegister.register("/edurpu/sw.js?v=abc123"), registration);
  await Promise.resolve();
  assert.deepEqual(posted, [{ t: "site-version", version: "abc123" }]);

  await guardedRegister.register("https://other.example/sw.js?v=ignored");
  await guardedRegister.register("/sw.js?v=wrong-scope");
  await guardedRegister.register("/edurpu/sw.js");
  await Promise.resolve();
  assert.equal(
    posted.length,
    1,
    "foreign, different-scope, or unversioned workers must not alter cache identity"
  );
});

test("a nested deployment maps V4's root worker registration to its active worker", async () => {
  const posted: unknown[] = [];
  const registration = {
    active: {
      scriptURL: "https://storage.example/prefix/bucket/sw.js",
      postMessage: (message: unknown) => posted.push(message)
    }
  };
  const serviceWorker = {
    ready: Promise.resolve(registration),
    controller: null
  };
  const source = guardScript("/prefix/bucket/")
    .replace(/^<script[^>]*>/, "")
    .replace(/<\/script>$/, "");
  const scope: Record<string, unknown> = {};
  const run = new Function("self", "navigator", "location", "URL", source);
  run(
    scope,
    { serviceWorker },
    {
      href: "https://storage.example/prefix/bucket/g-fra.html",
      origin: "https://storage.example"
    },
    URL
  );

  const guardedRegister = serviceWorker as typeof serviceWorker & {
    register: (url: string) => Promise<typeof registration>;
  };
  assert.equal(await guardedRegister.register("/sw.js?v=v4-build-5"), registration);
  await Promise.resolve();
  assert.deepEqual(posted, [{ t: "site-version", version: "v4-build-5" }]);

  await guardedRegister.register("/other/sw.js?v=wrong-worker");
  await guardedRegister.register("https://other.example/sw.js?v=foreign");
  await Promise.resolve();
  assert.equal(posted.length, 1, "only the active worker may update its cache identity");
});

test("the nested guard contains V4's programmatic game Back navigation", () => {
  let click: ((event: {
    target: { closest: (selector: string) => object | null };
    preventDefault: () => void;
    stopImmediatePropagation: () => void;
  }) => void) | undefined;
  const document = {
    addEventListener(type: string, listener: typeof click): void {
      if (type === "click") click = listener;
    }
  };
  const location = {
    href: "https://storage.example/prefix/bucket/g-fra.html?id=42",
    origin: "https://storage.example",
    pathname: "/prefix/bucket/g-fra.html"
  };
  const scope = {
    getGamesReturnHref: () => "/index.html?edurocks_return=gfra#catalog"
  };
  const source = guardScript("/prefix/bucket/")
    .replace(/^<script[^>]*>/, "")
    .replace(/<\/script>$/, "");
  const run = new Function("self", "navigator", "location", "URL", "document", source);
  run(scope, {}, location, URL, document);

  assert.ok(click, "the capture guard must be installed");
  let prevented = false;
  let stopped = false;
  click!({
    target: { closest: selector => selector === "#back-btn" ? {} : null },
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => { stopped = true; }
  });

  assert.equal(
    location.href,
    "https://storage.example/prefix/bucket/index.html?edurocks_return=gfra#catalog"
  );
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test("the nested guard keeps History API URLs inside the virtual root", () => {
  const calls: Array<{ method: string; url: unknown }> = [];
  const history = {
    pushState(_state: unknown, _unused: string, url?: string | URL | null): void {
      calls.push({ method: "push", url });
    },
    replaceState(_state: unknown, _unused: string, url?: string | URL | null): void {
      calls.push({ method: "replace", url });
    }
  };
  const scope = { history };
  const source = guardScript("/prefix/bucket/")
    .replace(/^<script[^>]*>/, "")
    .replace(/<\/script>$/, "");
  const run = new Function("self", "navigator", "location", "URL", source);
  run(
    scope,
    {},
    {
      href: "https://storage.example/prefix/bucket/index.html",
      origin: "https://storage.example",
      pathname: "/prefix/bucket/index.html"
    },
    URL
  );

  history.pushState({ page: "chat" }, "", "/chat.html?room=1#latest");
  history.replaceState({ page: "home" }, "", "/prefix/bucket/index.html");
  history.pushState({}, "", "https://other.example/external");
  history.replaceState({}, "", null);

  assert.deepEqual(calls, [
    {
      method: "push",
      url: "https://storage.example/prefix/bucket/chat.html?room=1#latest"
    },
    { method: "replace", url: "/prefix/bucket/index.html" },
    { method: "push", url: "https://other.example/external" },
    { method: "replace", url: null }
  ]);
});

test("the nested guard contains programmatic requests and dynamic resource URLs", async () => {
  const fetches: Array<{ input: string | Request; init: unknown; receiver: unknown }> = [];
  const xhrCalls: unknown[][] = [];
  const beaconCalls: Array<{ url: string; data: unknown; receiver: unknown }> = [];
  const eventSourceCalls: Array<{ url: string; options: unknown }> = [];

  class FakeXMLHttpRequest {
    open(...args: unknown[]): void {
      xhrCalls.push(args);
    }
  }
  class FakeEventSource {
    constructor(url: string, options?: unknown) {
      eventSourceCalls.push({ url, options });
    }
  }
  class FakeWebSocket {}
  class FakeElement {
    attributes = new Map<string, unknown>();

    setAttribute(name: string, value: unknown): void {
      this.attributes.set(name, value);
    }

    setAttributeNS(namespace: string | null, name: string, value: unknown): void {
      this.attributes.set(`${String(namespace)}:${name}`, value);
    }
  }
  class FakeImage extends FakeElement {
    storedSrc = "";
    storedSrcset = "";
  }
  Object.defineProperty(FakeImage.prototype, "src", {
    configurable: true,
    get(this: FakeImage): string { return this.storedSrc; },
    set(this: FakeImage, value: string) { this.storedSrc = value; }
  });
  Object.defineProperty(FakeImage.prototype, "srcset", {
    configurable: true,
    get(this: FakeImage): string { return this.storedSrcset; },
    set(this: FakeImage, value: string) { this.storedSrcset = value; }
  });

  class FakeForm extends FakeElement {
    storedAction = "/apiv2/form";
    submissions: Array<{ method: string; submitter?: FakeButton }> = [];

    submit(): void {
      this.submissions.push({ method: "submit" });
    }

    requestSubmit(submitter?: FakeButton): void {
      this.submissions.push({
        method: "requestSubmit",
        ...(submitter ? { submitter } : {})
      });
    }
  }
  Object.defineProperty(FakeForm.prototype, "action", {
    configurable: true,
    get(this: FakeForm): string { return this.storedAction; },
    set(this: FakeForm, value: string) { this.storedAction = value; }
  });
  class FakeButton {
    formAction = "/apiv2/button";
  }

  const nativeWebSocket = FakeWebSocket;
  const scope = {
    Request,
    fetch(this: unknown, input: string | Request, init?: unknown): Promise<object> {
      fetches.push({ input, init, receiver: this });
      return Promise.resolve({});
    },
    XMLHttpRequest: FakeXMLHttpRequest,
    EventSource: FakeEventSource,
    WebSocket: FakeWebSocket,
    Element: FakeElement,
    HTMLImageElement: FakeImage,
    HTMLFormElement: FakeForm,
    HTMLButtonElement: FakeButton
  };
  const navigator = {
    sendBeacon(this: unknown, url: string, data?: unknown): boolean {
      beaconCalls.push({ url, data, receiver: this });
      return true;
    }
  };
  const document = { addEventListener(): void {} };
  const location = {
    href: "https://storage.example/prefix/bucket/index.html",
    origin: "https://storage.example",
    pathname: "/prefix/bucket/index.html"
  };
  const source = guardScript("/prefix/bucket/")
    .replace(/^<script[^>]*>/, "")
    .replace(/<\/script>$/, "");
  const run = new Function("self", "navigator", "location", "URL", "document", source);
  run(scope, navigator, location, URL, document);

  const guardedFetch = scope.fetch as (
    input: string | Request,
    init?: unknown
  ) => Promise<object>;
  await guardedFetch("/apiv2/nick", { credentials: "include" });
  await guardedFetch("https://other.example/api");
  const originalRequest = new Request("https://storage.example/apiv2/profile", {
    method: "POST",
    body: "payload",
    credentials: "include",
    headers: { "content-type": "text/plain" },
    integrity: "sha256-test",
    redirect: "manual",
    referrerPolicy: "no-referrer"
  });
  await guardedFetch(originalRequest, { cache: "no-store" });

  assert.equal(fetches[0]?.input, "https://storage.example/prefix/bucket/apiv2/nick");
  assert.equal(fetches[1]?.input, "https://other.example/api");
  const mappedRequest = fetches[2]?.input;
  assert.ok(mappedRequest instanceof Request);
  assert.notEqual(mappedRequest, originalRequest);
  assert.equal(mappedRequest.url, "https://storage.example/prefix/bucket/apiv2/profile");
  assert.equal(mappedRequest.method, "POST");
  assert.equal(mappedRequest.credentials, "include");
  assert.equal(mappedRequest.headers.get("content-type"), "text/plain");
  assert.equal(mappedRequest.integrity, "sha256-test");
  assert.equal(mappedRequest.redirect, "manual");
  assert.equal(mappedRequest.referrerPolicy, "no-referrer");
  assert.equal(await mappedRequest.clone().text(), "payload");
  assert.deepEqual(fetches[2]?.init, { cache: "no-store" });
  assert.equal(fetches.every(call => call.receiver === scope), true);

  const xhr = new scope.XMLHttpRequest();
  xhr.open("POST", "/apiv2/nick", false, "user", "password");
  assert.deepEqual(xhrCalls, [[
    "POST",
    "https://storage.example/prefix/bucket/apiv2/nick",
    false,
    "user",
    "password"
  ]]);

  assert.equal(navigator.sendBeacon("/apiv2/playtime/42", "state"), true);
  assert.deepEqual(beaconCalls[0], {
    url: "https://storage.example/prefix/bucket/apiv2/playtime/42",
    data: "state",
    receiver: navigator
  });

  const GuardedEventSource = scope.EventSource as typeof FakeEventSource;
  new GuardedEventSource("/apiv2/chat/room?id=1", { withCredentials: true });
  new GuardedEventSource("https://events.example/stream");
  assert.deepEqual(eventSourceCalls, [
    {
      url: "https://storage.example/prefix/bucket/apiv2/chat/room?id=1",
      options: { withCredentials: true }
    },
    { url: "https://events.example/stream", options: undefined }
  ]);
  assert.equal(scope.WebSocket, nativeWebSocket, "WebSocket endpoints must not be virtualised");

  const element = new scope.Element();
  element.setAttribute("src", "/apiv2/avatar");
  element.setAttribute("href", "https://other.example/page");
  element.setAttribute("data-token", "/must-remain-an-opaque-value");
  element.setAttributeNS("http://www.w3.org/1999/xlink", "href", "/icons/account.svg");
  assert.equal(
    element.attributes.get("src"),
    "https://storage.example/prefix/bucket/apiv2/avatar"
  );
  assert.equal(element.attributes.get("href"), "https://other.example/page");
  assert.equal(element.attributes.get("data-token"), "/must-remain-an-opaque-value");
  assert.equal(
    element.attributes.get("http://www.w3.org/1999/xlink:href"),
    "https://storage.example/prefix/bucket/icons/account.svg"
  );

  const image = new scope.HTMLImageElement();
  (image as FakeImage & { src: string; srcset: string }).src = "/apiv2/avatar";
  (image as FakeImage & { src: string; srcset: string }).srcset = "/a.png 1x, /b.png 2x";
  assert.equal(image.storedSrc, "https://storage.example/prefix/bucket/apiv2/avatar");
  assert.equal(
    image.storedSrcset,
    "https://storage.example/prefix/bucket/a.png 1x, https://storage.example/prefix/bucket/b.png 2x"
  );

  const form = new scope.HTMLFormElement();
  const submitter = new scope.HTMLButtonElement();
  form.submit();
  form.storedAction = "/apiv2/other-form";
  form.requestSubmit(submitter);
  assert.equal(form.storedAction, "https://storage.example/prefix/bucket/apiv2/other-form");
  assert.equal(
    submitter.formAction,
    "https://storage.example/prefix/bucket/apiv2/button"
  );
  assert.deepEqual(form.submissions, [
    { method: "submit" },
    { method: "requestSubmit", submitter }
  ]);
});

test("guarding is idempotent", () => {
  const once = injectInto("<html><head></head></html>", null);
  assert.equal(injectInto(once, null), once);
  assert.equal(injectInto(once, BOOT), once, "already-guarded stays untouched");
});
