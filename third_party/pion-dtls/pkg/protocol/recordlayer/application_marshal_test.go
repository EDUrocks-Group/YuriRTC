// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package recordlayer

import (
	"bytes"
	"github.com/pion/dtls/v3/pkg/protocol"
	"testing"
)

func TestApplicationMarshalMatchesGenericRecord(t *testing.T) {
	for _, size := range []int{0, 1, 1200, 16384} {
		payload := bytes.Repeat([]byte{0x5a}, size)
		record := RecordLayer{Header: Header{Version: protocol.Version1_2, Epoch: 2, SequenceNumber: 123}, Content: &protocol.ApplicationData{Data: payload}}
		got, err := record.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		header, err := record.Header.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		want := append(header, payload...)
		if !bytes.Equal(got, want) {
			t.Fatal("wire bytes changed")
		}
		if size > 0 {
			payload[0] = 0
			if got[FixedHeaderSize] != 0x5a {
				t.Fatal("record aliases input")
			}
		}
	}
}
