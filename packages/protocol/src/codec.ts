import {
  Frame,
  FrameType,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_WS_MESSAGE_BYTES,
  ProtocolError,
  WebSocketDataKind,
  isFrameType,
  isValidRequestId
} from "./frames.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const EMPTY = new Uint8Array(0);

export function encodeFrame(
  type: FrameType,
  requestId: number,
  payload: Uint8Array = EMPTY
): Uint8Array {
  validateFrameHeader(type, requestId);
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new ProtocolError(
      `payload of ${payload.byteLength} exceeds ${MAX_PAYLOAD_BYTES}; chunk before encoding`
    );
  }

  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, requestId, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

/**
 * Encodes one frame directly from several payload views.
 *
 * Request streams commonly yield many small chunks. Coalescing them into one
 * wire frame with this helper avoids first copying them into a temporary
 * 128 KiB payload and then copying that payload again to prepend the header.
 */
export function encodeFrameChunks(
  type: FrameType,
  requestId: number,
  chunks: Iterable<Uint8Array>
): Uint8Array {
  validateFrameHeader(type, requestId);
  const parts: Uint8Array[] = [];
  let payloadBytes = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) {
      throw new ProtocolError("frame payload chunk must be a Uint8Array");
    }
    if (chunk.byteLength > MAX_PAYLOAD_BYTES - payloadBytes) {
      throw new ProtocolError(
        `payload exceeds ${MAX_PAYLOAD_BYTES}; chunk before encoding`
      );
    }
    if (chunk.byteLength === 0) continue;
    parts.push(chunk);
    payloadBytes += chunk.byteLength;
  }

  const frame = new Uint8Array(HEADER_BYTES + payloadBytes);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, requestId, false);
  let offset = HEADER_BYTES;
  for (const part of parts) {
    frame.set(part, offset);
    offset += part.byteLength;
  }
  return frame;
}

function validateFrameHeader(type: FrameType, requestId: number): void {
  if (!isFrameType(type)) throw new ProtocolError(`unknown frame type ${type}`);
  if (!isValidRequestId(requestId)) throw new ProtocolError(`invalid requestId ${requestId}`);
}

export function decodeFrame(data: ArrayBuffer | ArrayBufferView): Frame {
  const frame = decodeFrameView(data);

  // The safe general-purpose decoder owns its payload. Callers which own the
  // receive buffer and can transfer it onward should use decodeFrameView().
  return { ...frame, payload: frame.payload.slice() };
}

/**
 * Decodes without copying the payload.
 *
 * The returned view aliases `data`; it is specifically for hot paths such as
 * RTCDataChannel -> MessagePort where the original ArrayBuffer is immediately
 * transferred to the next owner. This removes one 128 KiB allocation and copy
 * per downloaded frame.
 */
export function decodeFrameView(data: ArrayBuffer | ArrayBufferView): Frame {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      `frame of ${bytes.byteLength} bytes exceeds ${MAX_FRAME_BYTES}`
    );
  }
  if (bytes.byteLength < HEADER_BYTES) {
    throw new ProtocolError(`frame of ${bytes.byteLength} bytes is shorter than the header`);
  }

  const type = bytes[0]!;
  if (!isFrameType(type)) throw new ProtocolError(`unknown frame type ${type}`);

  const requestId = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(1, false);
  if (!isValidRequestId(requestId)) throw new ProtocolError(`invalid requestId ${requestId}`);

  return { type, requestId, payload: bytes.subarray(HEADER_BYTES) };
}

/** Encodes a v3 Credit/ReqCredit payload: a positive u32 frame count. */
export function encodeCreditPayload(amount: number): Uint8Array {
  if (!Number.isInteger(amount) || amount < 1 || amount > 0xffffffff) {
    throw new ProtocolError(`invalid response credit ${amount}`);
  }
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, amount, false);
  return payload;
}

/** Decodes a v3 Credit/ReqCredit payload and rejects zero or malformed counts. */
export function decodeCreditPayload(payload: Uint8Array): number {
  if (payload.byteLength !== 4) {
    throw new ProtocolError(`credit payload must be 4 bytes, got ${payload.byteLength}`);
  }
  const amount = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
  if (amount === 0) throw new ProtocolError("response credit must be positive");
  return amount;
}

/**
 * Encodes one websocket message as `[u8 kind][payload]`.
 *
 * The kind byte is what keeps a text message text. The carrier moves bytes,
 * and a peer that received only bytes would have to guess whether to hand the
 * page a string or a Blob -- so the sender records what it had.
 */
export function encodeWebSocketData(kind: WebSocketDataKind, data: Uint8Array): Uint8Array {
  if (data.byteLength > MAX_WS_MESSAGE_BYTES) {
    throw new ProtocolError(
      `websocket message of ${data.byteLength} exceeds ${MAX_WS_MESSAGE_BYTES}`
    );
  }
  const payload = new Uint8Array(1 + data.byteLength);
  payload[0] = kind;
  payload.set(data, 1);
  return payload;
}

export function decodeWebSocketData(payload: Uint8Array): { kind: WebSocketDataKind; data: Uint8Array } {
  if (payload.byteLength < 1) {
    throw new ProtocolError("websocket data payload is empty");
  }
  const kind = payload[0];
  if (kind !== WebSocketDataKind.Text && kind !== WebSocketDataKind.Binary) {
    throw new ProtocolError(`unknown websocket data kind ${kind}`);
  }
  return { kind, data: payload.subarray(1) };
}

/**
 * Encodes a close as `[u16be code][utf8 reason]`.
 *
 * Codes below 1000 do not exist, and 1005/1006 are the two the spec reserves
 * for an endpoint to synthesise locally when it never saw a close frame --
 * putting either on the wire would be a lie about what happened.
 */
export function encodeWebSocketClose(code: number, reason = ""): Uint8Array {
  if (!Number.isInteger(code) || code < 1000 || code > 0xffff || code === 1005 || code === 1006) {
    throw new ProtocolError(`invalid websocket close code ${code}`);
  }
  const reasonBytes = encoder.encode(reason);
  // The websocket spec caps a close reason at 123 bytes, and a peer that
  // receives a longer one is required to fail the connection.
  if (reasonBytes.byteLength > 123) {
    throw new ProtocolError(`websocket close reason exceeds 123 bytes`);
  }
  const payload = new Uint8Array(2 + reasonBytes.byteLength);
  new DataView(payload.buffer).setUint16(0, code, false);
  payload.set(reasonBytes, 2);
  return payload;
}

export function decodeWebSocketClose(payload: Uint8Array): { code: number; reason: string } {
  if (payload.byteLength < 2) {
    throw new ProtocolError(`websocket close payload must be at least 2 bytes, got ${payload.byteLength}`);
  }
  const code = new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0, false);
  let reason: string;
  try {
    reason = decoder.decode(payload.subarray(2));
  } catch {
    throw new ProtocolError("websocket close reason is not valid UTF-8");
  }
  return { code, reason };
}

export function encodeJsonFrame(type: FrameType, requestId: number, value: unknown): Uint8Array {
  return encodeFrame(type, requestId, encoder.encode(JSON.stringify(value)));
}

export function decodeJsonPayload<T>(frame: Frame): T {
  let text: string;
  try {
    text = decoder.decode(frame.payload);
  } catch {
    throw new ProtocolError(`frame ${FrameType[frame.type]} payload is not valid UTF-8`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProtocolError(`frame ${FrameType[frame.type]} payload is not valid JSON`);
  }
}

/**
 * Splits a body into payload-sized pieces. Yields nothing for an empty body,
 * so callers should emit their terminating frame unconditionally.
 */
export function* chunkBody(
  body: Uint8Array,
  max: number = MAX_PAYLOAD_BYTES
): Generator<Uint8Array> {
  if (max < 1) throw new ProtocolError(`chunk size ${max} must be positive`);
  for (let offset = 0; offset < body.byteLength; offset += max) {
    yield body.subarray(offset, Math.min(offset + max, body.byteLength));
  }
}

/** Monotonic request ids, wrapping past the u32 ceiling and skipping the reserved 0. */
export function createRequestIdSource(): () => number {
  let next = 1;
  return () => {
    const id = next;
    next = next === 0xffffffff ? 1 : next + 1;
    return id;
  };
}
