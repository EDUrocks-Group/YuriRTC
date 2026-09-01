package main

import (
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestSummarizePeerTransportUsesIntervalDeltasAndPercentiles(t *testing.T) {
	peerA := &webrtc.PeerConnection{}
	peerB := &webrtc.PeerConnection{}
	peerC := &webrtc.PeerConnection{}
	stalePeer := &webrtc.PeerConnection{}
	samples := []peerTransportSample{
		{
			peer: peerA, congestionWindow: 1024, receiverWindow: 10 * 1024,
			smoothedRTT: 0.010, mtu: 1191, bytesSent: 150, bytesReceived: 80,
			iceProtocol: webrtc.ICEProtocolUDP,
			metadata: &webrtc.SCTPTransportMetadata{
				MessageInterleavingEnabled:   true,
				PartialReliabilityMode:       webrtc.SCTPTransportPartialReliabilityModeIForwardTSN,
				ZeroChecksumReceivingEnabled: true,
			},
		},
		{
			peer: peerB, congestionWindow: 4096, receiverWindow: 30 * 1024,
			smoothedRTT: 0.200, mtu: 1200, bytesSent: 50, bytesReceived: 30,
			iceProtocol: webrtc.ICEProtocolTCP,
			metadata: &webrtc.SCTPTransportMetadata{
				PartialReliabilityMode:     webrtc.SCTPTransportPartialReliabilityModeForwardTSN,
				ZeroChecksumSendingEnabled: true,
			},
		},
		{
			peer: peerC, congestionWindow: 2048, receiverWindow: 20 * 1024,
			smoothedRTT: 0.100, mtu: 1150, bytesSent: 10, bytesReceived: 15,
			iceProtocol: webrtc.ICEProtocolUnknown,
		},
	}
	previous := map[*webrtc.PeerConnection]peerTransportCounters{
		peerA:     {bytesSent: 100, bytesReceived: 60},
		peerC:     {bytesSent: 99, bytesReceived: 25}, // Simulate counters resetting.
		stalePeer: {bytesSent: 1_000, bytesReceived: 1_000},
	}

	summary, next := summarizePeerTransport(samples, previous)
	if summary.samples != 3 {
		t.Fatalf("samples = %d, want 3", summary.samples)
	}
	if summary.bytesSent != 110 || summary.bytesReceived != 65 {
		t.Fatalf("byte deltas = sent %d received %d, want sent 110 received 65", summary.bytesSent, summary.bytesReceived)
	}
	if summary.cwndLimited != 3 || summary.rwndLimited != 0 || summary.windowEqual != 0 || summary.windowUnknown != 0 {
		t.Fatalf("window-limit summary = cwnd %d rwnd %d equal %d unknown %d",
			summary.cwndLimited, summary.rwndLimited, summary.windowEqual, summary.windowUnknown)
	}
	if summary.iceUDP != 1 || summary.iceTCP != 1 || summary.iceUnknown != 1 {
		t.Fatalf("ICE counts = udp %d tcp %d unknown %d", summary.iceUDP, summary.iceTCP, summary.iceUnknown)
	}
	if got := summary.congestionWindow; got.min != 1024 || got.p50 != 2048 || got.p95 != 4096 || got.max != 4096 {
		t.Fatalf("CWND distribution = %+v", got)
	}
	if got := summary.receiverWindow; got.p50 != 20*1024 || got.p95 != 30*1024 {
		t.Fatalf("RWND distribution = %+v", got)
	}
	if got := summary.smoothedRTT; got.min != 0.010 || got.p50 != 0.100 || got.p95 != 0.200 || got.max != 0.200 {
		t.Fatalf("SRTT distribution = %+v", got)
	}
	if got := summary.mtu; got.min != 1150 || got.p50 != 1191 || got.p95 != 1200 || got.max != 1200 {
		t.Fatalf("MTU distribution = %+v", got)
	}
	if summary.metadataSamples != 2 || summary.messageInterleaving != 1 || summary.zeroChecksumSending != 1 || summary.zeroChecksumReceiving != 1 {
		t.Fatalf("metadata summary = %+v", summary)
	}
	if summary.partialNone != 0 || summary.partialForwardTSN != 1 || summary.partialIForwardTSN != 1 {
		t.Fatalf("partial-reliability summary = %+v", summary)
	}
	if len(next) != 3 {
		t.Fatalf("next counter entries = %d, want 3", len(next))
	}
	if _, exists := next[stalePeer]; exists {
		t.Fatal("disconnected peer was retained in interval counters")
	}
}

func TestSummarizePeerTransportEmptyIsZero(t *testing.T) {
	summary, next := summarizePeerTransport(nil, map[*webrtc.PeerConnection]peerTransportCounters{
		&webrtc.PeerConnection{}: {bytesSent: 10, bytesReceived: 20},
	})
	if summary != (peerTransportSummary{}) {
		t.Fatalf("empty summary = %+v, want zero value", summary)
	}
	if len(next) != 0 {
		t.Fatalf("next counter entries = %d, want 0", len(next))
	}
}

func TestPeerRegistrySnapshotIncludesOnlyConnectedSamples(t *testing.T) {
	registry := newPeerRegistry()
	connected := &webrtc.PeerConnection{}
	connecting := &webrtc.PeerConnection{}
	registry.Add(connected)
	registry.Add(connecting)
	registry.MarkConnected(connected)

	connectedPeers, peers, connectedCount, accepted, _, _, _, _ := registry.snapshot()
	if peers != 2 || connectedCount != 1 || accepted != 2 {
		t.Fatalf("snapshot counts = peers %d connected %d accepted %d", peers, connectedCount, accepted)
	}
	if len(connectedPeers) != 1 || connectedPeers[0] != connected {
		t.Fatalf("connected peer snapshot = %v, want only %p", connectedPeers, connected)
	}
}

func TestMonotonicDeltaHandlesReset(t *testing.T) {
	if got := monotonicDelta(125, 100); got != 25 {
		t.Fatalf("ordinary delta = %d, want 25", got)
	}
	if got := monotonicDelta(25, 100); got != 25 {
		t.Fatalf("reset delta = %d, want 25", got)
	}
}

func TestCollectPeerTransportSamplesToleratesNilAndClosedPeers(t *testing.T) {
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new peer: %v", err)
	}
	if err := peer.Close(); err != nil {
		t.Fatalf("close peer: %v", err)
	}
	if got := collectPeerTransportSamples([]*webrtc.PeerConnection{nil, peer}); len(got) != 0 {
		t.Fatalf("samples from nil/closed peers = %d, want 0", len(got))
	}
	if got := selectedICEProtocol(nil); got != webrtc.ICEProtocolUnknown {
		t.Fatalf("nil peer protocol = %v, want unknown", got)
	}
}
