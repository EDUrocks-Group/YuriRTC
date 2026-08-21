package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

type v3LaneResult struct {
	requestID uint32
	opened    chan struct{}
	done      chan error
	openOnce  sync.Once
	doneOnce  sync.Once
	mu        sync.Mutex
	body      bytes.Buffer
}

func newV3TestLane(t *testing.T, pc *webrtc.PeerConnection, laneID int, requestID uint32) (*webrtc.DataChannel, *v3LaneResult) {
	t.Helper()
	result := &v3LaneResult{requestID: requestID, opened: make(chan struct{}), done: make(chan error, 1)}
	channel, err := pc.CreateDataChannel(laneLabelPrefix+strconv.Itoa(laneID), &webrtc.DataChannelInit{Ordered: boolPointer(true)})
	if err != nil {
		t.Fatalf("create v3 lane %d: %v", laneID, err)
	}
	channel.OnOpen(func() { result.openOnce.Do(func() { close(result.opened) }) })
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if message.IsString {
			return
		}
		frame, err := DecodeFrame(message.Data)
		if err != nil {
			result.finish(err)
			return
		}
		if frame.RequestID != result.requestID {
			result.finish(fmt.Errorf("lane %d received request %d, want %d", laneID, frame.RequestID, result.requestID))
			return
		}
		switch frame.Type {
		case FrameResBody:
			result.mu.Lock()
			_, _ = result.body.Write(frame.Payload)
			result.mu.Unlock()
		case FrameResErr:
			var payload ProtocolErrorPayload
			if err := json.Unmarshal(frame.Payload, &payload); err != nil {
				result.finish(err)
			} else {
				result.finish(fmt.Errorf("server response error %s: %s", payload.Code, payload.Message))
			}
		case FrameResEnd:
			result.finish(nil)
		}
	})
	return channel, result
}

func (r *v3LaneResult) finish(err error) {
	r.doneOnce.Do(func() { r.done <- err })
}

func (r *v3LaneResult) bytes() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return bytes.Clone(r.body.Bytes())
}

func boolPointer(value bool) *bool { return &value }

func TestResolveICEPorts(t *testing.T) {
	tests := []struct {
		name     string
		list     string
		override int
		want     []int
		wantErr  bool
	}{
		{name: "defaults", list: defaultICEPorts, want: []int{443, 80, 49152}},
		{name: "whitespace", list: " 443, 80 ,49152 ", want: []int{443, 80, 49152}},
		{name: "legacy override", list: "not-used", override: 8443, want: []int{8443}},
		{name: "empty", list: "", wantErr: true},
		{name: "empty member", list: "443,,80", wantErr: true},
		{name: "not a number", list: "443,http", wantErr: true},
		{name: "zero", list: "0", wantErr: true},
		{name: "too large", list: "65536", wantErr: true},
		{name: "duplicate", list: "443,80,443", wantErr: true},
		{name: "bad legacy override", list: defaultICEPorts, override: 65536, wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveICEPorts(test.list, test.override)
			if test.wantErr {
				if err == nil {
					t.Fatalf("resolveICEPorts(%q, %d) unexpectedly succeeded: %v", test.list, test.override, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveICEPorts(%q, %d): %v", test.list, test.override, err)
			}
			if formatPorts(got) != formatPorts(test.want) {
				t.Fatalf("resolveICEPorts(%q, %d) = %v, want %v", test.list, test.override, got, test.want)
			}
		})
	}
}

func TestMultiPortTransportRejectsWildcardBind(t *testing.T) {
	rtc, err := buildTransport(options{
		bindIP:   "0.0.0.0",
		publicIP: "203.0.113.77",
		ports:    []int{443, 80, 49152},
	})
	if rtc != nil {
		_ = rtc.Close()
		t.Fatal("wildcard bind unexpectedly returned a transport")
	}
	if err == nil || !strings.Contains(err.Error(), "specific IPv4") {
		t.Fatalf("wildcard bind error = %v", err)
	}
}

func TestMultiPortTransportAdvertisesEveryUDPAndTCPPort(t *testing.T) {
	bindIP := net.IPv4(127, 0, 0, 1)
	ports := freeDualPorts(t, bindIP, 3)
	const publicIP = "203.0.113.77"

	rtc, err := buildTransport(options{
		bindIP:   bindIP.String(),
		publicIP: publicIP,
		ports:    ports,
	})
	if err != nil {
		t.Fatalf("build multi-port transport: %v", err)
	}
	defer func() {
		if err := rtc.Close(); err != nil {
			t.Errorf("close multi-port transport: %v", err)
		}
	}()

	pc, err := rtc.API.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new peer connection: %v", err)
	}
	defer func() { _ = pc.Close() }()
	if _, err := pc.CreateDataChannel("candidate-test", nil); err != nil {
		t.Fatalf("create data channel: %v", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("ICE gathering did not complete")
	}

	local := pc.LocalDescription()
	if local == nil {
		t.Fatal("ICE gathering completed without a local description")
	}
	candidates := parseSDPCandidates(t, local.SDP)
	if len(candidates) == 0 {
		t.Fatalf("gathered no ICE candidates:\n%s", local.SDP)
	}

	allowedPorts := make(map[int]bool, len(ports))
	for _, port := range ports {
		allowedPorts[port] = true
	}
	// Pion currently emits component 1 and 2 aliases for a data-only m-line.
	// Assert the six underlying protocol/port pairs through component 1 while
	// still validating every alias, so a harmless component-policy change does
	// not make this transport wiring test brittle.
	seen := make(map[string]bool, len(ports)*2)
	for _, candidate := range candidates {
		if candidate.address != publicIP {
			t.Errorf("candidate address = %q, want explicit public IP %q", candidate.address, publicIP)
		}
		if candidate.protocol != "udp" && candidate.protocol != "tcp" {
			t.Errorf("unexpected candidate protocol %q", candidate.protocol)
			continue
		}
		if !allowedPorts[candidate.port] {
			t.Errorf("candidate advertised unconfigured port %d", candidate.port)
		}
		if candidate.protocol == "tcp" && candidate.tcpType != "passive" {
			t.Errorf("TCP candidate on %d has tcptype %q, want passive", candidate.port, candidate.tcpType)
		}
		if candidate.component != 1 {
			continue
		}
		key := candidate.protocol + "/" + strconv.Itoa(candidate.port)
		if seen[key] {
			t.Errorf("duplicate component-1 candidate %s", key)
		}
		seen[key] = true
	}
	for _, port := range ports {
		for _, protocol := range []string{"udp", "tcp"} {
			key := protocol + "/" + strconv.Itoa(port)
			if !seen[key] {
				t.Errorf("missing component-1 candidate %s", key)
			}
		}
	}
}

func TestDisabledMDNSStillAllowsBrowserInitiatedChecks(t *testing.T) {
	bindIP := net.IPv4(127, 0, 0, 1)
	ports := freeDualPorts(t, bindIP, 3)
	rtc, err := buildTransport(options{
		bindIP: bindIP.String(), publicIP: bindIP.String(), ports: ports,
	})
	if err != nil {
		t.Fatalf("build transport: %v", err)
	}
	defer rtc.Close()

	clientSettings := webrtc.SettingEngine{}
	clientSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	clientSettings.SetIncludeLoopbackCandidate(true)
	clientSettings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	clientAPI := webrtc.NewAPI(webrtc.WithSettingEngine(clientSettings))
	client, err := clientAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	defer client.Close()
	opened := make(chan struct{})
	channel, err := client.CreateDataChannel(laneLabelPrefix+"0", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}
	channel.OnOpen(func() { close(opened) })

	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(client)
	if err := client.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local offer: %v", err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("client ICE gathering timed out")
	}
	local := client.LocalDescription()
	if local == nil {
		t.Fatal("client has no local description")
	}

	// Chrome commonly exposes host candidates as random .local names. The
	// server deliberately does not open per-peer mDNS sockets to resolve them;
	// the browser's check against a public server candidate establishes the
	// peer-reflexive route instead.
	mdnsOffer := replaceCandidateAddresses(local.SDP, "capacity-browser.local")
	registry := newPeerRegistry()
	defer registry.CloseAll()
	answer, err := answerOffer(
		context.Background(), rtc.API, NewHandler(t.TempDir(), "http://127.0.0.1:1"), registry,
		OfferBlob{SessionID: "mdns-browser", SDP: mdnsOffer},
	)
	if err != nil {
		t.Fatalf("answer mDNS offer: %v", err)
	}
	if err := client.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatalf("apply answer: %v", err)
	}
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("browser-initiated connectivity check did not open the data channel")
	}

	// The client's send window is the receive window advertised by the node.
	// Wait for DCEP to be acknowledged so no outstanding bytes obscure the exact
	// configured value.
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := client.SCTP().Stats().ReceiverWindow
		if got == sctpMaxReceiveBufferSize {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("node SCTP receive window = %d, want %d", got, sctpMaxReceiveBufferSize)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestV3FourLaneTransferAndBulkLaneReopen(t *testing.T) {
	root := t.TempDir()
	want := make([][]byte, transportLaneCount)
	for laneID := range transportLaneCount {
		size := 48 * 1024
		if laneID != controlLaneID {
			size = 384 * 1024
		}
		want[laneID] = bytes.Repeat([]byte{byte('a' + laneID)}, size)
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("lane-%d.bin", laneID)), want[laneID], 0o600); err != nil {
			t.Fatalf("write lane %d fixture: %v", laneID, err)
		}
	}

	bindIP := net.IPv4(127, 0, 0, 1)
	ports := freeDualPorts(t, bindIP, 3)
	rtc, err := buildTransport(options{bindIP: bindIP.String(), publicIP: bindIP.String(), ports: ports})
	if err != nil {
		t.Fatalf("build v3 test transport: %v", err)
	}
	defer rtc.Close()
	registry := newPeerRegistry()
	defer registry.CloseAll()

	clientSettings := webrtc.SettingEngine{}
	clientSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	clientSettings.SetIncludeLoopbackCandidate(true)
	clientSettings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	client := webrtc.NewAPI(webrtc.WithSettingEngine(clientSettings))
	pc, err := client.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new v3 client peer: %v", err)
	}
	defer pc.Close()

	channels := make([]*webrtc.DataChannel, transportLaneCount)
	results := make([]*v3LaneResult, transportLaneCount)
	for laneID := range transportLaneCount {
		channels[laneID], results[laneID] = newV3TestLane(t, pc, laneID, uint32(laneID+1))
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create v3 offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set v3 local offer: %v", err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("v3 client ICE gathering timed out")
	}
	local := pc.LocalDescription()
	if local == nil {
		t.Fatal("v3 client has no local description")
	}
	answer, err := answerOffer(
		context.Background(), rtc.API, NewHandler(root, "http://127.0.0.1:1"), registry,
		OfferBlob{SessionID: "v3-four-lanes", SDP: local.SDP},
	)
	if err != nil {
		t.Fatalf("answer v3 offer: %v", err)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatalf("apply v3 answer: %v", err)
	}

	for laneID, result := range results {
		select {
		case <-result.opened:
		case <-time.After(5 * time.Second):
			t.Fatalf("v3 lane %d did not open", laneID)
		}
		head := RequestHead{
			Version: protocolVersion, Method: http.MethodGet, URL: fmt.Sprintf("/lane-%d.bin", laneID),
			Priority: uint8(laneID), InitialCredits: 16,
		}
		frame, err := EncodeJSONFrame(FrameReq, result.requestID, head)
		if err != nil {
			t.Fatalf("encode lane %d request: %v", laneID, err)
		}
		if err := channels[laneID].Send(frame); err != nil {
			t.Fatalf("send lane %d request: %v", laneID, err)
		}
	}
	for laneID, result := range results {
		select {
		case err := <-result.done:
			if err != nil {
				t.Fatalf("lane %d response: %v", laneID, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("lane %d response timed out", laneID)
		}
		if got := result.bytes(); !bytes.Equal(got, want[laneID]) {
			t.Fatalf("lane %d body length/content mismatch: got %d want %d", laneID, len(got), len(want[laneID]))
		}
	}

	// A browser can dispatch far more than 64 service-worker fetches even though
	// only a small active subset should run at once. They must queue as request
	// state, not fail at the former per-peer goroutine cap.
	const waterfallRequests = 96
	waterfallDone := make(chan struct{})
	waterfallErr := make(chan error, 1)
	var waterfallOnce sync.Once
	var waterfallMu sync.Mutex
	waterfallEnds := make(map[uint32]struct{}, waterfallRequests)
	channels[0].OnMessage(func(message webrtc.DataChannelMessage) {
		if message.IsString {
			return
		}
		frame, err := DecodeFrame(message.Data)
		if err != nil {
			select {
			case waterfallErr <- err:
			default:
			}
			return
		}
		if frame.RequestID < 100 || frame.RequestID >= 100+waterfallRequests {
			return
		}
		switch frame.Type {
		case FrameResErr:
			select {
			case waterfallErr <- fmt.Errorf("waterfall request %d failed: %s", frame.RequestID, frame.Payload):
			default:
			}
		case FrameResEnd:
			waterfallMu.Lock()
			waterfallEnds[frame.RequestID] = struct{}{}
			complete := len(waterfallEnds) == waterfallRequests
			waterfallMu.Unlock()
			if complete {
				waterfallOnce.Do(func() { close(waterfallDone) })
			}
		}
	})
	for i := 0; i < waterfallRequests; i++ {
		id := uint32(100 + i)
		head := RequestHead{
			Version: protocolVersion, Method: http.MethodGet, URL: "/lane-0.bin",
			Priority: 2, InitialCredits: 1,
		}
		frame, err := EncodeJSONFrame(FrameReq, id, head)
		if err != nil {
			t.Fatalf("encode waterfall request %d: %v", id, err)
		}
		if err := channels[0].Send(frame); err != nil {
			t.Fatalf("send waterfall request %d: %v", id, err)
		}
	}
	select {
	case err := <-waterfallErr:
		t.Fatal(err)
	case <-waterfallDone:
	case <-time.After(10 * time.Second):
		waterfallMu.Lock()
		completed := len(waterfallEnds)
		waterfallMu.Unlock()
		t.Fatalf("waterfall completed %d/%d requests", completed, waterfallRequests)
	}

	bulkClosed := make(chan struct{})
	channels[1].OnClose(func() { close(bulkClosed) })
	if err := channels[1].Close(); err != nil {
		t.Fatalf("close bulk lane: %v", err)
	}
	select {
	case <-bulkClosed:
	case <-time.After(5 * time.Second):
		t.Fatal("bulk lane did not close")
	}
	if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatalf("closing a bulk lane closed peer: %s", pc.ConnectionState())
	}

	replacement, replacementResult := newV3TestLane(t, pc, 1, 1001)
	select {
	case <-replacementResult.opened:
	case <-time.After(5 * time.Second):
		t.Fatal("replacement bulk lane did not open")
	}
	replacementHead := RequestHead{
		Version: protocolVersion, Method: http.MethodGet, URL: "/lane-1.bin", Priority: 1, InitialCredits: 16,
	}
	replacementFrame, err := EncodeJSONFrame(FrameReq, replacementResult.requestID, replacementHead)
	if err != nil {
		t.Fatalf("encode replacement request: %v", err)
	}
	if err := replacement.Send(replacementFrame); err != nil {
		t.Fatalf("send replacement request: %v", err)
	}
	select {
	case err := <-replacementResult.done:
		if err != nil {
			t.Fatalf("replacement response: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("replacement response timed out")
	}
	if got := replacementResult.bytes(); !bytes.Equal(got, want[1]) {
		t.Fatalf("replacement body length/content mismatch: got %d want %d", len(got), len(want[1]))
	}
}

func TestV3UploadUsesInitialAndConsumedCreditBatches(t *testing.T) {
	const (
		requestID    = uint32(7001)
		uploadFrames = 40
		// Exercise the exact wire ceiling through real SCTP/Pion. Smaller chunks
		// would miss receive-buffer boundary regressions in ordinary uploads.
		chunkBytes = maxPayloadBytes
	)
	wantBytes := int64(uploadFrames * chunkBytes)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		got, err := io.Copy(io.Discard, request.Body)
		if err != nil {
			http.Error(response, err.Error(), http.StatusInternalServerError)
			return
		}
		_, _ = fmt.Fprintf(response, "%d", got)
	}))
	defer backend.Close()

	bindIP := net.IPv4(127, 0, 0, 1)
	ports := freeDualPorts(t, bindIP, 3)
	rtc, err := buildTransport(options{bindIP: bindIP.String(), publicIP: bindIP.String(), ports: ports})
	if err != nil {
		t.Fatalf("build v3 test transport: %v", err)
	}
	defer rtc.Close()
	registry := newPeerRegistry()
	defer registry.CloseAll()

	clientSettings := webrtc.SettingEngine{}
	clientSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	clientSettings.SetIncludeLoopbackCandidate(true)
	clientSettings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	clientAPI := webrtc.NewAPI(webrtc.WithSettingEngine(clientSettings))
	pc, err := clientAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new v3 client peer: %v", err)
	}
	defer pc.Close()

	opened := make(chan struct{})
	done := make(chan error, 1)
	creditCounts := make(chan uint32, uploadFrames)
	var doneOnce sync.Once
	var responseMu sync.Mutex
	var responseBody bytes.Buffer
	channel, err := pc.CreateDataChannel(laneLabelPrefix+"0", &webrtc.DataChannelInit{Ordered: boolPointer(true)})
	if err != nil {
		t.Fatalf("create v3 lane: %v", err)
	}
	channel.OnOpen(func() { close(opened) })
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if message.IsString {
			return
		}
		frame, err := DecodeFrame(message.Data)
		if err != nil {
			doneOnce.Do(func() { done <- err })
			return
		}
		if frame.RequestID != requestID {
			doneOnce.Do(func() { done <- fmt.Errorf("received request id %d", frame.RequestID) })
			return
		}
		switch frame.Type {
		case FrameReqCredit:
			count, ok := decodeCreditPayload(frame.Payload)
			if !ok {
				doneOnce.Do(func() { done <- errors.New("malformed v3 request credit") })
				return
			}
			creditCounts <- count
		case FrameResBody:
			responseMu.Lock()
			_, _ = responseBody.Write(frame.Payload)
			responseMu.Unlock()
		case FrameResErr:
			doneOnce.Do(func() { done <- fmt.Errorf("v3 response error: %s", frame.Payload) })
		case FrameResEnd:
			doneOnce.Do(func() { done <- nil })
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create v3 offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set v3 local offer: %v", err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("v3 client ICE gathering timed out")
	}
	local := pc.LocalDescription()
	if local == nil {
		t.Fatal("v3 client has no local description")
	}
	answer, err := answerOffer(
		context.Background(), rtc.API, NewHandler(t.TempDir(), backend.URL), registry,
		OfferBlob{SessionID: "v3-upload-credits", SDP: local.SDP},
	)
	if err != nil {
		t.Fatalf("answer v3 offer: %v", err)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatalf("apply v3 answer: %v", err)
	}
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("v3 lane did not open")
	}

	head := RequestHead{
		Version: protocolVersion, Method: http.MethodPost, URL: "/apiv2/upload", HasBody: true,
		Priority: 0, InitialCredits: 16,
	}
	headFrame, err := EncodeJSONFrame(FrameReq, requestID, head)
	if err != nil {
		t.Fatalf("encode v3 upload request: %v", err)
	}
	if err := channel.Send(headFrame); err != nil {
		t.Fatalf("send v3 upload request: %v", err)
	}

	payload := bytes.Repeat([]byte{'u'}, chunkBytes)
	available := uint32(0)
	grantHistory := make([]uint32, 0, 4)
	for sent := 0; sent < uploadFrames; sent++ {
		for available == 0 {
			select {
			case count := <-creditCounts:
				grantHistory = append(grantHistory, count)
				available += count
			case err := <-done:
				t.Fatalf("request ended before upload frame %d: %v", sent, err)
			case <-time.After(5 * time.Second):
				t.Fatalf("timed out waiting for upload credit before frame %d", sent)
			}
		}
		frame, err := EncodeFrame(FrameReqBody, requestID, payload)
		if err != nil {
			t.Fatalf("encode upload frame %d: %v", sent, err)
		}
		if err := channel.Send(frame); err != nil {
			t.Fatalf("send upload frame %d: %v", sent, err)
		}
		available--
	}
	endFrame, err := EncodeFrame(FrameReqEnd, requestID, nil)
	if err != nil {
		t.Fatalf("encode v3 request end: %v", err)
	}
	if err := channel.Send(endFrame); err != nil {
		t.Fatalf("send v3 request end: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("v3 upload response timed out")
	}
	if len(grantHistory) < 2 || grantHistory[0] != maxRequestCredits {
		t.Fatalf("upload grant history = %v, want initial 16 plus consumed refills", grantHistory)
	}
	granted := grantHistory[0]
	for i, count := range grantHistory[1:] {
		if count == 0 || count > requestCreditBatchSize {
			t.Fatalf("refill %d granted %d frames, want 1..%d", i+1, count, requestCreditBatchSize)
		}
		granted += count
	}
	if granted < uploadFrames {
		t.Fatalf("upload completed after only %d total credits: %v", granted, grantHistory)
	}
	responseMu.Lock()
	gotResponse := responseBody.String()
	responseMu.Unlock()
	if gotResponse != strconv.FormatInt(wantBytes, 10) {
		t.Fatalf("backend received response %q, want %d", gotResponse, wantBytes)
	}
}

func replaceCandidateAddresses(sdp, address string) string {
	lines := strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n")
	for i, line := range lines {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		fields[4] = address
		lines[i] = strings.Join(fields, " ")
	}
	return strings.Join(lines, "\r\n")
}

func TestMultiPortBindRollsBackEveryEarlierSocket(t *testing.T) {
	bindIP := net.IPv4(127, 0, 0, 1)
	ports := freeDualPorts(t, bindIP, 2)

	// Force the last bind to fail: buildTransport opens UDP+TCP on ports[0],
	// then UDP on ports[1], before colliding with this TCP listener.
	blocker, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: bindIP, Port: ports[1]})
	if err != nil {
		t.Fatalf("occupy final TCP port: %v", err)
	}
	defer blocker.Close()

	rtc, err := buildTransport(options{
		bindIP:   bindIP.String(),
		publicIP: bindIP.String(),
		ports:    ports,
	})
	if rtc != nil {
		_ = rtc.Close()
		t.Fatal("buildTransport returned a transport after a partial bind failure")
	}
	if err == nil || !strings.Contains(err.Error(), "tcp") {
		t.Fatalf("buildTransport error = %v, want the final TCP bind failure", err)
	}

	// All three sockets opened by buildTransport before the failure must already
	// be reusable while the deliberately occupied fourth socket remains open.
	assertUDPPortAvailable(t, bindIP, ports[0])
	assertTCPPortAvailable(t, bindIP, ports[0])
	assertUDPPortAvailable(t, bindIP, ports[1])
}

func TestMultiPortTransportCloseReleasesAllSockets(t *testing.T) {
	bindIP := net.IPv4(127, 0, 0, 1)
	ports := freeDualPorts(t, bindIP, 3)
	rtc, err := buildTransport(options{
		bindIP:   bindIP.String(),
		publicIP: bindIP.String(),
		ports:    ports,
	})
	if err != nil {
		t.Fatalf("build transport: %v", err)
	}
	if err := rtc.Close(); err != nil {
		t.Fatalf("close transport: %v", err)
	}
	if err := rtc.Close(); err != nil {
		t.Fatalf("idempotent close: %v", err)
	}
	for _, port := range ports {
		assertUDPPortAvailable(t, bindIP, port)
		assertTCPPortAvailable(t, bindIP, port)
	}
}

type sdpCandidate struct {
	protocol  string
	address   string
	port      int
	component int
	tcpType   string
}

func parseSDPCandidates(t *testing.T, sdp string) []sdpCandidate {
	t.Helper()
	var candidates []sdpCandidate
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 8 {
			t.Fatalf("malformed candidate line %q", line)
		}
		port, err := strconv.Atoi(fields[5])
		if err != nil {
			t.Fatalf("candidate port in %q: %v", line, err)
		}
		component, err := strconv.Atoi(fields[1])
		if err != nil {
			t.Fatalf("candidate component in %q: %v", line, err)
		}
		candidate := sdpCandidate{
			protocol:  strings.ToLower(fields[2]),
			address:   fields[4],
			port:      port,
			component: component,
		}
		for i := 8; i+1 < len(fields); i += 2 {
			if fields[i] == "tcptype" {
				candidate.tcpType = fields[i+1]
			}
		}
		candidates = append(candidates, candidate)
	}
	return candidates
}

func freeDualPorts(t testing.TB, ip net.IP, count int) []int {
	t.Helper()
	ports := make([]int, 0, count)
	used := make(map[int]bool, count)
	for len(ports) < count {
		tcpListener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: ip})
		if err != nil {
			t.Fatalf("allocate TCP test port: %v", err)
		}
		port := tcpListener.Addr().(*net.TCPAddr).Port
		if used[port] {
			_ = tcpListener.Close()
			continue
		}
		udpListener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip, Port: port})
		if err != nil {
			_ = tcpListener.Close()
			continue
		}
		_ = udpListener.Close()
		_ = tcpListener.Close()
		used[port] = true
		ports = append(ports, port)
	}
	return ports
}

func assertUDPPortAvailable(t *testing.T, ip net.IP, port int) {
	t.Helper()
	listener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip, Port: port})
	if err != nil {
		t.Fatalf("UDP %s:%d was not released: %v", ip, port, err)
	}
	_ = listener.Close()
}

func assertTCPPortAvailable(t *testing.T, ip net.IP, port int) {
	t.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: ip, Port: port})
	if err != nil {
		t.Fatalf("TCP %s:%d was not released: %v", ip, port, err)
	}
	_ = listener.Close()
}
