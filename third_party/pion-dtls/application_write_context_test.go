// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package dtls

import (
	"context"
	"testing"
	"time"

	"github.com/pion/dtls/v3/internal/closer"
	"github.com/pion/transport/v4/deadline"
)

func TestApplicationWriteContextReuseResetAndClose(t *testing.T) {
	c := &Conn{closed: closer.NewCloser(), writeDeadline: deadline.New()}
	defer c.closed.Close()
	first := c.applicationWriteContext()
	for range 100 {
		if c.applicationWriteContext() != first {
			t.Fatal("context recreated for each packet")
		}
	}
	c.writeDeadline.Set(time.Now().Add(time.Hour))
	if c.applicationWriteContext() != first {
		t.Fatal("unexpired deadline reset changed context")
	}
	c.writeDeadline.Set(time.Now().Add(-time.Second))
	select {
	case <-first.Done():
	case <-time.After(time.Second):
		t.Fatal("deadline not propagated")
	}
	if first.Err() != context.DeadlineExceeded {
		t.Fatal(first.Err())
	}
	c.writeDeadline.Set(time.Time{})
	next := c.applicationWriteContext()
	if next == first || next.Err() != nil {
		t.Fatal("expired context reused after reset")
	}
	// A callback must use the embedded standard context's cancellation path.
	callback := make(chan struct{})
	stop := context.AfterFunc(next, func() { close(callback) })
	defer stop()
	c.closed.Close()
	select {
	case <-callback:
	case <-time.After(time.Second):
		t.Fatal("close callback not propagated")
	}
	if next.Err() != context.Canceled {
		t.Fatal(next.Err())
	}
}

func TestApplicationWriteContextConcurrentDeadlineReset(t *testing.T) {
	c := &Conn{closed: closer.NewCloser(), writeDeadline: deadline.New()}
	defer c.closed.Close()
	for range 100 {
		old := c.applicationWriteContext()
		c.writeDeadline.Set(time.Now().Add(-time.Second))
		// Reset immediately, before the watcher necessarily runs.
		c.writeDeadline.Set(time.Time{})
		next := c.applicationWriteContext()
		select {
		case <-old.Done():
		case <-time.After(time.Second):
			t.Fatal("old generation stranded")
		}
		if old.Err() != context.DeadlineExceeded || next.Err() != nil {
			t.Fatal("deadline generation crossed")
		}
	}
}
