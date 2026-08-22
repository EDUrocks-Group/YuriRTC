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

// The visitor's address travels in a header of this node's own. A backend may
// read the absence of the standard forwarding headers as proof that a request
// came from this node rather than through its public edge -- this deployment
// does exactly that to issue the carrier's websocket ticket -- so stating those
// would silently break it.
func TestProxyStatesTheVisitorAddress(t *testing.T) {
	sender := &addressedSender{}
	sender.address = "203.0.113.42"
	seen := proxyForwardedHeaders(t, sender, HeaderPairs{{"accept", "text/event-stream"}})

	if got := seen.Get(peerAddressHeader); got != "203.0.113.42" {
		t.Fatalf("%s = %q, want the peer's ICE address", peerAddressHeader, got)
	}
	for _, name := range []string{"X-Forwarded-For", "X-Real-IP"} {
		if got := seen.Values(name); len(got) != 0 {
			t.Fatalf("%s = %v; a backend may read its absence as proof of this node", name, got)
		}
	}
	if got := seen.Get("X-Forwarded-Proto"); got != "https" {
		t.Fatalf("X-Forwarded-Proto = %q, want https", got)
	}
	if got := seen.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("ordinary headers must still reach the backend, got %q", got)
	}
}

// A peer that could state its own address would choose a different one per
// request and evade every per-visitor limit the backend applies. It would also
// be able to impersonate the public edge to a backend that tells the two apart
// by these headers.
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
		{"fastly-client-ip", "10.0.0.9"},
		{"x-azure-clientip", "10.0.0.10"},
		{"cloudfront-viewer-address", "10.0.0.11:443"},
		{"x-forwarded-proto", "http"},
		{"x-forwarded-host", "evil.example"},
		// The node's own header is no more trustworthy from a peer than the
		// standard ones: a peer that could set it would choose its own identity.
		{"x-yurirtc-peer", "10.0.0.12"},
	})

	if got := seen.Values(peerAddressHeader); len(got) != 1 || got[0] != "203.0.113.42" {
		t.Fatalf("%s = %v, want only the peer's real address", peerAddressHeader, got)
	}

	if got := seen.Get("X-Forwarded-Proto"); got != "https" {
		t.Fatalf("X-Forwarded-Proto = %q, want the node's own value", got)
	}
	for _, name := range []string{
		"X-Forwarded-For", "X-Real-Ip", "Forwarded", "X-Client-Ip",
		"Cf-Connecting-Ip", "True-Client-Ip", "Fastly-Client-Ip",
		"X-Azure-Clientip", "Cloudfront-Viewer-Address", "X-Forwarded-Host",
	} {
		if got := seen.Values(name); len(got) != 0 {
			t.Fatalf("%s reached the backend as %v; only this node may state it", name, got)
		}
	}
}

// A sender with no address (a peer whose pair is not yet nominated) must not
// invent one: a bogus address is worse than none, because a backend would
// attribute a real visitor's traffic to it.
func TestProxyStatesNothingWithoutAPeerAddress(t *testing.T) {
	seen := proxyForwardedHeaders(t, &collectingSender{}, HeaderPairs{
		{"x-forwarded-for", "10.0.0.1"},
		{"x-yurirtc-peer", "10.0.0.2"},
	})
	for _, name := range []string{"X-Forwarded-For", peerAddressHeader} {
		if got := seen.Values(name); len(got) != 0 {
			t.Fatalf("%s = %v, want none when the address is unknown", name, got)
		}
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
