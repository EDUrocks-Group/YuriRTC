//go:build !race

// SPDX-FileCopyrightText: 2026 EDUrocks contributors
// SPDX-License-Identifier: MIT

package sctp

import "testing"

func TestPacketize128KiBUsesBoundedAllocations(t *testing.T) {
	stream := newTestPacketizingStream(t, true, maxPayloadSizeForMTU(initialMTU, true))
	payload := make([]byte, 128<<10)

	allocations := testing.AllocsPerRun(100, func() {
		chunks, _ := stream.packetize(payload, PayloadTypeWebRTCBinary)
		if len(chunks) == 0 {
			panic("packetize returned no chunks")
		}
	})
	if allocations > 8 {
		t.Fatalf("128 KiB packetization allocated %.2f objects, want at most eight", allocations)
	}
}
