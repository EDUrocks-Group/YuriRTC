package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

func routeProbeRequest(method string) RequestHead {
	return RequestHead{
		Method:  method,
		URL:     "/any-hosted-path",
		Headers: HeaderPairs{{routeProbeHeader, strconv.Itoa(routeProbePayloadBytes)}, {wireAcceptEncodingHeader, wireGzipEncoding}},
	}
}

func TestRouteProbeIsBoundedSiteIndependentAndUncompressed(t *testing.T) {
	handler := NewHandler(t.TempDir(), "http://127.0.0.1:1")
	out := &recordingResponseSender{}
	if err := handler.Serve(context.Background(), out, 1, routeProbeRequest(http.MethodGet), nil); err != nil {
		t.Fatalf("serve route probe: %v", err)
	}
	if len(out.heads) != 1 || out.heads[0].Status != http.StatusOK {
		t.Fatalf("route probe heads = %+v", out.heads)
	}
	headers := out.heads[0].Headers
	if got := headerValue(headers, routeProbeHeader); got != strconv.Itoa(routeProbePayloadBytes) {
		t.Fatalf("route probe marker = %q", got)
	}
	if got := headerValue(headers, "cache-control"); got != "no-store" {
		t.Fatalf("route probe cache-control = %q", got)
	}
	if got := headerValue(headers, "content-length"); got != strconv.Itoa(routeProbePayloadBytes) {
		t.Fatalf("route probe content-length = %q", got)
	}
	if got := headerValue(headers, wireEncodingHeader); got != "" {
		t.Fatalf("route probe was compressed as %q", got)
	}
	if got := joinedBody(out); !bytes.Equal(got, routeProbePayload) {
		t.Fatalf("route probe body changed: got %d bytes", len(got))
	}
	if out.bulkAcquires != 1 || out.bulkReleases != 1 {
		t.Fatalf("route probe bulk acquires=%d releases=%d", out.bulkAcquires, out.bulkReleases)
	}
	for index, chunk := range out.bodies {
		if len(chunk) > maxPayloadBytes {
			t.Fatalf("route probe chunk %d is %d bytes", index, len(chunk))
		}
	}
}

func TestRouteProbeHEADHasNoBody(t *testing.T) {
	out := &recordingResponseSender{}
	if err := NewHandler(t.TempDir(), "http://127.0.0.1:1").Serve(
		context.Background(), out, 1, routeProbeRequest(http.MethodHead), nil,
	); err != nil {
		t.Fatalf("serve route probe HEAD: %v", err)
	}
	if out.heads[0].Status != http.StatusOK || len(out.bodies) != 0 || len(out.ends) != 1 {
		t.Fatalf("route probe HEAD = %+v", out)
	}
	if out.bulkAcquires != 0 {
		t.Fatalf("route probe HEAD acquired a bulk slot")
	}
}

func TestRouteProbeAllowsOnlyOneSuccessfulRequestPerPeer(t *testing.T) {
	handler := NewHandler(t.TempDir(), "http://127.0.0.1:1")
	out := &recordingResponseSender{}
	if err := handler.Serve(context.Background(), out, 1, routeProbeRequest(http.MethodGet), nil); err != nil {
		t.Fatalf("serve first route probe: %v", err)
	}
	if err := handler.Serve(context.Background(), out, 2, routeProbeRequest(http.MethodGet), nil); err != nil {
		t.Fatalf("serve repeated route probe: %v", err)
	}
	if len(out.heads) != 2 || out.heads[1].Status != http.StatusTooManyRequests {
		t.Fatalf("repeated route probe heads = %+v", out.heads)
	}
	if got := len(joinedBody(out)); got != routeProbePayloadBytes {
		t.Fatalf("repeat added a large response body: total=%d", got)
	}
}

func TestInvalidRouteProbeDoesNotAllocateOrConsumeClaim(t *testing.T) {
	handler := NewHandler(t.TempDir(), "http://127.0.0.1:1")
	out := &recordingResponseSender{}
	invalid := routeProbeRequest(http.MethodGet)
	invalid.Headers[0][1] = strconv.Itoa(routeProbePayloadBytes + 1)
	if err := handler.Serve(context.Background(), out, 1, invalid, nil); err != nil {
		t.Fatalf("serve invalid route probe: %v", err)
	}
	if out.heads[0].Status != http.StatusBadRequest || len(out.bodies) != 0 || out.probeClaimed {
		t.Fatalf("invalid route probe response = %+v", out)
	}
	if err := handler.Serve(context.Background(), out, 2, routeProbeRequest(http.MethodGet), nil); err != nil {
		t.Fatalf("serve valid route probe after invalid: %v", err)
	}
	if out.heads[1].Status != http.StatusOK {
		t.Fatalf("valid route probe status = %d", out.heads[1].Status)
	}
}

func TestRouteProbePayloadIsNotTriviallyCompressible(t *testing.T) {
	var encoded bytes.Buffer
	writer, err := gzip.NewWriterLevel(&encoded, gzip.BestSpeed)
	if err != nil {
		t.Fatalf("create gzip writer: %v", err)
	}
	if _, err := writer.Write(routeProbePayload); err != nil {
		t.Fatalf("compress route probe: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}
	if encoded.Len() < routeProbePayloadBytes*95/100 {
		t.Fatalf("route probe compressed to %d bytes", encoded.Len())
	}
}

func TestPeerSessionRouteProbeClaimIsAtomic(t *testing.T) {
	session := NewPeerSession(nil, nil)
	var successes atomic.Int64
	var wait sync.WaitGroup
	for range 32 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if session.ClaimRouteProbe() {
				successes.Add(1)
			}
		}()
	}
	wait.Wait()
	if got := successes.Load(); got != 1 {
		t.Fatalf("successful route-probe claims = %d, want 1", got)
	}
}
