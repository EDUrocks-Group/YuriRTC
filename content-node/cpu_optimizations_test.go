package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestRejectedCompressionCacheBoundedAndInvalidated(t *testing.T) {
	cache := newWireGzipCache()
	key := wireGzipCacheKey{path: "engine.wasm", size: 1234, modTimeNS: 1}
	calls := 0
	build := func() ([]byte, bool, error) { calls++; return nil, false, nil }
	for range 2 {
		if _, use, err := cache.load(context.Background(), key, build); err != nil || use {
			t.Fatalf("rejected result: %v %v", use, err)
		}
	}
	if calls != 1 {
		t.Fatalf("compressed %d times", calls)
	}
	key.modTimeNS++
	if _, _, err := cache.load(context.Background(), key, build); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(cache.entries) != 1 {
		t.Fatal("changed identity retained stale decision")
	}
	for i := 0; i < maxWireGzipCacheEntries+20; i++ {
		cache.storeResultLocked(wireGzipCacheKey{path: fmt.Sprint(i)}, nil, false)
	}
	if len(cache.entries) != maxWireGzipCacheEntries || len(cache.paths) != maxWireGzipCacheEntries || cache.used != 0 {
		t.Fatal("negative cache is not bounded")
	}
}

func TestCompressionFailuresAndCancellationAreNotCached(t *testing.T) {
	cache := newWireGzipCache()
	key := wireGzipCacheKey{path: "asset.js"}
	failure := errors.New("read failed")
	for range 2 {
		if _, _, err := cache.load(context.Background(), key, func() ([]byte, bool, error) { return nil, false, failure }); !errors.Is(err, failure) {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, _, _ = cache.load(ctx, key, func() ([]byte, bool, error) { cancel(); return nil, false, nil })
	if len(cache.entries) != 0 {
		t.Fatal("error/cancellation cached")
	}
	called := false
	if _, _, err := cache.load(ctx, key, func() ([]byte, bool, error) { called = true; return nil, false, nil }); err == nil || called {
		t.Fatal("canceled build ran")
	}
}

func TestCertificateReuseRotationAndConcurrentAccess(t *testing.T) {
	cache := &certificateCache{}
	now := time.Now()
	original, err := cache.get(now)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := cache.get(now.Add(time.Hour))
			if err != nil || !got.Equals(original) {
				t.Error("certificate not shared")
			}
		}()
	}
	wg.Wait()
	rotated, err := cache.get(now.Add(25 * time.Hour))
	if err != nil || rotated.Equals(original) {
		t.Fatal("certificate did not rotate")
	}
	if !original.Expires().After(now) {
		t.Fatal("rotation invalidated previous certificate")
	}
}

func TestPrecompressedAssetsPreserveHTTPAndFallback(t *testing.T) {
	root, sidecars := t.TempDir(), t.TempDir()
	body := bytes.Repeat([]byte("export const game = 'fixture';\n"), 2000)
	path := writeStaticFixture(t, root, "engine.js", body, time.Now().Add(-time.Hour))
	if err := GeneratePrecompressed(root, sidecars); err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(root, "http://127.0.0.1:1")
	if err := handler.LoadPrecompressed(sidecars); err != nil {
		t.Fatal(err)
	}
	gzipHeaders := HeaderPairs{{wireAcceptEncodingHeader, "gzip"}}
	serve := func(head RequestHead) *recordingResponseSender {
		t.Helper()
		out := &recordingResponseSender{}
		if err := handler.static(context.Background(), out, 1, head, "/engine.js"); err != nil {
			t.Fatal(err)
		}
		return out
	}
	out := serve(RequestHead{Method: "GET", Headers: gzipHeaders})
	if !bytes.Equal(gunzipBody(t, joinedBody(out)), body) {
		t.Fatal("sidecar bytes differ")
	}
	if len(handler.wireGzip.entries) != 0 {
		t.Fatal("sidecar recompressed")
	}
	etag := headerValue(out.heads[0].Headers, "etag")
	for _, head := range []RequestHead{
		{Method: "GET"}, {Method: "HEAD", Headers: gzipHeaders},
		{Method: "GET", Headers: append(append(HeaderPairs{}, gzipHeaders...), [2]string{"cache-control", "no-transform"})},
		{Method: "GET", Headers: append(append(HeaderPairs{}, gzipHeaders...), [2]string{"range", "bytes=5-20"})},
		{Method: "GET", Headers: append(append(HeaderPairs{}, gzipHeaders...), [2]string{"if-none-match", etag})},
	} {
		result := serve(head)
		if headerValue(result.heads[0].Headers, wireEncodingHeader) != "" {
			t.Fatal("transformed excluded request")
		}
		if head.Method == "HEAD" || result.heads[0].Status == http.StatusNotModified {
			if len(joinedBody(result)) != 0 {
				t.Fatal("unexpected body")
			}
			continue
		}
		want := body
		if result.heads[0].Status == http.StatusPartialContent {
			want = body[5:21]
		}
		if !bytes.Equal(joinedBody(result), want) {
			t.Fatal("original/range bytes differ")
		}
	}
	// Atomic source replacement invalidates the verified inode even if the
	// replacement preserves its size and timestamp.
	replacement := bytes.Repeat([]byte("x"), len(body))
	oldInfo, _ := os.Stat(path)
	tmp := filepath.Join(root, "replacement")
	if err := os.WriteFile(tmp, replacement, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(tmp, oldInfo.ModTime(), oldInfo.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
	out = serve(RequestHead{Method: "GET", Headers: gzipHeaders})
	if !bytes.Equal(gunzipBody(t, joinedBody(out)), replacement) {
		t.Fatal("served stale sidecar")
	}
	if err := NewHandler(root, "").LoadPrecompressed(sidecars); err == nil {
		t.Fatal("accepted stale source hash")
	}
}

func TestPrecompressedRejectsCorruptAndPublicSidecars(t *testing.T) {
	root, sidecars := t.TempDir(), t.TempDir()
	writeStaticFixture(t, root, "data.json", bytes.Repeat([]byte("{}\n"), 1000), time.Now())
	if err := GeneratePrecompressed(root, filepath.Join(root, "private")); err == nil {
		t.Fatal("allowed public sidecars")
	}
	if err := GeneratePrecompressed(root, sidecars); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(sidecars, "*.gz"))
	if err != nil || len(files) != 1 {
		t.Fatal("missing gzip")
	}
	handler := NewHandler(root, "")
	if err := handler.LoadPrecompressed(sidecars); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(files[0], []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	out := &recordingResponseSender{}
	if err := handler.static(context.Background(), out, 1, RequestHead{Method: "GET", Headers: HeaderPairs{{wireAcceptEncodingHeader, "gzip"}}}, "/data.json"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gunzipBody(t, joinedBody(out)), bytes.Repeat([]byte("{}\n"), 1000)) {
		t.Fatal("corrupt sidecar was served after startup")
	}
	if err := NewHandler(root, "").LoadPrecompressed(sidecars); err == nil {
		t.Fatal("accepted corrupt gzip")
	}
}
