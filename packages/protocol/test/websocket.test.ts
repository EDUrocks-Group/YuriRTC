import assert from "node:assert/strict";
import test from "node:test";

import {
  FrameType,
  MAX_WS_MESSAGE_BYTES,
  ProtocolError,
  WebSocketDataKind,
  decodeFrame,
  decodeWebSocketClose,
  decodeWebSocketData,
  encodeFrame,
  encodeWebSocketClose,
  encodeWebSocketData,
  isFrameType
} from "../src/index.js";

test("websocket frame types are known", () => {
  assert.equal(isFrameType(FrameType.WsOpen), true);
  assert.equal(isFrameType(FrameType.WsOpened), true);
  assert.equal(isFrameType(FrameType.WsData), true);
  assert.equal(isFrameType(FrameType.WsClose), true);
  assert.equal(isFrameType(15), false);
});

test("a text message survives the round trip as text", () => {
  const body = new TextEncoder().encode("hello wisp");
  const decoded = decodeWebSocketData(encodeWebSocketData(WebSocketDataKind.Text, body));

  assert.equal(decoded.kind, WebSocketDataKind.Text);
  assert.deepEqual([...decoded.data], [...body]);
});

test("a binary message stays binary", () => {
  const body = Uint8Array.from([0, 1, 2, 253, 254, 255]);
  const decoded = decodeWebSocketData(encodeWebSocketData(WebSocketDataKind.Binary, body));

  assert.equal(decoded.kind, WebSocketDataKind.Binary);
  assert.deepEqual([...decoded.data], [...body]);
});

test("an empty message is legal in both kinds", () => {
  for (const kind of [WebSocketDataKind.Text, WebSocketDataKind.Binary]) {
    const decoded = decodeWebSocketData(encodeWebSocketData(kind, new Uint8Array(0)));
    assert.equal(decoded.kind, kind);
    assert.equal(decoded.data.byteLength, 0);
  }
});

test("a message at the ceiling encodes and one past it does not", () => {
  const atLimit = new Uint8Array(MAX_WS_MESSAGE_BYTES);
  assert.equal(encodeWebSocketData(WebSocketDataKind.Binary, atLimit).byteLength, MAX_WS_MESSAGE_BYTES + 1);
  assert.throws(
    () => encodeWebSocketData(WebSocketDataKind.Binary, new Uint8Array(MAX_WS_MESSAGE_BYTES + 1)),
    ProtocolError
  );
});

test("an unknown data kind is rejected rather than guessed", () => {
  assert.throws(() => decodeWebSocketData(Uint8Array.from([7, 1, 2])), ProtocolError);
});

test("an empty data payload is rejected", () => {
  assert.throws(() => decodeWebSocketData(new Uint8Array(0)), ProtocolError);
});

test("a close round trips its code and reason", () => {
  const decoded = decodeWebSocketClose(encodeWebSocketClose(1000, "done"));

  assert.equal(decoded.code, 1000);
  assert.equal(decoded.reason, "done");
});

test("a close with no reason round trips", () => {
  assert.deepEqual(decodeWebSocketClose(encodeWebSocketClose(1001)), { code: 1001, reason: "" });
});

test("the codes an endpoint must synthesise locally never go on the wire", () => {
  for (const code of [1005, 1006]) {
    assert.throws(() => encodeWebSocketClose(code), ProtocolError);
  }
});

test("out-of-range close codes are rejected", () => {
  for (const code of [0, 999, 0x10000]) {
    assert.throws(() => encodeWebSocketClose(code), ProtocolError);
  }
});

test("a close reason longer than the spec allows is rejected", () => {
  assert.throws(() => encodeWebSocketClose(1000, "x".repeat(124)), ProtocolError);
  assert.doesNotThrow(() => encodeWebSocketClose(1000, "x".repeat(123)));
});

test("a truncated close payload is rejected", () => {
  assert.throws(() => decodeWebSocketClose(Uint8Array.from([3])), ProtocolError);
});

test("a websocket message travels inside an ordinary frame", () => {
  const payload = encodeWebSocketData(WebSocketDataKind.Text, new TextEncoder().encode("ping"));
  const frame = decodeFrame(encodeFrame(FrameType.WsData, 7, payload));

  assert.equal(frame.type, FrameType.WsData);
  assert.equal(frame.requestId, 7);
  assert.equal(decodeWebSocketData(frame.payload).kind, WebSocketDataKind.Text);
});
