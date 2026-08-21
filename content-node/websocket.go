package main

// WebSocket relay.
//
// A service worker never sees a websocket handshake, so a page running over the
// carrier cannot reach one by the route everything else takes: there is no
// fetch to intercept. Sockets are therefore opened explicitly by the page and
// carried here, on a requestId of their own, with frames flowing both ways for
// as long as the socket is open.
//
// The node will not dial anywhere it is told to. A socket is only opened to the
// one configured upstream, and only for a path under the API prefix -- the same
// boundary the HTTP side keeps. Without that, a page on the carrier could ask
// the node to connect to arbitrary hosts, which is precisely the capability the
// node is not supposed to hand out.
//
// Each open socket runs two goroutines: a pump reading the upstream toward the
// browser, and a writer draining the bounded browser -> upstream ring. The ring
// exists so the lane's frame-delivery goroutine never blocks on an upstream
// write; see writeWebSocket.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	// A handshake to a loopback upstream either completes quickly or is not
	// going to.
	webSocketDialTimeout = 10 * time.Second
	// Sockets a single peer may hold open at once. A browsing session needs one;
	// the ceiling is for a page that leaks them.
	maxWebSocketsPerPeer = 8
	// Bounds a WsOpen payload before it is parsed.
	maxWebSocketOpenBytes = 4 * 1024
	// Browser -> upstream messages queued while the upstream write is busy.
	// OnMessage must never wait on an upstream write: Pion delivers a lane's
	// frames from one goroutine, so a stalled write would freeze every request,
	// body frame, and credit on that lane for up to webSocketWriteTimeout. The
	// upstream is loopback, so this queue stays near empty unless the upstream
	// itself has stalled -- at which point closing the socket beats letting each
	// one retain an unbounded backlog. The byte bound keeps eight full-size
	// frames; the frame bound keeps a burst of small messages from growing the
	// ring unboundedly ahead of the byte check.
	maxWebSocketSendQueueFrames = 16
	maxWebSocketSendQueueBytes  = 1024 * 1024
)

type webSocketStream struct {
	id   uint32
	lane *sessionLane
	// conn is set once by the dial goroutine and read by OnMessage handling,
	// the pumps, and peer teardown, so the handoff must be atomic.
	conn   atomic.Pointer[websocket.Conn]
	cancel context.CancelFunc

	// Frames the node may still send toward the browser. Replenished by
	// FrameCredit exactly as a response body's window is.
	credits *responseCreditWindow

	// Outbound browser -> upstream ring, drained by one writer goroutine per
	// socket. Payloads are retained views of Pion-owned message buffers, the
	// same contract the request-body queue relies on.
	writeMu      sync.Mutex
	writeRing    []queuedWebSocketWrite
	writeAt      int
	writeLen     int
	writeBytes   int
	writeClosing bool
	writeWake    chan struct{}

	closeOnce sync.Once
}

type queuedWebSocketWrite struct {
	kind websocket.MessageType
	data []byte
	// close marks the item queued by a browser WsClose frame. The writer
	// executes it only after every message queued ahead of it has reached the
	// upstream, preserving the wire order the browser sent.
	close  bool
	code   int
	reason string
}

// enqueueWrite queues one outbound item. A close item always fits (the ring
// keeps one spare slot beyond the data bound) and marks the queue closing, so
// data arriving after a close is dropped the way frames for a forgotten socket
// are. It reports false only when a data item exceeds the queue bounds.
func (stream *webSocketStream) enqueueWrite(item queuedWebSocketWrite) bool {
	stream.writeMu.Lock()
	if stream.writeClosing {
		stream.writeMu.Unlock()
		return true
	}
	if item.close {
		stream.writeClosing = true
	} else if stream.writeLen >= maxWebSocketSendQueueFrames ||
		stream.writeBytes+len(item.data) > maxWebSocketSendQueueBytes {
		stream.writeMu.Unlock()
		return false
	}
	index := (stream.writeAt + stream.writeLen) % len(stream.writeRing)
	stream.writeRing[index] = item
	stream.writeLen++
	stream.writeBytes += len(item.data)
	stream.writeMu.Unlock()
	select {
	case stream.writeWake <- struct{}{}:
	default:
	}
	return true
}

// nextWrite blocks until an item is queued or the socket's context ends.
func (stream *webSocketStream) nextWrite(ctx context.Context) (queuedWebSocketWrite, bool) {
	for {
		stream.writeMu.Lock()
		if stream.writeLen != 0 {
			item := stream.writeRing[stream.writeAt]
			stream.writeRing[stream.writeAt] = queuedWebSocketWrite{}
			stream.writeAt = (stream.writeAt + 1) % len(stream.writeRing)
			stream.writeLen--
			stream.writeBytes -= len(item.data)
			stream.writeMu.Unlock()
			return item, true
		}
		stream.writeMu.Unlock()
		select {
		case <-ctx.Done():
			return queuedWebSocketWrite{}, false
		case <-stream.writeWake:
		}
	}
}

// beginWebSocket dials the upstream and, on success, starts pumping.
func (s *PeerSession) beginWebSocket(lane *sessionLane, id uint32, open WebSocketOpen) {
	if open.Version != protocolVersion {
		s.rejectProtocol(lane, id, "unsupported protocol version", "UNSUPPORTED_PROTOCOL")
		return
	}
	if open.InitialCredits < 1 || open.InitialCredits > maxWebSocketCredits {
		s.rejectProtocol(lane, id, "invalid websocket credit window", "BAD_REQUEST")
		return
	}

	target, err := s.handler.webSocketTarget(open.URL)
	if err != nil {
		s.rejectProtocol(lane, id, err.Error(), "BAD_REQUEST")
		return
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if _, taken := s.requests[id]; taken {
		s.mu.Unlock()
		s.noteProtocolViolation()
		return
	}
	if _, taken := s.sockets[id]; taken {
		s.mu.Unlock()
		s.noteProtocolViolation()
		return
	}
	if len(s.sockets) >= maxWebSocketsPerPeer {
		s.mu.Unlock()
		s.rejectProtocol(lane, id, "too many open websockets", "CAPACITY")
		return
	}
	if s.sockets == nil {
		s.sockets = make(map[uint32]*webSocketStream)
	}
	ctx, cancel := context.WithCancel(context.Background())
	stream := &webSocketStream{
		id:      id,
		lane:    lane,
		cancel:  cancel,
		credits: newResponseCreditWindow(uint32(open.InitialCredits)),
		// One spare slot so a browser close always queues behind full data.
		writeRing: make([]queuedWebSocketWrite, maxWebSocketSendQueueFrames+1),
		writeWake: make(chan struct{}, 1),
	}
	s.sockets[id] = stream
	s.mu.Unlock()

	go s.dialWebSocket(ctx, stream, target, open.Protocols)
}

func (s *PeerSession) dialWebSocket(
	ctx context.Context,
	stream *webSocketStream,
	target string,
	protocols []string,
) {
	dialCtx, cancelDial := context.WithTimeout(ctx, webSocketDialTimeout)
	conn, response, err := websocket.Dial(dialCtx, target, &websocket.DialOptions{
		Subprotocols: protocols,
		// The upstream is loopback and speaks no compression; negotiating it
		// would only add CPU on both ends of a link that is already local.
		CompressionMode: websocket.CompressionDisabled,
	})
	cancelDial()
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		// The upstream's own words are not echoed back to the browser: a failed
		// dial can carry host detail, and the page only needs to know it did not
		// open. It is worth recording here, where the destination is always the
		// one configured upstream and never a visitor's.
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		log.Printf("websocket dial to the configured upstream failed: status=%d err=%v", status, err)
		s.failWebSocket(stream, "websocket upstream refused the connection")
		return
	}

	// Wisp moves whole proxied responses; the default read limit is far too
	// small for that and would close the socket mid-transfer.
	conn.SetReadLimit(int64(maxWebSocketMessageBytes))
	stream.conn.Store(conn)

	opened, err := json.Marshal(WebSocketOpened{Protocol: conn.Subprotocol()})
	if err != nil {
		s.failWebSocket(stream, "websocket handshake could not be reported")
		return
	}
	frame, err := EncodeFrame(FrameWsOpened, stream.id, opened)
	if err != nil {
		s.failWebSocket(stream, "websocket handshake could not be reported")
		return
	}
	if err := stream.lane.send(frame); err != nil {
		s.closeWebSocket(stream, wsCloseGoingAway, "carrier send failed")
		return
	}

	go s.writeWebSocketLoop(ctx, stream, conn)
	s.pumpWebSocket(ctx, stream, conn)
}

// writeWebSocketLoop carries queued browser messages upstream. It is the only
// goroutine that writes to conn, so a slow upstream stalls this loop and the
// bounded ring rather than the lane's frame delivery.
func (s *PeerSession) writeWebSocketLoop(ctx context.Context, stream *webSocketStream, conn *websocket.Conn) {
	for {
		item, ok := stream.nextWrite(ctx)
		if !ok {
			return
		}
		if item.close {
			s.closeWebSocketHandshakeFirst(stream, conn, item.code, item.reason)
			return
		}
		writeCtx, cancel := context.WithTimeout(ctx, webSocketWriteTimeout)
		err := conn.Write(writeCtx, item.kind, item.data)
		cancel()
		if err != nil {
			s.closeWebSocket(stream, wsCloseGoingAway, "")
			return
		}
	}
}

// pumpWebSocket carries upstream messages to the browser until either end stops.
func (s *PeerSession) pumpWebSocket(ctx context.Context, stream *webSocketStream, conn *websocket.Conn) {
	for {
		if err := stream.credits.take(ctx); err != nil {
			s.closeWebSocket(stream, wsCloseGoingAway, "")
			return
		}

		kind, data, err := conn.Read(ctx)
		if err != nil {
			code := websocket.CloseStatus(err)
			if code == -1 {
				// No close frame: the socket dropped. 1001 rather than 1006,
				// which the browser synthesises locally and must not receive.
				s.closeWebSocket(stream, wsCloseGoingAway, "")
				return
			}
			s.closeWebSocket(stream, int(code), "")
			return
		}

		dataKind := WebSocketBinary
		if kind == websocket.MessageText {
			dataKind = WebSocketText
		}
		payload, err := encodeWebSocketData(dataKind, data)
		if err != nil {
			s.closeWebSocket(stream, wsCloseGoingAway, "message too large for the carrier")
			return
		}
		frame, err := EncodeFrame(FrameWsData, stream.id, payload)
		if err != nil {
			s.closeWebSocket(stream, wsCloseGoingAway, "message too large for the carrier")
			return
		}
		// The credit window bounds messages, not bytes: at the 64-credit window
		// a message-dense socket could otherwise queue 8 MiB on one lane. Wait
		// on the shared association watermarks like every response body does,
		// holding at most this one already-read message while paused.
		if err := s.waitForBuffer(ctx, stream.lane); err != nil {
			s.closeWebSocket(stream, wsCloseGoingAway, "")
			return
		}
		if err := stream.lane.send(frame); err != nil {
			s.closeWebSocket(stream, wsCloseGoingAway, "carrier send failed")
			return
		}
	}
}

// writeWebSocket queues one browser message for the upstream writer. It runs
// on the lane's frame-delivery goroutine, so it must never wait on the
// upstream itself.
func (s *PeerSession) writeWebSocket(id uint32, lane *sessionLane, payload []byte) {
	stream := s.socketOnLane(id, lane)
	if stream == nil || stream.conn.Load() == nil {
		// A socket the browser still thinks is open may already be gone here;
		// frames already on the ordered lane are expected, not a violation.
		return
	}
	kind, data, err := decodeWebSocketData(payload)
	if err != nil {
		s.noteProtocolViolation()
		s.closeWebSocket(stream, wsCloseGoingAway, "malformed message")
		return
	}
	messageType := websocket.MessageBinary
	if kind == WebSocketText {
		messageType = websocket.MessageText
	}
	if !stream.enqueueWrite(queuedWebSocketWrite{kind: messageType, data: data}) {
		// The loader sends socket data ungated, so a full ring means the
		// upstream has stalled behind a peer that kept transmitting. Closing
		// sheds the backlog instead of retaining it per socket.
		s.closeWebSocket(stream, wsCloseGoingAway, "websocket backlog")
	}
}

// requestWebSocketClose honours a browser-initiated close after every message
// the browser queued ahead of it has reached the upstream. A socket that has
// not finished dialling closes immediately, exactly as it did before the
// writer existed.
func (s *PeerSession) requestWebSocketClose(stream *webSocketStream, code int, reason string) {
	if stream.conn.Load() == nil {
		s.closeWebSocket(stream, code, reason)
		return
	}
	stream.enqueueWrite(queuedWebSocketWrite{close: true, code: code, reason: reason})
}

const webSocketWriteTimeout = 30 * time.Second

func (s *PeerSession) socketOnLane(id uint32, lane *sessionLane) *webSocketStream {
	s.mu.Lock()
	defer s.mu.Unlock()
	stream := s.sockets[id]
	if stream == nil {
		return nil
	}
	if stream.lane != lane {
		// Active ids are peer-global; frames arriving on another lane indicate a
		// broken or malicious router.
		return nil
	}
	return stream
}

func (s *PeerSession) socket(id uint32) *webSocketStream {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sockets[id]
}

// failWebSocket reports a socket that never opened, then forgets it.
func (s *PeerSession) failWebSocket(stream *webSocketStream, message string) {
	stream.closeOnce.Do(func() {
		s.forgetWebSocket(stream)
		stream.cancel()
		s.sendBoundedError(stream.lane, stream.id, message, "WEBSOCKET_FAILED")
	})
}

// closeWebSocket tears one down from either side, telling the browser once.
// Cancelling first aborts any in-flight pump Read, so the upstream may see an
// abrupt teardown; that is correct for every path that reaches here, because
// the socket is already broken or its owner is going away.
func (s *PeerSession) closeWebSocket(stream *webSocketStream, code int, reason string) {
	stream.closeOnce.Do(func() {
		s.forgetWebSocket(stream)
		stream.cancel()

		if conn := stream.conn.Load(); conn != nil {
			_ = conn.Close(upstreamCloseStatus(code), truncateCloseReason(reason))
		}

		s.reportWebSocketClose(stream, code, reason)
	})
}

// closeWebSocketHandshakeFirst is the writer's clean-close path. It completes
// the upstream close handshake before cancelling the pump: aborting the pump's
// in-flight Read tears the connection down mid-handshake, which would turn the
// browser's close code into an abrupt drop from the upstream's point of view.
// Holding closeOnce for the whole sequence also keeps the pump's concurrent
// close report (its Read fails once the handshake completes) from echoing a
// different code to the browser than the one the browser sent.
func (s *PeerSession) closeWebSocketHandshakeFirst(
	stream *webSocketStream,
	conn *websocket.Conn,
	code int,
	reason string,
) {
	stream.closeOnce.Do(func() {
		s.forgetWebSocket(stream)
		_ = conn.Close(upstreamCloseStatus(code), truncateCloseReason(reason))
		stream.cancel()
		s.reportWebSocketClose(stream, code, reason)
	})
}

// reportWebSocketClose echoes one WsClose to the browser.
func (s *PeerSession) reportWebSocketClose(stream *webSocketStream, code int, reason string) {
	payload, err := encodeWebSocketClose(sanitizeCloseCode(code), truncateCloseReason(reason))
	if err != nil {
		payload, _ = encodeWebSocketClose(wsCloseGoingAway, "")
	}
	if frame, encodeErr := EncodeFrame(FrameWsClose, stream.id, payload); encodeErr == nil {
		_ = stream.lane.send(frame)
	}
}

func (s *PeerSession) forgetWebSocket(stream *webSocketStream) {
	s.mu.Lock()
	if s.sockets[stream.id] == stream {
		delete(s.sockets, stream.id)
	}
	s.mu.Unlock()
	stream.credits.signal()
}

// closeAllWebSockets tears every socket down when the peer goes away.
func (s *PeerSession) closeAllWebSockets() {
	s.mu.Lock()
	streams := make([]*webSocketStream, 0, len(s.sockets))
	for _, stream := range s.sockets {
		streams = append(streams, stream)
	}
	s.mu.Unlock()

	for _, stream := range streams {
		s.closeWebSocket(stream, wsCloseCarrierLost, "")
	}
}

// upstreamCloseStatus maps a wire close code onto one the upstream library
// will accept, falling back to going-away for anything out of range.
func upstreamCloseStatus(code int) websocket.StatusCode {
	if code >= 1000 && code <= 0xffff {
		return websocket.StatusCode(code)
	}
	return websocket.StatusGoingAway
}

// sanitizeCloseCode keeps codes the browser must synthesise locally off the wire.
func sanitizeCloseCode(code int) int {
	if code < 1000 || code > 0xffff || code == 1005 || code == 1006 {
		return wsCloseGoingAway
	}
	return code
}

func truncateCloseReason(reason string) string {
	if len(reason) <= maxWebSocketCloseReason {
		return reason
	}
	return reason[:maxWebSocketCloseReason]
}

// webSocketTarget maps an origin-relative URL onto the one upstream this node
// is willing to open a socket to.
func (h *Handler) webSocketTarget(rawURL string) (string, error) {
	if h.WebSocketURL == "" {
		return "", errors.New("websockets are not enabled on this node")
	}
	if !strings.HasPrefix(rawURL, "/") || strings.HasPrefix(rawURL, "//") {
		return "", errors.New("websocket url must be origin-relative")
	}
	path, query := splitPath(rawURL)
	// Same boundary the HTTP side keeps: only the API namespace is proxied, and
	// only to the configured upstream. Nothing here lets the page choose a host.
	if path != apiPrefix && !strings.HasPrefix(path, apiPrefix+"/") {
		return "", errors.New("websocket url is outside the api namespace")
	}
	target := h.WebSocketURL + path
	if query != "" {
		target += "?" + query
	}
	return target, nil
}

// webSocketOpenFromFrame parses and bounds a WsOpen payload.
func webSocketOpenFromFrame(payload []byte) (WebSocketOpen, error) {
	if len(payload) > maxWebSocketOpenBytes {
		return WebSocketOpen{}, fmt.Errorf("websocket open payload too large")
	}
	var open WebSocketOpen
	if err := json.Unmarshal(payload, &open); err != nil {
		return WebSocketOpen{}, errors.New("invalid websocket open")
	}
	if len(open.Protocols) > 8 {
		return WebSocketOpen{}, errors.New("too many websocket subprotocols")
	}
	for _, protocol := range open.Protocols {
		if protocol == "" || len(protocol) > 64 || strings.ContainsAny(protocol, "\r\n,") {
			return WebSocketOpen{}, errors.New("invalid websocket subprotocol")
		}
	}
	return open, nil
}
