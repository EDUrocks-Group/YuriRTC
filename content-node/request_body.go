package main

import (
	"context"
	"errors"
	"io"
	"sync"
)

const (
	// API payloads are expected to be JSON or modest chat attachments. A hard
	// ceiling prevents one peer from turning the content node into an unbounded
	// upload relay while remaining well above the backend's ordinary JSON limit.
	maxRequestBodyBytes = 16 * 1024 * 1024
	// This queue exactly matches the request-credit window. OnMessage never
	// blocks Pion's ordered read loop, while the browser cannot enqueue more than
	// the globally reserved sixteen frames before the backend consumes a frame.
	requestBodyQueueFrames = 16
	// Across all peers, reserve at most roughly 256 MiB of full-sized upload
	// frames. Smaller frames consume the same conservative reservation.
	maxGlobalQueuedRequestBodyFrames = 2048
)

var (
	errRequestBodyClosed    = errors.New("request body closed")
	errRequestBodyEnded     = errors.New("request body already ended")
	errRequestBodyQueueFull = errors.New("request body ingress queue full")

	globalRequestBodyFrameTokens = filledTokens(maxGlobalQueuedRequestBodyFrames)
)

func reserveGlobalRequestBodyFrames(count int) bool {
	reserved := 0
	for reserved < count {
		select {
		case <-globalRequestBodyFrameTokens:
			reserved++
		default:
			for range reserved {
				globalRequestBodyFrameTokens <- struct{}{}
			}
			return false
		}
	}
	return true
}

func releaseGlobalRequestBodyFrames(count int) {
	for range count {
		globalRequestBodyFrameTokens <- struct{}{}
	}
}

// asyncRequestBody is a bounded, single-consumer ReadCloser. The producer only
// appends a borrowed Pion message payload to a fixed-size ring and signals a
// capacity-one wake channel, so OnMessage cannot block or allocate a channel or
// release guard per frame. The request owns its global reservation until EOF or
// cleanup rather than accounting for frames individually.
type asyncRequestBody struct {
	ctx             context.Context
	onChunkConsumed func()
	onDrained       func()
	drainedOnce     sync.Once

	stateMu  sync.Mutex
	closed   bool
	ended    bool
	chunks   [][]byte
	queueAt  int
	queueLen int
	wake     chan struct{}

	// net/http uses either Read or WriteTo for one body. Serializing both keeps
	// partial-read state correct even if a non-standard caller switches methods.
	readMu     sync.Mutex
	current    []byte
	currentAt  int
	hasCurrent bool
}

func newAsyncRequestBody(
	ctx context.Context,
	onChunkConsumed func(),
	onDrained func(),
) *asyncRequestBody {
	return &asyncRequestBody{
		ctx:             ctx,
		onChunkConsumed: onChunkConsumed,
		onDrained:       onDrained,
		chunks:          make([][]byte, requestBodyQueueFrames),
		wake:            make(chan struct{}, 1),
	}
}

func (b *asyncRequestBody) signal() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

func (b *asyncRequestBody) releaseDrained() {
	b.drainedOnce.Do(func() {
		if b.onDrained != nil {
			b.onDrained()
		}
	})
}

func (b *asyncRequestBody) enqueue(payload []byte) error {
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	if b.closed {
		return errRequestBodyClosed
	}
	if b.ended {
		return errRequestBodyEnded
	}
	if b.queueLen == len(b.chunks) {
		return errRequestBodyQueueFull
	}

	index := (b.queueAt + b.queueLen) % len(b.chunks)
	b.chunks[index] = payload
	b.queueLen++
	b.signal()
	return nil
}

func (b *asyncRequestBody) end() {
	b.stateMu.Lock()
	if !b.closed && !b.ended {
		b.ended = true
		b.signal()
	}
	b.stateMu.Unlock()
}

// awaitCurrent waits until a queued chunk becomes consumer-owned. readMu must
// be held by the caller. A chunk remains current across a short write so credits
// are returned only after every byte in that wire frame reaches the backend.
func (b *asyncRequestBody) awaitCurrent() error {
	for !b.hasCurrent {
		b.stateMu.Lock()
		if b.queueLen != 0 {
			b.current = b.chunks[b.queueAt]
			b.chunks[b.queueAt] = nil
			b.queueAt = (b.queueAt + 1) % len(b.chunks)
			b.queueLen--
			b.currentAt = 0
			b.hasCurrent = true
			b.stateMu.Unlock()
			return nil
		}
		ended := b.ended
		closed := b.closed
		b.stateMu.Unlock()

		if ended {
			b.releaseDrained()
			return io.EOF
		}
		if closed {
			return errRequestBodyClosed
		}
		select {
		case <-b.wake:
		case <-b.ctx.Done():
			return b.ctx.Err()
		}
	}
	return nil
}

func (b *asyncRequestBody) finishCurrent() {
	b.current = nil
	b.currentAt = 0
	b.hasCurrent = false
	if b.onChunkConsumed != nil {
		b.onChunkConsumed()
	}
}

// unlockConsumer transfers cleanup back to Close without making Close wait on
// a backend write. A still-active frame keeps the request's global reservation
// until the writer returns, accurately accounting for the retained payload.
func (b *asyncRequestBody) unlockConsumer() {
	b.unlockConsumerObserved(nil)
}

// unlockConsumerObserved keeps the lock transition testable without adding a
// hook field to every production request body. beforeReadUnlock is nil outside
// deterministic lock-ordering tests.
func (b *asyncRequestBody) unlockConsumerObserved(beforeReadUnlock func()) {
	b.stateMu.Lock()
	closed := b.closed
	if closed {
		b.current = nil
		b.currentAt = 0
		b.hasCurrent = false
	}
	// Keep stateMu through readMu.Unlock. Close therefore either observes this
	// consumer and leaves cleanup here, or acquires readMu after this unlock and
	// performs cleanup itself; there is no gap in which both can decline it.
	if beforeReadUnlock != nil {
		beforeReadUnlock()
	}
	b.readMu.Unlock()
	b.stateMu.Unlock()
	if closed {
		b.releaseDrained()
	}
}

func (b *asyncRequestBody) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	b.readMu.Lock()
	defer b.unlockConsumer()

	for {
		if err := b.awaitCurrent(); err != nil {
			return 0, err
		}
		n := copy(p, b.current[b.currentAt:])
		b.currentAt += n
		if b.currentAt == len(b.current) {
			b.finishCurrent()
		}
		if n != 0 {
			return n, nil
		}
		// A zero-byte body frame still consumes exactly one request credit. Do
		// not return (0, nil), which would permit a caller to busy-loop.
	}
}

// WriteTo lets net/http forward complete YuriRTC request frames directly to
// its connection writer. It avoids io.Copy's intermediate 32 KiB buffer and
// preserves frame-credit accounting across partial or failed writes.
func (b *asyncRequestBody) WriteTo(dst io.Writer) (int64, error) {
	b.readMu.Lock()
	defer b.unlockConsumer()

	var total int64
	for {
		if err := b.ctx.Err(); err != nil {
			return total, err
		}
		if err := b.awaitCurrent(); err != nil {
			if err == io.EOF {
				return total, nil
			}
			return total, err
		}

		remaining := b.current[b.currentAt:]
		if len(remaining) == 0 {
			b.finishCurrent()
			continue
		}
		n, err := dst.Write(remaining)
		if n < 0 || n > len(remaining) {
			return total, errors.New("invalid write count")
		}
		b.currentAt += n
		total += int64(n)
		if b.currentAt == len(b.current) {
			b.finishCurrent()
		}
		if err != nil {
			return total, err
		}
		if n != len(remaining) {
			return total, io.ErrShortWrite
		}
	}
}

func (b *asyncRequestBody) Close() error {
	b.stateMu.Lock()
	if !b.closed {
		b.closed = true
		for b.queueLen != 0 {
			b.chunks[b.queueAt] = nil
			b.queueAt = (b.queueAt + 1) % len(b.chunks)
			b.queueLen--
		}
		b.signal()
	}
	b.stateMu.Unlock()
	// If no consumer owns a current chunk, release retained state immediately.
	// Otherwise unlockConsumer releases it as soon as the in-progress write
	// returns, without making cancellation block behind an arbitrary Writer.
	if b.readMu.TryLock() {
		b.current = nil
		b.currentAt = 0
		b.hasCurrent = false
		b.readMu.Unlock()
		b.releaseDrained()
	}
	return nil
}
