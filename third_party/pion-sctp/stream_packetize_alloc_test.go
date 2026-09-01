// SPDX-FileCopyrightText: 2026 EDUrocks contributors
// SPDX-License-Identifier: MIT

package sctp

import (
	"bytes"
	"testing"
)

func TestPacketizeOwnsPayloadUntilAcknowledged(t *testing.T) {
	stream := newTestPacketizingStream(t, true, 3)
	payload := []byte("abcdef")

	chunks, _ := stream.packetize(payload, PayloadTypeWebRTCBinary)
	copy(payload, "XXXXXX")

	var got []byte
	for _, chunk := range chunks {
		got = append(got, chunk.userData...)
	}
	if !bytes.Equal(got, []byte("abcdef")) {
		t.Fatalf("packetized payload changed with caller buffer: got %q", got)
	}
}

func BenchmarkStreamPacketize128KiB(b *testing.B) {
	stream := newTestPacketizingStream(b, true, maxPayloadSizeForMTU(initialMTU, true))
	payload := make([]byte, 128<<10)

	b.ReportAllocs()
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for range b.N {
		chunks, _ := stream.packetize(payload, PayloadTypeWebRTCBinary)
		if len(chunks) == 0 {
			b.Fatal("packetize returned no chunks")
		}
	}
}
