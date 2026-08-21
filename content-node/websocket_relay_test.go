package main

// Relay-path tests for the browser -> upstream writer. The codec tests in
// websocket_test.go pin the wire format; these pin the queueing behavior that
// keeps a lane's frame delivery from ever waiting on an upstream write.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The wake threshold exists to serve waitForBuffer's aggregate predicates. If
// every lane can sit below the threshold while an aggregate limit is still
// exceeded, a paused writer waits for a buffered-amount-low crossing that will
// never come.
func TestLaneBufferedAmountLowThresholdCoversAggregateLimits(t *testing.T) {
	if laneBufferedAmountLowThreshold*transportLaneCount > bulkBufferHighWater {
		t.Fatalf(
			"threshold %d x %d lanes exceeds the bulk high-water mark %d; a bulk waiter could strand",
			laneBufferedAmountLowThreshold, transportLaneCount, bulkBufferHighWater,
		)
	}
	if laneBufferedAmountLowThreshold*transportLaneCount > aggregateBufferHighWater {
		t.Fatalf(
			"threshold %d x %d lanes exceeds the aggregate high-water mark %d; a control waiter could strand",
			laneBufferedAmountLowThreshold, transportLaneCount, aggregateBufferHighWater,
		)
	}
}

func newIdleWebSocketStream() *webSocketStream {
	return &webSocketStream{
		writeRing: make([]queuedWebSocketWrite, maxWebSocketSendQueueFrames+1),
		writeWake: make(chan struct{}, 1),
	}
}

func TestWebSocketWriteQueueBoundsFramesAndBytes(t *testing.T) {
	stream := newIdleWebSocketStream()
	for i := 0; i < maxWebSocketSendQueueFrames; i++ {
		if !stream.enqueueWrite(queuedWebSocketWrite{kind: websocket.MessageText, data: []byte("m")}) {
			t.Fatalf("data item %d rejected below the frame bound", i)
		}
	}
	if stream.enqueueWrite(queuedWebSocketWrite{kind: websocket.MessageText, data: []byte("m")}) {
		t.Fatal("data item past the frame bound was accepted")
	}
	// The spare slot exists so a close always fits behind a full data ring.
	if !stream.enqueueWrite(queuedWebSocketWrite{close: true, code: 1000}) {
		t.Fatal("close item rejected while the data ring was full")
	}
	if !stream.enqueueWrite(queuedWebSocketWrite{kind: websocket.MessageText, data: []byte("late")}) {
		t.Fatal("data after close must be dropped silently, not reported as backlog")
	}
	if stream.writeLen != maxWebSocketSendQueueFrames+1 {
		t.Fatalf("queue length = %d, want %d", stream.writeLen, maxWebSocketSendQueueFrames+1)
	}

	bytesBound := newIdleWebSocketStream()
	half := make([]byte, maxWebSocketSendQueueBytes/2+1)
	if !bytesBound.enqueueWrite(queuedWebSocketWrite{kind: websocket.MessageBinary, data: half}) {
		t.Fatal("first item within the byte bound was rejected")
	}
	if bytesBound.enqueueWrite(queuedWebSocketWrite{kind: websocket.MessageBinary, data: half}) {
		t.Fatal("item past the byte bound was accepted")
	}
}

func TestWebSocketWriteQueueDrainsInOrderAndFreesBytes(t *testing.T) {
	stream := newIdleWebSocketStream()
	for _, text := range []string{"one", "two"} {
		if !stream.enqueueWrite(queuedWebSocketWrite{kind: websocket.MessageText, data: []byte(text)}) {
			t.Fatalf("enqueue %q failed", text)
		}
	}
	if !stream.enqueueWrite(queuedWebSocketWrite{close: true, code: 1000, reason: "done"}) {
		t.Fatal("enqueue close failed")
	}

	for _, want := range []string{"one", "two"} {
		item, ok := stream.nextWrite(context.Background())
		if !ok || item.close || string(item.data) != want {
			t.Fatalf("nextWrite = %q close=%v ok=%v, want %q", item.data, item.close, ok, want)
		}
	}
	item, ok := stream.nextWrite(context.Background())
	if !ok || !item.close || item.code != 1000 || item.reason != "done" {
		t.Fatalf("final item = %+v ok=%v, want the browser's close", item, ok)
	}
	if stream.writeLen != 0 || stream.writeBytes != 0 {
		t.Fatalf("drained queue retains len=%d bytes=%d", stream.writeLen, stream.writeBytes)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := stream.nextWrite(cancelled); ok {
		t.Fatal("nextWrite on an empty queue must end with its context")
	}
}

// responseCreditWindow.grant silently clamps at maxResponseCredits, so a
// websocket window above it would lose replenishment credits rather than fail
// loudly. The protocol keeps the two equal; this pins the safe relationship.
func TestWebSocketCreditWindowFitsResponseWindow(t *testing.T) {
	if uint32(maxWebSocketCredits) > maxResponseCredits {
		t.Fatalf(
			"maxWebSocketCredits %d exceeds maxResponseCredits %d; grant() would clamp",
			maxWebSocketCredits, maxResponseCredits,
		)
	}
}

// The 64-credit window bounds messages, not bytes, so the pump must respect
// the shared association watermarks the way response bodies do. A pump that
// ignored them could queue 8 MiB of socket data on one lane.
func TestWebSocketPumpWaitsForAssociationDrain(t *testing.T) {
	upstreamURL := startPushingWebSocketUpstream(t, "pumped")
	dialCtx, cancelDial := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelDial()
	conn, response, err := websocket.Dial(dialCtx, upstreamURL+"/apiv2/sock", nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial upstream: %v", err)
	}
	defer conn.CloseNow()

	session := NewPeerSession(nil, nil)
	defer session.Close()
	var buffered atomic.Uint64
	buffered.Store(aggregateBufferHighWater + 1)
	frames := make(chan []byte, 8)
	lane := &sessionLane{
		id:   controlLaneID,
		peer: session,
		sendOverride: func(frame []byte) error {
			frames <- append([]byte(nil), frame...)
			return nil
		},
		bufferedAmountOverride: func() uint64 { return buffered.Load() },
	}
	session.lanes[controlLaneID].Store(lane)

	const socketID = 43
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := newIdleWebSocketStream()
	stream.id = socketID
	stream.lane = lane
	stream.cancel = cancel
	stream.credits = newResponseCreditWindow(4)
	stream.conn.Store(conn)
	session.mu.Lock()
	session.sockets = map[uint32]*webSocketStream{socketID: stream}
	session.mu.Unlock()

	go session.pumpWebSocket(ctx, stream, conn)

	select {
	case <-frames:
		t.Fatal("pump sent a frame while the association was above high water")
	case <-time.After(200 * time.Millisecond):
	}

	buffered.Store(0)
	session.signalBufferChanged()

	deadline := time.After(5 * time.Second)
	for {
		select {
		case raw := <-frames:
			frame, err := DecodeFrame(raw)
			if err != nil {
				t.Fatalf("undecodable frame after drain: %v", err)
			}
			if frame.Type != FrameWsData {
				continue
			}
			kind, data, err := decodeWebSocketData(frame.Payload)
			if err != nil || kind != WebSocketText || string(data) != "pumped" {
				t.Fatalf("relayed message = kind %d %q err %v", kind, data, err)
			}
			return
		case <-deadline:
			t.Fatal("pump never delivered the message after the association drained")
		}
	}
}

// startPushingWebSocketUpstream accepts one socket and immediately sends the
// given message toward the node, then holds the socket open.
func startPushingWebSocketUpstream(t *testing.T, message string) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		if err := conn.Write(r.Context(), websocket.MessageText, []byte(message)); err != nil {
			return
		}
		_, _, _ = conn.Read(r.Context())
	}))
	t.Cleanup(server.Close)
	return "ws://" + strings.TrimPrefix(server.URL, "http://")
}

type upstreamRecorder struct {
	mu          sync.Mutex
	messages    []string
	closeStatus websocket.StatusCode
	closed      chan struct{}
}

func startWebSocketUpstream(t *testing.T) (string, *upstreamRecorder) {
	t.Helper()
	recorder := &upstreamRecorder{closed: make(chan struct{})}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			_, data, err := conn.Read(r.Context())
			if err != nil {
				recorder.mu.Lock()
				recorder.closeStatus = websocket.CloseStatus(err)
				recorder.mu.Unlock()
				close(recorder.closed)
				return
			}
			recorder.mu.Lock()
			recorder.messages = append(recorder.messages, string(data))
			recorder.mu.Unlock()
		}
	}))
	t.Cleanup(server.Close)
	return "ws://" + strings.TrimPrefix(server.URL, "http://"), recorder
}

func awaitRelayFrame(t *testing.T, frames <-chan []byte, want FrameType) Frame {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case raw := <-frames:
			frame, err := DecodeFrame(raw)
			if err != nil {
				t.Fatalf("lane received an undecodable frame: %v", err)
			}
			if frame.Type == want {
				return frame
			}
		case <-deadline:
			t.Fatalf("timed out waiting for frame type %d", want)
		}
	}
}

// The full relay path: WsOpen dials, WsData items reach the upstream in the
// order the browser sent them, and a WsClose queued behind them closes the
// upstream only after the last message arrived.
func TestWebSocketRelayDeliversDataBeforeClose(t *testing.T) {
	upstreamURL, recorder := startWebSocketUpstream(t)
	session := NewPeerSession(&Handler{WebSocketURL: upstreamURL}, nil)
	defer session.Close()

	frames := make(chan []byte, 64)
	lane := &sessionLane{id: controlLaneID, peer: session, sendOverride: func(frame []byte) error {
		frames <- append([]byte(nil), frame...)
		return nil
	}}
	session.lanes[controlLaneID].Store(lane)

	const socketID = 41
	open, err := EncodeJSONFrame(FrameWsOpen, socketID, WebSocketOpen{
		Version: protocolVersion, URL: "/apiv2/sock", Protocols: nil, InitialCredits: maxWebSocketCredits,
	})
	if err != nil {
		t.Fatalf("encode open: %v", err)
	}
	session.OnMessage(lane, open)
	awaitRelayFrame(t, frames, FrameWsOpened)

	for _, text := range []string{"first", "second", "third"} {
		payload, err := encodeWebSocketData(WebSocketText, []byte(text))
		if err != nil {
			t.Fatalf("encode data: %v", err)
		}
		frame, err := EncodeFrame(FrameWsData, socketID, payload)
		if err != nil {
			t.Fatalf("frame data: %v", err)
		}
		session.OnMessage(lane, frame)
	}
	closePayload, err := encodeWebSocketClose(1000, "done")
	if err != nil {
		t.Fatalf("encode close: %v", err)
	}
	closeFrame, err := EncodeFrame(FrameWsClose, socketID, closePayload)
	if err != nil {
		t.Fatalf("frame close: %v", err)
	}
	session.OnMessage(lane, closeFrame)

	select {
	case <-recorder.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream never observed the close")
	}
	recorder.mu.Lock()
	messages := append([]string(nil), recorder.messages...)
	closeStatus := recorder.closeStatus
	recorder.mu.Unlock()
	if strings.Join(messages, ",") != "first,second,third" {
		t.Fatalf("upstream received %q, want all three messages before the close", messages)
	}
	if closeStatus != websocket.StatusNormalClosure {
		t.Fatalf("upstream close status = %d, want %d", closeStatus, websocket.StatusNormalClosure)
	}

	echoed := awaitRelayFrame(t, frames, FrameWsClose)
	code, _, err := decodeWebSocketClose(echoed.Payload)
	if err != nil || code != 1000 {
		t.Fatalf("browser close echo = code %d err %v, want 1000", code, err)
	}
}

// A stalled upstream must cost one bounded ring and then the socket, never the
// lane. The writer is deliberately not started, standing in for an upstream
// that stopped consuming.
func TestWebSocketRelayBacklogClosesTheSocket(t *testing.T) {
	upstreamURL, _ := startWebSocketUpstream(t)
	dialCtx, cancelDial := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelDial()
	conn, response, err := websocket.Dial(dialCtx, upstreamURL+"/apiv2/sock", nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial upstream: %v", err)
	}
	defer conn.CloseNow()

	session := NewPeerSession(nil, nil)
	defer session.Close()
	frames := make(chan []byte, 64)
	lane := &sessionLane{id: controlLaneID, peer: session, sendOverride: func(frame []byte) error {
		frames <- append([]byte(nil), frame...)
		return nil
	}}
	session.lanes[controlLaneID].Store(lane)

	const socketID = 42
	_, cancel := context.WithCancel(context.Background())
	stream := newIdleWebSocketStream()
	stream.id = socketID
	stream.lane = lane
	stream.cancel = cancel
	stream.credits = newResponseCreditWindow(1)
	stream.conn.Store(conn)
	session.mu.Lock()
	session.sockets = map[uint32]*webSocketStream{socketID: stream}
	session.mu.Unlock()

	payload, err := encodeWebSocketData(WebSocketText, []byte("x"))
	if err != nil {
		t.Fatalf("encode data: %v", err)
	}
	frame, err := EncodeFrame(FrameWsData, socketID, payload)
	if err != nil {
		t.Fatalf("frame data: %v", err)
	}
	for i := 0; i < maxWebSocketSendQueueFrames; i++ {
		session.OnMessage(lane, frame)
	}
	if session.socket(socketID) == nil {
		t.Fatal("socket closed before the ring was over-filled")
	}
	session.OnMessage(lane, frame)

	echoed := awaitRelayFrame(t, frames, FrameWsClose)
	code, reason, err := decodeWebSocketClose(echoed.Payload)
	if err != nil || code != wsCloseGoingAway || reason != "websocket backlog" {
		t.Fatalf("close echo = code %d reason %q err %v, want %d %q", code, reason, err, wsCloseGoingAway, "websocket backlog")
	}
	if session.socket(socketID) != nil {
		t.Fatal("backlogged socket was not forgotten")
	}
}
