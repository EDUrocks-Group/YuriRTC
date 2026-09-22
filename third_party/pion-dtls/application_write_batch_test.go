// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package dtls

import (
	"bytes"
	"testing"
	"time"
)

func TestWriteBatchPreservesApplicationRecords(t *testing.T) {
	sender, receiver, err := pipeMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	defer receiver.Close()
	if err := receiver.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	// Small records can share datagrams; full records cannot. More than eight
	// records also exercise the bounded batch boundary.
	payloads := make([][]byte, 20)
	for i := range payloads {
		size := 17
		if i%3 == 0 {
			size = 1200
		}
		payloads[i] = bytes.Repeat([]byte{byte(i)}, size)
	}
	done := make(chan error, 1)
	go func() { done <- sender.WriteBatch(payloads) }()
	buffer := make([]byte, 2048)
	for i, want := range payloads {
		n, err := receiver.Read(buffer)
		if err != nil || !bytes.Equal(buffer[:n], want) {
			t.Fatalf("record %d: n=%d err=%v", i, n, err)
		}
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("batch stalled")
	}
	if err := sender.SetWriteDeadline(time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := sender.WriteBatch(payloads); err == nil {
		t.Fatal("batch ignored deadline")
	}
}
