package main

import (
	"sort"

	"github.com/pion/webrtc/v4"
)

type peerTransportCounters struct {
	bytesSent     uint64
	bytesReceived uint64
}

type peerTransportSample struct {
	peer             *webrtc.PeerConnection
	congestionWindow uint32
	receiverWindow   uint32
	smoothedRTT      float64
	mtu              uint32
	bytesSent        uint64
	bytesReceived    uint64
	iceProtocol      webrtc.ICEProtocol
	metadata         *webrtc.SCTPTransportMetadata
}

type uint32Distribution struct {
	min uint32
	p50 uint32
	p95 uint32
	max uint32
}

type float64Distribution struct {
	min float64
	p50 float64
	p95 float64
	max float64
}

type peerTransportSummary struct {
	samples int

	iceUDP     int
	iceTCP     int
	iceUnknown int

	bytesSent     uint64
	bytesReceived uint64
	cwndLimited   int
	rwndLimited   int
	windowEqual   int
	windowUnknown int

	congestionWindow uint32Distribution
	receiverWindow   uint32Distribution
	smoothedRTT      float64Distribution
	mtu              uint32Distribution

	metadataSamples       int
	messageInterleaving   int
	zeroChecksumSending   int
	zeroChecksumReceiving int
	partialNone           int
	partialForwardTSN     int
	partialIForwardTSN    int
}

// collectPeerTransportSamples deliberately records only transport mechanics.
// Candidate addresses, request URLs, and peer identifiers must never enter the
// health log.
func collectPeerTransportSamples(peers []*webrtc.PeerConnection) []peerTransportSample {
	samples := make([]peerTransportSample, 0, len(peers))
	for _, peer := range peers {
		if peer == nil {
			continue
		}
		sctp := peer.SCTP()
		if sctp == nil || sctp.State() != webrtc.SCTPTransportStateConnected {
			continue
		}
		stats := sctp.Stats()
		samples = append(samples, peerTransportSample{
			peer:             peer,
			congestionWindow: stats.CongestionWindow,
			receiverWindow:   stats.ReceiverWindow,
			smoothedRTT:      stats.SmoothedRoundTripTime,
			mtu:              stats.MTU,
			bytesSent:        stats.BytesSent,
			bytesReceived:    stats.BytesReceived,
			iceProtocol:      selectedICEProtocol(peer),
			metadata:         stats.Metadata,
		})
	}
	return samples
}

func summarizePeerTransport(
	samples []peerTransportSample,
	previous map[*webrtc.PeerConnection]peerTransportCounters,
) (peerTransportSummary, map[*webrtc.PeerConnection]peerTransportCounters) {
	summary := peerTransportSummary{samples: len(samples)}
	next := make(map[*webrtc.PeerConnection]peerTransportCounters, len(samples))
	cwnd := make([]uint32, 0, len(samples))
	rwnd := make([]uint32, 0, len(samples))
	rtt := make([]float64, 0, len(samples))
	mtu := make([]uint32, 0, len(samples))

	for _, sample := range samples {
		prior := previous[sample.peer]
		summary.bytesSent += monotonicDelta(sample.bytesSent, prior.bytesSent)
		summary.bytesReceived += monotonicDelta(sample.bytesReceived, prior.bytesReceived)
		next[sample.peer] = peerTransportCounters{
			bytesSent:     sample.bytesSent,
			bytesReceived: sample.bytesReceived,
		}

		if sample.congestionWindow != 0 {
			cwnd = append(cwnd, sample.congestionWindow)
		}
		if sample.receiverWindow != 0 {
			rwnd = append(rwnd, sample.receiverWindow)
		}
		// Pion represents its not-yet-measured SRTT as zero. Excluding that
		// sentinel keeps a reconnect burst from making latency percentiles look
		// artificially healthy.
		if sample.smoothedRTT > 0 {
			rtt = append(rtt, sample.smoothedRTT)
		}
		if sample.mtu != 0 {
			mtu = append(mtu, sample.mtu)
		}

		switch {
		case sample.congestionWindow == 0 || sample.receiverWindow == 0:
			summary.windowUnknown++
		case sample.congestionWindow < sample.receiverWindow:
			summary.cwndLimited++
		case sample.receiverWindow < sample.congestionWindow:
			summary.rwndLimited++
		default:
			summary.windowEqual++
		}

		switch sample.iceProtocol {
		case webrtc.ICEProtocolUDP:
			summary.iceUDP++
		case webrtc.ICEProtocolTCP:
			summary.iceTCP++
		default:
			summary.iceUnknown++
		}

		if sample.metadata == nil {
			continue
		}
		summary.metadataSamples++
		if sample.metadata.MessageInterleavingEnabled {
			summary.messageInterleaving++
		}
		if sample.metadata.ZeroChecksumSendingEnabled {
			summary.zeroChecksumSending++
		}
		if sample.metadata.ZeroChecksumReceivingEnabled {
			summary.zeroChecksumReceiving++
		}
		switch sample.metadata.PartialReliabilityMode {
		case webrtc.SCTPTransportPartialReliabilityModeNone:
			summary.partialNone++
		case webrtc.SCTPTransportPartialReliabilityModeForwardTSN:
			summary.partialForwardTSN++
		case webrtc.SCTPTransportPartialReliabilityModeIForwardTSN:
			summary.partialIForwardTSN++
		}
	}

	summary.congestionWindow = summarizeUint32(cwnd)
	summary.receiverWindow = summarizeUint32(rwnd)
	summary.smoothedRTT = summarizeFloat64(rtt)
	summary.mtu = summarizeUint32(mtu)
	return summary, next
}

func summarizeUint32(values []uint32) uint32Distribution {
	if len(values) == 0 {
		return uint32Distribution{}
	}
	sorted := append([]uint32(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return uint32Distribution{
		min: sorted[0],
		p50: sorted[nearestRankIndex(len(sorted), 50)],
		p95: sorted[nearestRankIndex(len(sorted), 95)],
		max: sorted[len(sorted)-1],
	}
}

func summarizeFloat64(values []float64) float64Distribution {
	if len(values) == 0 {
		return float64Distribution{}
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	return float64Distribution{
		min: sorted[0],
		p50: sorted[nearestRankIndex(len(sorted), 50)],
		p95: sorted[nearestRankIndex(len(sorted), 95)],
		max: sorted[len(sorted)-1],
	}
}

func nearestRankIndex(length, percentile int) int {
	if length <= 1 {
		return 0
	}
	index := (length*percentile+99)/100 - 1
	if index < 0 {
		return 0
	}
	if index >= length {
		return length - 1
	}
	return index
}

func monotonicDelta(current, previous uint64) uint64 {
	if current < previous {
		// Associations and runtime counters should be monotonic. Treat a reset as
		// a fresh baseline instead of allowing unsigned subtraction to wrap.
		return current
	}
	return current - previous
}

func selectedICEProtocol(peer *webrtc.PeerConnection) webrtc.ICEProtocol {
	if peer == nil {
		return webrtc.ICEProtocolUnknown
	}
	sctp := peer.SCTP()
	if sctp == nil {
		return webrtc.ICEProtocolUnknown
	}
	dtls := sctp.Transport()
	if dtls == nil {
		return webrtc.ICEProtocolUnknown
	}
	iceTransport := dtls.ICETransport()
	if iceTransport == nil {
		return webrtc.ICEProtocolUnknown
	}
	pair, err := iceTransport.GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil {
		return webrtc.ICEProtocolUnknown
	}
	return pair.Local.Protocol
}
