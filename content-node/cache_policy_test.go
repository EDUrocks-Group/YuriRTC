package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestStaticCacheRulesTravelInResponseHeaders(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "image.png"), []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	rules := filepath.Join(t.TempDir(), "rules.json")
	if err := os.WriteFile(rules, []byte(`[{"prefix":"/","cache":"cache","cacheControl":"public, max-age=60","tags":["assets"]},{"prefix":"/image.png","cache":"no-store","tags":["private"]}]`), 0600); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(root, "")
	if err := h.LoadCacheRules(rules); err != nil {
		t.Fatal(err)
	}
	out := &recordingResponseSender{}
	if err := h.Serve(context.Background(), out, 1, RequestHead{Method: "GET", URL: "/image.png"}, nil); err != nil {
		t.Fatal(err)
	}
	if len(out.heads) != 1 {
		t.Fatalf("heads %+v", out.heads)
	}
	headers := out.heads[0].Headers
	if headerValue(headers, "cache-control") != "no-store" || headerValue(headers, "x-yurirtc-cache") != "no-store" || headerValue(headers, "cache-tag") != "private" {
		t.Fatalf("headers %+v", headers)
	}
}
