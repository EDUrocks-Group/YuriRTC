import assert from "node:assert/strict";
import test from "node:test";

import {
  FrameType,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  RequestPriority,
  chunkBody,
  decodeCreditPayload,
  createRequestIdSource,
  decodeFrame,
  decodeFrameView,
  decodeJsonPayload,
  encodeCreditPayload,
  encodeFrame,
  encodeFrameChunks,
  encodeJsonFrame,
  type RequestHead,
  type ResponseHead
} from "../src/index.js";

test("round-trips a binary frame", () => {
  const payload = new Uint8Array([1, 2, 3, 250, 255]);
  const frame = decodeFrame(encodeFrame(FrameType.ResBody, 42, payload));

  assert.equal(frame.type, FrameType.ResBody);
  assert.equal(frame.requestId, 42);
  assert.deepEqual([...frame.payload], [...payload]);
});

test("round-trips a request head", () => {
  const head: RequestHead = {
    version: PROTOCOL_VERSION,
    method: "POST",
    url: "/apiv2/login?next=%2Fdashboard",
    headers: [["content-type", "application/json"]],
    hasBody: true,
    priority: RequestPriority.Interactive,
    initialCredits: 8
  };

  const decoded = decodeJsonPayload<RequestHead>(
    decodeFrame(encodeJsonFrame(FrameType.Req, 7, head))
  );
  assert.deepEqual(decoded, head);
});

test("round-trips required v3 response and request credit frames", () => {
  const head: RequestHead = {
    version: PROTOCOL_VERSION,
    method: "GET",
    url: "/large.bin",
    headers: [],
    hasBody: false,
    priority: RequestPriority.Bulk,
    initialCredits: 32
  };
  const decodedHead = decodeJsonPayload<RequestHead>(
    decodeFrame(encodeJsonFrame(FrameType.Req, 12, head))
  );
  assert.equal(decodedHead.version, 3);
  assert.equal(decodedHead.initialCredits, 32);

  const count = encodeCreditPayload(8);
  const frame = decodeFrame(encodeFrame(FrameType.Credit, 12, count));
  assert.equal(frame.type, FrameType.Credit);
  assert.equal(decodeCreditPayload(frame.payload), 8);

  const requestCredit = decodeFrame(
    encodeFrame(FrameType.ReqCredit, 12, encodeCreditPayload(16))
  );
  assert.equal(requestCredit.type, FrameType.ReqCredit);
  assert.equal(decodeCreditPayload(requestCredit.payload), 16);
});

test("rejects malformed or zero v3 credit payloads", () => {
  assert.throws(() => encodeCreditPayload(0), ProtocolError);
  assert.throws(() => encodeCreditPayload(1.5), ProtocolError);
  assert.throws(() => decodeCreditPayload(new Uint8Array(3)), ProtocolError);
  assert.throws(() => decodeCreditPayload(new Uint8Array(4)), ProtocolError);
});

test("coalesces payload views directly into one frame", () => {
  const frame = decodeFrame(encodeFrameChunks(FrameType.ReqBody, 17, [
    Uint8Array.of(1, 2),
    new Uint8Array(),
    Uint8Array.of(3),
    Uint8Array.of(4, 5)
  ]));
  assert.equal(frame.type, FrameType.ReqBody);
  assert.equal(frame.requestId, 17);
  assert.deepEqual([...frame.payload], [1, 2, 3, 4, 5]);
});

test("direct chunk encoding enforces the aggregate payload cap", () => {
  assert.throws(
    () => encodeFrameChunks(FrameType.ReqBody, 1, [
      new Uint8Array(MAX_PAYLOAD_BYTES),
      Uint8Array.of(1)
    ]),
    ProtocolError
  );
});

test("preserves duplicate Set-Cookie headers", () => {
  // The service worker depends on this to maintain its cookie jar.
  const head: ResponseHead = {
    status: 200,
    statusText: "OK",
    headers: [
      ["set-cookie", "sid=abc; Path=/; HttpOnly"],
      ["set-cookie", "theme=dark; Path=/"],
      ["content-type", "application/json"]
    ]
  };

  const decoded = decodeJsonPayload<ResponseHead>(
    decodeFrame(encodeJsonFrame(FrameType.ResHead, 9, head))
  );
  assert.equal(decoded.headers.filter(([name]) => name === "set-cookie").length, 2);
  assert.deepEqual(decoded, head);
});

test("handles empty payloads", () => {
  const frame = decodeFrame(encodeFrame(FrameType.ResEnd, 1));
  assert.equal(frame.type, FrameType.ResEnd);
  assert.equal(frame.payload.byteLength, 0);
});

test("accepts a maximum-size payload and rejects one byte more", () => {
  const atLimit = new Uint8Array(MAX_PAYLOAD_BYTES);
  assert.equal(encodeFrame(FrameType.ResBody, 1, atLimit).byteLength, HEADER_BYTES + MAX_PAYLOAD_BYTES);

  assert.throws(
    () => encodeFrame(FrameType.ResBody, 1, new Uint8Array(MAX_PAYLOAD_BYTES + 1)),
    ProtocolError
  );

  const oversizedWireFrame = new Uint8Array(MAX_FRAME_BYTES + 1);
  oversizedWireFrame[0] = FrameType.ResBody;
  new DataView(oversizedWireFrame.buffer).setUint32(1, 1, false);
  assert.throws(() => decodeFrame(oversizedWireFrame), ProtocolError);
  assert.throws(() => decodeFrameView(oversizedWireFrame), ProtocolError);
});

test("round-trips the largest representable requestId", () => {
  const frame = decodeFrame(encodeFrame(FrameType.Cancel, 0xffffffff));
  assert.equal(frame.requestId, 0xffffffff);
});

test("rejects requestId 0 and negatives", () => {
  assert.throws(() => encodeFrame(FrameType.Req, 0), ProtocolError);
  assert.throws(() => encodeFrame(FrameType.Req, -1), ProtocolError);
});

test("rejects unknown frame types on encode and decode", () => {
  assert.throws(() => encodeFrame(99 as FrameType, 1), ProtocolError);

  const bogus = new Uint8Array(HEADER_BYTES);
  bogus[0] = 99;
  bogus[4] = 1;
  assert.throws(() => decodeFrame(bogus), ProtocolError);
});

test("rejects a truncated frame", () => {
  assert.throws(() => decodeFrame(new Uint8Array(HEADER_BYTES - 1)), ProtocolError);
});

test("decodes from a view with a non-zero byteOffset", () => {
  // Transports hand over views into a larger receive buffer.
  const encoded = encodeFrame(FrameType.ResBody, 5, new Uint8Array([9, 8, 7]));
  const backing = new Uint8Array(encoded.byteLength + 16);
  backing.set(encoded, 16);

  const frame = decodeFrame(new Uint8Array(backing.buffer, 16, encoded.byteLength));
  assert.equal(frame.requestId, 5);
  assert.deepEqual([...frame.payload], [9, 8, 7]);
});

test("decoded payloads do not alias the receive buffer", () => {
  const encoded = encodeFrame(FrameType.ResBody, 3, new Uint8Array([1, 2, 3]));
  const frame = decodeFrame(encoded);
  encoded.fill(0);
  assert.deepEqual([...frame.payload], [1, 2, 3]);
});

test("zero-copy decoding aliases an owned receive buffer", () => {
  const encoded = encodeFrame(FrameType.ResBody, 3, new Uint8Array([1, 2, 3]));
  const frame = decodeFrameView(encoded);
  encoded[HEADER_BYTES] = 9;
  assert.deepEqual([...frame.payload], [9, 2, 3]);
  assert.equal(frame.payload.buffer, encoded.buffer);
});

test("rejects malformed JSON payloads", () => {
  const frame = decodeFrame(encodeFrame(FrameType.ResHead, 1, new Uint8Array([0x7b, 0x7b])));
  assert.throws(() => decodeJsonPayload(frame), ProtocolError);
});

test("chunks a body into payload-sized pieces", () => {
  const body = new Uint8Array(MAX_PAYLOAD_BYTES * 2 + 17);
  const chunks = [...chunkBody(body)];

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.byteLength, MAX_PAYLOAD_BYTES);
  assert.equal(chunks[1]!.byteLength, MAX_PAYLOAD_BYTES);
  assert.equal(chunks[2]!.byteLength, 17);
  assert.equal(chunks.reduce((n, c) => n + c.byteLength, 0), body.byteLength);
});

test("chunking an empty body yields nothing", () => {
  assert.deepEqual([...chunkBody(new Uint8Array(0))], []);
});

test("chunks reassemble in order", () => {
  const body = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);
  const reassembled = new Uint8Array(body.byteLength);

  let offset = 0;
  for (const chunk of chunkBody(body, 128)) {
    reassembled.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assert.deepEqual([...reassembled], [...body]);
});

test("request ids are monotonic and skip the reserved zero", () => {
  const next = createRequestIdSource();
  assert.equal(next(), 1);
  assert.equal(next(), 2);
  assert.equal(next(), 3);
});
