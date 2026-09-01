import assert from "node:assert/strict";
import test from "node:test";

import {
  WIRE_CONTENT_ENCODING_HEADER,
  decodeWireBody,
  requestBodyForTransport,
  responseHeaders,
  supportsWireGzip
} from "../src/bridge.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

test("negotiated YuriRTC gzip round-trips without exposing wire metadata", async () => {
  assert.equal(supportsWireGzip(), true);
  const original = new TextEncoder().encode("universal static content\n".repeat(8_192));
  const compressed = new Blob([original]).stream().pipeThrough(new CompressionStream("gzip"));
  const decoded = await readAll(decodeWireBody(compressed, "gzip"));
  assert.deepEqual(decoded, original);

  const headers = responseHeaders([
    [WIRE_CONTENT_ENCODING_HEADER, "gzip"],
    ["content-length", "123"],
    ["content-type", "text/plain"]
  ]);
  assert.equal(headers.has(WIRE_CONTENT_ENCODING_HEADER), false);
  assert.equal(headers.has("content-length"), false);
  assert.equal(headers.get("content-type"), "text/plain");
});

test("an unnegotiated wire encoding fails closed", () => {
  const body = new Blob(["x"]).stream();
  assert.throws(() => decodeWireBody(body, "br"), /unsupported YuriRTC wire encoding/);
});

test("service-worker uploads keep an exposed request stream", async () => {
  const stream = new Blob(["streamed"]).stream();
  let buffered = false;
  const body = await requestBodyForTransport({
    method: "POST",
    body: stream,
    blob: async () => {
      buffered = true;
      return new Blob();
    }
  });

  assert.equal(body, stream);
  assert.equal(buffered, false);
});

test("service-worker uploads fall back to Body mixins when Request.body is hidden", async () => {
  const body = await requestBodyForTransport({
    method: "PUT",
    blob: async () => new Blob(["firefox upload"])
  });

  assert.ok(body);
  assert.equal(new TextDecoder().decode(await readAll(body)), "firefox upload");
});

test("bodyless methods and empty fallback bodies do not create upload streams", async () => {
  let reads = 0;
  const source = {
    body: null,
    blob: async () => {
      reads += 1;
      return new Blob();
    }
  };

  assert.equal(await requestBodyForTransport({ ...source, method: "GET" }), undefined);
  assert.equal(await requestBodyForTransport({ ...source, method: "HEAD" }), undefined);
  assert.equal(reads, 0);
  assert.equal(await requestBodyForTransport({ ...source, method: "POST" }), undefined);
  assert.equal(reads, 1);
});

test("a service-worker Body mixin failure propagates instead of sending an empty upload", async () => {
  await assert.rejects(
    requestBodyForTransport({
      method: "POST",
      blob: async () => {
        throw new Error("body unavailable");
      }
    }),
    /body unavailable/
  );
});
