// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package netctx

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCanceledWriteDoesNotPoisonNextPacket(t *testing.T) {
	ca, cb := pipe()
	writer := NewPacketConn(ca)
	defer writer.Close()
	defer cb.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := writer.WriteToContext(ctx, []byte("canceled"), nil); done <- err }()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked write did not cancel")
	}
	received := make(chan error, 1)
	go func() {
		b := make([]byte, 16)
		n, _, err := cb.ReadFrom(b)
		if err == nil && string(b[:n]) != "next" {
			err = errors.New("wrong payload")
		}
		received <- err
	}()
	next, cancelNext := context.WithTimeout(context.Background(), time.Second)
	defer cancelNext()
	if _, err := writer.WriteToContext(next, []byte("next"), nil); err != nil {
		t.Fatal(err)
	}
	if err := <-received; err != nil {
		t.Fatal(err)
	}
}
