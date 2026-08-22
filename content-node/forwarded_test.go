package main

// The backend sits behind this node exactly as it sits behind a reverse proxy.
// These pin who is allowed to state a visitor's address to it.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// collectingSender satisfies responseSender without a transport. It optionally
// reports a peer address, standing in for a live PeerSession.
type collectingSender struct {
	address string
	head    ResponseHead
	body    []byte
	ended   bool
}

func (s *collectingSender) SendHead(_ uint32, head ResponseHead) error {
	s.head = head
	return nil
}

func (s *collectingSender) SendBody(_ context.Context, _ uint32, chunk []byte) error {
	s.body = append(s.body, chunk...)
	return nil
}

func (s *collectingSender) SendEnd(_ uint32) error {
	s.ended = true
	return nil
}

// addressedSender additionally reports a peer address; a bare collectingSender
// deliberately does not, covering the no-address path.
type addressedSender struct{ collectingSender }

func (s *addressedSender) PeerAddress() string { return s.address }

func proxyForwardedHeaders(t *testing.T, out responseSender, requestHeaders HeaderPairs) http.Header {
	t.Helper()
	var seen http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		seen = request.Header.Clone()
		response.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()

	handler := NewHandler(t.TempDir(), backend.URL)
	head := RequestHead{
		Version:        protocolVersion,
		Method:         http.MethodGet,
		URL:            "/apiv2/ai",
		Headers:        requestHeaders,
		Priority:       0,
		InitialCredits: 8,
	}
	if err := handler.Serve(context.Background(), out, 11, head, nil); err != nil {
		t.Fatalf("serve proxied request: %v", err)
	}
	if seen == nil {
		t.Fatal("the backend never received the proxied request")
	}
	return seen
}

// Without this the backend attributes every transported request to the node's
// own loopback address, so one shared rate-limit bucket covers every visitor.
func TestProxyStatesTheVisitorAddress(t *testing.T) {
	sender := &addressedSender{}
	sender.address = "203.0.113.42"
	seen := proxyForwardedHeaders(t, sender, HeaderPairs{{"accept", "text/event-stream"}})

	if got := seen.Get("X-Forwarded-For"); got != "203.0.113.42" {
		t.Fatalf("X-Forwarded-For = %q, want the peer's ICE address", got)
	}
	if got := seen.Get("X-Real-IP"); got != "203.0.113.42" {
		t.Fatalf("X-Real-IP = %q, want the peer's ICE address", got)
	}
	if got := seen.Get("X-Forwarded-Proto"); got != "https" {
		t.Fatalf("X-Forwarded-Proto = %q, want https", got)
	}
	if got := seen.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("ordinary headers must still reach the backend, got %q", got)
	}
}

// A peer that could state its own address would choose a different one per
// request and evade every per-visitor limit the backend applies.
func TestProxyRefusesPeerSuppliedForwardingHeaders(t *testing.T) {
	sender := &addressedSender{}
	sender.address = "203.0.113.42"
	seen := proxyForwardedHeaders(t, sender, HeaderPairs{
		{"x-forwarded-for", "10.0.0.1"},
		// Header.Add canonicalises names, so a case variant would land under the
		// same key as the value this node sets.
		{"X-Forwarded-For", "10.0.0.2"},
		{"X-FORWARDED-FOR", "10.0.0.3"},
		{"x-real-ip", "10.0.0.4"},
		{"forwarded", "for=10.0.0.5"},
		{"x-client-ip", "10.0.0.6"},
		{"cf-connecting-ip", "10.0.0.7"},
		{"true-client-ip", "10.0.0.8"},
		{"x-forwarded-proto", "http"},
		{"x-forwarded-host", "evil.example"},
	})

	if got := seen.Values("X-Forwarded-For"); len(got) != 1 || got[0] != "203.0.113.42" {
		t.Fatalf("X-Forwarded-For = %v, want only the peer's real address", got)
	}
	if got := seen.Values("X-Real-IP"); len(got) != 1 || got[0] != "203.0.113.42" {
		t.Fatalf("X-Real-IP = %v, want only the peer's real address", got)
	}
	if got := seen.Get("X-Forwarded-Proto"); got != "https" {
		t.Fatalf("X-Forwarded-Proto = %q, want the node's own value", got)
	}
	for _, name := range []string{"Forwarded", "X-Client-Ip", "Cf-Connecting-Ip", "True-Client-Ip", "X-Forwarded-Host"} {
		if got := seen.Values(name); len(got) != 0 {
			t.Fatalf("%s reached the backend as %v; only this node may state it", name, got)
		}
	}
}

// A sender with no address (tests, or a peer whose pair is not yet nominated)
// must not invent one: a bogus value is worse than the loopback default.
func TestProxyOmitsAnUnknownVisitorAddress(t *testing.T) {
	seen := proxyForwardedHeaders(t, &collectingSender{}, HeaderPairs{{"x-forwarded-for", "10.0.0.1"}})
	if got := seen.Values("X-Forwarded-For"); len(got) != 0 {
		t.Fatalf("X-Forwarded-For = %v, want none when the address is unknown", got)
	}
}

func TestPeerAddressIgnoresEmptyUpdates(t *testing.T) {
	session := NewPeerSession(nil, nil)
	if got := session.PeerAddress(); got != "" {
		t.Fatalf("a fresh session reported %q", got)
	}
	session.SetPeerAddress("198.51.100.7")
	session.SetPeerAddress("")
	if got := session.PeerAddress(); got != "198.51.100.7" {
		t.Fatalf("PeerAddress() = %q, want the last known address", got)
	}
}
