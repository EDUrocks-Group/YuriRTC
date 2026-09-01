// SPDX-FileCopyrightText: 2026 EDUrocks contributors
// SPDX-License-Identifier: MIT

package sctp

import (
	"errors"
	"testing"
)

func drainPacketBufferPool() {
	for {
		select {
		case <-packetBufferPool:
		default:
			return
		}
	}
}

func TestPacketBufferPoolKeepsOutstandingBuffersExclusive(t *testing.T) {
	drainPacketBufferPool()
	t.Cleanup(drainPacketBufferPool)

	first := acquirePacketBuffer(int(initialMTU))
	first = append(first, 0)
	firstBacking := &first[0]
	releasePacketBuffer(first)

	reused := acquirePacketBuffer(int(initialMTU))
	reused = append(reused, 0)
	if &reused[0] != firstBacking {
		t.Fatal("released packet buffer was not reused")
	}

	// The reused buffer is still owned by the caller and must not be handed to
	// another concurrent packet marshal until it is explicitly released.
	other := acquirePacketBuffer(int(initialMTU))
	other = append(other, 0)
	if &other[0] == &reused[0] {
		t.Fatal("packet pool handed the same backing array to two owners")
	}

	releasePacketBuffer(reused)
	releasePacketBuffer(other)
}

func TestPacketBufferPoolRejectsOversizedBuffers(t *testing.T) {
	drainPacketBufferPool()
	t.Cleanup(drainPacketBufferPool)

	releasePacketBuffer(make([]byte, 0, int(maxPooledPacketBufferSize)+1))
	if got := len(packetBufferPool); got != 0 {
		t.Fatalf("oversized packet buffer retained: pool length = %d, want 0", got)
	}
}

func TestMarshalPacketReturnsBufferAfterError(t *testing.T) {
	drainPacketBufferPool()
	t.Cleanup(drainPacketBufferPool)

	assoc := &Association{mtu: initialMTU}
	payload := &chunkPayloadData{
		beginningFragment: true,
		endingFragment:    true,
		userData:          make([]byte, 1<<16),
	}
	_, err := assoc.marshalPacket(&packet{chunks: []chunk{payload}})
	if !errors.Is(err, ErrChunkPayloadTooLarge) {
		t.Fatalf("marshalPacket error = %v, want ErrChunkPayloadTooLarge", err)
	}
	if got := len(packetBufferPool); got != 1 {
		t.Fatalf("marshal failure retained its packet buffer: pool length = %d, want 1", got)
	}
}

func TestDATAPacketMarshalUsesBoundedAllocations(t *testing.T) {
	payload := &chunkPayloadData{
		beginningFragment: true,
		endingFragment:    true,
		tsn:               7,
		streamIdentifier:  3,
		payloadType:       PayloadTypeWebRTCBinary,
		userData:          make([]byte, 512),
	}
	packet := &packet{
		sourcePort:      5000,
		destinationPort: 5000,
		verificationTag: 0x12345678,
		chunks:          []chunk{payload},
	}

	allocations := testing.AllocsPerRun(1000, func() {
		raw, err := packet.marshal(true)
		if err != nil {
			panic(err)
		}
		if len(raw) == 0 {
			panic("empty packet")
		}
	})
	// Ordinary builds report one owned packet backing array. The race detector
	// adds one instrumentation allocation, so keep the regression bound at two
	// while BenchmarkDATAPacketMarshal records the production-build count.
	if allocations > 2 {
		t.Fatalf("DATA marshal allocated %.2f objects per packet, want at most two", allocations)
	}
}

func BenchmarkDATAPacketMarshal(b *testing.B) {
	payload := &chunkPayloadData{
		beginningFragment: true,
		endingFragment:    true,
		tsn:               7,
		streamIdentifier:  3,
		payloadType:       PayloadTypeWebRTCBinary,
		userData:          make([]byte, 1150),
	}
	packet := &packet{
		sourcePort:      5000,
		destinationPort: 5000,
		verificationTag: 0x12345678,
		chunks:          []chunk{payload},
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(payload.userData)))
	for range b.N {
		raw, err := packet.marshal(true)
		if err != nil {
			b.Fatal(err)
		}
		_ = raw
	}
}

func BenchmarkDATAPacketMarshalPooled(b *testing.B) {
	payload := &chunkPayloadData{
		beginningFragment: true,
		endingFragment:    true,
		tsn:               7,
		streamIdentifier:  3,
		payloadType:       PayloadTypeWebRTCBinary,
		userData:          make([]byte, 1150),
	}
	packet := &packet{
		sourcePort:      5000,
		destinationPort: 5000,
		verificationTag: 0x12345678,
		chunks:          []chunk{payload},
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(payload.userData)))
	for range b.N {
		raw := acquirePacketBuffer(int(initialMTU))
		marshaled, err := packet.marshalAppend(raw, true)
		if err != nil {
			b.Fatal(err)
		}
		releasePacketBuffer(marshaled)
	}
}

func TestDATAPacketMarshalRejectsChunkLengthOverflow(t *testing.T) {
	payload := &chunkPayloadData{
		beginningFragment: true,
		endingFragment:    true,
		userData:          make([]byte, 1<<16),
	}
	_, err := payload.marshal()
	if !errors.Is(err, ErrChunkPayloadTooLarge) {
		t.Fatalf("oversized DATA marshal error = %v, want ErrChunkPayloadTooLarge", err)
	}
}
