package main

// Loopback throughput probes use the real node transport, handler, and Pion
// client. They measure the software ceiling of the download path without a
// browser while retaining production's bounded, batched response flow control.

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

type loopbackBenchmarkProtocol struct {
	name        string
	networkType webrtc.NetworkType
}

var loopbackBenchmarkProtocols = []loopbackBenchmarkProtocol{
	{name: "udp", networkType: webrtc.NetworkTypeUDP4},
	{name: "tcp", networkType: webrtc.NetworkTypeTCP4},
}

// benchmarkCreditWindow mirrors the consumer side of V3 response flow
// control. A credit is returned only after its body frame has been consumed.
// Full batches keep control traffic low; a partial batch is sent only if the
// sender has exhausted every outstanding credit and would otherwise stall.
type benchmarkCreditWindow struct {
	outstanding uint32
	pending     uint32
	batch       uint32
}

func newBenchmarkCreditWindow(initial, batch uint32) benchmarkCreditWindow {
	return benchmarkCreditWindow{outstanding: initial, batch: batch}
}

func (w *benchmarkCreditWindow) consumed() uint32 {
	if w.outstanding == 0 {
		panic("benchmark response arrived without credit")
	}
	w.outstanding--
	w.pending++
	if w.pending < w.batch && w.outstanding != 0 {
		return 0
	}
	grant := w.pending
	w.pending = 0
	w.outstanding += grant
	return grant
}

func TestBenchmarkCreditWindowBatchesConsumedFrames(t *testing.T) {
	window := newBenchmarkCreditWindow(4, 2)
	want := []uint32{0, 2, 0, 2, 0}
	for i, expected := range want {
		if got := window.consumed(); got != expected {
			t.Fatalf("frame %d grant = %d, want %d", i+1, got, expected)
		}
	}
	if window.pending != 1 {
		t.Fatalf("final unneeded partial batch = %d, want 1", window.pending)
	}
}

func TestBenchmarkCreditWindowRefillsOnlyToAvoidStall(t *testing.T) {
	window := newBenchmarkCreditWindow(2, 4)
	if got := window.consumed(); got != 0 {
		t.Fatalf("first grant = %d, want 0", got)
	}
	if got := window.consumed(); got != 2 {
		t.Fatalf("stall-preventing grant = %d, want 2", got)
	}
}

type benchmarkTransfer struct {
	requestID uint32
	credits   benchmarkCreditWindow
	received  atomic.Int64
	done      chan error
	doneOnce  sync.Once
}

func newBenchmarkTransfer(requestID, initialCredits, refillBatch uint32) *benchmarkTransfer {
	return &benchmarkTransfer{
		requestID: requestID,
		credits:   newBenchmarkCreditWindow(initialCredits, refillBatch),
		done:      make(chan error, 1),
	}
}

func (t *benchmarkTransfer) finish(err error) {
	t.doneOnce.Do(func() { t.done <- err })
}

type benchmarkLane struct {
	channel *webrtc.DataChannel
	active  atomic.Pointer[benchmarkTransfer]
}

func (l *benchmarkLane) receive(message webrtc.DataChannelMessage) {
	if message.IsString {
		return
	}
	transfer := l.active.Load()
	if transfer == nil {
		return
	}
	data := message.Data
	if len(data) < headerBytes {
		transfer.finish(fmt.Errorf("short frame: %d bytes", len(data)))
		return
	}
	requestID := binary.BigEndian.Uint32(data[1:5])
	if requestID != transfer.requestID {
		// A completed iteration can still be unwinding its callback when the next
		// request becomes active. Request IDs make those tails unambiguous.
		return
	}
	switch FrameType(data[0]) {
	case FrameResBody:
		transfer.received.Add(int64(len(data) - headerBytes))
		grant := transfer.credits.consumed()
		if grant == 0 {
			return
		}
		credit, err := encodeCreditFrame(FrameCredit, requestID, grant)
		if err == nil {
			err = l.channel.Send(credit)
		}
		if err != nil {
			transfer.finish(fmt.Errorf("send %d-credit refill: %w", grant, err))
		}
	case FrameResEnd:
		transfer.finish(nil)
	case FrameResErr:
		transfer.finish(fmt.Errorf("response error: %s", data[headerBytes:]))
	}
}

type loopbackBenchmarkPeer struct {
	lanes []*benchmarkLane
}

func newLoopbackBenchmarkPeer(
	b *testing.B,
	root string,
	protocol loopbackBenchmarkProtocol,
	laneCount int,
) *loopbackBenchmarkPeer {
	b.Helper()
	bindIP := net.IPv4(127, 0, 0, 1)
	ports := freeDualPorts(b, bindIP, 1)
	rtc, err := buildTransport(options{
		bindIP: bindIP.String(), publicIP: bindIP.String(), ports: ports,
	})
	if err != nil {
		b.Fatalf("build transport: %v", err)
	}
	registry := newPeerRegistry()

	clientSettings := webrtc.SettingEngine{}
	clientSettings.SetNetworkTypes([]webrtc.NetworkType{protocol.networkType})
	clientSettings.SetIncludeLoopbackCandidate(true)
	clientSettings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	client := webrtc.NewAPI(webrtc.WithSettingEngine(clientSettings))
	pc, err := client.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		registry.CloseAll()
		_ = rtc.Close()
		b.Fatalf("new client peer: %v", err)
	}
	b.Cleanup(func() {
		_ = pc.Close()
		registry.CloseAll()
		_ = rtc.Close()
	})

	opened := make(chan struct{}, laneCount)
	peer := &loopbackBenchmarkPeer{lanes: make([]*benchmarkLane, laneCount)}
	for laneIndex := range laneCount {
		channel, createErr := pc.CreateDataChannel(
			fmt.Sprintf("%s%d", laneLabelPrefix, laneIndex+1),
			&webrtc.DataChannelInit{Ordered: boolPointer(true)},
		)
		if createErr != nil {
			b.Fatalf("create lane %d: %v", laneIndex+1, createErr)
		}
		lane := &benchmarkLane{channel: channel}
		peer.lanes[laneIndex] = lane
		channel.OnOpen(func() { opened <- struct{}{} })
		channel.OnMessage(lane.receive)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		b.Fatalf("offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		b.Fatalf("set local: %v", err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		b.Fatal("gather timed out")
	}
	answer, err := answerOffer(
		context.Background(), rtc.API, NewHandler(root, "http://127.0.0.1:1"), registry,
		OfferBlob{
			SessionID: fmt.Sprintf("bench-%s-%d", protocol.name, laneCount),
			SDP:       pc.LocalDescription().SDP,
		},
	)
	if err != nil {
		b.Fatalf("answer: %v", err)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  answer.SDP,
	}); err != nil {
		b.Fatalf("set remote: %v", err)
	}
	for range laneCount {
		select {
		case <-opened:
		case <-time.After(5 * time.Second):
			b.Fatalf("%s lane did not open", protocol.name)
		}
	}
	return peer
}

func benchmarkRequestID(b *testing.B, iteration, laneIndex, laneCount int) uint32 {
	b.Helper()
	id := uint64(iteration)*uint64(laneCount) + uint64(laneIndex) + 1
	if id > uint64(^uint32(0)) {
		b.Fatalf("benchmark request ID overflow at iteration %d", iteration)
	}
	return uint32(id)
}

func waitBenchmarkTransfer(b *testing.B, transfer *benchmarkTransfer, timeout time.Duration) {
	b.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-transfer.done:
		if err != nil {
			b.Fatalf("request %d transfer: %v", transfer.requestID, err)
		}
	case <-timer.C:
		b.Fatalf("request %d transfer timed out", transfer.requestID)
	}
}

func benchmarkLoopbackDownload(
	b *testing.B,
	protocol loopbackBenchmarkProtocol,
	fileBytes int,
	initialCredits uint32,
	refillBatch uint32,
) {
	if initialCredits == 0 || refillBatch == 0 {
		b.Fatal("initial credits and refill batch must be positive")
	}
	root := b.TempDir()
	payload := make([]byte, fileBytes)
	for i := range payload {
		payload[i] = byte(i * 31)
	}
	if err := os.WriteFile(filepath.Join(root, "big.bin"), payload, 0o600); err != nil {
		b.Fatalf("write fixture: %v", err)
	}
	peer := newLoopbackBenchmarkPeer(b, root, protocol, 1)
	lane := peer.lanes[0]

	b.SetBytes(int64(fileBytes))
	b.ResetTimer()
	var transferElapsed time.Duration
	for iteration := 0; iteration < b.N; iteration++ {
		requestID := benchmarkRequestID(b, iteration, 0, 1)
		transfer := newBenchmarkTransfer(requestID, initialCredits, refillBatch)
		lane.active.Store(transfer)
		head := RequestHead{
			Version: protocolVersion, Method: "GET", URL: "/big.bin",
			Priority: 3, InitialCredits: initialCredits,
		}
		req, err := EncodeJSONFrame(FrameReq, requestID, head)
		if err != nil {
			b.Fatalf("encode request %d: %v", requestID, err)
		}
		started := time.Now()
		if err := lane.channel.Send(req); err != nil {
			b.Fatalf("send request %d: %v", requestID, err)
		}
		waitBenchmarkTransfer(b, transfer, 120*time.Second)
		transferElapsed += time.Since(started)
		lane.active.Store(nil)
		if got := transfer.received.Load(); got != int64(fileBytes) {
			b.Fatalf("request %d received %d bytes, want %d", requestID, got, fileBytes)
		}
	}
	b.StopTimer()
	if transferElapsed > 0 {
		bytes := float64(fileBytes) * float64(b.N)
		b.ReportMetric(bytes*8/1e6/transferElapsed.Seconds(), "Mbps")
		b.ReportMetric(bytes/1e6/transferElapsed.Seconds(), "MB/s")
	}
}

func BenchmarkLoopbackDownload(b *testing.B) {
	for _, protocol := range loopbackBenchmarkProtocols {
		protocol := protocol
		b.Run(protocol.name, func(b *testing.B) {
			b.Run("64MiB-credit32-refill8", func(b *testing.B) {
				benchmarkLoopbackDownload(b, protocol, 64*1024*1024, 32, 8)
			})
			b.Run("64MiB-credit64-refill1", func(b *testing.B) {
				benchmarkLoopbackDownload(b, protocol, 64*1024*1024, 64, 1)
			})
			b.Run("64MiB-credit64-refill8", func(b *testing.B) {
				benchmarkLoopbackDownload(b, protocol, 64*1024*1024, 64, 8)
			})
			b.Run("64MiB-credit64-refill16", func(b *testing.B) {
				benchmarkLoopbackDownload(b, protocol, 64*1024*1024, 64, 16)
			})
		})
	}
}

// Three parallel requests on three lanes over one association, matching how the
// browser splits concurrent bulk assets. Scaling shows whether the limit is
// per-lane serialization or shared SCTP/DTLS CPU.
func benchmarkLoopbackParallelDownload(
	b *testing.B,
	protocol loopbackBenchmarkProtocol,
) {
	const (
		fileBytes     = 64 * 1024 * 1024
		laneCount     = 3
		initialCredit = uint32(64)
		refillBatch   = uint32(16)
	)
	root := b.TempDir()
	payload := make([]byte, fileBytes)
	for i := range payload {
		payload[i] = byte(i * 31)
	}
	for _, name := range []string{"a.bin", "b.bin", "c.bin"} {
		if err := os.WriteFile(filepath.Join(root, name), payload, 0o600); err != nil {
			b.Fatalf("write fixture: %v", err)
		}
	}
	peer := newLoopbackBenchmarkPeer(b, root, protocol, laneCount)

	b.SetBytes(laneCount * fileBytes)
	b.ResetTimer()
	var transferElapsed time.Duration
	for iteration := 0; iteration < b.N; iteration++ {
		transfers := make([]*benchmarkTransfer, laneCount)
		requests := make([][]byte, laneCount)
		for laneIndex, lane := range peer.lanes {
			requestID := benchmarkRequestID(b, iteration, laneIndex, laneCount)
			transfer := newBenchmarkTransfer(requestID, initialCredit, refillBatch)
			transfers[laneIndex] = transfer
			lane.active.Store(transfer)
			head := RequestHead{
				Version:  protocolVersion,
				Method:   "GET",
				URL:      fmt.Sprintf("/%c.bin", 'a'+laneIndex),
				Priority: 3, InitialCredits: initialCredit,
			}
			request, err := EncodeJSONFrame(FrameReq, requestID, head)
			if err != nil {
				b.Fatalf("encode request %d: %v", requestID, err)
			}
			requests[laneIndex] = request
		}

		started := time.Now()
		for laneIndex, lane := range peer.lanes {
			if err := lane.channel.Send(requests[laneIndex]); err != nil {
				b.Fatalf("send request %d: %v", transfers[laneIndex].requestID, err)
			}
		}
		for _, transfer := range transfers {
			waitBenchmarkTransfer(b, transfer, 180*time.Second)
		}
		transferElapsed += time.Since(started)

		for laneIndex, transfer := range transfers {
			peer.lanes[laneIndex].active.Store(nil)
			if got := transfer.received.Load(); got != int64(fileBytes) {
				b.Fatalf("request %d received %d bytes, want %d", transfer.requestID, got, fileBytes)
			}
		}
	}
	b.StopTimer()
	if transferElapsed > 0 {
		bytes := float64(laneCount*fileBytes) * float64(b.N)
		b.ReportMetric(bytes*8/1e6/transferElapsed.Seconds(), "Mbps")
		b.ReportMetric(bytes/1e6/transferElapsed.Seconds(), "MB/s")
	}
}

func BenchmarkLoopbackParallelDownload(b *testing.B) {
	for _, protocol := range loopbackBenchmarkProtocols {
		protocol := protocol
		b.Run(protocol.name, func(b *testing.B) {
			benchmarkLoopbackParallelDownload(b, protocol)
		})
	}
}
