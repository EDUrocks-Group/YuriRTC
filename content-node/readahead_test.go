package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The advice must never change what is served, only how fast it arrives.
func TestHintSequentialReadDoesNotDisturbContents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "asset.bin")
	want := make([]byte, 512*1024)
	for i := range want {
		want[i] = byte(i)
	}
	if err := os.WriteFile(path, want, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer file.Close()

	if err := hintSequentialRead(file, 0, int64(len(want))); err != nil {
		t.Fatalf("hintSequentialRead: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("length changed: got %d want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("byte %d changed after advice", i)
		}
	}
}

// A range request advises from the seek offset, so the offset must be honoured
// rather than assumed to be zero.
func TestHintSequentialReadAcceptsOffsetAndDegradesQuietly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "asset.bin")
	if err := os.WriteFile(path, make([]byte, 256*1024), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer file.Close()

	if err := hintSequentialRead(file, 64*1024, 64*1024); err != nil {
		t.Fatalf("offset advice: %v", err)
	}
	// Zero and negative lengths are reachable for empty files and HEAD-like
	// paths; they must be ignored rather than turned into a syscall error.
	if err := hintSequentialRead(file, 0, 0); err != nil {
		t.Fatalf("zero length should be a no-op: %v", err)
	}
	if err := hintSequentialRead(nil, 0, 1024); err != nil {
		t.Fatalf("nil file should be a no-op: %v", err)
	}
}
