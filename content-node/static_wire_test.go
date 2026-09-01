package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func writeStaticFixture(t *testing.T, root, name string, body []byte, modified time.Time) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create fixture directory: %v", err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatalf("set fixture time: %v", err)
	}
	return path
}

func joinedBody(out *recordingResponseSender) []byte {
	return bytes.Join(out.bodies, nil)
}

func gunzipBody(t *testing.T, encoded []byte) []byte {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("open gzip response: %v", err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip response: %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close gzip response: %v", err)
	}
	return decoded
}

func TestStaticResponsesExposeUniversalValidators(t *testing.T) {
	root := t.TempDir()
	modified := time.Date(2026, time.August, 30, 12, 34, 56, 0, time.UTC)
	body := []byte("console.log('ordinary static response');")
	writeStaticFixture(t, root, "scripts/app.js", body, modified)

	handler := NewHandler(root, "http://127.0.0.1:1")
	out := &recordingResponseSender{}
	if err := handler.static(context.Background(), out, 1, RequestHead{Method: http.MethodGet}, "/scripts/app.js"); err != nil {
		t.Fatalf("serve static response: %v", err)
	}
	if len(out.heads) != 1 || out.heads[0].Status != http.StatusOK {
		t.Fatalf("response heads = %+v", out.heads)
	}
	headers := out.heads[0].Headers
	if got := headerValue(headers, "cache-control"); got != "public, max-age=0, must-revalidate" {
		t.Fatalf("cache-control = %q", got)
	}
	if got := headerValue(headers, "etag"); got == "" {
		t.Fatal("ordinary static response has no ETag")
	}
	if got := headerValue(headers, "last-modified"); got != modified.Format(http.TimeFormat) {
		t.Fatalf("last-modified = %q", got)
	}
	if _, err := http.ParseTime(headerValue(headers, "date")); err != nil {
		t.Fatalf("date is not an HTTP date: %v", err)
	}
	if got := headerValue(headers, "content-length"); got != strconv.Itoa(len(body)) {
		t.Fatalf("content-length = %q", got)
	}
	if got := joinedBody(out); !bytes.Equal(got, body) {
		t.Fatalf("body changed: got %q want %q", got, body)
	}
}

func TestStaticWireGzipIsNegotiatedAndCached(t *testing.T) {
	root := t.TempDir()
	body := bytes.Repeat([]byte("const answer = 42;\n"), 2_000)
	writeStaticFixture(t, root, "app.js", body, time.Now().Add(-time.Hour))

	handler := NewHandler(root, "http://127.0.0.1:1")
	request := RequestHead{
		Method:  http.MethodGet,
		Headers: HeaderPairs{{wireAcceptEncodingHeader, "gzip"}},
	}
	for id := uint32(1); id <= 2; id++ {
		out := &recordingResponseSender{}
		if err := handler.static(context.Background(), out, id, request, "/app.js"); err != nil {
			t.Fatalf("serve gzip request %d: %v", id, err)
		}
		if got := headerValue(out.heads[0].Headers, wireEncodingHeader); got != wireGzipEncoding {
			t.Fatalf("wire encoding = %q", got)
		}
		// This remains the semantic representation length. The private body is
		// decoded before the loader constructs the browser Response.
		if got := headerValue(out.heads[0].Headers, "content-length"); got != strconv.Itoa(len(body)) {
			t.Fatalf("content-length = %q", got)
		}
		if got := gunzipBody(t, joinedBody(out)); !bytes.Equal(got, body) {
			t.Fatalf("decoded gzip body changed: got %d bytes, want %d", len(got), len(body))
		}
	}
	if got := len(handler.wireGzip.entries); got != 1 {
		t.Fatalf("gzip cache entries = %d, want 1", got)
	}
	if handler.wireGzip.used <= 0 || handler.wireGzip.used >= int64(len(body)) {
		t.Fatalf("gzip cache bytes = %d for %d-byte source", handler.wireGzip.used, len(body))
	}
}

func TestStaticWireGzipNeverChangesRangeOrHead(t *testing.T) {
	root := t.TempDir()
	body := bytes.Repeat([]byte("0123456789"), 1_000)
	writeStaticFixture(t, root, "asset.txt", body, time.Now().Add(-time.Hour))
	handler := NewHandler(root, "http://127.0.0.1:1")

	rangeOut := &recordingResponseSender{}
	if err := handler.static(context.Background(), rangeOut, 1, RequestHead{
		Method: http.MethodGet,
		Headers: HeaderPairs{
			{wireAcceptEncodingHeader, "gzip"},
			{"range", "bytes=10-29"},
		},
	}, "/asset.txt"); err != nil {
		t.Fatalf("serve range: %v", err)
	}
	if rangeOut.heads[0].Status != http.StatusPartialContent {
		t.Fatalf("range status = %d", rangeOut.heads[0].Status)
	}
	if got := headerValue(rangeOut.heads[0].Headers, wireEncodingHeader); got != "" {
		t.Fatalf("range was wire encoded as %q", got)
	}
	if got := joinedBody(rangeOut); !bytes.Equal(got, body[10:30]) {
		t.Fatalf("range body = %q", got)
	}
	if got := headerValue(rangeOut.heads[0].Headers, "content-range"); got != "bytes 10-29/10000" {
		t.Fatalf("content-range = %q", got)
	}

	headOut := &recordingResponseSender{}
	if err := handler.static(context.Background(), headOut, 2, RequestHead{
		Method:  http.MethodHead,
		Headers: HeaderPairs{{wireAcceptEncodingHeader, "gzip"}},
	}, "/asset.txt"); err != nil {
		t.Fatalf("serve HEAD: %v", err)
	}
	if len(headOut.bodies) != 0 || headerValue(headOut.heads[0].Headers, wireEncodingHeader) != "" {
		t.Fatalf("HEAD unexpectedly carried an encoded body: %+v", headOut)
	}
}

func TestStaticWireGzipRespectsNoTransformAndMediaType(t *testing.T) {
	root := t.TempDir()
	body := bytes.Repeat([]byte{'x'}, 8*1024)
	writeStaticFixture(t, root, "app.css", body, time.Now().Add(-time.Hour))
	writeStaticFixture(t, root, "image.png", body, time.Now().Add(-time.Hour))
	handler := NewHandler(root, "http://127.0.0.1:1")

	cases := []struct {
		path    string
		headers HeaderPairs
	}{
		{"/app.css", HeaderPairs{{wireAcceptEncodingHeader, "gzip;q=0"}}},
		{"/app.css", HeaderPairs{{wireAcceptEncodingHeader, "gzip"}, {"cache-control", "max-age=0, No-Transform"}}},
		{"/image.png", HeaderPairs{{wireAcceptEncodingHeader, "gzip"}}},
	}
	for id, test := range cases {
		out := &recordingResponseSender{}
		if err := handler.static(context.Background(), out, uint32(id+1), RequestHead{Method: http.MethodGet, Headers: test.headers}, test.path); err != nil {
			t.Fatalf("serve %s: %v", test.path, err)
		}
		if got := headerValue(out.heads[0].Headers, wireEncodingHeader); got != "" {
			t.Fatalf("%s wire encoding = %q", test.path, got)
		}
		if got := joinedBody(out); !bytes.Equal(got, body) {
			t.Fatalf("%s body changed", test.path)
		}
	}
}

func TestStaticConditionalRequestsReturn304(t *testing.T) {
	root := t.TempDir()
	modified := time.Date(2026, time.August, 30, 12, 34, 56, 789, time.UTC)
	body := bytes.Repeat([]byte("cache me\n"), 200)
	writeStaticFixture(t, root, "index.html", body, modified)
	handler := NewHandler(root, "http://127.0.0.1:1")

	initial := &recordingResponseSender{}
	if err := handler.static(context.Background(), initial, 1, RequestHead{Method: http.MethodGet}, "/index.html"); err != nil {
		t.Fatalf("serve initial response: %v", err)
	}
	etag := headerValue(initial.heads[0].Headers, "etag")
	lastModified := headerValue(initial.heads[0].Headers, "last-modified")

	for id, headers := range []HeaderPairs{
		{{"if-none-match", etag}},
		{{"if-none-match", "\"other\", " + etag}},
		{{"if-none-match", "*"}},
		{{"if-modified-since", lastModified}},
	} {
		out := &recordingResponseSender{}
		if err := handler.static(context.Background(), out, uint32(id+2), RequestHead{Method: http.MethodGet, Headers: headers}, "/index.html"); err != nil {
			t.Fatalf("conditional request %d: %v", id, err)
		}
		if len(out.heads) != 1 || out.heads[0].Status != http.StatusNotModified {
			t.Fatalf("conditional request %d heads = %+v", id, out.heads)
		}
		if len(out.bodies) != 0 || len(out.ends) != 1 {
			t.Fatalf("304 carried body or did not end: bodies=%d ends=%v", len(out.bodies), out.ends)
		}
		for _, name := range []string{"date", "etag", "last-modified", "cache-control"} {
			if got := headerValue(out.heads[0].Headers, name); got == "" {
				t.Fatalf("304 omitted %s", name)
			}
		}
		if got := headerValue(out.heads[0].Headers, "content-length"); got != "" {
			t.Fatalf("304 content-length = %q", got)
		}
	}

	// A present If-None-Match suppresses If-Modified-Since even when the latter
	// would independently validate the representation.
	precedence := &recordingResponseSender{}
	if err := handler.static(context.Background(), precedence, 9, RequestHead{
		Method: http.MethodGet,
		Headers: HeaderPairs{
			{"if-none-match", "\"different\""},
			{"if-modified-since", time.Now().Add(time.Hour).Format(http.TimeFormat)},
		},
	}, "/index.html"); err != nil {
		t.Fatalf("serve precedence request: %v", err)
	}
	if precedence.heads[0].Status != http.StatusOK || !bytes.Equal(joinedBody(precedence), body) {
		t.Fatalf("If-None-Match precedence response = %+v", precedence)
	}
}

func TestImmutableStaticCacheBehaviorIsPreserved(t *testing.T) {
	root := t.TempDir()
	writeStaticFixture(t, root, "a/app.123.js", []byte("short"), time.Now().Add(-time.Hour))
	out := &recordingResponseSender{}
	if err := NewHandler(root, "http://127.0.0.1:1").static(
		context.Background(), out, 1, RequestHead{Method: http.MethodGet}, "/a/app.123.js",
	); err != nil {
		t.Fatalf("serve immutable asset: %v", err)
	}
	if got := headerValue(out.heads[0].Headers, "cache-control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("immutable cache-control = %q", got)
	}
}

func TestProxyCannotSeeOrSetWireEncodingHeaders(t *testing.T) {
	var leakedEncoding, leakedProbe string
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		leakedEncoding = request.Header.Get(wireAcceptEncodingHeader)
		leakedProbe = request.Header.Get(routeProbeHeader)
		response.Header().Set(wireEncodingHeader, wireGzipEncoding)
		response.Header().Set(routeProbeHeader, strconv.Itoa(routeProbePayloadBytes))
		_, _ = response.Write([]byte("ordinary API body"))
	}))
	defer backend.Close()

	handler := NewHandler(t.TempDir(), backend.URL)
	out := &recordingResponseSender{}
	if err := handler.Serve(context.Background(), out, 1, RequestHead{
		Method:  http.MethodGet,
		URL:     "/apiv2/status",
		Headers: HeaderPairs{{wireAcceptEncodingHeader, wireGzipEncoding}},
	}, nil); err != nil {
		t.Fatalf("proxy API response: %v", err)
	}
	if leakedEncoding != "" || leakedProbe != "" {
		t.Fatalf("private transport headers leaked to backend as encoding=%q probe=%q", leakedEncoding, leakedProbe)
	}
	if got := headerValue(out.heads[0].Headers, wireEncodingHeader); got != "" {
		t.Fatalf("backend controlled private wire response header as %q", got)
	}
	if got := headerValue(out.heads[0].Headers, routeProbeHeader); got != "" {
		t.Fatalf("backend controlled private route-probe response header as %q", got)
	}
	if got := joinedBody(out); string(got) != "ordinary API body" {
		t.Fatalf("API body changed: %q", got)
	}
}

func TestStreamWireGzipRoundTrip(t *testing.T) {
	body := bytes.Repeat([]byte("large streaming wasm-like payload\n"), 20_000)
	selectedLength := int64(len(body) - 137)
	out := &recordingResponseSender{}
	if err := streamWireGzip(context.Background(), out, 1, bytes.NewReader(body), selectedLength); err != nil {
		t.Fatalf("stream gzip: %v", err)
	}
	if got := gunzipBody(t, joinedBody(out)); !bytes.Equal(got, body[:selectedLength]) {
		t.Fatalf("streamed gzip body changed: got %d bytes, want %d", len(got), selectedLength)
	}
	for index, chunk := range out.bodies {
		if len(chunk) > maxPayloadBytes {
			t.Fatalf("wire chunk %d has %d bytes", index, len(chunk))
		}
	}
}
