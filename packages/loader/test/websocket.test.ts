import assert from "node:assert/strict";
import test from "node:test";

import {
  WebSocketDataKind,
  decodeWebSocketClose,
  decodeWebSocketData
} from "@yurirtc/protocol";

import {
  CarriedWebSocket,
  SOCKET_CLOSED,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  type SocketCarrier
} from "../src/websocket.js";

function harness() {
  const sent: Uint8Array[] = [];
  const closes: Uint8Array[] = [];
  const released: number[] = [];
  const carrier: SocketCarrier = {
    sendData: (_id, payload) => void sent.push(payload),
    sendClose: (_id, payload) => void closes.push(payload),
    release: id => void released.push(id)
  };
  return { socket: new CarriedWebSocket("/apiv2/wonderlands/", 1, carrier), sent, closes, released };
}

test("a socket starts connecting and opens only when the node says so", () => {
  const { socket } = harness();
  assert.equal(socket.readyState, SOCKET_CONNECTING);

  let opened = 0;
  socket.onopen = () => void opened++;
  socket.acceptOpen("wisp-v2");

  assert.equal(socket.readyState, SOCKET_OPEN);
  assert.equal(socket.protocol, "wisp-v2");
  assert.equal(opened, 1);
});

test("sending before open throws the way the platform does", () => {
  const { socket } = harness();
  assert.throws(() => socket.send("too early"), { name: "InvalidStateError" });
});

test("a string is sent as text and bytes as binary", () => {
  const { socket, sent } = harness();
  socket.acceptOpen("");

  socket.send("hello");
  socket.send(Uint8Array.from([1, 2, 3]));

  assert.equal(sent.length, 2);
  assert.equal(decodeWebSocketData(sent[0]!).kind, WebSocketDataKind.Text);
  assert.equal(new TextDecoder().decode(decodeWebSocketData(sent[0]!).data), "hello");
  assert.equal(decodeWebSocketData(sent[1]!).kind, WebSocketDataKind.Binary);
});

test("a typed-array view sends only its own window of the buffer", () => {
  const { socket, sent } = harness();
  socket.acceptOpen("");

  const backing = Uint8Array.from([9, 9, 1, 2, 9]);
  socket.send(backing.subarray(2, 4));

  assert.deepEqual([...decodeWebSocketData(sent[0]!).data], [1, 2]);
});

test("an incoming text message arrives as a string", () => {
  const { socket } = harness();
  socket.acceptOpen("");

  const seen: unknown[] = [];
  socket.onmessage = event => void seen.push(event.data);
  socket.acceptMessage(WebSocketDataKind.Text, new TextEncoder().encode("pong"));

  assert.deepEqual(seen, ["pong"]);
});

test("binary arrives as an ArrayBuffer once binaryType asks for it", () => {
  const { socket } = harness();
  socket.binaryType = "arraybuffer";
  socket.acceptOpen("");

  const seen: unknown[] = [];
  socket.onmessage = event => void seen.push(event.data);
  socket.acceptMessage(WebSocketDataKind.Binary, Uint8Array.from([7, 8]));

  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(seen[0] as ArrayBuffer)], [7, 8]);
});

test("a delivered message keeps its own copy of the carrier's buffer", () => {
  const { socket } = harness();
  socket.binaryType = "arraybuffer";
  socket.acceptOpen("");

  const frame = Uint8Array.from([1, 2, 3, 4]);
  let received: ArrayBuffer | null = null;
  socket.onmessage = event => void (received = event.data as ArrayBuffer);
  socket.acceptMessage(WebSocketDataKind.Binary, frame.subarray(0, 2));

  // The carrier reuses its frame buffer; a client that kept a view would see
  // its message change underneath it.
  frame.fill(0);
  assert.deepEqual([...new Uint8Array(received!)], [1, 2]);
});

test("close sends a close frame and settles when the node answers", () => {
  const { socket, closes, released } = harness();
  socket.acceptOpen("");

  const seen: CloseEvent[] = [];
  socket.onclose = event => void seen.push(event);
  socket.close(1000, "done");

  assert.equal(closes.length, 1);
  assert.deepEqual(decodeWebSocketClose(closes[0]!), { code: 1000, reason: "done" });

  socket.acceptClose(1000, "done");
  assert.equal(socket.readyState, SOCKET_CLOSED);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.code, 1000);
  assert.equal(seen[0]!.wasClean, true);
  assert.deepEqual(released, [1]);
});

test("a socket that never opened reports an error before its close", () => {
  const { socket } = harness();
  const order: string[] = [];
  socket.onerror = () => void order.push("error");
  socket.onclose = () => void order.push("close");

  socket.acceptClose(1006, "", false);

  assert.deepEqual(order, ["error", "close"]);
  assert.equal(socket.readyState, SOCKET_CLOSED);
});

test("closing twice notifies once", () => {
  const { socket } = harness();
  socket.acceptOpen("");
  let closed = 0;
  socket.onclose = () => void closed++;

  socket.acceptClose(1000, "");
  socket.acceptClose(1000, "");

  assert.equal(closed, 1);
});

test("messages after close are dropped", () => {
  const { socket } = harness();
  socket.acceptOpen("");
  socket.acceptClose(1000, "");

  let delivered = 0;
  socket.onmessage = () => void delivered++;
  socket.acceptMessage(WebSocketDataKind.Text, new TextEncoder().encode("late"));

  assert.equal(delivered, 0);
});

test("a throwing handler does not stop addEventListener listeners", () => {
  const { socket } = harness();
  socket.acceptOpen("");

  let listenerRan = false;
  socket.onmessage = () => {
    throw new Error("handler blew up");
  };
  socket.addEventListener("message", () => void (listenerRan = true));
  socket.acceptMessage(WebSocketDataKind.Text, new TextEncoder().encode("x"));

  assert.equal(listenerRan, true);
});

test("a carrier that cannot send fails the socket rather than hanging in CLOSING", () => {
  const socket = new CarriedWebSocket("/apiv2/wonderlands/", 2, {
    sendData: () => {
      throw new Error("channel gone");
    },
    sendClose: () => {
      throw new Error("channel gone");
    },
    release: () => undefined
  });
  socket.acceptOpen("");

  socket.close();
  assert.equal(socket.readyState, SOCKET_CLOSED);
});
