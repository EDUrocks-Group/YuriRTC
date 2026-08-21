package main

// Mirrors packages/protocol/test/websocket.test.ts. That package is the
// normative definition of the wire format; these assert this side agrees.

import (
	"strings"
	"testing"
)

func TestWebSocketDataRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		name string
		kind WebSocketDataKind
		body []byte
	}{
		{"text", WebSocketText, []byte("hello wisp")},
		{"binary", WebSocketBinary, []byte{0, 1, 2, 253, 254, 255}},
		{"empty text", WebSocketText, []byte{}},
		{"empty binary", WebSocketBinary, []byte{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := encodeWebSocketData(tc.kind, tc.body)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			kind, data, err := decodeWebSocketData(payload)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if kind != tc.kind {
				t.Fatalf("kind = %d, want %d", kind, tc.kind)
			}
			if string(data) != string(tc.body) {
				t.Fatalf("data = %q, want %q", data, tc.body)
			}
		})
	}
}

func TestWebSocketDataRejectsOversizeMessage(t *testing.T) {
	if _, err := encodeWebSocketData(WebSocketBinary, make([]byte, maxWebSocketMessageBytes)); err != nil {
		t.Fatalf("a message at the ceiling must encode: %v", err)
	}
	if _, err := encodeWebSocketData(WebSocketBinary, make([]byte, maxWebSocketMessageBytes+1)); err == nil {
		t.Fatal("a message past the ceiling must not encode")
	}
}

func TestWebSocketDataRejectsUnknownKind(t *testing.T) {
	if _, _, err := decodeWebSocketData([]byte{7, 1, 2}); err == nil {
		t.Fatal("an unknown kind must be rejected rather than guessed")
	}
	if _, _, err := decodeWebSocketData(nil); err == nil {
		t.Fatal("an empty payload must be rejected")
	}
}

func TestWebSocketCloseRoundTrip(t *testing.T) {
	payload, err := encodeWebSocketClose(1000, "done")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	code, reason, err := decodeWebSocketClose(payload)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if code != 1000 || reason != "done" {
		t.Fatalf("got %d %q, want 1000 \"done\"", code, reason)
	}
}

func TestWebSocketCloseRejectsLocallySynthesisedCodes(t *testing.T) {
	// 1005 and 1006 mean "no close frame was seen"; sending either would be a
	// lie about what happened.
	for _, code := range []int{1005, 1006, 0, 999, 0x10000} {
		if _, err := encodeWebSocketClose(code, ""); err == nil {
			t.Fatalf("close code %d must be rejected", code)
		}
	}
}

func TestWebSocketCloseRejectsOversizeReason(t *testing.T) {
	if _, err := encodeWebSocketClose(1000, strings.Repeat("x", 124)); err == nil {
		t.Fatal("a reason past 123 bytes must be rejected")
	}
	if _, err := encodeWebSocketClose(1000, strings.Repeat("x", 123)); err != nil {
		t.Fatalf("a reason at 123 bytes must encode: %v", err)
	}
}

func TestWebSocketCloseRejectsTruncatedPayload(t *testing.T) {
	if _, _, err := decodeWebSocketClose([]byte{3}); err == nil {
		t.Fatal("a truncated close payload must be rejected")
	}
}

func TestSanitizeCloseCode(t *testing.T) {
	for _, code := range []int{1005, 1006, 0, 999, 0x10000} {
		if got := sanitizeCloseCode(code); got != wsCloseGoingAway {
			t.Fatalf("sanitizeCloseCode(%d) = %d, want %d", code, got, wsCloseGoingAway)
		}
	}
	if got := sanitizeCloseCode(1000); got != 1000 {
		t.Fatalf("a legal code must survive, got %d", got)
	}
}

// The node must not become a general-purpose dialler for whatever the page asks.
func TestWebSocketTargetRefusesAnythingButTheConfiguredUpstream(t *testing.T) {
	handler := &Handler{WebSocketURL: "ws://127.0.0.1:1802"}

	for _, tc := range []struct {
		name string
		url  string
	}{
		{"absolute url", "https://evil.example/socket"},
		{"scheme-relative url", "//evil.example/socket"},
		{"outside the api namespace", "/socket"},
		{"static path", "/index.html"},
		{"api lookalike prefix", "/apiv2evil/socket"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := handler.webSocketTarget(tc.url); err == nil {
				t.Fatalf("%s must be refused", tc.url)
			}
		})
	}
}

func TestWebSocketTargetAcceptsTheApiNamespace(t *testing.T) {
	handler := &Handler{WebSocketURL: "ws://127.0.0.1:1802"}

	target, err := handler.webSocketTarget("/apiv2/wonderlands/?t=1")
	if err != nil {
		t.Fatalf("an api path must be accepted: %v", err)
	}
	if target != "ws://127.0.0.1:1802/apiv2/wonderlands/?t=1" {
		t.Fatalf("target = %q", target)
	}
}

func TestWebSocketDisabledByDefault(t *testing.T) {
	handler := &Handler{}
	if _, err := handler.webSocketTarget("/apiv2/wonderlands/"); err == nil {
		t.Fatal("a node with no configured upstream must not open sockets")
	}
}

func TestWebSocketOpenFromFrameBoundsItsInput(t *testing.T) {
	if _, err := webSocketOpenFromFrame(make([]byte, maxWebSocketOpenBytes+1)); err == nil {
		t.Fatal("an oversize open payload must be rejected")
	}
	if _, err := webSocketOpenFromFrame([]byte("not json")); err == nil {
		t.Fatal("a malformed open payload must be rejected")
	}
	if _, err := webSocketOpenFromFrame([]byte(`{"protocols":["a\r\nb"]}`)); err == nil {
		t.Fatal("a subprotocol carrying header separators must be rejected")
	}
	if _, err := webSocketOpenFromFrame([]byte(`{"version":3,"url":"/apiv2/x","protocols":[],"initialCredits":16}`)); err != nil {
		t.Fatalf("a well-formed open must parse: %v", err)
	}
}

// The frame types must decode, not merely have payload codecs. knownType is a
// range, so a new type that is not inside it is dropped before dispatch ever
// sees it -- which looks exactly like the node ignoring the peer.
func TestWebSocketFrameTypesDecode(t *testing.T) {
	for _, frameType := range []FrameType{FrameWsOpen, FrameWsOpened, FrameWsData, FrameWsClose} {
		if !knownType(frameType) {
			t.Fatalf("frame type %d must be known to the decoder", frameType)
		}
		encoded, err := EncodeFrame(frameType, 1, []byte{0})
		if err != nil {
			t.Fatalf("EncodeFrame(%d): %v", frameType, err)
		}
		frame, err := decodeFrameView(encoded)
		if err != nil {
			t.Fatalf("decodeFrameView(%d): %v", frameType, err)
		}
		if frame.Type != frameType {
			t.Fatalf("round trip gave type %d, want %d", frame.Type, frameType)
		}
	}
	if knownType(FrameWsClose + 1) {
		t.Fatal("the range must not admit types the protocol has not defined")
	}
}
