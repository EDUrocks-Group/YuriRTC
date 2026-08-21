package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestBeginHandshakeImmediateAcquireAndIdempotentRelease(t *testing.T) {
	registry := newPeerRegistry()
	release, err := registry.BeginHandshake(context.Background())
	if err != nil {
		t.Fatalf("begin handshake: %v", err)
	}
	if got := len(registry.handshake); got != 1 {
		t.Fatalf("handshake tokens = %d, want 1", got)
	}
	if registry.handshakesActive != 1 {
		t.Fatalf("active handshakes = %d, want 1", registry.handshakesActive)
	}

	release()
	release()
	if got := len(registry.handshake); got != 0 {
		t.Fatalf("handshake tokens after release = %d, want 0", got)
	}
	if registry.handshakesActive != 0 {
		t.Fatalf("active handshakes after release = %d, want 0", registry.handshakesActive)
	}
}

func TestBeginHandshakeSaturationStillTimesOut(t *testing.T) {
	registry := newPeerRegistry()
	releases := fillHandshakeCapacity(t, registry)
	defer releaseHandshakes(releases)

	started := time.Now()
	release, err := registry.beginHandshake(context.Background(), 5*time.Millisecond)
	if release != nil {
		t.Fatal("saturated handshake unexpectedly returned a release function")
	}
	if !errors.Is(err, errHandshakeCapacity) {
		t.Fatalf("saturated handshake error = %v, want %v", err, errHandshakeCapacity)
	}
	if elapsed := time.Since(started); elapsed < time.Millisecond {
		t.Fatalf("saturated handshake returned before its queue timeout: %v", elapsed)
	}
	if registry.handshakesRejected != 1 {
		t.Fatalf("handshake rejects = %d, want 1", registry.handshakesRejected)
	}
}

func TestBeginHandshakeSaturationHonorsCancellation(t *testing.T) {
	registry := newPeerRegistry()
	releases := fillHandshakeCapacity(t, registry)
	defer releaseHandshakes(releases)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	release, err := registry.BeginHandshake(ctx)
	if release != nil {
		t.Fatal("cancelled handshake unexpectedly returned a release function")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled handshake error = %v, want %v", err, context.Canceled)
	}
	if registry.handshakesRejected != 0 {
		t.Fatalf("cancellation counted as %d handshake rejects", registry.handshakesRejected)
	}
}

func BenchmarkBeginHandshakeImmediate(b *testing.B) {
	registry := newPeerRegistry()
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		release, err := registry.BeginHandshake(ctx)
		if err != nil {
			b.Fatal(err)
		}
		release()
	}
}

func fillHandshakeCapacity(t *testing.T, registry *peerRegistry) []func() {
	t.Helper()
	releases := make([]func(), 0, maxConcurrentHandshakes)
	for range maxConcurrentHandshakes {
		release, err := registry.BeginHandshake(context.Background())
		if err != nil {
			t.Fatalf("fill handshake capacity: %v", err)
		}
		releases = append(releases, release)
	}
	return releases
}

func releaseHandshakes(releases []func()) {
	for _, release := range releases {
		release()
	}
}
