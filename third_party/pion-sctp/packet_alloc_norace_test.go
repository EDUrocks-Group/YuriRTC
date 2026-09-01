//go:build !race

// SPDX-FileCopyrightText: 2026 EDUrocks contributors
// SPDX-License-Identifier: MIT

package sctp

import "testing"

func TestDATAPacketMarshalUsesOneOwnedAllocation(t *testing.T) {
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

	allocations := testing.AllocsPerRun(1000, func() {
		raw, err := packet.marshal(true)
		if err != nil {
			panic(err)
		}
		if len(raw) == 0 {
			panic("empty packet")
		}
	})
	if allocations > 1 {
		t.Fatalf("DATA marshal allocated %.2f objects per packet, want one owned backing array", allocations)
	}
}

func TestDATAPacketMarshalPoolAvoidsAllocations(t *testing.T) {
	drainPacketBufferPool()
	t.Cleanup(drainPacketBufferPool)

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

	// Seed one buffer so AllocsPerRun measures the steady-state association
	// write path instead of the pool's first use.
	releasePacketBuffer(make([]byte, 0, int(initialMTU)))
	allocations := testing.AllocsPerRun(1000, func() {
		raw := acquirePacketBuffer(int(initialMTU))
		marshaled, err := packet.marshalAppend(raw, true)
		if err != nil {
			panic(err)
		}
		releasePacketBuffer(marshaled)
	})
	if allocations != 0 {
		t.Fatalf("pooled DATA marshal allocated %.2f objects per packet, want zero", allocations)
	}
}
