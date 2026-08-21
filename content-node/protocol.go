package main

// YuriRTC v3 wire protocol. Must stay byte-compatible with
// packages/protocol — that package is the normative definition and its tests
// are the contract this mirrors.
//
// Every frame is [u8 type][u32be requestId][payload].

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

type FrameType uint8

const (
	FrameReq     FrameType = 1
	FrameReqBody FrameType = 2
	FrameReqEnd  FrameType = 3
	FrameResHead FrameType = 4
	FrameResBody FrameType = 5
	FrameResEnd  FrameType = 6
	FrameResErr  FrameType = 7
	FrameCancel  FrameType = 8
	// FrameCredit grants permission for response body frames. Its payload is a
	// u32 big-endian count and the browser replenishes the window as it consumes
	// response data.
	FrameCredit FrameType = 9
	// FrameReqCredit grants the browser permission to send request-body frames.
	// It is server -> browser only, uses a positive u32 big-endian count, and is
	// valid only server -> browser.
	FrameReqCredit FrameType = 10

	// WebSocket streams. A socket occupies a requestId like any other exchange,
	// but its frames flow both ways for as long as it is open rather than
	// turning around once. Flow control reuses FrameCredit and FrameReqCredit
	// unchanged; for a socket both simply keep replenishing.
	FrameWsOpen   FrameType = 11
	FrameWsOpened FrameType = 12
	FrameWsData   FrameType = 13
	FrameWsClose  FrameType = 14
)

// WebSocketDataKind records whether a relayed message was text or binary, so
// the far side hands the page a string rather than guessing from bytes.
type WebSocketDataKind uint8

const (
	WebSocketText   WebSocketDataKind = 0
	WebSocketBinary WebSocketDataKind = 1
)

const (
	wsCloseNormal      = 1000
	wsCloseGoingAway   = 1001
	wsCloseCarrierLost = 4001

	maxWebSocketMessageBytes = maxPayloadBytes - 1
	maxWebSocketCloseReason  = 123
)

type WebSocketOpen struct {
	Version        int      `json:"version"`
	URL            string   `json:"url"`
	Protocols      []string `json:"protocols"`
	InitialCredits int      `json:"initialCredits"`
}

type WebSocketOpened struct {
	Protocol string `json:"protocol"`
}

// encodeWebSocketData lays out [u8 kind][payload].
func encodeWebSocketData(kind WebSocketDataKind, data []byte) ([]byte, error) {
	if len(data) > maxWebSocketMessageBytes {
		return nil, fmt.Errorf("websocket message of %d exceeds %d", len(data), maxWebSocketMessageBytes)
	}
	payload := make([]byte, 1+len(data))
	payload[0] = byte(kind)
	copy(payload[1:], data)
	return payload, nil
}

func decodeWebSocketData(payload []byte) (WebSocketDataKind, []byte, error) {
	if len(payload) < 1 {
		return 0, nil, errors.New("websocket data payload is empty")
	}
	kind := WebSocketDataKind(payload[0])
	if kind != WebSocketText && kind != WebSocketBinary {
		return 0, nil, fmt.Errorf("unknown websocket data kind %d", payload[0])
	}
	return kind, payload[1:], nil
}

// encodeWebSocketClose lays out [u16be code][utf8 reason]. 1005 and 1006 are
// reserved for an endpoint to synthesise locally when it never saw a close
// frame, so putting either on the wire would misreport what happened.
func encodeWebSocketClose(code int, reason string) ([]byte, error) {
	if code < 1000 || code > 0xffff || code == 1005 || code == 1006 {
		return nil, fmt.Errorf("invalid websocket close code %d", code)
	}
	if len(reason) > maxWebSocketCloseReason {
		return nil, fmt.Errorf("websocket close reason exceeds %d bytes", maxWebSocketCloseReason)
	}
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload, uint16(code))
	copy(payload[2:], reason)
	return payload, nil
}

func decodeWebSocketClose(payload []byte) (int, string, error) {
	if len(payload) < 2 {
		return 0, "", fmt.Errorf("websocket close payload must be at least 2 bytes, got %d", len(payload))
	}
	return int(binary.BigEndian.Uint16(payload[:2])), string(payload[2:]), nil
}

const (
	protocolVersion = 3
	headerBytes     = 5
	// SCTP delivery gets unreliable above roughly 256KB, so frames stay well
	// under it. Chrome 146 and Pion negotiate 256KiB; 128KiB halves framing,
	// callback, and transfer overhead while retaining a 2x safety margin.
	maxFrameBytes   = 128 * 1024
	maxPayloadBytes = maxFrameBytes - headerBytes

	minRequestID uint32 = 1
)

var errShortFrame = errors.New("frame shorter than header")

// HeaderPairs travel as pairs rather than a map because duplicates are
// significant — notably Set-Cookie, which the service worker consumes to
// maintain the service-worker cookie jar.
type HeaderPairs [][2]string

type RequestHead struct {
	Version        int         `json:"version"`
	Method         string      `json:"method"`
	URL            string      `json:"url"`
	Headers        HeaderPairs `json:"headers"`
	HasBody        bool        `json:"hasBody"`
	Priority       uint8       `json:"priority"`
	InitialCredits uint32      `json:"initialCredits"`
}

type ResponseHead struct {
	Status     int         `json:"status"`
	StatusText string      `json:"statusText"`
	Headers    HeaderPairs `json:"headers"`
}

type ProtocolErrorPayload struct {
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
}

type Frame struct {
	Type      FrameType
	RequestID uint32
	Payload   []byte
}

// knownType bounds the wire's frame types. It is a range rather than a set
// because the types are contiguous by construction; anything added to
// packages/protocol has to move the upper bound with it, or the node drops the
// new frames as undecodable and the peer waits forever for an answer.
func knownType(t FrameType) bool {
	return t >= FrameReq && t <= FrameWsClose
}

func decodeCreditPayload(payload []byte) (uint32, bool) {
	if len(payload) != 4 {
		return 0, false
	}
	count := binary.BigEndian.Uint32(payload)
	return count, count != 0
}

func encodeCreditFrame(t FrameType, requestID, count uint32) ([]byte, error) {
	if t != FrameCredit && t != FrameReqCredit {
		return nil, fmt.Errorf("frame type %d is not a credit frame", t)
	}
	if count == 0 {
		return nil, errors.New("credit count must be positive")
	}
	payload := make([]byte, 4)
	binary.BigEndian.PutUint32(payload, count)
	return EncodeFrame(t, requestID, payload)
}

func EncodeFrame(t FrameType, requestID uint32, payload []byte) ([]byte, error) {
	if err := validateFrame(t, requestID, payload); err != nil {
		return nil, err
	}
	out := make([]byte, headerBytes+len(payload))
	return encodeFrameInto(out, t, requestID, payload)
}

// encodeFrameInto is the allocation-free variant used by the streaming hot
// path. The caller owns out and may reuse it after the synchronous Send call
// returns (Pion copies data into SCTP's retransmission queue before returning).
func encodeFrameInto(out []byte, t FrameType, requestID uint32, payload []byte) ([]byte, error) {
	if err := validateFrame(t, requestID, payload); err != nil {
		return nil, err
	}
	frameSize := headerBytes + len(payload)
	if cap(out) < frameSize {
		return nil, fmt.Errorf("frame buffer capacity %d is below required %d", cap(out), frameSize)
	}
	out = out[:frameSize]
	out[0] = byte(t)
	binary.BigEndian.PutUint32(out[1:5], requestID)
	copy(out[headerBytes:], payload)
	return out, nil
}

func validateFrame(t FrameType, requestID uint32, payload []byte) error {
	if !knownType(t) {
		return fmt.Errorf("unknown frame type %d", t)
	}
	if requestID < minRequestID {
		return fmt.Errorf("invalid requestId %d", requestID)
	}
	if len(payload) > maxPayloadBytes {
		return fmt.Errorf("payload of %d exceeds %d; chunk before encoding", len(payload), maxPayloadBytes)
	}
	return nil
}

func EncodeJSONFrame(t FrameType, requestID uint32, value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return EncodeFrame(t, requestID, payload)
}

func DecodeFrame(data []byte) (Frame, error) {
	frame, err := decodeFrameView(data)
	if err != nil {
		return Frame{}, err
	}
	// Generic callers may recycle or mutate their receive buffer after this
	// function returns, so retain DecodeFrame's owning-copy contract.
	frame.Payload = append([]byte(nil), frame.Payload...)
	return frame, nil
}

// decodeFrameView avoids a second full-frame copy when the caller already owns
// data for the lifetime of the returned payload. Pion hands OnMessage an owned
// byte slice, so queued upload chunks can safely retain this view.
func decodeFrameView(data []byte) (Frame, error) {
	// Pion's receive limit is a transport-level pressure guard, not the wire
	// protocol validator. Enforce the application cap here as well so a peer
	// cannot make an oversized SCTP message survive into request processing.
	if len(data) > maxFrameBytes {
		return Frame{}, fmt.Errorf("frame of %d exceeds maximum %d", len(data), maxFrameBytes)
	}
	if len(data) < headerBytes {
		return Frame{}, errShortFrame
	}
	t := FrameType(data[0])
	if !knownType(t) {
		return Frame{}, fmt.Errorf("unknown frame type %d", t)
	}
	requestID := binary.BigEndian.Uint32(data[1:5])
	if requestID < minRequestID {
		return Frame{}, fmt.Errorf("invalid requestId %d", requestID)
	}
	return Frame{Type: t, RequestID: requestID, Payload: data[headerBytes:]}, nil
}

func headerValue(h HeaderPairs, name string) string {
	for _, pair := range h {
		if equalFold(pair[0], name) {
			return pair[1]
		}
	}
	return ""
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
