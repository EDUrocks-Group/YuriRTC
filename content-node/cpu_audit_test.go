package main

// Compare repeated compression and certificate creation with their alternatives.
// They isolate avoidable work, not whole-connection CPU or WAN performance.
import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"io"
	mathrand "math/rand/v2"
	"os"
	"path/filepath"
	"testing"

	"github.com/pion/webrtc/v4"
)

func BenchmarkPeerCertificateReuse(b *testing.B) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		b.Fatal(err)
	}
	certificate, err := webrtc.GenerateCertificate(key)
	if err != nil {
		b.Fatal(err)
	}
	api := webrtc.NewAPI()
	for _, reuse := range []bool{false, true} {
		name := "fresh-certificate"
		config := webrtc.Configuration{}
		if reuse {
			name = "reused-certificate"
			config.Certificates = []webrtc.Certificate{*certificate}
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for range b.N {
				pc, err := api.NewPeerConnection(config)
				if err != nil {
					b.Fatal(err)
				}
				if err := pc.Close(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkRejectedCompressionDecision(b *testing.B) {
	// A compression-eligible asset containing already compressed/entropy-heavy
	// bytes. The cache now remembers both successful compression and rejection.
	data := make([]byte, 2*1024*1024)
	random := mathrand.NewChaCha8([32]byte{42})
	if _, err := io.ReadFull(random, data); err != nil {
		b.Fatal(err)
	}
	key := wireGzipCacheKey{path: "fixture.wasm", size: int64(len(data)), modTimeNS: 1}
	for _, remember := range []bool{false, true} {
		name := "baseline-repeat-compression"
		if remember {
			name = "bounded-cached-rejection"
		}
		b.Run(name, func(b *testing.B) {
			cache := newWireGzipCache()
			load := func() error {
				build := func() ([]byte, bool, error) { return compressWireGzip(bytes.NewReader(data), int64(len(data))) }
				var encoded []byte
				var use bool
				var err error
				if remember {
					encoded, use, err = cache.load(context.Background(), key, build)
				} else {
					encoded, use, err = build()
				}
				if err != nil {
					return err
				}
				if use || len(encoded) != 0 {
					b.Fatal("fixture must keep the original representation")
				}
				return nil
			}

			// Both paths pay their first compression before the repeated-request test.
			if err := load(); err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if err := load(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// Disk and compression preparation only: the sender consumes bytes without a
// network. This isolates the CPU work removed by offline sidecars.
type cpuDiscardSender struct{}

func (cpuDiscardSender) SendHead(uint32, ResponseHead) error                  { return nil }
func (cpuDiscardSender) SendEnd(uint32) error                                 { return nil }
func (cpuDiscardSender) SendBody(_ context.Context, _ uint32, _ []byte) error { return nil }
func (cpuDiscardSender) StreamBody(_ context.Context, _ uint32, source io.Reader, length int64) error {
	_, err := io.CopyN(io.Discard, source, length)
	return err
}

func BenchmarkLargePrecompressedAsset(b *testing.B) {
	root, sidecars := b.TempDir(), b.TempDir()
	data := bytes.Repeat([]byte(`{"game":"fixture","assets":["texture.png","engine.wasm"]}`), 800000)
	if err := os.WriteFile(filepath.Join(root, "game.json"), data, 0600); err != nil {
		b.Fatal(err)
	}
	if err := GeneratePrecompressed(root, sidecars); err != nil {
		b.Fatal(err)
	}
	for _, prepared := range []bool{false, true} {
		name := "dynamic-gzip"
		if prepared {
			name = "verified-sidecar"
		}
		b.Run(name, func(b *testing.B) {
			handler := NewHandler(root, "")
			if prepared {
				if err := handler.LoadPrecompressed(sidecars); err != nil {
					b.Fatal(err)
				}
			}
			head := RequestHead{Method: "GET", Headers: HeaderPairs{{wireAcceptEncodingHeader, "gzip"}}}
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if err := handler.static(context.Background(), cpuDiscardSender{}, 1, head, "/game.json"); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
