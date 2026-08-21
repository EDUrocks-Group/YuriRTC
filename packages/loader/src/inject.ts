/**
 * Injecting the transport into every document the SW serves.
 *
 * `RTCPeerConnection` does not exist in `ServiceWorkerGlobalScope`, so the
 * connection lives in the page. That has a consequence which is easy to
 * miss until it bites: the *only* page carrying the loader is the bucket's
 * bootstrap page, and the moment the SW takes over it serves the real site
 * instead — a document with no loader in it. The SW then has no client to route
 * through and every request fails.
 *
 * So the SW injects the client into each HTML document on its way out. The page
 * reconnects on load and hands the SW a fresh port.
 *
 * Config is persisted rather than held in memory because the SW can be killed
 * and restarted with no page attached, and would otherwise wake up unable to
 * bootstrap the very thing it needs.
 */

import type { YuriRTCConfig } from "./config.js";

const DB_NAME = "edurocks-loader-config";
const STORE = "config";
const KEY = "current";

export interface InjectedBootstrap {
  /**
   * Ordered client-bundle sources. More than one because a blocked CDN must
   * degrade to the other rather than leaving the page with no transport.
   */
  clientUrls: string[];
  config: YuriRTCConfig;
  /** Canonical page that owns the transport and can rebuild it after a cold visit. */
  shellPath?: string;
  /** Build id reported by the transported site's guarded worker registration. */
  siteVersion?: string;
}

export function mergeBootstrap(
  previous: InjectedBootstrap | null,
  incoming: InjectedBootstrap
): InjectedBootstrap {
  if (!previous) return incoming;
  return {
    ...incoming,
    ...(!incoming.shellPath && previous.shellPath ? { shellPath: previous.shellPath } : {}),
    ...(!incoming.siteVersion && previous.siteVersion ? { siteVersion: previous.siteVersion } : {})
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("config_open_failed"));
  });
}

export async function saveBootstrap(value: InjectedBootstrap): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("config_write_failed"));
    });
  } finally {
    db.close();
  }
}

export async function loadBootstrap(): Promise<InjectedBootstrap | null> {
  try {
    const db = await open();
    try {
      return await new Promise<InjectedBootstrap | null>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(KEY);
        request.onsuccess = () => resolve((request.result as InjectedBootstrap) ?? null);
        request.onerror = () => reject(request.error ?? new Error("config_read_failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Marker so a document is never injected twice. */
export const INJECT_MARKER = "__edurocks_loader__";
export const GUARD_MARKER = "__edurocks_guard__";
// Script ids become named Window properties. Runtime flags therefore must not
// reuse the ids or the element itself is truthy before its code even starts.
export const INJECT_STATE = "__edurocks_loader_active__";
export const GUARD_STATE = "__edurocks_guard_active__";

/**
 * Stops the served page from tearing down the worker that is serving it.
 *
 * The site ships its own service worker bootstrap. Left alone it registers
 * `/sw.js?v=<build>` for the same scope, which *replaces* our registration and
 * tears down the transport worker currently serving it.
 *
 * Inside the frame that is fatal rather than merely wasteful: the reload lands
 * while the worker is being swapped, so the navigation misses the worker
 * entirely and falls through to whatever is actually hosting the loader.
 *
 * Registration therefore becomes a no-op that hands back the worker already
 * running. Its build id is forwarded to that worker so the V4/V5 cache-update
 * contract is preserved even though the transport registration stays in place.
 */
export function guardScript(scopePath = "/"): string {
  const scope = JSON.stringify(scopePath).replace(/</g, "\\u003c");
  // Treat a directory-scoped object-store deployment as the site's virtual
  // root. Static markup is rebased in the response stream below; this guard is
  // injected before site scripts so URLs created later through browser APIs
  // cannot fall through to the object-store origin root. WebSocket is
  // deliberately excluded: service workers cannot proxy it, so changing its
  // pathname would only disguise an unsupported endpoint.
  return (
    `<script id="${GUARD_MARKER}">` +
    `(function(){if(self.${GUARD_STATE})return;self.${GUARD_STATE}=1;` +
    `var s=${scope};function p(u){if(s==="/"||u==null)return u;try{var x=new URL(u,location.href);` +
    `if(x.origin===location.origin&&x.pathname.indexOf(s)!==0){` +
    `x.pathname=s+x.pathname.replace(/^\\/+/,"");return x.href;}}catch(e){}return u;}` +
    `function q(u){return typeof u==="string"?u.replace(/(^|,\\s*)(\\/(?!\\/)[^\\s,]+)/g,` +
    `function(_,a,v){return a+p(v);}):u;}` +
    `var F=self.fetch,R=self.Request;if(s!=="/"&&F)self.fetch=function(i,o){try{` +
    `if(R&&i instanceof R){var v=p(i.url);if(v!==i.url)i=new R(v,i);}else i=p(i);` +
    `}catch(e){return Promise.reject(e);}return F.call(self,i,o);};` +
    `var X=self.XMLHttpRequest,P=X&&X.prototype,O=P&&P.open;if(s!=="/"&&O)try{P.open=function(){` +
    `if(arguments.length>1)arguments[1]=p(arguments[1]);return O.apply(this,arguments);};}catch(e){}` +
    `var B=navigator.sendBeacon;if(s!=="/"&&B)try{navigator.sendBeacon=function(u,d){return B.call(this,p(u),d);};}catch(e){}` +
    `var U={action:1,background:1,cite:1,codebase:1,data:1,formaction:1,href:1,longdesc:1,` +
    `manifest:1,poster:1,profile:1,src:1,usemap:1};` +
    `var E=self.Element,A=E&&E.prototype&&E.prototype.setAttribute;if(s!=="/"&&A)try{E.prototype.setAttribute=function(n,v){` +
    `var a=String(n).toLowerCase();return A.call(this,n,a==="srcset"||a==="imagesrcset"?q(v):U[a]?p(v):v);};}catch(e){}` +
    `var AN=E&&E.prototype&&E.prototype.setAttributeNS;if(s!=="/"&&AN)try{E.prototype.setAttributeNS=function(ns,n,v){` +
    `var a=String(n).toLowerCase();return AN.call(this,ns,n,a==="href"||a==="xlink:href"?p(v):v);};}catch(e){}` +
    `function d(n,a,f){if(s==="/")return;var C=self[n],D=C&&Object.getOwnPropertyDescriptor(C.prototype,a);` +
    `if(!D||!D.set||!D.configurable)return;try{Object.defineProperty(C.prototype,a,Object.assign({},D,{` +
    `set:function(v){return D.set.call(this,f(v));}}));}catch(e){}}` +
    `[["HTMLAnchorElement","href"],["HTMLAreaElement","href"],["HTMLBaseElement","href"],` +
    `["HTMLLinkElement","href"],["HTMLImageElement","src"],["HTMLScriptElement","src"],` +
    `["HTMLIFrameElement","src"],["HTMLFrameElement","src"],["HTMLEmbedElement","src"],` +
    `["HTMLSourceElement","src"],["HTMLTrackElement","src"],["HTMLMediaElement","src"],` +
    `["HTMLInputElement","src"],["HTMLInputElement","formAction"],["HTMLButtonElement","formAction"],` +
    `["HTMLFormElement","action"],["HTMLObjectElement","data"],["HTMLVideoElement","poster"]]` +
    `.forEach(function(a){d(a[0],a[1],p);});` +
    `[["HTMLImageElement","srcset"],["HTMLSourceElement","srcset"]]` +
    `.forEach(function(a){d(a[0],a[1],q);});` +
    `function j(n){if(s==="/")return;var C=self.HTMLFormElement,P=C&&C.prototype,H=P&&P[n];if(!H)return;try{P[n]=function(b){` +
    `try{this.action=p(this.action);if(b&&b.formAction)b.formAction=p(b.formAction);}catch(e){}` +
    `return H.apply(this,arguments);};}catch(e){}}j("submit");j("requestSubmit");` +
    `function w(n){var C=self[n];if(!C)return;var N=function(u,o){return new C(p(u),o)};` +
    `N.prototype=C.prototype;try{Object.setPrototypeOf(N,C);self[n]=N;}catch(e){}}` +
    `w("Worker");w("SharedWorker");if(s!=="/")w("EventSource");var wo=self.open;if(wo)self.open=function(u,n,f){` +
    `return wo.call(self,p(u),n,f);};` +
    `var h=self.history;["pushState","replaceState"].forEach(function(n){var f=h&&h[n];if(!f)return;` +
    `try{h[n]=function(){if(arguments.length>2&&arguments[2]!=null)arguments[2]=p(arguments[2]);` +
    `return f.apply(h,arguments);};}catch(e){}});` +
    `var g=self.navigation;if(g&&g.addEventListener)g.addEventListener("navigate",function(e){try{` +
    `var u=e.destination&&e.destination.url,v=p(u);if(v&&v!==u&&e.cancelable){e.preventDefault();` +
    `g.navigate(v,{history:"replace"});}}catch(x){}});` +
    `if(typeof document!=="undefined"){document.addEventListener("click",function(e){var q=e.target&&e.target.closest?` +
    `e.target.closest("#back-btn"):null;if(q&&s!=="/"&&/(?:^|\\/)g-fra(?:-sab)?\\.html$/.test(location.pathname)` +
    `&&typeof self.getGamesReturnHref==="function"){var u,v;try{u=self.getGamesReturnHref();v=p(u);}catch(x){}` +
    `if(v&&v!==u){e.preventDefault();e.stopImmediatePropagation();location.href=v;return;}}` +
    `var a=e.target&&e.target.closest?e.target.closest("a[href],area[href]"):null;if(a)a.href=p(a.href);},true);` +
    `document.addEventListener("submit",function(e){var f=e.target;` +
    `if(f&&f.action)f.action=p(f.action);},true);}` +
    `var c=navigator.serviceWorker;if(!c)return;var r=c.ready;try{` +
    `Object.defineProperty(c,"register",{configurable:true,value:function(u){` +
    `var q=null,v=null;try{q=new URL(p(u),location.href);v=q.searchParams.get("v");}catch(e){}` +
    `if(v)r.then(function(g){var w=g.active||c.controller;` +
    `if(!w)return;try{var a=new URL(w.scriptURL);` +
    `if(!q||q.origin!==a.origin||q.pathname!==a.pathname)return;}catch(e){return;}` +
    `w.postMessage({t:"site-version",version:v});}).catch(function(){});return r;}});` +
    `Object.defineProperty(c,"getRegistrations",{configurable:true,value:function(){return Promise.resolve([]);}});` +
    `Object.defineProperty(c,"getRegistration",{configurable:true,value:function(){return r;}});` +
    `}catch(e){console.warn("[YuriRTC] could not guard serviceWorker",e);}})();` +
    `</scr` +
    `ipt>`
  );
}

export function bootstrapScript(boot: InjectedBootstrap): string {
  // JSON.stringify escapes `<` poorly for inline scripts; `</script>` inside a
  // string would close the tag early. Escape the sequence explicitly.
  const config = JSON.stringify(boot.config).replace(/</g, "\\u003c");
  const urls = JSON.stringify(boot.clientUrls).replace(/</g, "\\u003c");
  const shellPath = JSON.stringify(boot.shellPath ?? null).replace(/</g, "\\u003c");

  // A *classic* inline script, not `type="module"`.
  //
  // Module scripts are deferred until the document has finished parsing — but
  // parsing blocks on the page's own `<script src="/a/…">` tags, which the SW
  // cannot serve without the transport this script creates. Deferring it
  // deadlocks the page.
  //
  // Classic inline scripts run the moment the parser reaches them, so the
  // dynamic import and the connection start while the rest of the document is
  // still being parsed. Requests that arrive before it completes queue in the
  // SW's bridge and drain once the port attaches.
  return (
    `<script id="${INJECT_MARKER}">` +
    `if(!self.${INJECT_STATE}){self.${INJECT_STATE}=1;` +
    `(function(u,i){function n(){` +
    `if(i>=u.length)return Promise.reject(new Error("no loader source reachable"));` +
    `return import(u[i++]).catch(n);}return n();})(${urls},0)` +
    `.then(function(m){` +
    `return navigator.serviceWorker.ready.then(function(r){` +
    `var C=m.YuriRTCClient||m.LoaderClient;` +
    `if(!C)throw new Error("YuriRTC client export unavailable");` +
    `return new C(${config},${shellPath}).connect(r);});})` +
    `.then(function(){})` +
    `.catch(function(){console.error("[YuriRTC] transport unavailable");});}` +
    `</scr` +
    `ipt>`
  );
}

function isAsciiWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r";
}

/** Finds a tag/declaration end without treating a quoted `>` as the end. */
function markupEnd(html: string, from: number): number | null {
  let quote: "\"" | "'" | null = null;
  for (let at = from; at < html.length; at += 1) {
    const char = html[at];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return at + 1;
  }
  return null;
}

/** Whitespace and comments are legal between every part of the document prologue. */
function skipPrologueTrivia(html: string, from: number): number {
  let at = from;
  while (at < html.length) {
    while (isAsciiWhitespace(html[at])) at += 1;
    if (!html.startsWith("<!--", at)) break;
    const end = html.indexOf("-->", at + 4);
    // Inserting before a malformed comment is safer than hiding the loader in it.
    if (end < 0) break;
    at = end + 3;
  }
  return at;
}

interface StartTag {
  name: string;
  end: number;
}

function startTagAt(html: string, at: number): StartTag | null {
  if (html[at] !== "<" || !/[A-Za-z]/.test(html[at + 1] ?? "")) return null;

  let nameEnd = at + 2;
  while (/[A-Za-z0-9:-]/.test(html[nameEnd] ?? "")) nameEnd += 1;
  const boundary = html[nameEnd];
  if (boundary !== ">" && boundary !== "/" && !isAsciiWhitespace(boundary)) return null;

  const end = markupEnd(html, nameEnd);
  if (end === null) return null;
  return { name: html.slice(at + 1, nameEnd).toLowerCase(), end };
}

function doctypeEndAt(html: string, at: number): number | null {
  const prefix = html.slice(at, at + 9).toLowerCase();
  if (prefix !== "<!doctype") return null;
  const boundary = html[at + 9];
  if (boundary !== ">" && !isAsciiWhitespace(boundary)) return null;
  return markupEnd(html, at + 9);
}

/**
 * Finds an insertion point without searching arbitrary document contents.
 *
 * `<html>`, `<head>`, and `<body>` are optional in HTML. If the first real
 * token is already a link, script, or other head content, the parser has
 * implicitly created those elements and any later `<head>` text may be inside
 * JavaScript, CSS, or an attribute. Only the legal document prologue is safe to
 * inspect: BOM/trivia, doctype, optional `<html>`, then an immediate `<head>` or
 * `<body>`. Otherwise the loader goes immediately before the first content
 * token while leaving a doctype first so standards mode is preserved.
 */
function injectionPoint(html: string): number {
  let at = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  at = skipPrologueTrivia(html, at);

  const doctypeEnd = doctypeEndAt(html, at);
  if (doctypeEnd !== null) at = skipPrologueTrivia(html, doctypeEnd);

  let fallback = at;
  let tag = startTagAt(html, at);
  if (tag?.name === "html") {
    fallback = tag.end;
    at = skipPrologueTrivia(html, tag.end);
    tag = startTagAt(html, at);
  }

  if (tag?.name === "head" || tag?.name === "body") return tag.end;
  return fallback;
}

function injectionScript(boot: InjectedBootstrap | null, scopePath = "/"): string {
  return guardScript(scopePath) + (boot ? bootstrapScript(boot) : "");
}

const ROOT_URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "codebase",
  "data",
  "data-href",
  "data-manifest",
  "data-original",
  "data-path",
  "data-src",
  "data-url",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "profile",
  "src",
  "usemap",
  "value"
]);

const MARKUP_REBASE_TAIL = 1024;

function isMarkupSpace(byte: number | undefined): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isAttributeNameByte(byte: number | undefined): boolean {
  return byte !== undefined && (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x2d || byte === 0x3a || byte === 0x5f
  );
}

function asciiLower(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index]!;
    value += String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
  }
  return value;
}

function slashStartsRootAttribute(bytes: Uint8Array, slash: number): boolean {
  if (bytes[slash] !== 0x2f || bytes[slash + 1] === 0x2f) return false;

  let at = slash - 1;
  if (bytes[at] === 0x22 || bytes[at] === 0x27) at -= 1;
  while (at >= 0 && isMarkupSpace(bytes[at])) at -= 1;
  if (bytes[at] !== 0x3d) return false;
  at -= 1;
  while (at >= 0 && isMarkupSpace(bytes[at])) at -= 1;
  const end = at + 1;
  while (at >= 0 && isAttributeNameByte(bytes[at])) at -= 1;
  if (end === at + 1) return false;
  return ROOT_URL_ATTRIBUTES.has(asciiLower(bytes, at + 1, end));
}

function bytesStartWith(bytes: Uint8Array, at: number, wanted: Uint8Array): boolean {
  if (at + wanted.byteLength > bytes.byteLength) return false;
  for (let index = 0; index < wanted.byteLength; index += 1) {
    if (bytes[at + index] !== wanted[index]) return false;
  }
  return true;
}

function attributeValueSlash(bytes: Uint8Array, equals: number, length: number): number {
  let at = equals + 1;
  while (at < length && isMarkupSpace(bytes[at])) at += 1;
  if (bytes[at] === 0x22 || bytes[at] === 0x27) at += 1;
  return at < length && bytes[at] === 0x2f ? at : -1;
}

function rebaseMarkupBytes(
  bytes: Uint8Array,
  scopePath: string,
  length = bytes.byteLength
): Uint8Array {
  if (scopePath === "/" || length === 0) return bytes.subarray(0, length);
  const scope = new TextEncoder().encode(scopePath);
  const scopeAfterSlash = scope.subarray(1);
  let pieces: Uint8Array[] | null = null;
  let from = 0;
  let outputLength = 0;

  for (
    let equals = bytes.indexOf(0x3d);
    equals >= 0 && equals < length;
    equals = bytes.indexOf(0x3d, equals + 1)
  ) {
    const at = attributeValueSlash(bytes, equals, length);
    if (at < 0 || !slashStartsRootAttribute(bytes, at)) continue;
    if (bytesStartWith(bytes, at + 1, scopeAfterSlash)) continue;
    if (pieces === null) pieces = [];
    if (at > from) {
      pieces.push(bytes.subarray(from, at));
      outputLength += at - from;
    }
    pieces.push(scope);
    outputLength += scope.byteLength;
    from = at + 1;
  }

  if (pieces === null) return bytes.subarray(0, length);
  if (from < length) {
    pieces.push(bytes.subarray(from, length));
    outputLength += length - from;
  }

  const output = new Uint8Array(outputLength);
  let offset = 0;
  for (const piece of pieces) {
    output.set(piece, offset);
    offset += piece.byteLength;
  }
  return output;
}

/** Rebase root-relative markup URLs without changing non-ASCII document bytes. */
export function rebaseRootRelativeMarkup(html: string, scopePath: string): string {
  const encoder = new TextEncoder();
  return new TextDecoder().decode(rebaseMarkupBytes(encoder.encode(html), scopePath));
}

const WEB_MANIFEST_URL_FIELDS = new Set([
  "action",
  "id",
  "scope",
  "src",
  "start_url",
  "url"
]);

function rebaseRootRelativeUrl(value: string, scopePath: string): string {
  if (scopePath === "/" || !value.startsWith("/") || value.startsWith("//")) return value;
  const suffixAt = value.search(/[?#]/);
  const pathname = suffixAt < 0 ? value : value.slice(0, suffixAt);
  const suffix = suffixAt < 0 ? "" : value.slice(suffixAt);
  const base = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
  if (pathname === base.slice(0, -1) || pathname.startsWith(base)) return value;
  return `${base}${pathname.replace(/^\/+/, "")}${suffix}`;
}

/**
 * V4's deployed web manifest still uses origin-root start, scope, icon, and
 * shortcut URLs. Unlike document subresources, those values are interpreted
 * by the browser outside the controlled page's fetch flow, so they must be
 * made scope-relative in the response itself.
 */
export function rebaseWebManifestJson(json: string, scopePath: string): string {
  if (scopePath === "/") return json;

  let manifest: unknown;
  try {
    manifest = JSON.parse(json);
  } catch {
    return json;
  }

  let changed = false;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;

    const mapped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (WEB_MANIFEST_URL_FIELDS.has(key) && typeof child === "string") {
        const rebased = rebaseRootRelativeUrl(child, scopePath);
        if (rebased !== child) changed = true;
        mapped[key] = rebased;
      } else {
        mapped[key] = visit(child);
      }
    }
    return mapped;
  };

  const rebased = visit(manifest);
  return changed ? JSON.stringify(rebased) : json;
}

function rebaseRootRelativeMarkupStream(
  body: ReadableStream<Uint8Array>,
  scopePath: string
): ReadableStream<Uint8Array> {
  if (scopePath === "/") return body;
  let pending: Uint8Array | null = null;

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let combined: Uint8Array;
      if (pending === null || pending.byteLength === 0) {
        combined = chunk;
      } else {
        combined = new Uint8Array(pending.byteLength + chunk.byteLength);
        combined.set(pending);
        combined.set(chunk, pending.byteLength);
      }
      if (combined.byteLength <= MARKUP_REBASE_TAIL) {
        pending = combined === chunk ? chunk.slice() : combined;
        return;
      }
      const length = combined.byteLength - MARKUP_REBASE_TAIL;
      controller.enqueue(rebaseMarkupBytes(combined, scopePath, length));
      pending = combined.slice(length);
    },
    flush(controller) {
      if (pending !== null && pending.byteLength > 0) {
        controller.enqueue(rebaseMarkupBytes(pending, scopePath));
      }
    }
  }));
}

/**
 * Places the bootstrap as early as possible so the transport is establishing
 * while the rest of the document parses. The insertion point is limited to the
 * document prologue so tag-looking text inside an existing script is never
 * mistaken for document structure.
 */
export function injectInto(
  html: string,
  boot: InjectedBootstrap | null
): string {
  // The guard goes into every document. The transport bootstrap only goes into
  // documents that have to build their own connection — a frame whose parent
  // already holds one would otherwise open a second, redundant transport.
  if (html.includes(GUARD_MARKER)) return html;
  const script = injectionScript(boot);
  const at = injectionPoint(html);
  return html.slice(0, at) + script + html.slice(at);
}

/**
 * Injects by inspecting only the first transport chunk, then passes every
 * remaining byte through unchanged. The document prologue is where the loader
 * is inserted, so buffering a whole HTML response (some library files are over
 * 100MB) only delayed first paint and created avoidable GC pressure.
 */
export function injectIntoStream(
  body: ReadableStream<Uint8Array>,
  boot: InjectedBootstrap | null,
  scopePath = "/"
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  const script = encoder.encode(injectionScript(boot, scopePath));
  let inspected = false;

  return rebaseRootRelativeMarkupStream(body, scopePath).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (inspected || chunk.byteLength === 0) {
        if (chunk.byteLength > 0) controller.enqueue(chunk);
        return;
      }
      inspected = true;

      const hasBom =
        chunk.byteLength >= 3 &&
        chunk[0] === 0xef &&
        chunk[1] === 0xbb &&
        chunk[2] === 0xbf;
      const bomBytes = hasBom ? 3 : 0;
      const decoded = decoder.decode(chunk.subarray(bomBytes));

      // A document injected by a previous pass is already safe. The marker is
      // deliberately placed in the prologue, so it is present in this chunk.
      if (decoded.includes(GUARD_MARKER)) {
        controller.enqueue(chunk);
        return;
      }

      const scanned = (hasBom ? "\ufeff" : "") + decoded;
      const characterAt = injectionPoint(scanned);
      const prefix = scanned.slice(hasBom ? 1 : 0, characterAt);
      const byteAt = bomBytes + encoder.encode(prefix).byteLength;

      if (byteAt > 0) controller.enqueue(chunk.subarray(0, byteAt));
      controller.enqueue(script);
      if (byteAt < chunk.byteLength) controller.enqueue(chunk.subarray(byteAt));
    },
    flush(controller) {
      // Preserve injectInto("") semantics for a genuinely empty HTML body.
      if (!inspected) controller.enqueue(script);
    }
  }));
}

export function isHtml(headers: Headers): boolean {
  const type = headers.get("content-type") ?? "";
  return type.includes("text/html");
}

/**
 * Content-Type alone does not make a response a browser document. Express uses
 * text/html for short string API responses too (for example a chat username),
 * and prepending a script to those payloads corrupts their application data.
 */
export function shouldInjectDocument(
  request: Pick<Request, "mode">,
  response: Pick<Response, "ok" | "headers">
): boolean {
  return request.mode === "navigate" && response.ok && isHtml(response.headers);
}
