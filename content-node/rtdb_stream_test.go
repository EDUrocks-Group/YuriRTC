package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRTDBOfferStreamExtractsSupportedOfferPaths(t *testing.T) {
	offer := func(id string) OfferBlob {
		return OfferBlob{SessionID: id, SDP: "v=0-" + id, Candidates: []json.RawMessage{}}
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/signal.json" {
			t.Errorf("path = %s, want /signal.json", r.URL.Path)
		}
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept = %q, want text/event-stream", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")

		writeRTDBSSEFrame(t, w, "put", "/", map[string]any{
			"root": map[string]any{"offer": offer("root")},
			"answered": map[string]any{
				"offer":  offer("must-not-repeat"),
				"answer": map[string]any{"sdp": "done"},
			},
		})
		writeRTDBSSEFrame(t, w, "put", "/node", map[string]any{"offer": offer("node")})
		writeRTDBSSEFrame(t, w, "put", "/leaf/offer", offer("leaf"))
		writeRTDBSSEFrame(t, w, "patch", "/", map[string]any{
			"patch-root": map[string]any{"offer": offer("patch-root")},
		})
		writeRTDBSSEFrame(t, w, "patch", "/patch-node", map[string]any{"offer": offer("patch-node")})
		writeRTDBSSEFrame(t, w, "patch", "/", map[string]any{
			"patch-leaf/offer": offer("patch-leaf"),
		})
		writeRTDBSSEFrame(t, w, "put", "/root/answer", map[string]any{"sdp": "ignore"})
	}))
	defer server.Close()

	stream, err := NewRTDBOfferStream(server.Client(), server.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	received := make(map[string]OfferBlob)
	err = stream.Listen(context.Background(), func(event RTDBOfferEvent) error {
		received[event.UID] = event.Offer
		return nil
	})
	if !errors.Is(err, io.EOF) {
		t.Fatalf("Listen() error = %v, want EOF", err)
	}

	want := []string{"root", "node", "leaf", "patch-root", "patch-node", "patch-leaf"}
	if len(received) != len(want) {
		t.Fatalf("received %d offers (%v), want %d", len(received), received, len(want))
	}
	for _, uid := range want {
		got, ok := received[uid]
		if !ok {
			t.Errorf("missing offer for %q", uid)
			continue
		}
		if got.SessionID != uid || got.SDP != "v=0-"+uid {
			t.Errorf("offer %q = %+v", uid, got)
		}
	}
}

func TestRTDBOfferStreamControlEventsAreTyped(t *testing.T) {
	tests := []struct {
		name  string
		event string
		data  string
		want  error
	}{
		{name: "cancel", event: "cancel", data: `"rules denied"`, want: ErrRTDBStreamCancelled},
		{name: "auth revoked", event: "auth_revoked", data: `"expired"`, want: ErrRTDBStreamAuthRevoked},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", tt.event, tt.data)
			}))
			defer server.Close()

			stream, err := NewRTDBOfferStream(server.Client(), server.URL)
			if err != nil {
				t.Fatal(err)
			}
			err = stream.Listen(context.Background(), func(RTDBOfferEvent) error {
				t.Fatal("control event must not produce an offer")
				return nil
			})
			if !errors.Is(err, tt.want) {
				t.Fatalf("Listen() error = %v, want errors.Is(%v)", err, tt.want)
			}
			if !strings.Contains(err.Error(), strings.Trim(tt.data, `"`)) {
				t.Errorf("Listen() error %q does not retain server detail", err)
			}
		})
	}
}

func TestRTDBOfferStreamCancellationClosesRequest(t *testing.T) {
	requestStarted := make(chan struct{})
	requestDone := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		close(requestStarted)
		<-r.Context().Done()
		close(requestDone)
	}))
	defer server.Close()

	stream, err := NewRTDBOfferStream(server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- stream.Listen(ctx, func(RTDBOfferEvent) error { return nil })
	}()

	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("stream request did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Listen() error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Listen did not stop after cancellation")
	}
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("HTTP request remained open after cancellation")
	}
}

func TestRTDBOfferStreamBoundsEventData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "event: put\ndata: %s\n\n", strings.Repeat("x", 128))
	}))
	defer server.Close()

	stream, err := NewRTDBOfferStream(server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	stream.maxEventBytes = 64
	err = stream.Listen(context.Background(), func(RTDBOfferEvent) error { return nil })
	if !errors.Is(err, ErrRTDBStreamEventTooBig) {
		t.Fatalf("Listen() error = %v, want ErrRTDBStreamEventTooBig", err)
	}
}

func TestRTDBOfferStreamPropagatesHandlerFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		writeRTDBSSEFrame(t, w, "put", "/uid/offer", OfferBlob{SessionID: "s", SDP: "v=0"})
	}))
	defer server.Close()

	stream, err := NewRTDBOfferStream(server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	want := errors.New("handler stopped")
	err = stream.Listen(context.Background(), func(RTDBOfferEvent) error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("Listen() error = %v, want handler error", err)
	}
}

func TestFirebaseRTDBRedirectKeepsCredentialsOnlyOnTrustedHTTPSHosts(t *testing.T) {
	prior, err := http.NewRequest(http.MethodGet, "https://project.firebaseio.com/signal.json", nil)
	if err != nil {
		t.Fatal(err)
	}
	prior.Header.Set("Authorization", "Bearer secret")

	trusted, err := http.NewRequest(http.MethodGet, "https://s-us-central1.firebaseio.com/signal.json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := firebaseRTDBRedirect(trusted, []*http.Request{prior}); err != nil {
		t.Fatalf("trusted redirect rejected: %v", err)
	}
	if got := trusted.Header.Get("Authorization"); got != "Bearer secret" {
		t.Fatalf("Authorization = %q, want preserved bearer token", got)
	}
	if got := trusted.Header.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("Accept = %q", got)
	}

	for _, target := range []string{
		"https://attacker.example/signal.json",
		"http://s-us-central1.firebaseio.com/signal.json",
	} {
		request, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := firebaseRTDBRedirect(request, []*http.Request{prior}); err == nil {
			t.Fatalf("unsafe credential redirect to %s was allowed", target)
		}
	}
}

func writeRTDBSSEFrame(t *testing.T, w io.Writer, event, path string, data any) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"path": path, "data": data})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload); err != nil {
		t.Fatal(err)
	}
}
