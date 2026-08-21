package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type limitedBodyWriter struct {
	limit int
	err   error
	data  bytes.Buffer
}

func (w *limitedBodyWriter) Write(p []byte) (int, error) {
	n := min(w.limit, len(p))
	_, _ = w.data.Write(p[:n])
	return n, w.err
}

type blockingBodyWriter struct {
	entered chan struct{}
	release chan struct{}
}

func (w *blockingBodyWriter) Write(p []byte) (int, error) {
	close(w.entered)
	<-w.release
	return len(p), nil
}

func TestAsyncRequestBodyPreservesOrderAndReleasesBudget(t *testing.T) {
	before := len(globalRequestBodyFrameTokens)
	body := newAsyncRequestBody(context.Background(), nil, nil)
	parts := [][]byte{[]byte("alpha"), []byte("-"), []byte("omega")}
	for _, part := range parts {
		if err := body.enqueue(part); err != nil {
			t.Fatalf("enqueue %q: %v", part, err)
		}
	}
	body.end()
	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if want := bytes.Join(parts, nil); !bytes.Equal(got, want) {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if err := body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}
	if after := len(globalRequestBodyFrameTokens); after != before {
		t.Fatalf("global body-frame tokens = %d, want %d", after, before)
	}
}

func TestAsyncRequestBodyQueueIsNonBlockingAndBounded(t *testing.T) {
	body := newAsyncRequestBody(context.Background(), nil, nil)
	defer body.Close()
	for i := 0; i < requestBodyQueueFrames; i++ {
		if err := body.enqueue([]byte{byte(i)}); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}
	started := time.Now()
	err := body.enqueue([]byte("overflow"))
	if !errors.Is(err, errRequestBodyQueueFull) {
		t.Fatalf("overflow error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 50*time.Millisecond {
		t.Fatalf("overflow enqueue blocked for %s", elapsed)
	}
}

func TestAsyncRequestBodyWriteToForwardsFramesDirectly(t *testing.T) {
	var consumed atomic.Int32
	body := newAsyncRequestBody(
		context.Background(),
		func() { consumed.Add(1) },
		nil,
	)
	parts := [][]byte{[]byte("alpha"), nil, []byte("-omega")}
	for _, part := range parts {
		if err := body.enqueue(part); err != nil {
			t.Fatalf("enqueue %q: %v", part, err)
		}
	}
	body.end()

	var dst bytes.Buffer
	n, err := body.WriteTo(&dst)
	if err != nil {
		t.Fatalf("write body: %v", err)
	}
	if want := bytes.Join(parts, nil); !bytes.Equal(dst.Bytes(), want) || n != int64(len(want)) {
		t.Fatalf("forwarded %d bytes %q, want %d bytes %q", n, dst.Bytes(), len(want), want)
	}
	if got := consumed.Load(); got != int32(len(parts)) {
		t.Fatalf("consumed callbacks = %d, want %d", got, len(parts))
	}
}

func TestAsyncRequestBodyWriteToDoesNotCreditPartialWrite(t *testing.T) {
	var consumed atomic.Int32
	body := newAsyncRequestBody(
		context.Background(),
		func() { consumed.Add(1) },
		nil,
	)
	if err := body.enqueue([]byte("abcdef")); err != nil {
		t.Fatal(err)
	}
	body.end()

	short := &limitedBodyWriter{limit: 2}
	n, err := body.WriteTo(short)
	if !errors.Is(err, io.ErrShortWrite) || n != 2 {
		t.Fatalf("short WriteTo = %d, %v; want 2, ErrShortWrite", n, err)
	}
	if got := consumed.Load(); got != 0 {
		t.Fatalf("partial write returned %d request credits", got)
	}

	var rest bytes.Buffer
	n, err = body.WriteTo(&rest)
	if err != nil || n != 4 || rest.String() != "cdef" {
		t.Fatalf("resumed WriteTo = %d, %v, %q; want 4, nil, cdef", n, err, rest.String())
	}
	if got := consumed.Load(); got != 1 {
		t.Fatalf("completed frame returned %d request credits, want 1", got)
	}
}

func TestAsyncRequestBodyWriteToPreservesPartialWriterError(t *testing.T) {
	wantErr := errors.New("backend write failed")
	var consumed atomic.Int32
	body := newAsyncRequestBody(
		context.Background(),
		func() { consumed.Add(1) },
		nil,
	)
	if err := body.enqueue([]byte("abcdef")); err != nil {
		t.Fatal(err)
	}
	body.end()

	failing := &limitedBodyWriter{limit: 3, err: wantErr}
	n, err := body.WriteTo(failing)
	if !errors.Is(err, wantErr) || n != 3 {
		t.Fatalf("failed WriteTo = %d, %v; want 3, %v", n, err, wantErr)
	}
	if got := consumed.Load(); got != 0 {
		t.Fatalf("failed partial frame returned %d request credits", got)
	}
}

func TestAsyncRequestBodyWriteToWakesOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	body := newAsyncRequestBody(ctx, nil, nil)
	result := make(chan error, 1)
	go func() {
		_, err := body.WriteTo(io.Discard)
		result <- err
	}()
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled WriteTo returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled WriteTo remained blocked")
	}
}

func TestAsyncRequestBodyCloseDropsQueuedPayloadReferences(t *testing.T) {
	body := newAsyncRequestBody(context.Background(), nil, nil)
	for i := 0; i < requestBodyQueueFrames; i++ {
		if err := body.enqueue([]byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := body.Close(); err != nil {
		t.Fatal(err)
	}
	body.stateMu.Lock()
	defer body.stateMu.Unlock()
	if body.queueLen != 0 {
		t.Fatalf("closed queue retained %d chunks", body.queueLen)
	}
	for i, chunk := range body.chunks {
		if chunk != nil {
			t.Fatalf("closed queue retained payload reference at slot %d", i)
		}
	}
}

func TestAsyncRequestBodyCloseDefersReservationWhileWriteIsActive(t *testing.T) {
	var drained atomic.Int32
	body := newAsyncRequestBody(
		context.Background(),
		nil,
		func() { drained.Add(1) },
	)
	if err := body.enqueue([]byte("active frame")); err != nil {
		t.Fatal(err)
	}
	body.end()
	writer := &blockingBodyWriter{entered: make(chan struct{}), release: make(chan struct{})}
	result := make(chan error, 1)
	go func() {
		_, err := body.WriteTo(writer)
		result <- err
	}()
	select {
	case <-writer.entered:
	case <-time.After(time.Second):
		t.Fatal("WriteTo did not enter the backend writer")
	}

	closed := make(chan struct{})
	go func() {
		_ = body.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close blocked behind an active backend write")
	}
	if got := drained.Load(); got != 0 {
		t.Fatalf("active frame released its reservation %d times before the write returned", got)
	}

	close(writer.release)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("closed WriteTo returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("WriteTo did not return after the backend writer unblocked")
	}
	if got := drained.Load(); got != 1 {
		t.Fatalf("completed active-frame cleanup released reservation %d times, want 1", got)
	}
}

func TestAsyncRequestBodyCloseAndConsumerCannotBothSkipCleanup(t *testing.T) {
	var drained atomic.Int32
	body := newAsyncRequestBody(
		context.Background(),
		nil,
		func() { drained.Add(1) },
	)

	// Model a consumer returning while it owns readMu. Pause it after it has
	// observed closed=false and acquired stateMu; Close must wait for stateMu,
	// then acquire the already-released readMu and perform cleanup itself.
	body.readMu.Lock()
	consumerHoldingState := make(chan struct{})
	allowConsumerUnlock := make(chan struct{})
	consumerDone := make(chan struct{})
	go func() {
		body.unlockConsumerObserved(func() {
			close(consumerHoldingState)
			<-allowConsumerUnlock
		})
		close(consumerDone)
	}()
	<-consumerHoldingState

	closeStarted := make(chan struct{})
	closeDone := make(chan struct{})
	go func() {
		close(closeStarted)
		_ = body.Close()
		close(closeDone)
	}()
	<-closeStarted
	close(allowConsumerUnlock)
	select {
	case <-consumerDone:
	case <-time.After(time.Second):
		t.Fatal("consumer did not complete its ordered unlock")
	}
	select {
	case <-closeDone:
	case <-time.After(time.Second):
		t.Fatal("Close did not acquire cleanup ownership")
	}
	if got := drained.Load(); got != 1 {
		t.Fatalf("Close/consumer arbitration released cleanup %d times, want 1", got)
	}
}

func TestCancelledActiveWriterRetainsGlobalReservationUntilReturn(t *testing.T) {
	beforeBodyTokens := len(globalRequestBodyFrameTokens)
	beforeAdmissionTokens := len(globalRequestAdmissionTokens)
	beforeAdmitted := transportStats.admittedRequests.Load()
	if !reserveGlobalRequestBodyFrames(int(maxRequestCredits)) {
		t.Fatal("could not reserve request-body window")
	}

	session := NewPeerSession(nil, nil)
	lane := &sessionLane{id: controlLaneID, peer: session, sendOverride: func([]byte) error { return nil }}
	ctx, cancel := context.WithCancel(context.Background())
	state := &requestState{
		id:                 73,
		ctx:                ctx,
		cancel:             cancel,
		lane:               lane,
		head:               RequestHead{Version: protocolVersion, HasBody: true},
		reservedBodyFrames: int(maxRequestCredits),
	}
	state.body = newAsyncRequestBody(
		ctx,
		nil,
		func() { session.releaseRequestBodyReservation(state) },
	)
	if err := state.body.enqueue([]byte("active frame")); err != nil {
		t.Fatal(err)
	}
	<-globalRequestAdmissionTokens
	transportStats.admittedRequests.Add(1)
	session.requests[state.id] = state
	session.bodyRequests = 1

	writer := &blockingBodyWriter{entered: make(chan struct{}), release: make(chan struct{})}
	var releaseWriter sync.Once
	t.Cleanup(func() {
		releaseWriter.Do(func() { close(writer.release) })
		_ = session.cancelRequestState(state.id, state)
		_ = state.body.Close()
		cancel()
	})
	result := make(chan error, 1)
	go func() {
		_, err := state.body.WriteTo(writer)
		result <- err
	}()
	select {
	case <-writer.entered:
	case <-time.After(time.Second):
		t.Fatal("WriteTo did not enter the held backend writer")
	}

	if !session.cancelRequestState(state.id, state) {
		t.Fatal("active request was not cancelled")
	}
	if got := len(globalRequestBodyFrameTokens); got != beforeBodyTokens-int(maxRequestCredits) {
		t.Fatalf("cancelled active writer returned reservation early: got %d tokens, want %d", got, beforeBodyTokens-int(maxRequestCredits))
	}

	releaseWriter.Do(func() { close(writer.release) })
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled writer returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled writer did not return")
	}
	if got := len(globalRequestBodyFrameTokens); got != beforeBodyTokens {
		t.Fatalf("completed cancelled writer left %d tokens, want %d", got, beforeBodyTokens)
	}
	if got := len(globalRequestAdmissionTokens); got != beforeAdmissionTokens {
		t.Fatalf("admission tokens = %d, want %d", got, beforeAdmissionTokens)
	}
	if got := transportStats.admittedRequests.Load(); got != beforeAdmitted {
		t.Fatalf("admitted request metric = %d, want %d", got, beforeAdmitted)
	}
}

func TestRequestBodyTimerIsReusedAndStaleFireRearms(t *testing.T) {
	session := NewPeerSession(nil, nil)
	state := &requestState{}
	state.bodyMu.Lock()
	session.resetRequestBodyTimerLocked(state)
	first := state.bodyTimer
	session.resetRequestBodyTimerLocked(state)
	second := state.bodyTimer
	state.bodyDeadline = time.Now().Add(time.Hour)
	state.bodyMu.Unlock()
	if first == nil || second != first {
		t.Fatalf("request timer was replaced: first=%p second=%p", first, second)
	}

	session.expireRequestBody(state)
	state.bodyMu.Lock()
	timedOut := state.bodyTimedOut
	state.bodyEnded = true
	state.bodyTimer.Stop()
	state.bodyMu.Unlock()
	if timedOut {
		t.Fatal("stale timer callback expired a request with a later deadline")
	}
}

func TestReservedV3WindowOwnsGlobalTokensUntilRequestCleanup(t *testing.T) {
	before := len(globalRequestBodyFrameTokens)
	if !reserveGlobalRequestBodyFrames(int(maxRequestCredits)) {
		t.Fatal("could not reserve a v3 request window")
	}
	defer func() {
		if after := len(globalRequestBodyFrameTokens); after != before {
			t.Fatalf("global body-frame tokens = %d, want %d", after, before)
		}
	}()

	body := newAsyncRequestBody(context.Background(), nil, func() {
		releaseGlobalRequestBodyFrames(int(maxRequestCredits))
	})
	for i := 0; i < int(maxRequestCredits); i++ {
		if err := body.enqueue([]byte{byte(i)}); err != nil {
			t.Fatalf("enqueue reserved frame %d: %v", i, err)
		}
	}
	for i := 0; i < int(maxRequestCredits); i++ {
		if n, err := body.Read(make([]byte, 1)); err != nil || n != 1 {
			t.Fatalf("read reserved frame %d = %d, %v", i, n, err)
		}
	}
	if got := len(globalRequestBodyFrameTokens); got != before-int(maxRequestCredits) {
		t.Fatalf("consumption returned advertised window tokens: got %d", got)
	}
	body.end()
	if n, err := body.Read(make([]byte, 1)); err != io.EOF || n != 0 {
		t.Fatalf("reserved body EOF = %d, %v", n, err)
	}
	if err := body.Close(); err != nil {
		t.Fatalf("close reserved body: %v", err)
	}
}

func newTrackedV3BodyRequest(
	t *testing.T,
	id uint32,
) (*PeerSession, *sessionLane, *requestState) {
	t.Helper()
	beforeBodyTokens := len(globalRequestBodyFrameTokens)
	beforeAdmissionTokens := len(globalRequestAdmissionTokens)
	beforeAdmitted := transportStats.admittedRequests.Load()

	session := NewPeerSession(nil, nil)
	lane := &sessionLane{
		id:           controlLaneID,
		peer:         session,
		sendOverride: func([]byte) error { return nil },
	}
	if !reserveGlobalRequestBodyFrames(int(maxRequestCredits)) {
		t.Fatal("could not reserve request-body window")
	}
	ctx, cancel := context.WithCancel(context.Background())
	state := &requestState{
		id:                      id,
		ctx:                     ctx,
		cancel:                  cancel,
		credits:                 newResponseCreditWindow(1),
		lane:                    lane,
		requestCreditsAvailable: maxRequestCredits,
		reservedBodyFrames:      int(maxRequestCredits),
		head: RequestHead{
			Version: protocolVersion,
			HasBody: true,
		},
	}
	state.body = newAsyncRequestBody(
		ctx,
		func() { session.requestBodyChunkConsumed(state) },
		func() { session.releaseRequestBodyReservation(state) },
	)

	<-globalRequestAdmissionTokens
	transportStats.admittedRequests.Add(1)
	session.mu.Lock()
	session.requests[id] = state
	session.bodyRequests = 1
	session.mu.Unlock()

	t.Cleanup(func() {
		_ = session.cancelRequestState(id, state)
		cancel()
		_ = state.body.Close()
		session.mu.Lock()
		delete(session.rejectedBodies, id)
		session.mu.Unlock()
		if got := len(globalRequestBodyFrameTokens); got != beforeBodyTokens {
			t.Errorf("global body-frame tokens = %d, want %d", got, beforeBodyTokens)
		}
		if got := len(globalRequestAdmissionTokens); got != beforeAdmissionTokens {
			t.Errorf("global admission tokens = %d, want %d", got, beforeAdmissionTokens)
		}
		if got := transportStats.admittedRequests.Load(); got != beforeAdmitted {
			t.Errorf("admitted request metric = %d, want %d", got, beforeAdmitted)
		}
	})
	return session, lane, state
}

func TestFinishedV3HandlerIgnoresOnlyBoundedCreditedTail(t *testing.T) {
	session, lane, state := newTrackedV3BodyRequest(t, 58)
	session.finishHandledRequest(state.id, state)

	bodyFrame, err := EncodeFrame(FrameReqBody, state.id, []byte("already-buffered"))
	if err != nil {
		t.Fatalf("encode trailing body: %v", err)
	}
	for i := 0; i < int(maxRejectedBodyTrailingFrames); i++ {
		session.OnMessage(lane, bodyFrame)
	}
	if session.protocolViolations != 0 {
		t.Fatalf("bounded credited tail caused %d protocol violations", session.protocolViolations)
	}

	// The compatibility window is not an unbounded unknown-request bypass.
	session.OnMessage(lane, bodyFrame)
	if session.protocolViolations != 1 {
		t.Fatalf("body beyond tombstone cap caused %d violations, want 1", session.protocolViolations)
	}
	endFrame, err := EncodeFrame(FrameReqEnd, state.id, nil)
	if err != nil {
		t.Fatalf("encode trailing end: %v", err)
	}
	session.OnMessage(lane, endFrame)
	if session.protocolViolations != 1 {
		t.Fatalf("ordered trailing end caused %d violations, want 1", session.protocolViolations)
	}
	session.mu.Lock()
	_, retained := session.rejectedBodies[state.id]
	session.mu.Unlock()
	if retained {
		t.Fatal("REQ_END did not release the trailing-body tombstone")
	}
}

func TestCancelledV3RequestRetainsCreditedBodyTail(t *testing.T) {
	session, lane, state := newTrackedV3BodyRequest(t, 59)
	cancelFrame, err := EncodeFrame(FrameCancel, state.id, nil)
	if err != nil {
		t.Fatalf("encode cancel: %v", err)
	}
	session.OnMessage(lane, cancelFrame)

	session.mu.Lock()
	_, retained := session.rejectedBodies[state.id]
	session.mu.Unlock()
	if !retained {
		t.Fatal("CANCEL did not retain a credited-tail tombstone")
	}
	bodyFrame, err := EncodeFrame(FrameReqBody, state.id, []byte("queued-before-cancel"))
	if err != nil {
		t.Fatalf("encode trailing body: %v", err)
	}
	session.OnMessage(lane, bodyFrame)
	if session.protocolViolations != 0 {
		t.Fatalf("credited body after CANCEL caused %d protocol violations", session.protocolViolations)
	}
}

func TestV3BodyCapacityRejectionDoesNotAuthorizeUploadTail(t *testing.T) {
	session := NewPeerSession(nil, nil)
	var sent [][]byte
	lane := &sessionLane{
		id:   controlLaneID,
		peer: session,
		sendOverride: func(frame []byte) error {
			sent = append(sent, bytes.Clone(frame))
			return nil
		},
	}
	session.lanes[controlLaneID].Store(lane)
	session.bodyRequests = maxBodyRequestsPerPeer
	beforeRejects := transportStats.requestRejects.Load()
	t.Cleanup(func() {
		transportStats.requestRejects.Add(beforeRejects - transportStats.requestRejects.Load())
	})

	const requestID uint32 = 64
	session.begin(lane, requestID, RequestHead{
		Version:        protocolVersion,
		Method:         "POST",
		URL:            "/apiv2/upload",
		HasBody:        true,
		InitialCredits: 8,
	})
	if session.protocolViolations != 0 {
		t.Fatalf("ordinary capacity reject caused %d protocol violations", session.protocolViolations)
	}
	if len(sent) != 1 {
		t.Fatalf("capacity reject emitted %d terminal frames, want 1", len(sent))
	}
	if session.capacityErrorSends != 1 {
		t.Fatalf("capacity error budget used %d sends, want 1", session.capacityErrorSends)
	}
	terminal, err := DecodeFrame(sent[0])
	if err != nil || terminal.Type != FrameResErr {
		t.Fatalf("capacity terminal frame = type %d err %v", terminal.Type, err)
	}
	session.mu.Lock()
	_, retained := session.rejectedBodies[requestID]
	session.mu.Unlock()
	if retained {
		t.Fatal("capacity rejection installed a tombstone before granting any upload credits")
	}

	bodyFrame, err := EncodeFrame(FrameReqBody, requestID, []byte("uncredited"))
	if err != nil {
		t.Fatalf("encode uncredited body: %v", err)
	}
	session.OnMessage(lane, bodyFrame)
	if session.protocolViolations != 1 {
		t.Fatalf("uncredited upload caused %d violations, want 1", session.protocolViolations)
	}
}

func TestValidOverCapacityRequestsDoNotSpendMalformedFrameBudget(t *testing.T) {
	var closes atomic.Int32
	session := NewPeerSession(nil, func() { closes.Add(1) })
	var sent int
	lane := &sessionLane{
		id:   controlLaneID,
		peer: session,
		sendOverride: func([]byte) error {
			sent++
			return nil
		},
	}
	session.lanes[controlLaneID].Store(lane)
	for id := uint32(1); id <= maxAdmittedRequestsPerPeer; id++ {
		session.requests[id] = &requestState{id: id, lane: lane}
	}
	beforeRejects := transportStats.requestRejects.Load()
	t.Cleanup(func() {
		transportStats.requestRejects.Add(beforeRejects - transportStats.requestRejects.Load())
	})

	const attempts = maxProtocolViolationsPerPeer + 2
	for offset := uint32(1); offset <= attempts; offset++ {
		session.begin(lane, uint32(maxAdmittedRequestsPerPeer)+offset, RequestHead{
			Version:        protocolVersion,
			Method:         "GET",
			URL:            "/asset.js",
			InitialCredits: 8,
		})
	}
	if session.protocolViolations != 0 {
		t.Fatalf("valid overload responses spent %d malformed-frame violations", session.protocolViolations)
	}
	if got := closes.Load(); got != 0 {
		t.Fatalf("valid overload closed peer %d times", got)
	}
	if sent != attempts {
		t.Fatalf("overload terminal frames = %d, want %d", sent, attempts)
	}
	if session.capacityErrorSends != attempts {
		t.Fatalf("capacity error budget used %d sends, want %d", session.capacityErrorSends, attempts)
	}
}

func TestRepeatedOverCapacityRequestsHaveHardTerminalErrorCeiling(t *testing.T) {
	var closes atomic.Int32
	session := NewPeerSession(nil, func() { closes.Add(1) })
	var sent atomic.Int32
	lane := &sessionLane{
		id:   controlLaneID,
		peer: session,
		sendOverride: func([]byte) error {
			sent.Add(1)
			return nil
		},
	}
	session.lanes[controlLaneID].Store(lane)
	for id := uint32(1); id <= maxAdmittedRequestsPerPeer; id++ {
		session.requests[id] = &requestState{id: id, lane: lane}
	}
	beforeRejects := transportStats.requestRejects.Load()
	t.Cleanup(func() {
		transportStats.requestRejects.Add(beforeRejects - transportStats.requestRejects.Load())
	})

	head := RequestHead{
		Version:        protocolVersion,
		Method:         "GET",
		URL:            "/asset.js",
		InitialCredits: 8,
	}
	const firstRejectedID uint32 = 10_000
	for offset := uint32(0); offset < maxCapacityErrorSendsPerPeer; offset++ {
		session.begin(lane, firstRejectedID+offset, head)
	}
	if got := sent.Load(); got != maxCapacityErrorSendsPerPeer {
		t.Fatalf("terminal frames before ceiling = %d, want %d", got, maxCapacityErrorSendsPerPeer)
	}
	if got := closes.Load(); got != 0 {
		t.Fatalf("peer closed %d times within legitimate overload burst", got)
	}

	// Every request remains syntactically valid and uses a fresh ID. None after
	// the ceiling may enqueue another frame, and all close attempts coalesce.
	for offset := uint32(maxCapacityErrorSendsPerPeer); offset < maxCapacityErrorSendsPerPeer+64; offset++ {
		session.begin(lane, firstRejectedID+offset, head)
	}
	waitForSchedulerCondition(t, "overload peer close", func() bool { return closes.Load() == 1 })
	if got := sent.Load(); got != maxCapacityErrorSendsPerPeer {
		t.Fatalf("terminal frames after ceiling = %d, want hard cap %d", got, maxCapacityErrorSendsPerPeer)
	}
	session.mu.Lock()
	budgetUsed := session.capacityErrorSends
	violations := session.protocolViolations
	session.mu.Unlock()
	if budgetUsed != maxCapacityErrorSendsPerPeer {
		t.Fatalf("capacity error budget = %d, want %d", budgetUsed, maxCapacityErrorSendsPerPeer)
	}
	if violations != 0 {
		t.Fatalf("valid overload requests spent %d malformed-frame violations", violations)
	}
	if got := closes.Load(); got != 1 {
		t.Fatalf("overload peer close callback ran %d times, want once", got)
	}
}

func TestV3CreditedTailTombstoneIsLaneAndRequestBoundAndExpires(t *testing.T) {
	session, lane, state := newTrackedV3BodyRequest(t, 61)
	session.finishHandledRequest(state.id, state)

	bodyFrame, err := EncodeFrame(FrameReqBody, state.id, []byte("tail"))
	if err != nil {
		t.Fatalf("encode trailing body: %v", err)
	}
	otherLane := &sessionLane{id: 1, peer: session}
	session.OnMessage(otherLane, bodyFrame)
	otherIDFrame, err := EncodeFrame(FrameReqBody, state.id+1, []byte("tail"))
	if err != nil {
		t.Fatalf("encode other-id body: %v", err)
	}
	session.OnMessage(lane, otherIDFrame)
	if session.protocolViolations != 2 {
		t.Fatalf("wrong lane/id caused %d violations, want 2", session.protocolViolations)
	}

	// Wrong lane/ID probes must not spend the valid request's bounded allowance.
	session.mu.Lock()
	tombstone := session.rejectedBodies[state.id]
	if tombstone.remaining != maxRejectedBodyTrailingFrames {
		session.mu.Unlock()
		t.Fatalf("wrong lane/id reduced credited-tail allowance to %d", tombstone.remaining)
	}
	tombstone.expires = time.Now().Add(-time.Nanosecond)
	session.rejectedBodies[state.id] = tombstone
	session.mu.Unlock()

	session.OnMessage(lane, bodyFrame)
	if session.protocolViolations != 3 {
		t.Fatalf("expired tombstone caused %d violations, want 3", session.protocolViolations)
	}
	session.mu.Lock()
	_, retained := session.rejectedBodies[state.id]
	session.mu.Unlock()
	if retained {
		t.Fatal("expired trailing-body tombstone was not pruned")
	}
}

func TestRequestBodyTimeoutInstallsTailBeforeReportingError(t *testing.T) {
	session, lane, state := newTrackedV3BodyRequest(t, 62)
	var sent [][]byte
	lane.sendOverride = func(frame []byte) error {
		sent = append(sent, bytes.Clone(frame))
		return nil
	}
	state.bodyMu.Lock()
	state.bodyDeadline = time.Now().Add(-time.Nanosecond)
	state.bodyMu.Unlock()

	session.expireRequestBody(state)
	if len(sent) != 1 {
		t.Fatalf("timeout emitted %d terminal frames, want 1", len(sent))
	}
	terminal, err := DecodeFrame(sent[0])
	if err != nil || terminal.Type != FrameResErr {
		t.Fatalf("timeout terminal frame = type %d err %v", terminal.Type, err)
	}
	session.mu.Lock()
	_, active := session.requests[state.id]
	tombstone, retained := session.rejectedBodies[state.id]
	session.mu.Unlock()
	if active || !retained {
		t.Fatalf("timeout left active=%v tombstone=%v", active, retained)
	}

	// Model OnMessage having captured state just before the timeout won. Close
	// makes its enqueue report Ended, and the already-installed tombstone must
	// consume that valid buffered frame without adding a protocol violation.
	err = session.enqueueRequestBody(state, []byte("racing-tail"))
	if !errors.Is(err, errRequestBodyEnded) {
		t.Fatalf("stale enqueue error = %v, want body ended", err)
	}
	if !session.discardRacedRequestBodyError(state.id, lane, err) {
		t.Fatal("captured-state race did not consume the body tombstone")
	}
	if session.protocolViolations != 0 {
		t.Fatalf("captured-state race caused %d protocol violations", session.protocolViolations)
	}
	session.mu.Lock()
	tombstone = session.rejectedBodies[state.id]
	session.mu.Unlock()
	if tombstone.remaining != maxRejectedBodyTrailingFrames-1 {
		t.Fatalf("tail allowance = %d, want %d", tombstone.remaining, maxRejectedBodyTrailingFrames-1)
	}
}

func TestTerminalRequestErrorSurvivesOrdinaryV3BufferPressure(t *testing.T) {
	session := NewPeerSession(nil, nil)
	var sent [][]byte
	lane := &sessionLane{
		id:   controlLaneID,
		peer: session,
		bufferedAmountOverride: func() uint64 {
			return aggregateBufferHighWater - 1
		},
		sendOverride: func(frame []byte) error {
			sent = append(sent, bytes.Clone(frame))
			return nil
		},
	}
	session.lanes[controlLaneID].Store(lane)
	if got := session.aggregateBufferedAmount(); got <= 256*1024 {
		t.Fatalf("test buffer pressure = %d, want above former drop threshold", got)
	}

	session.sendBoundedError(lane, 63, "request rejected", "REQUEST_CAPACITY")
	if len(sent) != 1 {
		t.Fatalf("buffered terminal errors sent = %d, want 1", len(sent))
	}
	frame, err := DecodeFrame(sent[0])
	if err != nil || frame.Type != FrameResErr || frame.RequestID != 63 {
		t.Fatalf("terminal error frame = type %d id %d err %v", frame.Type, frame.RequestID, err)
	}
}

func TestTerminalErrorsAtOrAboveBufferCeilingEnqueueNothingAndCloseOnce(t *testing.T) {
	for _, test := range []struct {
		name   string
		amount uint64
	}{
		{name: "at ceiling", amount: terminalErrorBufferedAmountCeiling},
		{name: "above ceiling", amount: terminalErrorBufferedAmountCeiling + maxFrameBytes},
	} {
		t.Run(test.name, func(t *testing.T) {
			var closes atomic.Int32
			var sent atomic.Int32
			session := NewPeerSession(nil, func() { closes.Add(1) })
			lane := &sessionLane{
				id:   controlLaneID,
				peer: session,
				bufferedAmountOverride: func() uint64 {
					return test.amount
				},
				sendOverride: func([]byte) error {
					sent.Add(1)
					return nil
				},
			}
			session.lanes[controlLaneID].Store(lane)

			const attempts = 64
			var workers sync.WaitGroup
			workers.Add(attempts)
			for id := uint32(1); id <= attempts; id++ {
				go func() {
					defer workers.Done()
					session.sendBoundedError(lane, id, "request failed", "REQUEST_FAILED")
				}()
			}
			workers.Wait()
			waitForSchedulerCondition(t, "saturated peer close", func() bool {
				return closes.Load() == 1
			})
			if got := sent.Load(); got != 0 {
				t.Fatalf("saturated terminal path enqueued %d frames, want 0", got)
			}
			if got := closes.Load(); got != 1 {
				t.Fatalf("saturated terminal path closed peer %d times, want once", got)
			}
		})
	}
}

func TestRejectedV3BodyIgnoresOnlyBoundedCreditedTail(t *testing.T) {
	session := NewPeerSession(nil, nil)
	lane := &sessionLane{id: controlLaneID, peer: session}
	ctx, cancel := context.WithCancel(context.Background())
	state := &requestState{
		id:     57,
		ctx:    ctx,
		cancel: cancel,
		lane:   lane,
		head:   RequestHead{Version: protocolVersion, HasBody: true},
	}
	state.body = newAsyncRequestBody(ctx, nil, nil)

	// Mirror the ownership normally established by begin without starting a
	// handler goroutine; cancellation must return the admission token and create
	// a lane-scoped tombstone for body frames already authorized on SCTP.
	<-globalRequestAdmissionTokens
	transportStats.admittedRequests.Add(1)
	session.mu.Lock()
	session.lanes[controlLaneID].Store(lane)
	session.requests[state.id] = state
	session.bodyRequests = 1
	session.mu.Unlock()
	if !session.cancelRequestStateWithTrailing(state.id, state, true) {
		t.Fatal("server-side request rejection did not cancel the body")
	}

	bodyFrame, err := EncodeFrame(FrameReqBody, state.id, []byte("already-credited"))
	if err != nil {
		t.Fatalf("encode trailing body: %v", err)
	}
	for i := 0; i < int(maxRequestCredits); i++ {
		session.OnMessage(lane, bodyFrame)
	}
	if session.protocolViolations != 0 {
		t.Fatalf("credited tail caused %d protocol violations", session.protocolViolations)
	}

	// The free tail is strictly capped; one more body frame is a real violation.
	session.OnMessage(lane, bodyFrame)
	if session.protocolViolations != 1 {
		t.Fatalf("body beyond tombstone cap caused %d violations, want 1", session.protocolViolations)
	}
	endFrame, err := EncodeFrame(FrameReqEnd, state.id, nil)
	if err != nil {
		t.Fatalf("encode trailing end: %v", err)
	}
	session.OnMessage(lane, endFrame)
	if session.protocolViolations != 1 {
		t.Fatalf("ordered trailing end caused %d violations, want 1", session.protocolViolations)
	}
	session.mu.Lock()
	_, retained := session.rejectedBodies[state.id]
	session.mu.Unlock()
	if retained {
		t.Fatal("REQ_END did not release rejected-body tombstone")
	}
}

func TestV3RequestBodyCreditsBoundAndReplenishOnlyConsumedChunks(t *testing.T) {
	if maxRequestCredits != 16 || requestCreditBatchSize != 4 {
		t.Fatalf("v3 request-credit window=%d batch=%d, want 16 and 4", maxRequestCredits, requestCreditBatchSize)
	}
	if int(maxRequestCredits) != requestBodyQueueFrames {
		t.Fatalf("credit window %d does not match queue bound %d", maxRequestCredits, requestBodyQueueFrames)
	}

	before := len(globalRequestBodyFrameTokens)
	session := NewPeerSession(nil, nil)
	var sent []Frame
	lane := &sessionLane{
		id:   controlLaneID,
		peer: session,
		sendOverride: func(data []byte) error {
			frame, err := DecodeFrame(data)
			if err != nil {
				return err
			}
			sent = append(sent, frame)
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	state := &requestState{
		id:                      41,
		ctx:                     ctx,
		cancel:                  cancel,
		lane:                    lane,
		head:                    RequestHead{Version: protocolVersion, HasBody: true},
		requestCreditsAvailable: maxRequestCredits,
	}
	state.body = newAsyncRequestBody(ctx, func() { session.requestBodyChunkConsumed(state) }, nil)
	t.Cleanup(func() {
		session.endRequestBody(state)
		_ = state.body.Close()
		cancel()
	})

	if err := session.sendRequestCredits(state, maxRequestCredits); err != nil {
		t.Fatalf("send initial credits: %v", err)
	}
	if len(sent) != 1 || sent[0].Type != FrameReqCredit {
		t.Fatalf("initial credit frames = %+v", sent)
	}
	if count, ok := decodeCreditPayload(sent[0].Payload); !ok || count != maxRequestCredits {
		t.Fatalf("initial credit count=%d ok=%v", count, ok)
	}

	for i := 0; i < int(maxRequestCredits); i++ {
		if err := session.enqueueRequestBody(state, []byte{byte(i), byte(i)}); err != nil {
			t.Fatalf("enqueue credited frame %d: %v", i, err)
		}
	}
	if err := session.enqueueRequestBody(state, []byte("over-credit")); !errors.Is(err, errRequestBodyCreditExhausted) {
		t.Fatalf("seventeenth frame error = %v, want credit exhaustion", err)
	}

	// A partial Read has not consumed its chunk and must not return capacity.
	oneByte := make([]byte, 1)
	if n, err := state.body.Read(oneByte); err != nil || n != 1 {
		t.Fatalf("partial body read = %d, %v", n, err)
	}
	if len(sent) != 1 {
		t.Fatalf("partial chunk emitted %d credit frames", len(sent)-1)
	}
	if n, err := state.body.Read(oneByte); err != nil || n != 1 {
		t.Fatalf("complete first chunk = %d, %v", n, err)
	}
	if len(sent) != 2 || sent[1].Type != FrameReqCredit {
		t.Fatalf("zero-credit emergency refill produced frames %+v", sent)
	}
	if count, ok := decodeCreditPayload(sent[1].Payload); !ok || count != 1 {
		t.Fatalf("zero-credit emergency refill count=%d ok=%v, want 1", count, ok)
	}

	wholeChunk := make([]byte, 2)
	for i := 1; i <= int(requestCreditBatchSize); i++ {
		if n, err := state.body.Read(wholeChunk); err != nil || n != len(wholeChunk) {
			t.Fatalf("consume chunk %d = %d, %v", i+1, n, err)
		}
	}
	if len(sent) != 3 || sent[2].Type != FrameReqCredit {
		t.Fatalf("consuming one batch produced frames %+v", sent)
	}
	if count, ok := decodeCreditPayload(sent[2].Payload); !ok || count != requestCreditBatchSize {
		t.Fatalf("refill credit count=%d ok=%v", count, ok)
	}

	state.bodyMu.Lock()
	available, pending := state.requestCreditsAvailable, state.requestCreditsPending
	state.bodyMu.Unlock()
	if available != requestCreditBatchSize+1 || pending != 0 {
		t.Fatalf("after refill available=%d pending=%d", available, pending)
	}
	for i := 0; i < int(requestCreditBatchSize)+1; i++ {
		if err := session.enqueueRequestBody(state, []byte{0xaa}); err != nil {
			t.Fatalf("enqueue replenished frame %d: %v", i, err)
		}
	}
	if err := session.enqueueRequestBody(state, []byte("over-credit-again")); !errors.Is(err, errRequestBodyCreditExhausted) {
		t.Fatalf("frame beyond replenished window error = %v", err)
	}

	session.endRequestBody(state)
	if err := state.body.Close(); err != nil {
		t.Fatalf("close v3 body: %v", err)
	}
	cancel()
	if len(sent) != 3 {
		t.Fatalf("discarding queued chunks emitted another credit frame: %+v", sent[3:])
	}
	if after := len(globalRequestBodyFrameTokens); after != before {
		t.Fatalf("global body-frame tokens = %d, want %d", after, before)
	}
}

func TestInteractiveWorkBypassesNonInteractiveHandlerCap(t *testing.T) {
	session := NewPeerSession(nil, nil)
	session.activeHandlers = maxActiveNonInteractivePerPeer
	session.activeNonInteractive = maxActiveNonInteractivePerPeer
	normal := &requestState{id: 1, priority: 2}
	interactive := &requestState{id: 2, priority: 0}
	session.requests[normal.id] = normal
	session.requests[interactive.id] = interactive
	session.pending[normal.priority] = append(session.pending[normal.priority], normal)
	session.pending[interactive.priority] = append(session.pending[interactive.priority], interactive)

	if got := session.nextPendingLocked(); got != interactive {
		t.Fatalf("scheduler selected %+v, want interactive request", got)
	}

	interactive.started = true
	atOverallLimit := &requestState{id: 3, priority: 0}
	session.requests[atOverallLimit.id] = atOverallLimit
	session.pending[atOverallLimit.priority] = append(session.pending[atOverallLimit.priority], atOverallLimit)
	session.activeHandlers = maxActiveRequestsPerPeer
	if got := session.nextPendingLocked(); got != nil {
		t.Fatalf("scheduler selected %+v after reaching the overall handler limit", got)
	}
}

func waitForSchedulerCondition(t *testing.T, label string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", label)
}

func TestNonInteractiveHandlerCapHonorsCriticalPriorityWithoutTokenLeaks(t *testing.T) {
	beforeAdmissionTokens := len(globalRequestAdmissionTokens)
	beforeActiveTokens := len(globalActiveRequestTokens)
	beforeNonInteractiveTokens := len(globalNonInteractiveTokens)
	beforeLanes := transportStats.activeLanes.Load()
	beforeAdmitted := transportStats.admittedRequests.Load()
	beforeHandlers := transportStats.activeHandlers.Load()
	beforeNonInteractive := transportStats.activeNonInteractiveHandlers.Load()

	root := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(root, "large.bin"),
		bytes.Repeat([]byte("x"), bulkResponseThreshold),
		0o600,
	); err != nil {
		t.Fatalf("write large fixture: %v", err)
	}

	session := NewPeerSession(NewHandler(root, "http://127.0.0.1:1"), nil)
	lane := &sessionLane{id: 1, peer: session}
	session.mu.Lock()
	session.lanes[lane.id].Store(lane)
	session.mu.Unlock()
	transportStats.activeLanes.Add(1)

	// Keep every started static handler parked before SendHead. This models three
	// slow large responses without constructing a WebRTC data channel in the unit
	// test and makes handler-start ordering deterministic.
	for range maxConcurrentBulkResponses {
		session.bulkSlots <- struct{}{}
	}

	t.Cleanup(func() {
		session.Close()
		waitForSchedulerCondition(t, "active handlers to exit", func() bool {
			session.mu.Lock()
			defer session.mu.Unlock()
			return session.activeHandlers == 0
		})
		for range maxConcurrentBulkResponses {
			<-session.bulkSlots
		}
		waitForSchedulerCondition(t, "scheduler tokens and metrics to be released", func() bool {
			return len(globalRequestAdmissionTokens) == beforeAdmissionTokens &&
				len(globalActiveRequestTokens) == beforeActiveTokens &&
				len(globalNonInteractiveTokens) == beforeNonInteractiveTokens &&
				transportStats.activeLanes.Load() == beforeLanes &&
				transportStats.admittedRequests.Load() == beforeAdmitted &&
				transportStats.activeHandlers.Load() == beforeHandlers &&
				transportStats.activeNonInteractiveHandlers.Load() == beforeNonInteractive
		})
	})

	head := func(priority uint8) RequestHead {
		return RequestHead{
			Version:        protocolVersion,
			Method:         "GET",
			URL:            "/large.bin",
			Priority:       priority,
			InitialCredits: 1,
		}
	}
	state := func(id uint32) *requestState {
		session.mu.Lock()
		defer session.mu.Unlock()
		return session.requests[id]
	}

	activeNormal := make([]*requestState, 0, maxActiveNonInteractivePerPeer)
	for id := uint32(1); id <= maxActiveNonInteractivePerPeer; id++ {
		session.begin(lane, id, head(2))
		activeNormal = append(activeNormal, state(id))
	}
	waitForSchedulerCondition(t, "three Normal handlers to start", func() bool {
		session.mu.Lock()
		defer session.mu.Unlock()
		if session.activeHandlers != maxActiveNonInteractivePerPeer ||
			session.activeNonInteractive != maxActiveNonInteractivePerPeer {
			return false
		}
		for _, request := range activeNormal {
			if request == nil || !request.started {
				return false
			}
		}
		return true
	})

	queuedNormal := make([]*requestState, 0, 3)
	for id := uint32(4); id <= 6; id++ {
		session.begin(lane, id, head(2))
		queuedNormal = append(queuedNormal, state(id))
	}
	const criticalID uint32 = 20
	session.begin(lane, criticalID, head(1))
	critical := state(criticalID)

	session.mu.Lock()
	criticalStartedEarly := critical == nil || critical.started
	queuedNormalStartedEarly := false
	badQueuedNormal := (*requestState)(nil)
	for _, request := range queuedNormal {
		if request == nil || request.started {
			queuedNormalStartedEarly = true
			badQueuedNormal = request
			break
		}
	}
	session.mu.Unlock()
	if criticalStartedEarly {
		t.Fatal("critical request started before handler capacity was available")
	}
	if queuedNormalStartedEarly {
		t.Fatalf("queued Normal request unexpectedly started: %+v", badQueuedNormal)
	}

	// Cancellation makes one handler slot available. The dispatcher must select
	// the later Critical request before any older Normal request.
	if !session.cancelRequestState(activeNormal[0].id, activeNormal[0]) {
		t.Fatal("failed to cancel active Normal request")
	}
	waitForSchedulerCondition(t, "Critical request to take the released slot", func() bool {
		session.mu.Lock()
		defer session.mu.Unlock()
		return critical.started
	})

	session.mu.Lock()
	defer session.mu.Unlock()
	if session.activeHandlers != maxActiveNonInteractivePerPeer ||
		session.activeNonInteractive != maxActiveNonInteractivePerPeer {
		t.Fatalf(
			"active handlers=%d noninteractive=%d, want %d each",
			session.activeHandlers,
			session.activeNonInteractive,
			maxActiveNonInteractivePerPeer,
		)
	}
	for _, request := range queuedNormal {
		if request.started {
			t.Fatalf("Normal request %d started before Critical request", request.id)
		}
	}
}

func TestProtocolViolationBudgetClosesPeer(t *testing.T) {
	var closes atomic.Int32
	session := NewPeerSession(nil, func() { closes.Add(1) })
	for i := 0; i < maxProtocolViolationsPerPeer; i++ {
		if !session.noteProtocolViolation() {
			t.Fatalf("violation %d unexpectedly suppressed", i+1)
		}
	}
	deadline := time.Now().Add(time.Second)
	for closes.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := closes.Load(); got != 1 {
		t.Fatalf("close callbacks = %d, want 1", got)
	}
}

func TestGlobalAdmissionSupportsTwentyThousandLongLivedRequests(t *testing.T) {
	if maxGlobalActiveRequests < 20_000 {
		t.Fatalf("global active limit %d is below 20k", maxGlobalActiveRequests)
	}
	if maxGlobalAdmittedRequests < 20_000 {
		t.Fatalf("global admission limit %d is below 20k", maxGlobalAdmittedRequests)
	}
}
