package main

import (
	"context"
	"errors"
	"log"
	"runtime"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	maxConcurrentHandshakes = 256
	handshakeQueueTimeout   = 10 * time.Second
)

var errHandshakeCapacity = errors.New("WebRTC handshake capacity temporarily exhausted")

// peerRegistry provides bounded-lifecycle cleanup and low-overhead aggregate
// observability. Logging every state transition becomes its own bottleneck
// during a reconnect burst, while one aggregate line per minute stays useful.
type peerRegistry struct {
	mu sync.Mutex

	peers              map[*webrtc.PeerConnection]bool // value is whether it connected
	connected          int
	accepted           uint64
	failed             uint64
	timedOut           uint64
	handshake          chan struct{}
	handshakesActive   int
	handshakesRejected uint64
}

func newPeerRegistry() *peerRegistry {
	return &peerRegistry{
		peers:     make(map[*webrtc.PeerConnection]bool),
		handshake: make(chan struct{}, maxConcurrentHandshakes),
	}
}

func (r *peerRegistry) BeginHandshake(ctx context.Context) (func(), error) {
	return r.beginHandshake(ctx, handshakeQueueTimeout)
}

func (r *peerRegistry) beginHandshake(ctx context.Context, queueTimeout time.Duration) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case r.handshake <- struct{}{}:
		return r.trackHandshake(), nil
	default:
	}

	timer := time.NewTimer(queueTimeout)
	defer timer.Stop()
	select {
	case r.handshake <- struct{}{}:
		return r.trackHandshake(), nil
	case <-timer.C:
		r.mu.Lock()
		r.handshakesRejected++
		r.mu.Unlock()
		return nil, errHandshakeCapacity
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (r *peerRegistry) trackHandshake() func() {
	r.mu.Lock()
	r.handshakesActive++
	r.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			<-r.handshake
			r.mu.Lock()
			r.handshakesActive--
			r.mu.Unlock()
		})
	}
}

func (r *peerRegistry) Add(pc *webrtc.PeerConnection) {
	r.mu.Lock()
	r.peers[pc] = false
	r.accepted++
	r.mu.Unlock()
}

func (r *peerRegistry) MarkConnected(pc *webrtc.PeerConnection) {
	r.mu.Lock()
	if connected, exists := r.peers[pc]; exists && !connected {
		r.peers[pc] = true
		r.connected++
	}
	r.mu.Unlock()
}

func (r *peerRegistry) Remove(pc *webrtc.PeerConnection) {
	r.mu.Lock()
	if connected, exists := r.peers[pc]; exists {
		delete(r.peers, pc)
		if connected {
			r.connected--
		}
	}
	r.mu.Unlock()
}

func (r *peerRegistry) MarkFailed() {
	r.mu.Lock()
	r.failed++
	r.mu.Unlock()
}

// CloseIfUnconnected rechecks state under the registry lock so a timer racing
// the connected callback cannot close a healthy peer.
func (r *peerRegistry) CloseIfUnconnected(pc *webrtc.PeerConnection) {
	r.mu.Lock()
	connected, exists := r.peers[pc]
	if exists && !connected {
		r.timedOut++
		delete(r.peers, pc)
	}
	r.mu.Unlock()
	if exists && !connected {
		_ = pc.Close()
	}
}

func (r *peerRegistry) CloseAll() {
	r.mu.Lock()
	peers := make([]*webrtc.PeerConnection, 0, len(r.peers))
	for pc := range r.peers {
		peers = append(peers, pc)
	}
	r.peers = make(map[*webrtc.PeerConnection]bool)
	r.connected = 0
	r.mu.Unlock()
	for _, pc := range peers {
		_ = pc.Close()
	}
}

func (r *peerRegistry) snapshot() (
	connectedPeers []*webrtc.PeerConnection,
	peers int,
	connected int,
	accepted uint64,
	failed uint64,
	timedOut uint64,
	handshakesActive int,
	handshakesRejected uint64,
) {
	r.mu.Lock()
	defer r.mu.Unlock()
	connectedPeers = make([]*webrtc.PeerConnection, 0, r.connected)
	for peer, isConnected := range r.peers {
		if isConnected {
			connectedPeers = append(connectedPeers, peer)
		}
	}
	return connectedPeers, len(r.peers), r.connected, r.accepted, r.failed, r.timedOut, r.handshakesActive, r.handshakesRejected
}

func (r *peerRegistry) LogUntil(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	lastBodyBytes := transportStats.bodyBytes.Load()
	lastBodyFrames := transportStats.bodyFrames.Load()
	lastLog := time.Now()
	var lastMemory runtime.MemStats
	runtime.ReadMemStats(&lastMemory)
	previousTransport := make(map[*webrtc.PeerConnection]peerTransportCounters)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		now := time.Now()
		elapsedSeconds := now.Sub(lastLog).Seconds()
		if elapsedSeconds <= 0 {
			elapsedSeconds = time.Minute.Seconds()
		}
		lastLog = now
		connectedPeers, peers, connected, accepted, failed, timedOut, handshakesActive, handshakesRejected := r.snapshot()
		transport, nextTransport := summarizePeerTransport(
			collectPeerTransportSamples(connectedPeers), previousTransport,
		)
		previousTransport = nextTransport

		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		bodyBytes := transportStats.bodyBytes.Load()
		bodyFrames := transportStats.bodyFrames.Load()
		intervalBytes := bodyBytes - lastBodyBytes
		intervalFrames := bodyFrames - lastBodyFrames
		lastBodyBytes = bodyBytes
		lastBodyFrames = bodyFrames
		allocationBytes := monotonicDelta(memory.TotalAlloc, lastMemory.TotalAlloc)
		mallocs := monotonicDelta(memory.Mallocs, lastMemory.Mallocs)
		gcCycles := monotonicDelta(uint64(memory.NumGC), uint64(lastMemory.NumGC))
		gcPauseNanos := monotonicDelta(memory.PauseTotalNs, lastMemory.PauseTotalNs)
		lastMemory = memory
		log.Printf(
			"health peers=%d connected=%d accepted=%d failed=%d connect_timeouts=%d handshakes=%d handshake_rejects=%d lanes=%d requests=%d active_handlers=%d active_noninteractive=%d bulk=%d request_rejects=%d invalid_channels=%d body_mbps=%.2f body_frames=%d body_bytes_total=%d sctp_samples=%d ice_udp=%d ice_tcp=%d ice_unknown=%d sctp_tx_mbps=%.2f sctp_rx_mbps=%.2f sctp_cwnd_limited=%d sctp_rwnd_limited=%d sctp_window_equal=%d sctp_window_unknown=%d sctp_cwnd_kib_min=%.1f sctp_cwnd_kib_p50=%.1f sctp_cwnd_kib_p95=%.1f sctp_rwnd_kib_p50=%.1f sctp_rwnd_kib_p95=%.1f sctp_srtt_ms_p50=%.1f sctp_srtt_ms_p95=%.1f sctp_srtt_ms_max=%.1f sctp_mtu_b_p50=%d sctp_mtu_b_min=%d sctp_mtu_b_max=%d sctp_meta=%d sctp_interleave=%d sctp_zero_tx=%d sctp_zero_rx=%d sctp_pr_none=%d sctp_pr_fwd=%d sctp_pr_ifwd=%d goroutines=%d heap_mib=%.1f sys_mib=%.1f alloc_mib_s=%.2f mallocs_s=%.0f gc_cycles=%d gc_pause_ms=%.2f gc_cpu_fraction=%.4f",
			peers, connected, accepted, failed, timedOut, handshakesActive, handshakesRejected,
			transportStats.activeLanes.Load(), transportStats.admittedRequests.Load(),
			transportStats.activeHandlers.Load(), transportStats.activeNonInteractiveHandlers.Load(),
			transportStats.activeBulk.Load(),
			transportStats.requestRejects.Load(), transportStats.invalidChannels.Load(),
			float64(intervalBytes*8)/(elapsedSeconds*1_000_000), intervalFrames, bodyBytes,
			transport.samples, transport.iceUDP, transport.iceTCP, transport.iceUnknown,
			float64(transport.bytesSent*8)/(elapsedSeconds*1_000_000),
			float64(transport.bytesReceived*8)/(elapsedSeconds*1_000_000),
			transport.cwndLimited, transport.rwndLimited,
			transport.windowEqual, transport.windowUnknown,
			float64(transport.congestionWindow.min)/1024,
			float64(transport.congestionWindow.p50)/1024,
			float64(transport.congestionWindow.p95)/1024,
			float64(transport.receiverWindow.p50)/1024,
			float64(transport.receiverWindow.p95)/1024,
			transport.smoothedRTT.p50*1000,
			transport.smoothedRTT.p95*1000,
			transport.smoothedRTT.max*1000,
			transport.mtu.p50, transport.mtu.min, transport.mtu.max,
			transport.metadataSamples, transport.messageInterleaving,
			transport.zeroChecksumSending, transport.zeroChecksumReceiving,
			transport.partialNone, transport.partialForwardTSN, transport.partialIForwardTSN,
			runtime.NumGoroutine(),
			float64(memory.HeapAlloc)/(1024*1024), float64(memory.Sys)/(1024*1024),
			float64(allocationBytes)/(1024*1024)/elapsedSeconds,
			float64(mallocs)/elapsedSeconds, gcCycles,
			float64(gcPauseNanos)/float64(time.Millisecond), memory.GCCPUFraction,
		)
	}
}
