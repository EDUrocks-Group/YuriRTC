package main

// Peer-scoped request handling over a fixed YuriRTC v3 data-channel pool.
//
// Lane 0 is reserved for the document shell and interactive/API traffic.
// Lanes 1-3 carry bulk assets. All request IDs are peer-global, responses stay
// on the lane where their request arrived, and all memory/concurrency limits
// are aggregate across the four lanes.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const (
	transportLaneCount = 4
	controlLaneID      = 0
	laneLabelPrefix    = "yuriRTC-v3/"

	// The four lanes share one SCTP association. The aggregate window keeps
	// higher-bandwidth, higher-latency routes busy while retaining one MiB of
	// interactive reserve when all three bulk lanes are saturated.
	aggregateBufferHighWater = 4 * 1024 * 1024
	aggregateBufferLowWater  = 1 * 1024 * 1024
	bulkBufferHighWater      = 3 * 1024 * 1024
	// The per-lane buffered-amount-low callback is the only wakeup waitForBuffer
	// receives, and Pion fires it only when that one lane drains below the
	// threshold. The largest safe value is the smallest aggregate wait limit
	// divided by the lane count: whenever the aggregate exceeds the bulk (or
	// aggregate) high-water mark, at least one lane must sit above this
	// threshold and its eventual downward crossing wakes the waiters. A smaller
	// threshold is also safe but lets the shared send queue drain almost to
	// empty before a paused writer refills it, which under-buffers high
	// bandwidth-delay routes between refills.
	laneBufferedAmountLowThreshold = bulkBufferHighWater / transportLaneCount
	// Terminal frames bypass ordinary waitForBuffer so a rejected request is not
	// left hanging. Once the whole association is already saturated, enqueueing
	// more terminal errors is counterproductive; close the peer instead.
	terminalErrorBufferedAmountCeiling = aggregateBufferHighWater
	// Bulk writers pause early, reserving space for HTML, CSS, API and control
	// responses on lane 0 even during a saturated asset download.

	// Three bulk lanes allow three independent large assets to fill the path.
	// This remains peer-scoped, unlike the former per-channel limiter.
	maxConcurrentBulkResponses = transportLaneCount - 1
	// Requests are admitted as small state objects and dispatched separately.
	// This accommodates image-heavy waterfalls without creating one goroutine per
	// queued request. Only the active subset below may run handlers concurrently.
	// Non-interactive handlers share the same three-lane transfer path as large
	// static bodies. Starting more than three only parks handler goroutines in the
	// bulk limiter, consumes global execution tokens, and prevents a later critical
	// request from reaching the priority queue when a transfer finishes.
	maxAdmittedRequestsPerPeer     = 256
	maxActiveRequestsPerPeer       = 16
	maxActiveNonInteractivePerPeer = maxConcurrentBulkResponses
	maxBodyRequestsPerPeer         = 4

	// At least 20k long-lived API/SSE handlers fit while all transient work stays
	// globally bounded. Non-interactive work has its own lower ceiling so a bulk
	// burst cannot consume the capacity reserved for navigation/chat.
	maxGlobalAdmittedRequests        = 128 * 1024
	maxGlobalActiveRequests          = 32 * 1024
	maxGlobalActiveNonInteractive    = 8 * 1024
	requestBodyIdleTimeout           = 30 * time.Second
	rejectedBodyTombstoneLifetime    = requestBodyIdleTimeout
	maxRejectedBodyTombstonesPerPeer = maxAdmittedRequestsPerPeer
	maxProtocolViolationsPerPeer     = 8
	// Valid overloads receive explicit terminal errors, but a peer may otherwise
	// generate an unbounded number of tiny responses without consuming malformed-
	// frame budget. Thirty-two preserves a useful legitimate retry burst while
	// hard-bounding queued overload responses before the peer is closed.
	maxCapacityErrorSendsPerPeer = 32
	maxRequestHeadBytes          = 16 * 1024
	// Credits are frame counts. 64 frames is just under 8 MiB of logical demand,
	// but channel backpressure independently limits queued application data.
	maxResponseCredits uint32 = 64
	// Websocket frames the node may send before the browser replenishes. One
	// credit is one message regardless of size, so this window is a hard
	// messages-per-round-trip ceiling — and Wisp-style carried sockets move
	// many small messages, which made the former window of 16 the binding
	// throughput limit (~160 messages/second at 100 ms RTT). Byte pressure is
	// bounded independently: the pump waits on the shared association
	// watermarks before each send, so several open sockets cannot queue more
	// than the aggregate high-water mark between them. Must not exceed
	// maxResponseCredits — responseCreditWindow.grant silently clamps there.
	// Old loaders still open with 16; this is only what the node accepts.
	maxWebSocketCredits int = 64
	// V3 request bodies start with a bounded 16-frame window. Credits return in
	// quarter-window batches only after their corresponding chunks are fully read
	// by the backend. Smaller refills keep high-RTT uploads moving while still
	// avoiding one credit frame on the wire for every request-body frame.
	maxRequestCredits      uint32 = requestBodyQueueFrames
	requestCreditBatchSize uint32 = maxRequestCredits / 4
	// An early cleanup may discard only one credited, queue-sized ordered tail.
	// Lane, request ID, lifetime, and per-peer entry bounds apply independently.
	maxRejectedBodyTrailingFrames uint32 = requestBodyQueueFrames
)

var responseFramePool = sync.Pool{
	New: func() any { return make([]byte, maxFrameBytes) },
}

func filledTokens(count int) chan struct{} {
	tokens := make(chan struct{}, count)
	for range count {
		tokens <- struct{}{}
	}
	return tokens
}

var (
	globalRequestAdmissionTokens = filledTokens(maxGlobalAdmittedRequests)
	globalActiveRequestTokens    = filledTokens(maxGlobalActiveRequests)
	globalNonInteractiveTokens   = filledTokens(maxGlobalActiveNonInteractive)
)

// transportStats are deliberately aggregate and lock-free. They feed the
// existing once-per-minute health line without logging request paths, peer IPs,
// or one event per frame.
var transportStats struct {
	activeLanes                  atomic.Int64
	admittedRequests             atomic.Int64
	activeHandlers               atomic.Int64
	activeNonInteractiveHandlers atomic.Int64
	activeBulk                   atomic.Int64
	requestRejects               atomic.Uint64
	invalidChannels              atomic.Uint64
	bodyFrames                   atomic.Uint64
	bodyBytes                    atomic.Uint64
}

type PeerSession struct {
	handler   *Handler
	closePeer func()

	mu             sync.Mutex
	requests       map[uint32]*requestState
	sockets        map[uint32]*webSocketStream
	rejectedBodies map[uint32]rejectedBodyTombstone
	// lanes entries are mutated only under mu, but loaded atomically so the
	// per-frame send path (aggregateBufferedAmount via waitForBuffer) never
	// contends with OnMessage processing for the session mutex.
	lanes                [transportLaneCount]atomic.Pointer[sessionLane]
	closed               bool
	pending              [4][]*requestState
	activeHandlers       int
	activeNonInteractive int
	bodyRequests         int
	protocolViolations   int
	capacityErrorSends   int
	dispatchWake         chan struct{}
	done                 chan struct{}
	dispatchOnce         sync.Once
	closePeerOnce        sync.Once

	bulkSlots chan struct{}

	// A generation channel provides a broadcast wakeup when any lane drains.
	// Each lane's threshold is laneBufferedAmountLowThreshold. Whenever the
	// aggregate exceeds a high-water mark at least one lane must be above that
	// threshold, so callback-only wakeups cannot strand a saturated writer and
	// avoid creating thousands of short-lived timers under load.
	bufferMu      sync.Mutex
	bufferChanged chan struct{}
}

func (s *PeerSession) requestPeerClose() {
	s.closePeerOnce.Do(func() { go s.closePeer() })
}

type sessionLane struct {
	id      int
	channel *webrtc.DataChannel
	peer    *PeerSession
	// sendOverride is used by deterministic unit tests and benchmarks that need
	// to inspect frames without constructing a full SCTP association.
	sendOverride           func([]byte) error
	bufferedAmountOverride func() uint64

	sendMu     sync.Mutex
	bodySendMu sync.Mutex
}

type requestState struct {
	id       uint32
	ctx      context.Context
	cancel   context.CancelFunc
	body     *asyncRequestBody
	credits  *responseCreditWindow
	lane     *sessionLane
	head     RequestHead
	priority uint8
	started  bool

	bodyMu       sync.Mutex
	bodyBytes    int64
	bodyEnded    bool
	bodyTimer    *time.Timer
	bodyDeadline time.Time
	bodyTimedOut bool
	// Available is the number of request-body frames the browser may still send;
	// consumedPending is backend-consumed capacity waiting for the next batched
	// ReqCredit grant. Both are protected by bodyMu.
	requestCreditsAvailable uint32
	requestCreditsPending   uint32
	reservedBodyFrames      int
	bodyReservationOnce     sync.Once
}

type rejectedBodyTombstone struct {
	lane      *sessionLane
	remaining uint32
	expires   time.Time
}

// responseCreditWindow is a request-local counting semaphore. Its capacity-one
// wake channel is reusable across all grants; available remains the source of
// truth, so coalescing wakeups cannot lose credits.
type responseCreditWindow struct {
	mu        sync.Mutex
	available uint32
	wake      chan struct{}
}

func (w *responseCreditWindow) signal() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func newResponseCreditWindow(initial uint32) *responseCreditWindow {
	w := &responseCreditWindow{wake: make(chan struct{}, 1)}
	w.grant(initial)
	return w
}

func (w *responseCreditWindow) grant(count uint32) {
	if count == 0 {
		return
	}
	w.mu.Lock()
	if w.available >= maxResponseCredits {
		w.mu.Unlock()
		return
	}
	if count > maxResponseCredits-w.available {
		count = maxResponseCredits - w.available
	}
	w.available += count
	w.mu.Unlock()
	w.signal()
}

func (w *responseCreditWindow) take(ctx context.Context) error {
	for {
		w.mu.Lock()
		if w.available > 0 {
			w.available--
			more := w.available > 0
			w.mu.Unlock()
			// Pass a coalesced wake to another waiter when one exists. This costs
			// no allocation and is harmless when the current goroutine is the sole
			// consumer because the next take simply drains the stale signal.
			if more {
				w.signal()
			}
			return nil
		}
		w.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-w.wake:
		}
	}
}

func NewPeerSession(handler *Handler, closePeer func()) *PeerSession {
	if closePeer == nil {
		closePeer = func() {}
	}
	return &PeerSession{
		handler:        handler,
		closePeer:      closePeer,
		requests:       make(map[uint32]*requestState),
		rejectedBodies: make(map[uint32]rejectedBodyTombstone),
		bulkSlots:      make(chan struct{}, maxConcurrentBulkResponses),
		bufferChanged:  make(chan struct{}),
		dispatchWake:   make(chan struct{}, 1),
		done:           make(chan struct{}),
	}
}

func parseLaneLabel(label string) (id int, err error) {
	if !strings.HasPrefix(label, laneLabelPrefix) {
		return 0, fmt.Errorf("data channel must use a %q label", laneLabelPrefix)
	}
	id, err = strconv.Atoi(strings.TrimPrefix(label, laneLabelPrefix))
	if err != nil || id < 0 || id >= transportLaneCount || label != laneLabelPrefix+strconv.Itoa(id) {
		return 0, errors.New("invalid YuriRTC v3 lane label")
	}
	return id, nil
}

// Attach accepts exactly one ordered/reliable channel for each lane. A peer is
// closed immediately for every non-v3 label so a stale offer cannot retain an
// otherwise idle Pion connection until the handshake reaper runs.
func (s *PeerSession) Attach(channel *webrtc.DataChannel) error {
	id, err := parseLaneLabel(channel.Label())
	if err != nil {
		transportStats.invalidChannels.Add(1)
		s.requestPeerClose()
		return err
	}
	if !channel.Ordered() || channel.MaxPacketLifeTime() != nil || channel.MaxRetransmits() != nil {
		transportStats.invalidChannels.Add(1)
		s.noteProtocolViolation()
		return errors.New("YuriRTC lanes must be ordered and reliable")
	}

	lane := &sessionLane{id: id, channel: channel, peer: s}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.New("peer session closed")
	}
	if s.lanes[id].Load() != nil {
		s.mu.Unlock()
		transportStats.invalidChannels.Add(1)
		s.noteProtocolViolation()
		return errors.New("duplicate YuriRTC lane")
	}
	s.lanes[id].Store(lane)
	s.mu.Unlock()

	transportStats.activeLanes.Add(1)
	channel.SetBufferedAmountLowThreshold(laneBufferedAmountLowThreshold)
	channel.OnBufferedAmountLow(s.signalBufferChanged)
	channel.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			s.OnMessage(lane, msg.Data)
		} else {
			s.noteProtocolViolation()
		}
	})
	channel.OnClose(func() { s.detachLane(lane) })
	return nil
}

func (s *PeerSession) detachLane(lane *sessionLane) {
	s.mu.Lock()
	if s.lanes[lane.id].Load() != lane {
		s.mu.Unlock()
		return
	}
	s.lanes[lane.id].Store(nil)
	states := make([]*requestState, 0)
	for id, state := range s.requests {
		if state.lane == lane {
			_ = id
			states = append(states, state)
		}
	}
	remaining := 0
	for i := range s.lanes {
		if s.lanes[i].Load() != nil {
			remaining++
		}
	}
	s.mu.Unlock()

	transportStats.activeLanes.Add(-1)
	s.signalBufferChanged()
	for _, state := range states {
		s.cancelRequestState(state.id, state)
	}
	// Lane 0 carries control and reconnection state. A bulk lane may disappear
	// without killing healthy work on the other lanes, but losing control (or
	// every lane) makes the peer unusable.
	if lane.id == controlLaneID || remaining == 0 {
		s.requestPeerClose()
	}
}

// AcquireBulk is aggregate across all four lanes. It is deliberately separate
// from API traffic and small shell assets, which remain responsive while all
// three bulk lanes are occupied.
func (s *PeerSession) AcquireBulk(ctx context.Context) (func(), error) {
	select {
	case s.bulkSlots <- struct{}{}:
		transportStats.activeBulk.Add(1)
		var once sync.Once
		return func() {
			once.Do(func() {
				<-s.bulkSlots
				transportStats.activeBulk.Add(-1)
			})
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *PeerSession) OnMessage(lane *sessionLane, data []byte) {
	// Pion owns message.Data for the callback rather than recycling a shared
	// receive buffer, so upload queues can retain a payload view and avoid a
	// second allocation/copy for every body frame.
	frame, err := decodeFrameView(data)
	if err != nil {
		// Do not echo decoder detail to the browser; it can include attacker-
		// controlled data and adds no recovery value. Repeated malformed traffic
		// closes the peer instead of consuming CPU forever.
		s.noteProtocolViolation()
		return
	}

	switch frame.Type {
	case FrameReq:
		if len(frame.Payload) > maxRequestHeadBytes {
			s.rejectProtocol(lane, frame.RequestID, "request metadata too large", "BAD_REQUEST")
			return
		}
		var head RequestHead
		if err := json.Unmarshal(frame.Payload, &head); err != nil {
			s.rejectProtocol(lane, frame.RequestID, "invalid request", "BAD_REQUEST")
			return
		}
		if err := validateRequestHead(head); err != nil {
			code := "BAD_REQUEST"
			if head.Version != protocolVersion {
				code = "UNSUPPORTED_PROTOCOL"
			}
			s.rejectProtocol(lane, frame.RequestID, err.Error(), code)
			return
		}
		s.begin(lane, frame.RequestID, head)

	case FrameReqBody:
		state := s.requestOnLane(frame.RequestID, lane)
		if state != nil && state.body != nil {
			if err := s.enqueueRequestBody(state, frame.Payload); err != nil {
				// The request may have been cancelled after requestOnLane returned
				// but before bodyMu became available. Its tombstone owns this
				// already-buffered frame, so do not penalize the peer for the race.
				if s.discardRacedRequestBodyError(frame.RequestID, lane, err) {
					return
				}
				code := "REQUEST_BODY_BACKPRESSURE"
				message := "request body arrived too quickly"
				if errors.Is(err, errRequestBodyTooLarge) {
					code = "REQUEST_BODY_TOO_LARGE"
					message = "request body too large"
				} else if errors.Is(err, errRequestBodyCreditExhausted) {
					code = "REQUEST_BODY_CREDIT_EXHAUSTED"
					message = "request body exceeded its credit window"
				}
				s.rejectProtocol(state.lane, frame.RequestID, message, code)
				allowTrailing := errors.Is(err, errRequestBodyTooLarge) ||
					errors.Is(err, errRequestBodyQueueFull) ||
					errors.Is(err, errRequestBodyClosed)
				s.cancelRequestStateWithTrailing(frame.RequestID, state, allowTrailing)
			}
		} else if !s.discardRejectedRequestBody(frame.RequestID, lane, false) {
			s.noteProtocolViolation()
		}

	case FrameReqEnd:
		state := s.requestOnLane(frame.RequestID, lane)
		if state != nil && state.body != nil {
			s.endRequestBody(state)
		} else if !s.discardRejectedRequestBody(frame.RequestID, lane, true) {
			s.noteProtocolViolation()
		}

	case FrameWsOpen:
		open, err := webSocketOpenFromFrame(frame.Payload)
		if err != nil {
			s.rejectProtocol(lane, frame.RequestID, err.Error(), "BAD_REQUEST")
			return
		}
		s.beginWebSocket(lane, frame.RequestID, open)

	case FrameWsData:
		s.writeWebSocket(frame.RequestID, lane, frame.Payload)

	case FrameWsClose:
		code, reason, err := decodeWebSocketClose(frame.Payload)
		if err != nil {
			s.noteProtocolViolation()
			return
		}
		if stream := s.socketOnLane(frame.RequestID, lane); stream != nil {
			// Ordered behind any WsData the browser sent first, so the upstream
			// receives those messages before the close handshake begins.
			s.requestWebSocketClose(stream, code, reason)
		}

	case FrameCredit:
		count, ok := decodeCreditPayload(frame.Payload)
		if !ok || count == 0 {
			s.noteProtocolViolation()
			return
		}
		if stream := s.socketOnLane(frame.RequestID, lane); stream != nil {
			// A socket's window is replenished by the same frame a response
			// body's is; for a socket it simply keeps refilling.
			stream.credits.grant(count)
			return
		}
		state := s.request(frame.RequestID)
		if state == nil {
			// Response consumption and its batched refill message cross the
			// page/service-worker boundary independently. A final refill may arrive
			// after RES_END removed the request; it is harmless and expected.
			return
		}
		if state.lane != lane {
			// Active request IDs are peer-global. Credits arriving on another lane
			// indicate a broken or malicious router and must not alter its window.
			s.noteProtocolViolation()
			return
		}
		if state.credits != nil {
			state.credits.grant(count)
		}

	case FrameCancel:
		if state := s.requestOnLane(frame.RequestID, lane); state != nil {
			// Credits already placed on the ordered SCTP lane can arrive after the
			// cancellation callback. Retain only that bounded authorized tail.
			s.cancelRequestStateWithTrailing(
				frame.RequestID,
				state,
				hasUnfinishedRequestBody(state),
			)
		} else {
			_ = s.discardRejectedRequestBody(frame.RequestID, lane, true)
		}

	default:
		// Response frames are valid on the wire but never valid client -> node.
		s.noteProtocolViolation()
	}
}

var (
	errRequestBodyTooLarge        = errors.New("request body exceeds limit")
	errRequestBodyCreditExhausted = errors.New("request body credit exhausted")
)

func validateRequestHead(head RequestHead) error {
	if head.Version != protocolVersion {
		return fmt.Errorf("YuriRTC protocol v%d required", protocolVersion)
	}
	if head.Method == "" || head.URL == "" {
		return errors.New("request method and URL are required")
	}
	if head.Priority > 3 {
		return errors.New("request priority is outside the supported range")
	}
	if head.InitialCredits == 0 || head.InitialCredits > maxResponseCredits {
		return fmt.Errorf("initialCredits must be between 1 and %d", maxResponseCredits)
	}
	return nil
}

func (s *PeerSession) begin(lane *sessionLane, id uint32, head RequestHead) {
	ctx, cancel := context.WithCancel(context.Background())
	priority := head.Priority

	s.mu.Lock()
	if s.closed || s.lanes[lane.id].Load() != lane {
		s.mu.Unlock()
		cancel()
		return
	}
	if _, exists := s.requests[id]; exists {
		s.mu.Unlock()
		cancel()
		transportStats.requestRejects.Add(1)
		s.rejectProtocol(lane, id, "duplicate request id", "DUPLICATE_REQUEST")
		return
	}
	s.pruneRejectedBodiesLocked(time.Now())
	if _, exists := s.rejectedBodies[id]; exists {
		s.mu.Unlock()
		cancel()
		transportStats.requestRejects.Add(1)
		s.rejectProtocol(lane, id, "request id is still draining", "DUPLICATE_REQUEST")
		return
	}
	if len(s.requests) >= maxAdmittedRequestsPerPeer {
		s.mu.Unlock()
		cancel()
		transportStats.requestRejects.Add(1)
		s.sendCapacityError(lane, id, "too many concurrent requests", "REQUEST_CAPACITY")
		return
	}
	if head.HasBody && s.bodyRequests >= maxBodyRequestsPerPeer {
		s.mu.Unlock()
		cancel()
		transportStats.requestRejects.Add(1)
		s.sendCapacityError(lane, id, "too many request bodies", "REQUEST_BODY_CAPACITY")
		return
	}
	select {
	case <-globalRequestAdmissionTokens:
	default:
		s.mu.Unlock()
		cancel()
		transportStats.requestRejects.Add(1)
		s.sendCapacityError(lane, id, "server request capacity exhausted", "SERVER_BUSY")
		return
	}
	reservedBodyFrames := 0
	if head.HasBody {
		if !reserveGlobalRequestBodyFrames(int(maxRequestCredits)) {
			globalRequestAdmissionTokens <- struct{}{}
			s.mu.Unlock()
			cancel()
			transportStats.requestRejects.Add(1)
			s.sendCapacityError(lane, id, "server request-body capacity exhausted", "SERVER_BUSY")
			return
		}
		reservedBodyFrames = int(maxRequestCredits)
	}
	credits := newResponseCreditWindow(head.InitialCredits)
	state := &requestState{
		id:                 id,
		ctx:                ctx,
		cancel:             cancel,
		credits:            credits,
		lane:               lane,
		head:               head,
		priority:           priority,
		reservedBodyFrames: reservedBodyFrames,
	}
	if head.HasBody {
		state.requestCreditsAvailable = maxRequestCredits
		state.body = newAsyncRequestBody(
			ctx,
			func() { s.requestBodyChunkConsumed(state) },
			func() { s.releaseRequestBodyReservation(state) },
		)
		s.bodyRequests++
	}
	s.requests[id] = state
	s.pending[priority] = append(s.pending[priority], state)
	s.mu.Unlock()
	transportStats.admittedRequests.Add(1)
	if state.body != nil {
		if err := s.sendRequestCredits(state, maxRequestCredits); err != nil {
			s.cancelRequestState(id, state)
			return
		}
		s.armRequestBodyTimer(id, state)
	}
	s.dispatchOnce.Do(func() { go s.dispatchLoop() })
	s.signalDispatch()
}

func (s *PeerSession) requestOnLane(id uint32, lane *sessionLane) *requestState {
	s.mu.Lock()
	state := s.requests[id]
	s.mu.Unlock()
	if state == nil || state.lane != lane {
		return nil
	}
	return state
}

func (s *PeerSession) request(id uint32) *requestState {
	s.mu.Lock()
	state := s.requests[id]
	s.mu.Unlock()
	return state
}

func (s *PeerSession) signalDispatch() {
	select {
	case s.dispatchWake <- struct{}{}:
	default:
	}
}

func (s *PeerSession) nextPendingLocked() *requestState {
	if s.activeHandlers >= maxActiveRequestsPerPeer {
		return nil
	}
	for priority := range s.pending {
		if priority != 0 && s.activeNonInteractive >= maxActiveNonInteractivePerPeer {
			continue
		}
		queue := s.pending[priority]
		for len(queue) != 0 {
			state := queue[0]
			if state.started || s.requests[state.id] != state {
				queue = queue[1:]
				continue
			}
			s.pending[priority] = queue
			return state
		}
		s.pending[priority] = queue
	}
	return nil
}

func (s *PeerSession) waitForActiveTokens(priority uint8) (nonInteractive bool, ok bool) {
	nonInteractive = priority != 0
	if nonInteractive {
		select {
		case <-globalNonInteractiveTokens:
		case <-s.dispatchWake:
			return false, false
		case <-s.done:
			return false, false
		}
	}
	select {
	case <-globalActiveRequestTokens:
		return nonInteractive, true
	case <-s.dispatchWake:
		if nonInteractive {
			globalNonInteractiveTokens <- struct{}{}
		}
		return false, false
	case <-s.done:
		if nonInteractive {
			globalNonInteractiveTokens <- struct{}{}
		}
		return false, false
	}
}

func releaseActiveTokens(nonInteractive bool) {
	globalActiveRequestTokens <- struct{}{}
	if nonInteractive {
		globalNonInteractiveTokens <- struct{}{}
	}
}

func (s *PeerSession) dispatchLoop() {
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return
		}
		state := s.nextPendingLocked()
		s.mu.Unlock()
		if state == nil {
			select {
			case <-s.dispatchWake:
				continue
			case <-s.done:
				return
			}
		}

		nonInteractive, ok := s.waitForActiveTokens(state.priority)
		if !ok {
			continue
		}
		s.mu.Lock()
		id := state.id
		canStart := !s.closed && s.requests[id] == state && !state.started && s.activeHandlers < maxActiveRequestsPerPeer
		if canStart && state.priority != 0 {
			canStart = s.activeNonInteractive < maxActiveNonInteractivePerPeer
		}
		if canStart {
			state.started = true
			s.activeHandlers++
			transportStats.activeHandlers.Add(1)
			if nonInteractive {
				s.activeNonInteractive++
				transportStats.activeNonInteractiveHandlers.Add(1)
			}
		}
		s.mu.Unlock()
		if !canStart {
			releaseActiveTokens(nonInteractive)
			continue
		}
		go s.serveRequest(id, state, nonInteractive)
	}
}

func (s *PeerSession) serveRequest(id uint32, state *requestState, nonInteractive bool) {
	defer s.handlerExited(state, nonInteractive)
	var body io.ReadCloser
	if state.body != nil {
		body = state.body
	}
	if err := s.handler.Serve(state.ctx, s, id, state.head, body); err != nil && !errors.Is(err, context.Canceled) {
		// Full detail remains in the node log, but the browser receives a stable
		// generic error that cannot disclose a backend address or path.
		log.Printf("request %d failed: %v", id, err)
		s.sendRequestError(state, id, "request failed", "REQUEST_FAILED")
	}
	s.finishHandledRequest(id, state)
}

// finishHandledRequest tolerates only the bounded credited wire tail for an
// upload whose handler returned before every authorized SCTP frame arrived.
func (s *PeerSession) finishHandledRequest(id uint32, state *requestState) {
	s.cancelRequestStateWithTrailing(id, state, hasUnfinishedRequestBody(state))
}

func hasUnfinishedRequestBody(state *requestState) bool {
	if state.body == nil {
		return false
	}
	state.bodyMu.Lock()
	defer state.bodyMu.Unlock()
	return !state.bodyEnded
}

func (s *PeerSession) handlerExited(state *requestState, nonInteractive bool) {
	s.mu.Lock()
	s.activeHandlers--
	transportStats.activeHandlers.Add(-1)
	if nonInteractive {
		s.activeNonInteractive--
		transportStats.activeNonInteractiveHandlers.Add(-1)
	}
	s.mu.Unlock()
	releaseActiveTokens(nonInteractive)
	s.signalDispatch()
}

func (s *PeerSession) cancelRequestState(id uint32, expected *requestState) bool {
	return s.cancelRequestStateWithTrailing(id, expected, false)
}

func (s *PeerSession) cancelRequestStateWithTrailing(
	id uint32,
	expected *requestState,
	allowTrailing bool,
) bool {
	s.mu.Lock()
	state, ok := s.requests[id]
	if !ok || state != expected {
		s.mu.Unlock()
		return false
	}
	delete(s.requests, id)
	if allowTrailing && state.body != nil {
		s.rememberRejectedBodyLocked(id, state.lane, time.Now())
	}
	if state.body != nil {
		s.bodyRequests--
	}
	s.mu.Unlock()
	transportStats.admittedRequests.Add(-1)
	globalRequestAdmissionTokens <- struct{}{}
	state.cancel()
	if state.body != nil {
		s.stopRequestBody(state)
	}
	s.signalDispatch()
	return true
}

func (s *PeerSession) releaseRequestBodyReservation(state *requestState) {
	state.bodyReservationOnce.Do(func() {
		if state.reservedBodyFrames != 0 {
			releaseGlobalRequestBodyFrames(state.reservedBodyFrames)
		}
	})
}

func (s *PeerSession) pruneRejectedBodiesLocked(now time.Time) {
	for id, tombstone := range s.rejectedBodies {
		if !now.Before(tombstone.expires) {
			delete(s.rejectedBodies, id)
		}
	}
}

func (s *PeerSession) rememberRejectedBodyLocked(id uint32, lane *sessionLane, now time.Time) {
	s.pruneRejectedBodiesLocked(now)
	if len(s.rejectedBodies) >= maxRejectedBodyTombstonesPerPeer {
		var oldestID uint32
		var oldest time.Time
		for candidateID, tombstone := range s.rejectedBodies {
			if oldest.IsZero() || tombstone.expires.Before(oldest) {
				oldestID = candidateID
				oldest = tombstone.expires
			}
		}
		delete(s.rejectedBodies, oldestID)
	}
	s.rejectedBodies[id] = rejectedBodyTombstone{
		lane:      lane,
		remaining: maxRejectedBodyTrailingFrames,
		expires:   now.Add(rejectedBodyTombstoneLifetime),
	}
}

func (s *PeerSession) discardRejectedRequestBody(id uint32, lane *sessionLane, end bool) bool {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneRejectedBodiesLocked(now)
	tombstone, ok := s.rejectedBodies[id]
	if !ok || tombstone.lane != lane {
		return false
	}
	if end {
		delete(s.rejectedBodies, id)
		return true
	}
	if tombstone.remaining == 0 {
		return false
	}
	tombstone.remaining--
	s.rejectedBodies[id] = tombstone
	return true
}

func (s *PeerSession) discardRacedRequestBodyError(
	id uint32,
	lane *sessionLane,
	err error,
) bool {
	if !errors.Is(err, errRequestBodyClosed) && !errors.Is(err, errRequestBodyEnded) {
		return false
	}
	return s.discardRejectedRequestBody(id, lane, false)
}

func (s *PeerSession) sendRequestCredits(state *requestState, count uint32) error {
	frame, err := encodeCreditFrame(FrameReqCredit, state.id, count)
	if err != nil {
		return err
	}
	return state.lane.send(frame)
}

// requestBodyChunkConsumed is called exactly once when a queued chunk has been
// fully read, never when Close merely discards it. Keeping the accounting and
// Send under bodyMu ensures a concurrently arriving body frame cannot spend a
// grant before it has actually been placed on the ordered data channel.
func (s *PeerSession) requestBodyChunkConsumed(state *requestState) {
	state.bodyMu.Lock()
	if state.bodyEnded || state.ctx.Err() != nil {
		state.bodyMu.Unlock()
		return
	}
	state.requestCreditsPending++
	// Batch routine refills, but never leave a sender at zero waiting for a
	// partially accumulated batch. This matters for short/slow pipelines where
	// the HTTP transport has consumed only a few of the sixteen queued frames.
	if state.requestCreditsPending < requestCreditBatchSize && state.requestCreditsAvailable != 0 {
		state.bodyMu.Unlock()
		return
	}

	grant := state.requestCreditsPending
	if capacity := maxRequestCredits - state.requestCreditsAvailable; grant > capacity {
		grant = capacity
	}
	if grant == 0 {
		state.bodyMu.Unlock()
		return
	}
	state.requestCreditsPending -= grant
	state.requestCreditsAvailable += grant
	err := s.sendRequestCredits(state, grant)
	state.bodyMu.Unlock()
	if err != nil {
		s.cancelRequestState(state.id, state)
	}
}

func (s *PeerSession) resetRequestBodyTimerLocked(state *requestState) {
	state.bodyDeadline = time.Now().Add(requestBodyIdleTimeout)
	if state.bodyTimer == nil {
		state.bodyTimer = time.AfterFunc(requestBodyIdleTimeout, func() {
			s.expireRequestBody(state)
		})
		return
	}
	state.bodyTimer.Reset(requestBodyIdleTimeout)
}

// expireRequestBody is the single callback reused for the request's lifetime.
// A callback that raced Reset observes the later deadline and rearms itself.
// On a real timeout it installs the credited-tail tombstone while holding
// bodyMu, so a frame that already captured state cannot fall through as an
// unknown malformed request before cancellation removes the state.
func (s *PeerSession) expireRequestBody(state *requestState) {
	state.bodyMu.Lock()
	if state.bodyEnded || state.bodyTimedOut {
		state.bodyMu.Unlock()
		return
	}
	if remaining := time.Until(state.bodyDeadline); remaining > 0 {
		state.bodyTimer.Reset(remaining)
		state.bodyMu.Unlock()
		return
	}

	state.bodyTimedOut = true
	state.bodyEnded = true
	s.mu.Lock()
	active := s.requests[state.id] == state
	if active {
		s.rememberRejectedBodyLocked(state.id, state.lane, time.Now())
	}
	s.mu.Unlock()
	state.bodyMu.Unlock()
	if active && s.cancelRequestStateWithTrailing(state.id, state, false) {
		s.sendBoundedError(state.lane, state.id, "request body timed out", "REQUEST_BODY_TIMEOUT")
	}
}

func (s *PeerSession) armRequestBodyTimer(_ uint32, state *requestState) {
	state.bodyMu.Lock()
	if !state.bodyEnded {
		s.resetRequestBodyTimerLocked(state)
	}
	state.bodyMu.Unlock()
}

func (s *PeerSession) enqueueRequestBody(state *requestState, payload []byte) error {
	state.bodyMu.Lock()
	defer state.bodyMu.Unlock()
	if state.bodyEnded {
		return errRequestBodyEnded
	}
	if state.requestCreditsAvailable == 0 {
		return errRequestBodyCreditExhausted
	}
	if int64(len(payload)) > maxRequestBodyBytes-state.bodyBytes {
		return errRequestBodyTooLarge
	}
	if err := state.body.enqueue(payload); err != nil {
		return err
	}
	state.requestCreditsAvailable--
	state.bodyBytes += int64(len(payload))
	s.resetRequestBodyTimerLocked(state)
	return nil
}

func (s *PeerSession) endRequestBody(state *requestState) {
	state.bodyMu.Lock()
	if !state.bodyEnded {
		state.bodyEnded = true
		state.bodyDeadline = time.Time{}
		if state.bodyTimer != nil {
			state.bodyTimer.Stop()
		}
		state.body.end()
	}
	state.bodyMu.Unlock()
}

func (s *PeerSession) stopRequestBody(state *requestState) {
	state.bodyMu.Lock()
	state.bodyEnded = true
	state.bodyDeadline = time.Time{}
	if state.bodyTimer != nil {
		state.bodyTimer.Stop()
	}
	state.bodyMu.Unlock()
	_ = state.body.Close()
}

// noteProtocolViolation applies one small peer-scoped budget to malformed
// frames and channels. The aggregate counter remains useful operationally,
// while closing after a handful prevents per-event log and response floods.
func (s *PeerSession) noteProtocolViolation() bool {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	s.protocolViolations++
	allowed := s.protocolViolations <= maxProtocolViolationsPerPeer
	closePeer := s.protocolViolations == maxProtocolViolationsPerPeer
	s.mu.Unlock()
	if closePeer {
		s.requestPeerClose()
	}
	return allowed
}

func (s *PeerSession) rejectProtocol(lane *sessionLane, id uint32, message, code string) {
	if s.noteProtocolViolation() {
		s.sendBoundedError(lane, id, message, code)
	}
}

func (s *PeerSession) sendRequestError(state *requestState, id uint32, message, code string) {
	if s.requestOnLane(id, state.lane) == state {
		s.sendBoundedError(state.lane, id, message, code)
	}
}

// sendCapacityError bounds terminal responses generated by valid but rejected
// REQ frames independently of the malformed-frame budget. Once the allowance
// is exhausted, further overload requests enqueue nothing and close the peer.
// requestPeerClose's sync.Once makes concurrent excess requests idempotent.
func (s *PeerSession) sendCapacityError(lane *sessionLane, id uint32, message, code string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if s.capacityErrorSends >= maxCapacityErrorSendsPerPeer {
		s.mu.Unlock()
		s.requestPeerClose()
		return
	}
	s.capacityErrorSends++
	s.mu.Unlock()
	s.sendBoundedError(lane, id, message, code)
}

func (s *PeerSession) sendBoundedError(lane *sessionLane, id uint32, message, code string) {
	if lane == nil {
		return
	}
	if s.aggregateBufferedAmount() >= terminalErrorBufferedAmountCeiling {
		s.requestPeerClose()
		return
	}
	// Error payloads are protocol-sized and peer violations are capped. Always
	// enqueue below the hard association ceiling: silently dropping it under
	// ordinary pressure leaves the browser waiting for a removed request.
	frame, err := EncodeJSONFrame(FrameResErr, id, ProtocolErrorPayload{Message: message, Code: code})
	if err == nil {
		_ = lane.send(frame)
	}
}

// Close cancels all in-flight work. The owning PeerConnection closes the data
// channels, so this method intentionally does not recurse into channel.Close.
func (s *PeerSession) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.done)
	sockets := make([]*webSocketStream, 0, len(s.sockets))
	for _, stream := range s.sockets {
		sockets = append(sockets, stream)
	}
	s.sockets = nil
	states := make([]*requestState, 0, len(s.requests))
	for _, state := range s.requests {
		states = append(states, state)
	}
	requestCount := len(s.requests)
	s.requests = make(map[uint32]*requestState)
	s.rejectedBodies = make(map[uint32]rejectedBodyTombstone)
	s.bodyRequests = 0
	laneCount := 0
	for i := range s.lanes {
		if s.lanes[i].Load() != nil {
			laneCount++
			s.lanes[i].Store(nil)
		}
	}
	s.mu.Unlock()

	if requestCount != 0 {
		transportStats.admittedRequests.Add(-int64(requestCount))
	}
	if laneCount != 0 {
		transportStats.activeLanes.Add(-int64(laneCount))
	}
	// Sockets outlive any single request, so the peer going away is the only
	// thing that ends them. The lane is already detached, so this cancels the
	// pumps and closes upstream rather than trying to report a close frame.
	for _, stream := range sockets {
		stream.closeOnce.Do(func() {
			stream.cancel()
			if conn := stream.conn.Load(); conn != nil {
				_ = conn.Close(websocket.StatusGoingAway, "")
			}
			stream.credits.signal()
		})
	}
	for _, state := range states {
		state.cancel()
		if state.body != nil {
			s.stopRequestBody(state)
		}
		globalRequestAdmissionTokens <- struct{}{}
	}
	s.signalBufferChanged()
	s.signalDispatch()
}

func (s *PeerSession) signalBufferChanged() {
	s.bufferMu.Lock()
	close(s.bufferChanged)
	s.bufferChanged = make(chan struct{})
	s.bufferMu.Unlock()
}

func (s *PeerSession) aggregateBufferedAmount() uint64 {
	var total uint64
	for i := range s.lanes {
		if lane := s.lanes[i].Load(); lane != nil {
			total += lane.bufferedAmount()
		}
	}
	return total
}

func (lane *sessionLane) bufferedAmount() uint64 {
	if lane.bufferedAmountOverride != nil {
		return lane.bufferedAmountOverride()
	}
	if lane.channel == nil {
		return 0
	}
	return lane.channel.BufferedAmount()
}

func (s *PeerSession) waitForBuffer(ctx context.Context, lane *sessionLane) error {
	limit := uint64(bulkBufferHighWater)
	if lane.id == controlLaneID {
		limit = aggregateBufferHighWater
	}
	for s.aggregateBufferedAmount() > limit {
		s.bufferMu.Lock()
		changed := s.bufferChanged
		s.bufferMu.Unlock()
		// Recheck after capturing the generation to avoid missing a drain that
		// raced the first measurement.
		if s.aggregateBufferedAmount() <= limit {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
	return nil
}

func (lane *sessionLane) send(frame []byte) error {
	lane.sendMu.Lock()
	defer lane.sendMu.Unlock()
	if lane.sendOverride != nil {
		return lane.sendOverride(frame)
	}
	if lane.channel.ReadyState() != webrtc.DataChannelStateOpen {
		return errors.New("data channel closed")
	}
	return lane.channel.Send(frame)
}

func takeResponseCredit(ctx context.Context, state *requestState) error {
	if state.credits == nil {
		return nil
	}
	return state.credits.take(ctx)
}

func (s *PeerSession) SendHead(id uint32, head ResponseHead) error {
	state := s.request(id)
	if state == nil {
		return context.Canceled
	}
	frame, err := EncodeJSONFrame(FrameResHead, id, head)
	if err != nil {
		return err
	}
	if err := s.waitForBuffer(state.ctx, state.lane); err != nil {
		return err
	}
	return state.lane.send(frame)
}

func (s *PeerSession) SendBody(ctx context.Context, id uint32, chunk []byte) error {
	state := s.request(id)
	if state == nil {
		return context.Canceled
	}
	if err := takeResponseCredit(ctx, state); err != nil {
		return err
	}

	lane := state.lane
	lane.bodySendMu.Lock()
	defer lane.bodySendMu.Unlock()
	if err := s.waitForBuffer(ctx, lane); err != nil {
		return err
	}
	buffer := responseFramePool.Get().([]byte)
	defer responseFramePool.Put(buffer[:maxFrameBytes])
	frame, err := encodeFrameInto(buffer, FrameResBody, id, chunk)
	if err != nil {
		return err
	}
	if err := lane.send(frame); err != nil {
		return err
	}
	transportStats.bodyFrames.Add(1)
	transportStats.bodyBytes.Add(uint64(len(chunk)))
	return nil
}

// StreamBody is used only for regular files. It reads directly into the frame
// payload area, removing one 128 KiB buffer and copy per active response.
// Regular-file reads cannot wait indefinitely like proxy response bodies, so
// holding bodySendMu across the read cannot strand an API stream on this lane.
func (s *PeerSession) StreamBody(ctx context.Context, id uint32, src io.Reader, limit int64) error {
	// One lookup for the whole transfer: the state is immutable after begin and
	// cancellation always cancels state.ctx (the ctx the handler passes here),
	// so re-checking the request map per frame only added mutex traffic.
	state := s.request(id)
	if state == nil {
		return context.Canceled
	}
	lane := state.lane
	remaining := limit
	for remaining != 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := takeResponseCredit(ctx, state); err != nil {
			return err
		}

		lane.bodySendMu.Lock()
		if err := s.waitForBuffer(ctx, lane); err != nil {
			lane.bodySendMu.Unlock()
			return err
		}
		buffer := responseFramePool.Get().([]byte)
		readSize := maxPayloadBytes
		if remaining > 0 && remaining < int64(readSize) {
			readSize = int(remaining)
		}
		n, readErr := src.Read(buffer[headerBytes : headerBytes+readSize])
		if n > 0 {
			frame, encodeErr := encodeFrameInto(
				buffer, FrameResBody, id, buffer[headerBytes:headerBytes+n],
			)
			if encodeErr == nil {
				encodeErr = lane.send(frame)
			}
			if encodeErr == nil {
				transportStats.bodyFrames.Add(1)
				transportStats.bodyBytes.Add(uint64(n))
				if remaining > 0 {
					remaining -= int64(n)
				}
			}
			responseFramePool.Put(buffer[:maxFrameBytes])
			lane.bodySendMu.Unlock()
			if encodeErr != nil {
				return encodeErr
			}
		} else {
			responseFramePool.Put(buffer[:maxFrameBytes])
			lane.bodySendMu.Unlock()
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
		if n == 0 {
			// io.Reader permits a transient zero-length read. Yield rather than
			// burning a core while preserving the request's cancellation path.
			runtime.Gosched()
		}
	}
	return nil
}

func (s *PeerSession) SendEnd(id uint32) error {
	state := s.request(id)
	if state == nil {
		return context.Canceled
	}
	frame, err := EncodeFrame(FrameResEnd, id, nil)
	if err != nil {
		return err
	}
	if err := s.waitForBuffer(state.ctx, state.lane); err != nil {
		return err
	}
	return state.lane.send(frame)
}

// headerPairsFrom flattens net/http headers, preserving duplicates.
func headerPairsFrom(h http.Header) HeaderPairs {
	pairs := make(HeaderPairs, 0, len(h))
	for name, values := range h {
		for _, value := range values {
			pairs = append(pairs, [2]string{strings.ToLower(name), value})
		}
	}
	return pairs
}
