// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package dtls

import (
	"context"
	"time"

	"github.com/pion/transport/v4/deadline"
)

// Share one cancelable context per write-deadline generation. Done is stable
// until an expired deadline is reset. A standard embedded context lets netctx
// register cancellation callbacks without spawning a per-packet goroutine.
type applicationWriteContext struct {
	context.Context
	deadline *deadline.Deadline
}

func (c *applicationWriteContext) Deadline() (time.Time, bool) { return c.deadline.Deadline() }
func (c *applicationWriteContext) Err() error                  { return context.Cause(c.Context) }

func (c *Conn) applicationWriteContext() context.Context {
	c.writeContextMu.Lock()
	defer c.writeContextMu.Unlock()
	done := c.writeDeadline.Done()
	if c.writeContext != nil && c.writeContextDeadline == done {
		return c.writeContext
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	c.writeContext = &applicationWriteContext{Context: ctx, deadline: c.writeDeadline}
	c.writeContextDeadline = done
	go func() {
		select {
		case <-c.closed.Done():
			cancel(context.Canceled)
		case <-done:
			cancel(context.DeadlineExceeded)
		}
	}()
	return c.writeContext
}
