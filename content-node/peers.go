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

func (r *peerRegistry) LogUntil(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	lastBodyBytes := transportStats.bodyBytes.Load()
	lastBodyFrames := transportStats.bodyFrames.Load()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		r.mu.Lock()
		peers := len(r.peers)
		connected := r.connected
		accepted := r.accepted
		failed := r.failed
		timedOut := r.timedOut
		handshakesActive := r.handshakesActive
		handshakesRejected := r.handshakesRejected
		r.mu.Unlock()

		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		bodyBytes := transportStats.bodyBytes.Load()
		bodyFrames := transportStats.bodyFrames.Load()
		intervalBytes := bodyBytes - lastBodyBytes
		intervalFrames := bodyFrames - lastBodyFrames
		lastBodyBytes = bodyBytes
		lastBodyFrames = bodyFrames
		log.Printf(
			"health peers=%d connected=%d accepted=%d failed=%d connect_timeouts=%d handshakes=%d handshake_rejects=%d lanes=%d requests=%d active_handlers=%d active_noninteractive=%d bulk=%d request_rejects=%d invalid_channels=%d body_mbps=%.2f body_frames=%d body_bytes_total=%d goroutines=%d heap_mib=%.1f sys_mib=%.1f",
			peers, connected, accepted, failed, timedOut, handshakesActive, handshakesRejected,
			transportStats.activeLanes.Load(), transportStats.admittedRequests.Load(),
			transportStats.activeHandlers.Load(), transportStats.activeNonInteractiveHandlers.Load(),
			transportStats.activeBulk.Load(),
			transportStats.requestRejects.Load(), transportStats.invalidChannels.Load(),
			float64(intervalBytes*8)/(60*1_000_000), intervalFrames, bodyBytes,
			runtime.NumGoroutine(),
			float64(memory.HeapAlloc)/(1024*1024), float64(memory.Sys)/(1024*1024),
		)
	}
}
