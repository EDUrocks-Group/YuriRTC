package main

import (
	"bytes"
	"context"
	"io"
	"sync"
	"testing"
	"time"
)

var benchmarkByteSink byte

type framingBenchmarkSender struct {
	frame []byte
}

func (s *framingBenchmarkSender) SendHead(uint32, ResponseHead) error { return nil }
func (s *framingBenchmarkSender) SendEnd(uint32) error                { return nil }
func (s *framingBenchmarkSender) SendBody(_ context.Context, id uint32, payload []byte) error {
	frame, err := encodeFrameInto(s.frame, FrameResBody, id, payload)
	if err == nil && len(frame) != 0 {
		benchmarkByteSink ^= frame[len(frame)-1]
	}
	return err
}

func BenchmarkResponseFraming(b *testing.B) {
	const bodyBytes = 8 * 1024 * 1024
	body := bytes.Repeat([]byte("y"), bodyBytes)

	b.Run("v3-128KiB-direct-frame-read", func(b *testing.B) {
		reader := bytes.NewReader(body)
		frameBuffer := make([]byte, maxFrameBytes)
		b.SetBytes(bodyBytes)
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			reader.Reset(body)
			remaining := bodyBytes
			for remaining > 0 {
				readSize := min(remaining, maxPayloadBytes)
				n, err := reader.Read(frameBuffer[headerBytes : headerBytes+readSize])
				if n > 0 {
					frame, encodeErr := encodeFrameInto(
						frameBuffer, FrameResBody, 1, frameBuffer[headerBytes:headerBytes+n],
					)
					if encodeErr != nil {
						b.Fatal(encodeErr)
					}
					benchmarkByteSink ^= frame[len(frame)-1]
					remaining -= n
				}
				if err != nil && err != io.EOF {
					b.Fatal(err)
				}
			}
		}
	})
}

// Models a browser waterfall over a path where each frame has a small amount
// of asynchronous transport latency. The old scheduler admitted one large
// response; v3 admits one per bulk lane. This benchmark isolates scheduler
// wall time rather than claiming to model a specific production bandwidth.
func BenchmarkLargeAssetWaterfallScheduler(b *testing.B) {
	const (
		assets          = 9
		framesPerAsset  = 8
		bytesPerAsset   = framesPerAsset * maxPayloadBytes
		frameCompletion = 200 * time.Microsecond
	)

	for _, test := range []struct {
		name  string
		slots int
	}{
		{name: "serialized-single-slot", slots: 1},
		{name: "three-v3-bulk-lanes", slots: maxConcurrentBulkResponses},
	} {
		b.Run(test.name, func(b *testing.B) {
			b.SetBytes(assets * bytesPerAsset)
			for range b.N {
				slots := make(chan struct{}, test.slots)
				var workers sync.WaitGroup
				workers.Add(assets)
				for range assets {
					go func() {
						defer workers.Done()
						slots <- struct{}{}
						defer func() { <-slots }()
						for range framesPerAsset {
							time.Sleep(frameCompletion)
						}
					}()
				}
				workers.Wait()
			}
		})
	}
}

// BenchmarkRequestBodyFlowControl measures the complete bounded v3
// producer/consumer path, including initial and batched ReqCredit frames.
func BenchmarkRequestBodyFlowControl(b *testing.B) {
	const (
		framesPerUpload = 128
		payloadBytes    = 32 * 1024
	)
	payload := bytes.Repeat([]byte("u"), payloadBytes)
	readBuffer := make([]byte, payloadBytes)

	b.Run("v3-credit-window", func(b *testing.B) {
		b.SetBytes(framesPerUpload * payloadBytes)
		b.ReportAllocs()
		for range b.N {
			ctx, cancel := context.WithCancel(context.Background())
			session := NewPeerSession(nil, nil)
			lane := &sessionLane{
				id:   controlLaneID,
				peer: session,
				sendOverride: func(frame []byte) error {
					benchmarkByteSink ^= frame[len(frame)-1]
					return nil
				},
			}
			state := &requestState{
				id:                      1,
				ctx:                     ctx,
				cancel:                  cancel,
				lane:                    lane,
				head:                    RequestHead{Version: protocolVersion, HasBody: true},
				requestCreditsAvailable: maxRequestCredits,
			}
			state.body = newAsyncRequestBody(
				ctx,
				func() { session.requestBodyChunkConsumed(state) },
				nil,
			)
			if err := session.sendRequestCredits(state, maxRequestCredits); err != nil {
				b.Fatal(err)
			}

			for sent := 0; sent < framesPerUpload; {
				state.bodyMu.Lock()
				window := int(state.requestCreditsAvailable)
				state.bodyMu.Unlock()
				window = min(window, framesPerUpload-sent)
				if window == 0 {
					b.Fatal("v3 upload stalled without returned credits")
				}
				for range window {
					if err := session.enqueueRequestBody(state, payload); err != nil {
						b.Fatal(err)
					}
				}
				for range window {
					n, err := state.body.Read(readBuffer)
					if err != nil || n != len(payload) {
						b.Fatalf("read %d bytes: %v", n, err)
					}
				}
				sent += window
			}
			session.endRequestBody(state)
			if err := state.body.Close(); err != nil {
				b.Fatal(err)
			}
			cancel()
		}
	})
}

func BenchmarkAsyncRequestBodyForwarding(b *testing.B) {
	payload := bytes.Repeat([]byte("u"), 32*1024)
	readBuffer := make([]byte, len(payload))
	const frames = requestBodyQueueFrames

	for _, test := range []struct {
		name    string
		forward func(*asyncRequestBody) error
	}{
		{
			name: "Read",
			forward: func(body *asyncRequestBody) error {
				for range frames {
					if _, err := io.ReadFull(body, readBuffer); err != nil {
						return err
					}
				}
				return nil
			},
		},
		{
			name: "WriteTo",
			forward: func(body *asyncRequestBody) error {
				_, err := body.WriteTo(io.Discard)
				return err
			},
		},
	} {
		b.Run(test.name, func(b *testing.B) {
			b.SetBytes(int64(frames * len(payload)))
			b.ReportAllocs()
			for range b.N {
				body := newAsyncRequestBody(context.Background(), nil, nil)
				for range frames {
					if err := body.enqueue(payload); err != nil {
						b.Fatal(err)
					}
				}
				body.end()
				if err := test.forward(body); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
