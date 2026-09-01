package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

type recordingResponseSender struct {
	heads        []ResponseHead
	bodies       [][]byte
	ends         []uint32
	bulkAcquires int
	bulkReleases int
	probeClaimed bool
}

func (r *recordingResponseSender) AcquireBulk(context.Context) (func(), error) {
	r.bulkAcquires++
	return func() { r.bulkReleases++ }, nil
}

func (r *recordingResponseSender) ClaimRouteProbe() bool {
	if r.probeClaimed {
		return false
	}
	r.probeClaimed = true
	return true
}

func (r *recordingResponseSender) SendHead(_ uint32, head ResponseHead) error {
	r.heads = append(r.heads, head)
	return nil
}

func (r *recordingResponseSender) SendBody(_ context.Context, _ uint32, chunk []byte) error {
	r.bodies = append(r.bodies, bytes.Clone(chunk))
	return nil
}

func (r *recordingResponseSender) SendEnd(id uint32) error {
	r.ends = append(r.ends, id)
	return nil
}

func TestFrameRoundTrip(t *testing.T) {
	payload := []byte("hello world")
	encoded, err := EncodeFrame(FrameResBody, 42, payload)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(encoded) != headerBytes+len(payload) {
		t.Fatalf("expected %d bytes, got %d", headerBytes+len(payload), len(encoded))
	}

	frame, err := DecodeFrame(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if frame.Type != FrameResBody || frame.RequestID != 42 {
		t.Fatalf("got type=%d id=%d", frame.Type, frame.RequestID)
	}
	if !bytes.Equal(frame.Payload, payload) {
		t.Fatalf("payload mismatch: %q", frame.Payload)
	}
}

// The header is [u8 type][u32be requestId]. Big-endian is load-bearing: the
// TypeScript side uses DataView.setUint32(_, false).
func TestRequestIDIsBigEndian(t *testing.T) {
	encoded, err := EncodeFrame(FrameReq, 0x01020304, nil)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := []byte{byte(FrameReq), 0x01, 0x02, 0x03, 0x04}
	if !bytes.Equal(encoded, want) {
		t.Fatalf("header mismatch: got % x want % x", encoded, want)
	}
}

func TestRequestIDZeroIsReserved(t *testing.T) {
	if _, err := EncodeFrame(FrameReq, 0, nil); err == nil {
		t.Fatal("requestId 0 must fail loudly, not encode")
	}
}

func TestOversizePayloadRejected(t *testing.T) {
	if _, err := EncodeFrame(FrameResBody, 1, make([]byte, maxPayloadBytes+1)); err == nil {
		t.Fatal("payload above the cap must be rejected; callers must chunk first")
	}
	if _, err := EncodeFrame(FrameResBody, 1, make([]byte, maxPayloadBytes)); err != nil {
		t.Fatalf("exactly at the cap must encode: %v", err)
	}
}

func TestDecodeRejectsGarbage(t *testing.T) {
	if _, err := DecodeFrame([]byte{1, 2}); err == nil {
		t.Fatal("short frame must be rejected")
	}
	if _, err := DecodeFrame([]byte{99, 0, 0, 0, 1}); err == nil {
		t.Fatal("unknown frame type must be rejected")
	}
	oversized := make([]byte, maxFrameBytes+1)
	oversized[0] = byte(FrameReqBody)
	binary.BigEndian.PutUint32(oversized[1:5], 1)
	if _, err := DecodeFrame(oversized); err == nil {
		t.Fatal("frame above the wire cap must be rejected on decode")
	}
}

func TestResponseCreditFrame(t *testing.T) {
	payload := make([]byte, 4)
	binary.BigEndian.PutUint32(payload, 7)
	encoded, err := EncodeFrame(FrameCredit, 23, payload)
	if err != nil {
		t.Fatalf("encode credit: %v", err)
	}
	frame, err := DecodeFrame(encoded)
	if err != nil {
		t.Fatalf("decode credit: %v", err)
	}
	count, ok := decodeCreditPayload(frame.Payload)
	if !ok || count != 7 {
		t.Fatalf("credit payload decoded as count=%d ok=%v", count, ok)
	}
	for _, malformed := range [][]byte{nil, {0}, {0, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 1, 0}} {
		if _, ok := decodeCreditPayload(malformed); ok {
			t.Fatalf("malformed credit %v was accepted", malformed)
		}
	}
}

func TestV3RequestCreditFrame(t *testing.T) {
	encoded, err := encodeCreditFrame(FrameReqCredit, 29, maxRequestCredits)
	if err != nil {
		t.Fatalf("encode request credit: %v", err)
	}
	frame, err := DecodeFrame(encoded)
	if err != nil {
		t.Fatalf("decode request credit: %v", err)
	}
	if frame.Type != FrameReqCredit || frame.RequestID != 29 {
		t.Fatalf("decoded request credit type=%d id=%d", frame.Type, frame.RequestID)
	}
	count, ok := decodeCreditPayload(frame.Payload)
	if !ok || count != maxRequestCredits {
		t.Fatalf("request credit count=%d ok=%v, want %d", count, ok, maxRequestCredits)
	}
	if _, err := encodeCreditFrame(FrameReqCredit, 29, 0); err == nil {
		t.Fatal("zero request credit encoded successfully")
	}
	if _, err := encodeCreditFrame(FrameReqBody, 29, 1); err == nil {
		t.Fatal("non-credit frame encoded through credit helper")
	}
}

func TestLateResponseCreditsForMissingOrCompletedRequestsAreIgnored(t *testing.T) {
	creditPayload := make([]byte, 4)
	binary.BigEndian.PutUint32(creditPayload, 4)
	creditFrame, err := EncodeFrame(FrameCredit, 77, creditPayload)
	if err != nil {
		t.Fatalf("encode credit: %v", err)
	}
	lane := &sessionLane{id: controlLaneID}

	for _, test := range []struct {
		name  string
		setup func(*PeerSession)
	}{
		{name: "missing"},
		{
			name: "completed",
			setup: func(session *PeerSession) {
				// Model the state transition performed by cancelRequestState after
				// RES_END: the peer-global request ID is no longer active.
				session.requests[77] = &requestState{id: 77, lane: lane}
				delete(session.requests, 77)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			session := NewPeerSession(nil, nil)
			if test.setup != nil {
				test.setup(session)
			}
			// More than the violation budget reproduces the production failure:
			// the old behavior closed all lanes after eight late refill batches.
			for range maxProtocolViolationsPerPeer + 2 {
				session.OnMessage(lane, creditFrame)
			}
			session.mu.Lock()
			violations := session.protocolViolations
			session.mu.Unlock()
			if violations != 0 {
				t.Fatalf("late credits recorded %d protocol violations", violations)
			}
		})
	}
}

func TestResponseCreditForActiveRequestOnWrongLaneIsRejected(t *testing.T) {
	creditPayload := make([]byte, 4)
	binary.BigEndian.PutUint32(creditPayload, 3)
	creditFrame, err := EncodeFrame(FrameCredit, 91, creditPayload)
	if err != nil {
		t.Fatalf("encode credit: %v", err)
	}

	requestLane := &sessionLane{id: controlLaneID}
	wrongLane := &sessionLane{id: 1}
	credits := newResponseCreditWindow(0)
	session := NewPeerSession(nil, nil)
	session.requests[91] = &requestState{id: 91, lane: requestLane, credits: credits}
	session.OnMessage(wrongLane, creditFrame)

	session.mu.Lock()
	violations := session.protocolViolations
	session.mu.Unlock()
	credits.mu.Lock()
	available := credits.available
	credits.mu.Unlock()
	if violations != 1 {
		t.Fatalf("wrong-lane credit recorded %d violations, want 1", violations)
	}
	if available != 0 {
		t.Fatalf("wrong-lane credit granted %d response frames", available)
	}

	// The same frame on its owning lane remains valid.
	session.OnMessage(requestLane, creditFrame)
	credits.mu.Lock()
	available = credits.available
	credits.mu.Unlock()
	if available != 3 {
		t.Fatalf("owning-lane credit granted %d response frames, want 3", available)
	}
}

func TestResponseCreditWindowCapsAndWakes(t *testing.T) {
	w := newResponseCreditWindow(0)
	wake := w.wake
	w.grant(math.MaxUint32)
	for i := uint32(0); i < maxResponseCredits; i++ {
		if err := w.take(context.Background()); err != nil {
			t.Fatalf("take credit %d: %v", i, err)
		}
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := w.take(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("credit count exceeded cap: take returned %v", err)
	}

	result := make(chan error, 1)
	go func() { result <- w.take(context.Background()) }()
	w.grant(1)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("woken credit waiter: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("grant did not wake credit waiter")
	}
	if w.wake != wake {
		t.Fatal("response-credit grant replaced its reusable wake channel")
	}
}

func TestResponseCreditWindowWakesAllCreditedWaiters(t *testing.T) {
	const waiters = 4
	w := newResponseCreditWindow(0)
	results := make(chan error, waiters)
	for range waiters {
		go func() { results <- w.take(context.Background()) }()
	}
	w.grant(waiters)
	for i := 0; i < waiters; i++ {
		select {
		case err := <-results:
			if err != nil {
				t.Fatalf("waiter %d returned %v", i, err)
			}
		case <-time.After(time.Second):
			t.Fatalf("waiter %d remained blocked with available credit", i)
		}
	}
}

func TestV3RequiresVersionAndInitialCredits(t *testing.T) {
	var legacy RequestHead
	if err := json.Unmarshal([]byte(`{"method":"GET","url":"/","headers":[],"hasBody":false}`), &legacy); err != nil {
		t.Fatalf("decode legacy request: %v", err)
	}
	if err := validateRequestHead(legacy); err == nil {
		t.Fatal("v3 lane accepted a request without version and initial credits")
	}

	olderVersion := RequestHead{
		Version: 2, Method: http.MethodGet, URL: "/asset.js", Priority: 1, InitialCredits: 16,
	}
	if err := validateRequestHead(olderVersion); err == nil {
		t.Fatal("older-protocol request head was accepted")
	}

	v3 := RequestHead{
		Version: protocolVersion, Method: http.MethodPost, URL: "/apiv2/upload", Priority: 0, InitialCredits: 16,
	}
	if err := validateRequestHead(v3); err != nil {
		t.Fatalf("valid v3 request rejected: %v", err)
	}
	v3.InitialCredits = maxResponseCredits + 1
	if err := validateRequestHead(v3); err == nil {
		t.Fatal("v3 request exceeded the bounded response-credit window")
	}
}

func TestOnlyExactV3LaneLabelsAreAccepted(t *testing.T) {
	for laneID := range transportLaneCount {
		got, err := parseLaneLabel(laneLabelPrefix + strconv.Itoa(laneID))
		if err != nil || got != laneID {
			t.Fatalf("v3 lane %d parsed as id=%d err=%v", laneID, got, err)
		}
	}
	for _, invalid := range []string{
		"", "yuriRTC", "yuriRTC-v1/0", "yuriRTC-v2/0", "yuriRTC-v2/3",
		"yuriRTC-v3/-1", "yuriRTC-v3/4", "yuriRTC-v3/01", "unrelated",
	} {
		got, err := parseLaneLabel(invalid)
		if err == nil {
			t.Fatalf("invalid label %q parsed as id=%d", invalid, got)
		}
	}
}

func TestV3BufferWatermarksPreserveInteractiveReserve(t *testing.T) {
	if aggregateBufferHighWater != 4*1024*1024 ||
		bulkBufferHighWater != 3*1024*1024 ||
		aggregateBufferLowWater != 1*1024*1024 {
		t.Fatalf(
			"v3 watermarks = aggregate %d bulk %d low %d",
			aggregateBufferHighWater,
			bulkBufferHighWater,
			aggregateBufferLowWater,
		)
	}
	if bulkBufferHighWater >= aggregateBufferHighWater {
		t.Fatal("bulk high-water marks must preserve control-lane reserve")
	}
}

func TestOlderProtocolLaneClosesPeerImmediately(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new peer connection: %v", err)
	}
	defer pc.Close()
	channel, err := pc.CreateDataChannel("yuriRTC-v2/0", nil)
	if err != nil {
		t.Fatalf("create legacy lane: %v", err)
	}

	closed := make(chan struct{}, 1)
	session := NewPeerSession(nil, func() { closed <- struct{}{} })
	if err := session.Attach(channel); err == nil {
		t.Fatal("older-protocol lane was accepted")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("legacy lane did not trigger immediate peer close")
	}
}

func TestOlderProtocolRequestHeadIsRejectedOnV3Lane(t *testing.T) {
	session := NewPeerSession(nil, nil)
	var sent []byte
	lane := &sessionLane{
		id:   controlLaneID,
		peer: session,
		sendOverride: func(frame []byte) error {
			sent = bytes.Clone(frame)
			return nil
		},
	}
	session.lanes[controlLaneID].Store(lane)
	head := RequestHead{
		Version:        2,
		Method:         http.MethodGet,
		URL:            "/asset.js",
		InitialCredits: 8,
	}
	request, err := EncodeJSONFrame(FrameReq, 71, head)
	if err != nil {
		t.Fatal(err)
	}
	session.OnMessage(lane, request)

	if session.request(71) != nil {
		t.Fatal("older-protocol request was admitted on a v3 lane")
	}
	if session.protocolViolations != 1 {
		t.Fatalf("legacy head recorded %d violations, want 1", session.protocolViolations)
	}
	terminal, err := DecodeFrame(sent)
	if err != nil || terminal.Type != FrameResErr {
		t.Fatalf("legacy head terminal frame = type %d err %v", terminal.Type, err)
	}
	var payload ProtocolErrorPayload
	if err := json.Unmarshal(terminal.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != "UNSUPPORTED_PROTOCOL" {
		t.Fatalf("legacy head error code = %q", payload.Code)
	}
}

// The payload must be copied, not aliased: the transport recycles its receive
// buffer and a retained slice would silently corrupt.
func TestDecodeCopiesPayload(t *testing.T) {
	buf := []byte{byte(FrameResBody), 0, 0, 0, 1, 'a', 'b'}
	frame, err := DecodeFrame(buf)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	buf[5] = 'z'
	if frame.Payload[0] != 'a' {
		t.Fatal("payload aliases the input buffer")
	}
}

func TestDecodeFrameViewBorrowsPayload(t *testing.T) {
	buf := []byte{byte(FrameReqBody), 0, 0, 0, 1, 'a', 'b'}
	frame, err := decodeFrameView(buf)
	if err != nil {
		t.Fatalf("decode view: %v", err)
	}
	buf[5] = 'z'
	if frame.Payload[0] != 'z' {
		t.Fatal("view decoder copied its owned input buffer")
	}
}

func TestJSONFrameRoundTrip(t *testing.T) {
	head := ResponseHead{
		Status: 200, StatusText: "OK",
		Headers: HeaderPairs{{"set-cookie", "sid=a"}, {"set-cookie", "other=b"}},
	}
	encoded, err := EncodeJSONFrame(FrameResHead, 7, head)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	frame, err := DecodeFrame(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	var decoded ResponseHead
	if err := json.Unmarshal(frame.Payload, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Duplicates must survive: Set-Cookie is why headers are pairs, not a map.
	if len(decoded.Headers) != 2 {
		t.Fatalf("duplicate headers lost: %+v", decoded.Headers)
	}
}

func TestHeaderValueIsCaseInsensitive(t *testing.T) {
	h := HeaderPairs{{"Range", "bytes=0-10"}}
	if headerValue(h, "range") != "bytes=0-10" {
		t.Fatal("header lookup must be case-insensitive")
	}
	if headerValue(h, "missing") != "" {
		t.Fatal("absent header must return empty")
	}
}

func TestParseRange(t *testing.T) {
	const size = 100
	cases := []struct {
		raw                string
		wantStart, wantEnd int64
		ok                 bool
	}{
		{"bytes=0-49", 0, 49, true},
		{"bytes=50-", 50, 99, true},
		{"bytes=-10", 90, 99, true},    // suffix form
		{"bytes=0-999", 0, 99, true},   // clamped to size
		{"bytes=100-", 0, 0, false},    // start at EOF
		{"bytes=60-50", 0, 0, false},   // inverted
		{"bytes=0-1,5-6", 0, 0, false}, // multipart is not supported
		{"items=0-1", 0, 0, false},
		{"garbage", 0, 0, false},
	}
	for _, c := range cases {
		start, end, ok := parseRange(c.raw, size)
		if ok != c.ok {
			t.Fatalf("%q: ok=%v want %v", c.raw, ok, c.ok)
		}
		if ok && (start != c.wantStart || end != c.wantEnd) {
			t.Fatalf("%q: got %d-%d want %d-%d", c.raw, start, end, c.wantStart, c.wantEnd)
		}
	}
}

func TestUnsatisfiableRangeTerminatesResponse(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "asset.bin"), []byte("data"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	h := NewHandler(root, "http://127.0.0.1:1801")
	out := &recordingResponseSender{}
	head := RequestHead{Method: "GET", Headers: HeaderPairs{{"range", "bytes=99-"}}}
	if err := h.static(context.Background(), out, 17, head, "/asset.bin"); err != nil {
		t.Fatalf("serve range: %v", err)
	}

	if len(out.heads) != 1 || out.heads[0].Status != 416 {
		t.Fatalf("expected one 416 head, got %+v", out.heads)
	}
	if len(out.bodies) != 0 {
		t.Fatalf("416 must not carry body frames, got %d", len(out.bodies))
	}
	if len(out.ends) != 1 || out.ends[0] != 17 {
		t.Fatalf("416 must terminate request 17, got end ids %v", out.ends)
	}
}

func TestLargeStaticResponseUsesBulkSlot(t *testing.T) {
	root := t.TempDir()
	payload := bytes.Repeat([]byte{'x'}, bulkResponseThreshold)
	if err := os.WriteFile(filepath.Join(root, "large.bin"), payload, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	h := NewHandler(root, "http://127.0.0.1:1801")
	out := &recordingResponseSender{}
	if err := h.static(context.Background(), out, 31, RequestHead{Method: "GET"}, "/large.bin"); err != nil {
		t.Fatalf("serve large response: %v", err)
	}
	if out.bulkAcquires != 1 || out.bulkReleases != 1 {
		t.Fatalf("bulk acquires=%d releases=%d, want one of each", out.bulkAcquires, out.bulkReleases)
	}

	out = &recordingResponseSender{}
	if err := h.static(context.Background(), out, 32, RequestHead{Method: "HEAD"}, "/large.bin"); err != nil {
		t.Fatalf("serve HEAD response: %v", err)
	}
	if out.bulkAcquires != 0 || out.bulkReleases != 0 {
		t.Fatalf("HEAD unexpectedly occupied a bulk slot")
	}
}

func TestSSEStreamUsesSmallBuffers(t *testing.T) {
	payload := bytes.Repeat([]byte("event: message\ndata: x\n\n"), 500)
	out := &recordingResponseSender{}
	if err := streamSSE(context.Background(), out, 71, bytes.NewReader(payload), -1); err != nil {
		t.Fatalf("stream SSE: %v", err)
	}
	for i, chunk := range out.bodies {
		if len(chunk) > sseBufferBytes {
			t.Fatalf("SSE chunk %d retained %d bytes, limit is %d", i, len(chunk), sseBufferBytes)
		}
	}
	if got := bytes.Join(out.bodies, nil); !bytes.Equal(got, payload) {
		t.Fatalf("SSE payload changed: got %d bytes, want %d", len(got), len(payload))
	}
}

func TestBulkSlotsAreBoundedAndCancellable(t *testing.T) {
	session := NewPeerSession(nil, nil)
	releases := make([]func(), 0, maxConcurrentBulkResponses)
	for range maxConcurrentBulkResponses {
		release, err := session.AcquireBulk(context.Background())
		if err != nil {
			t.Fatalf("fill bulk slot: %v", err)
		}
		releases = append(releases, release)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := session.AcquireBulk(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("over-capacity acquire returned %v", err)
	}

	releases[0]()
	release, err := session.AcquireBulk(context.Background())
	if err != nil {
		t.Fatalf("reacquire released bulk slot: %v", err)
	}
	release()
	for _, release := range releases[1:] {
		release()
	}
}

func TestResolveRefusesTraversal(t *testing.T) {
	h := NewHandler("/srv/root", "http://127.0.0.1:1801")
	for _, bad := range []string{"/../etc/passwd", "/a/../../etc/passwd", "/..%2f"} {
		if _, err := h.resolve(bad); err == nil {
			// Clean() may normalise some of these; the check is that nothing
			// resolves outside the root.
			resolved, _ := h.resolve(bad)
			if len(resolved) > 0 && resolved[:len("/srv/root")] != "/srv/root" {
				t.Fatalf("%q escaped the root: %s", bad, resolved)
			}
		}
	}
	ok, err := h.resolve("/a/app.js")
	if err != nil || ok != "/srv/root/a/app.js" {
		t.Fatalf("legitimate path broke: %s %v", ok, err)
	}
}

// A raced offer arrives on both legs. Answering twice would open two peer
// connections and leak one.
func TestDedupeClaimsOnce(t *testing.T) {
	d := NewDedupe(time.Minute)
	first, leader := d.Join("session-a")
	if !leader {
		t.Fatal("first claim must succeed")
	}
	second, leader := d.Join("session-a")
	if leader {
		t.Fatal("second claim for the same session must be refused")
	}
	if first != second {
		t.Fatal("duplicate callers must share one result slot")
	}
	if _, leader := d.Join("session-b"); !leader {
		t.Fatal("a different session must still be claimable")
	}
}

func TestDedupeExpires(t *testing.T) {
	d := NewDedupe(10 * time.Millisecond)
	d.Join("s")
	time.Sleep(25 * time.Millisecond)
	if _, leader := d.Join("s"); !leader {
		t.Fatal("entries must expire so a reconnecting client is not blocked forever")
	}
}

func TestDedupePrunesLargeExpiredWindow(t *testing.T) {
	d := NewDedupe(time.Minute)
	old := time.Now().Add(-2 * time.Minute)
	for i := 0; i < 20_000; i++ {
		_, leader := d.Join(fmt.Sprintf("expired-%d", i))
		if !leader {
			t.Fatalf("entry %d unexpectedly duplicated", i)
		}
	}
	for _, record := range d.order {
		record.entry.at = old
	}

	if _, leader := d.Join("current"); !leader {
		t.Fatal("current entry was not accepted")
	}
	if len(d.seen) != 1 || len(d.order) != 1 || d.head != 0 {
		t.Fatalf("expired window was not reclaimed: seen=%d order=%d head=%d", len(d.seen), len(d.order), d.head)
	}
}

// The HTTP backend mounts its routes at root, so forwarding the public prefix
// intact would make every API call miss.
func TestAPIPrefixIsStripped(t *testing.T) {
	cases := map[string]string{
		"/apiv2/ai":         "/ai",
		"/apiv2/chat/list":  "/chat/list",
		"/apiv2/":           "/",
		"/apiv2":            "/",
		"/apiv2/apiv2/deep": "/apiv2/deep", // only the leading prefix goes
	}
	for in, want := range cases {
		got := strings.TrimPrefix(in, apiPrefix)
		if got == "" {
			got = "/"
		}
		if got != want {
			t.Fatalf("%q -> %q, want %q", in, got, want)
		}
	}
}

func TestAPIProxyMarksSecureOriginAndPreservesSessionCookie(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Forwarded-Proto"); got != "https" {
			t.Fatalf("X-Forwarded-Proto=%q, want https", got)
		}
		http.SetCookie(w, &http.Cookie{Name: "sid", Value: "session-token", Path: "/", Secure: true, HttpOnly: true})
		_, _ = w.Write([]byte("signed-in"))
	}))
	defer backend.Close()

	h := NewHandler(t.TempDir(), backend.URL)
	out := &recordingResponseSender{}
	head := RequestHead{
		Method:  http.MethodGet,
		URL:     "/apiv2/session",
		Headers: HeaderPairs{{"x-forwarded-proto", "http"}},
	}
	if err := h.Serve(context.Background(), out, 41, head, nil); err != nil {
		t.Fatalf("proxy session request: %v", err)
	}
	if len(out.heads) != 1 || out.heads[0].Status != http.StatusOK {
		t.Fatalf("unexpected response heads: %+v", out.heads)
	}
	var cookie string
	for _, pair := range out.heads[0].Headers {
		if strings.EqualFold(pair[0], "set-cookie") {
			cookie = pair[1]
		}
	}
	if !strings.Contains(cookie, "sid=session-token") || !strings.Contains(cookie, "Secure") {
		t.Fatalf("session cookie was not preserved: %q", cookie)
	}
	if got := string(bytes.Join(out.bodies, nil)); got != "signed-in" {
		t.Fatalf("proxied body=%q, want signed-in", got)
	}
}

// Both signaling legs must receive the same answer. Discarding the duplicate
// made fallback impossible when the primary return path was blocked.
func TestDuplicateLegReusesAnswer(t *testing.T) {
	answered := 0
	replied := 0
	sig := &Signaler{dedupe: NewDedupe(time.Minute), answer: func(context.Context, OfferBlob) (AnswerBlob, error) {
		answered++
		return AnswerBlob{SDP: "v=0-answer"}, nil
	}}
	offer := OfferBlob{SessionID: "s1", SDP: "v=0"}
	for _, leg := range []string{"firestore", "rtdb"} {
		sig.handle(context.Background(), leg, offer, func(answer AnswerBlob) error {
			if answer.SDP != "v=0-answer" {
				t.Fatalf("unexpected shared answer: %+v", answer)
			}
			replied++
			return nil
		}, func() { t.Fatal("a valid duplicate must not be discarded") })
	}
	if answered != 1 || replied != 2 {
		t.Fatalf("answer calls=%d replies=%d, want 1 and 2", answered, replied)
	}
}

func TestMalformedOfferDiscards(t *testing.T) {
	discarded := false
	sig := &Signaler{dedupe: NewDedupe(time.Minute)}
	sig.handle(context.Background(), "rtdb", OfferBlob{SessionID: "", SDP: ""},
		func(AnswerBlob) error { return nil }, func() { discarded = true })
	if !discarded {
		t.Fatal("a malformed offer must be cleaned up, not left to accumulate")
	}
}

func TestAnswerFailureDiscards(t *testing.T) {
	discarded := false
	sig := &Signaler{
		dedupe: NewDedupe(time.Minute),
		answer: func(context.Context, OfferBlob) (AnswerBlob, error) {
			return AnswerBlob{}, errors.New("could not create peer connection")
		},
	}
	sig.handle(context.Background(), "firestore", OfferBlob{SessionID: "s", SDP: "v=0"},
		func(AnswerBlob) error { t.Fatal("must not reply after answer failure"); return nil },
		func() { discarded = true })
	if !discarded {
		t.Fatal("an offer that cannot be answered must be removed")
	}
}

func TestReplyFailureDiscards(t *testing.T) {
	discarded := false
	sig := &Signaler{
		dedupe: NewDedupe(time.Minute),
		answer: func(context.Context, OfferBlob) (AnswerBlob, error) {
			return AnswerBlob{SDP: "v=0"}, nil
		},
	}
	sig.handle(context.Background(), "rtdb", OfferBlob{SessionID: "s", SDP: "v=0"},
		func(AnswerBlob) error { return errors.New("write failed") },
		func() { discarded = true })
	if !discarded {
		t.Fatal("an offer whose answer cannot be written must be removed")
	}
}

func TestFirestoreAnswerDocumentReplacesOffer(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	want := AnswerBlob{SDP: "v=0", Candidates: []json.RawMessage{json.RawMessage(`{"candidate":"c"}`)}}
	fields, err := firestoreAnswerDocument(want, now)
	if err != nil {
		t.Fatalf("encode answer document: %v", err)
	}
	if len(fields) != 2 {
		t.Fatalf("answer replacement must contain only answer and expireAt, got %v", fields)
	}
	if _, retained := fields["offer"]; retained {
		t.Fatal("answer replacement retained the duplicated offer")
	}
	if got, ok := fields["expireAt"].(time.Time); !ok || !got.Equal(now.Add(5*time.Minute)) {
		t.Fatalf("unexpected expiry: %#v", fields["expireAt"])
	}

	encoded, ok := fields["answer"].(string)
	if !ok {
		t.Fatalf("answer is not a string: %#v", fields["answer"])
	}
	var got AnswerBlob
	if err := json.Unmarshal([]byte(encoded), &got); err != nil {
		t.Fatalf("decode stored answer: %v", err)
	}
	if got.SDP != want.SDP || len(got.Candidates) != 1 || !bytes.Equal(got.Candidates[0], want.Candidates[0]) {
		t.Fatalf("stored answer mismatch: got %+v want %+v", got, want)
	}
}
