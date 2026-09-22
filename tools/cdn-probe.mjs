// Read-only browser CORS and byte-identity probe for an already-published release.
// Usage: node tools/cdn-probe.mjs 0.5.3
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { packageUrls } from "../packages/protocol/src/cdn.ts";
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version ?? "")) throw Error("pass an immutable published loader version");
const server=createServer((_req,res)=>res.end("<!doctype html><title>CDN probe</title>"));
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const files=["dist/bundle/client.js","dist/bundle/sw.js","dist/assets/rot13.woff"];
 const results=[];
 for(const file of files) {
  const probes=await page.evaluate(async urls=>Promise.all(urls.map(async url=>{
   try {
    const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)return {url,status:response.status};
    const bytes=await response.arrayBuffer();
    const sha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(x=>x.toString(16).padStart(2,"0")).join("");
    return {url,status:response.status,bytes:bytes.byteLength,sha256};
   }catch(error){return {url,error:String(error)};}
  })),packageUrls("@advwebrec/grainloading",version,file));
  results.push({file,probes});
 }
 console.log(JSON.stringify({checkedAt:new Date().toISOString(),version,results},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
