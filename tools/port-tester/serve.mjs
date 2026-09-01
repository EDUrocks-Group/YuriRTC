#!/usr/bin/env node
// Minimal static server for the local port tester. LOCAL DIAGNOSTIC ONLY.
// Serves this directory over http://localhost so the page runs in a secure
// context (localhost qualifies) — WebRTC and the Firebase REST calls need it,
// and file:// does not provide it.
//
//   node tools/port-tester/serve.mjs [port]
//
// Then open the printed URL. Nothing here is part of any published package.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8787;

const types = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const path = join(here, rel === "/" ? "port-test.html" : rel);
    if (!path.startsWith(here)) { res.writeHead(403).end("forbidden"); return; }
    const body = await readFile(path);
    const ext = path.slice(path.lastIndexOf("."));
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`port tester → http://localhost:${port}/port-test.html`);
});
