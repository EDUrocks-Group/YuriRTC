import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright-core";
import { createHash, generateKeyPairSync } from "node:crypto";
import { loaderDescriptor, signManifest, base64url } from "../../../packages/integrity/manifest-crypto.mjs";
import { packageUrls } from "../../../packages/protocol/src/cdn.ts";

const root = new URL("../../../", import.meta.url).pathname;
const client = "export const verified = true;";
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKeySpki = base64url(keys.publicKey.export({ format: "der", type: "spki" }));
const descriptor = loaderDescriptor("0.5.3", createHash("sha256").update(client).digest("base64url"));
const manifest = JSON.stringify(signManifest(descriptor, keys.privateKey));

for (const engine of [chromium, firefox, webkit]) {
 test(`${engine.name()}: five CDN fallbacks, isolated cookies and cache invalidation`, async () => {
  const bundle = await build({ stdin: { contents: `
    export { resolveLoader } from "./deploy/npm/src/integrity-loader.mjs";
    export * from "./packages/loader/src/cache.ts";
    export * from "./packages/loader/src/session.ts";
    export { RtdbBackend } from "./packages/signaling/src/rtdb.ts";
  `, resolveDir: root }, bundle: true, write: false, format: "esm", platform: "browser" });
  const stub = await readFile(new URL("../src/sw.js", import.meta.url), "utf8");
  let workerWinner = 0;
  const workerAttempts = [];
  const server = createServer((req,res) => {
   res.setHeader("Cache-Control","no-store");
   if (req.url.startsWith("/sw.js")) {
    res.setHeader("Content-Type", "text/javascript");
    res.end(stub.replace("__YURIRTC_WORKER_CDN_BASES__", JSON.stringify(Array.from({length:5},(_,i)=>`/cdn${i}/pkg@VERSION/dist/bundle/sw.js${i===2?"?raw":""}`))));
   } else if (req.url.startsWith("/cdn")) {
    const index=Number(req.url[4]);workerAttempts.push(req.url);
    res.setHeader("Content-Type", "text/javascript");
    if(index!==workerWinner){res.statusCode=404;res.end("unavailable");}
    else res.end('self.addEventListener("install",event=>event.waitUntil(self.skipWaiting()));');
   } else if (req.url === "/features.js") { res.setHeader("Content-Type","text/javascript");res.end(bundle.outputFiles[0].contents); }
   else { res.setHeader("Content-Type","text/html");res.end('<script type="module">import * as api from "/features.js"; window.api=api;</script>'); }
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await engine.launch({headless:true});
  try {
   const page=await browser.newPage();
   let winner=0; const seen=[];
   await page.route("https://**/*",async route=>{
    const url=route.request().url();seen.push(url);
    if (new URL(url).pathname.endsWith("loader.json")) return route.fulfill({contentType:"application/json",body:manifest,headers:{"Access-Control-Allow-Origin":"*"}});
    const index=descriptor.urls.indexOf(url);
    if(index!==winner)return route.abort();
    return route.fulfill({contentType:"text/javascript",body:client,headers:{"Access-Control-Allow-Origin":"*"}});
   });
   await page.goto(origin);await page.waitForFunction(()=>window.api);
   for(winner=0;winner<5;winner++) {
    seen.length=0;
    const result=await page.evaluate(async publicKeySpki=>{
     const r=await api.resolveLoader({publicKeySpki,versionStore:null});
     const m=await import(URL.createObjectURL(new Blob([r.bytes],{type:"text/javascript"})));
     return {url:r.url,verified:m.verified};
    },publicKeySpki);
    assert.equal(result.verified,true);assert.equal(result.url,descriptor.urls[winner]);
    assert.deepEqual(seen.filter(u=>new URL(u).pathname.endsWith("client.js")),descriptor.urls.slice(0,winner+1));
   }
   // Classic service-worker imports must use raw JS, including the esm.sh
   // query. HTTP failures must advance to every later mirror in order.
   for(workerWinner=0;workerWinner<5;workerWinner++) {
    workerAttempts.length=0;
    await page.evaluate(async n=>{
     const reg=await navigator.serviceWorker.register(`/sw.js?yurirtc-loader=0.5.3&case=${n}`);
     const worker=reg.installing || reg.waiting || reg.active;
     if(worker.state!=="activated") await new Promise((resolve,reject)=>worker.addEventListener("statechange",()=>{
      if(worker.state==="activated")resolve();
      if(worker.state==="redundant")reject(Error("worker import failed"));
     }));
     await reg.unregister();
    },workerWinner);
    assert.deepEqual([...new Set(workerAttempts.map(path=>Number(path[4])))],Array.from({length:workerWinner+1},(_,i)=>i));
    if(workerWinner>=2)assert.ok(workerAttempts.some(path=>path.endsWith("sw.js?raw")));
   }
   // The actual cache implementation, actual CacheStorage/IndexedDB, and an
   // unfinished response reproduce the clear-during-download race.
   const cacheResult=await page.evaluate(async()=>{
    const budget={budgetBytes:1048576,maxQuotaShare:.5};
    const request=new Request(location.origin+"/slow.bin");let upstream;
    const stream=new ReadableStream({start(c){upstream=c;}});
    const response=api.cacheWhileConsumed(request,new Response(stream,{headers:{"cache-tag":"slow"}}),"revalidate-lru",budget);
    const consume=response.text();
    upstream.enqueue(new TextEncoder().encode("old"));
    await api.clearAllCaches();upstream.close();await consume;
    await new Promise(r=>setTimeout(r,50));
    if(await caches.match(request))throw Error("old response repopulated cleared cache");
    const a=new Request(location.origin+"/a.bin"),b=new Request(location.origin+"/b.bin");
    await api.putBounded(a,new Response("a",{headers:{"cache-tag":"game:a"}}),"revalidate-lru",budget);
    await api.putBounded(b,new Response("b",{headers:{"cache-tag":"game:b"}}),"revalidate-lru",budget);
    await api.invalidateCaches(["game:a"]);
    if(await caches.match(a) || !(await caches.match(b)))throw Error("tag selector failed");
    await api.invalidateCaches(undefined,[b.url]);
    if(await caches.match(b))throw Error("URL selector failed");
    return true;
   });assert.equal(cacheResult,true);
   const cookieResult=await page.evaluate(async()=>{
    await api.configureSession(location.origin+"/one/","persistent");
    await api.applySetCookie("sid=persistent; Path=/apiv2/auth; HttpOnly; Secure");
    if(await api.cookieHeader("/apiv2/auth/me")!=="sid=persistent")throw Error("cookie missing");
    if(await api.cookieHeader("/apiv2/other"))throw Error("cookie escaped path");
    await api.configureSession(location.origin+"/two/","persistent");
    if(await api.cookieHeader("/apiv2/auth/me"))throw Error("cookie escaped deployment scope");
    await api.configureSession(location.origin+"/one/","memory");
    await api.applySetCookie("sid=memory-only; Path=/");
    if(await api.cookieHeader("/apiv2")!=="sid=memory-only")throw Error("memory cookie missing");
    await api.configureSession(location.origin+"/one/","persistent");
    if(await api.cookieHeader("/apiv2"))throw Error("memory token was persisted");
    return true;
   });assert.equal(cookieResult,true);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
 });
}

// Optional local Firebase emulator: exercises the real rules, HTTP PUT and
// browser EventSource, rather than mocking away the permission decision.
test("RTDB rules and simultaneous Playwright exchanges", {skip:!process.env.YURIRTC_RTDB_EMULATOR}, async()=>{
 const base=process.env.YURIRTC_RTDB_EMULATOR;
 const rules=await readFile(new URL("../../firebase/database.rules.json",import.meta.url),"utf8");
 await fetch(base+"/signal/test-user.json",{method:"DELETE",headers:{Authorization:"Bearer owner"}});
 const set=await fetch(base+"/.settings/rules.json",{method:"PUT",headers:{Authorization:"Bearer owner"},body:rules});
 assert.equal(set.status,200,await set.text());
 const claims={sub:"test-user",user_id:"test-user",aud:"demo-yurirtc",iss:"https://securetoken.google.com/demo-yurirtc",iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,firebase:{sign_in_provider:"anonymous"}};
 const token=Buffer.from(JSON.stringify({alg:"none",typ:"JWT"})).toString("base64url")+"."+Buffer.from(JSON.stringify(claims)).toString("base64url")+".";
 const browser=await chromium.launch({headless:true});
 const bundle=await build({entryPoints:[root+"packages/signaling/src/rtdb.ts"],bundle:true,write:false,format:"esm"});
 const server=createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/module.js"?"text/javascript":"text/html");res.end(req.url==="/module.js"?bundle.outputFiles[0].contents:'<script type="module">import {RtdbBackend} from "/module.js";window.Backend=RtdbBackend;</script>');});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try {
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.Backend);
  await page.evaluate(({base,token})=>localStorage.setItem(`yurirtc:rtdb-auth:test-key:${base}`,JSON.stringify({idToken:token,localId:"test-user",refreshToken:"unused",expiresAt:Date.now()+300000})),{base,token});
  const exchanging=page.evaluate(async base=>Promise.all(["first","second"].map(sessionId=>new Backend({apiKey:"test-key",databaseUrl:base}).exchange({sessionId,sdp:"v=0",candidates:[]},new AbortController().signal))),base);
  let sessions;
  for(let i=0;i<100;i++) {
   sessions=await fetch(base+"/signal/test-user/sessions.json",{headers:{Authorization:"Bearer owner"}}).then(r=>r.json());
   if(sessions && Object.keys(sessions).length===2)break;
   await new Promise(r=>setTimeout(r,30));
  }
  assert.equal(Object.keys(sessions??{}).length,2);
  for(const [id,{offer}] of Object.entries(sessions)) {
   const forbidden=await fetch(`${base}/signal/test-user/sessions/${id}/answer.json?auth=${token}`,{method:"PUT",body:JSON.stringify({sdp:"forged",candidates:[]})});assert.equal(forbidden.status,401);
   const result=await fetch(`${base}/signal/test-user/sessions/${id}/answer.json`,{method:"PUT",headers:{Authorization:"Bearer owner"},body:JSON.stringify({sdp:offer.sessionId,candidates:[]})});assert.equal(result.status,200);
  }
  assert.deepEqual((await exchanging).map(x=>x.sdp),["first","second"]);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
