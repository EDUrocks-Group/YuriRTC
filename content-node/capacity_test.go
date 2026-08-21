package main

// This opt-in harness measures the real Pion/answerOffer path without creating
// Firebase documents or chat users. It is inert during the normal test suite.
// Build with `go test -c`, then run one binary in server mode and another in
// client mode (ideally on a different host).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

type capacityMetrics struct {
	Timestamp          time.Time `json:"timestamp"`
	Peers              int       `json:"peers"`
	Connected          int       `json:"connected"`
	Accepted           uint64    `json:"accepted"`
	Failed             uint64    `json:"failed"`
	ConnectTimeouts    uint64    `json:"connectTimeouts"`
	Handshakes         int       `json:"handshakes"`
	HandshakeRejects   uint64    `json:"handshakeRejects"`
	Goroutines         int       `json:"goroutines"`
	HeapAllocBytes     uint64    `json:"heapAllocBytes"`
	HeapInUseBytes     uint64    `json:"heapInUseBytes"`
	StackInUseBytes    uint64    `json:"stackInUseBytes"`
	RuntimeSystemBytes uint64    `json:"runtimeSystemBytes"`
	RSSBytes           uint64    `json:"rssBytes"`
	FDs                int       `json:"fds"`
}

func TestCapacityHarness(t *testing.T) {
	mode := capacityEnv("MODE", "")
	switch mode {
	case "":
		t.Skip("opt-in capacity harness")
	case "server":
		runCapacityServer(t)
	case "client":
		runCapacityClient(t)
	default:
		t.Fatalf("unknown YURIRTC_CAPACITY_MODE %q", mode)
	}
}

func runCapacityServer(t *testing.T) {
	bindIP := capacityEnv("BIND_IP", "127.0.0.1")
	publicIP := capacityEnv("PUBLIC_IP", bindIP)
	ports, err := resolveICEPorts(capacityEnv("PORTS", "55000,55001,55002"), 0)
	if err != nil {
		t.Fatalf("capacity ports: %v", err)
	}
	rtc, err := buildTransport(options{bindIP: bindIP, publicIP: publicIP, ports: ports})
	if err != nil {
		t.Fatalf("capacity transport: %v", err)
	}
	defer rtc.Close()

	registry := newPeerRegistry()
	defer registry.CloseAll()
	handler := NewHandler(t.TempDir(), "http://127.0.0.1:1")
	stop := make(chan struct{})
	var stopOnce sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("/offer", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		defer r.Body.Close()
		var offer OfferBlob
		decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
		if err := decoder.Decode(&offer); err != nil {
			http.Error(w, "invalid offer", http.StatusBadRequest)
			return
		}
		answer, err := answerOffer(r.Context(), rtc.API, handler, registry, offer)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(answer)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("gc") == "1" {
			runtime.GC()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(readCapacityMetrics(registry))
	})
	mux.HandleFunc("/stop", func(w http.ResponseWriter, _ *http.Request) {
		stopOnce.Do(func() { close(stop) })
		w.WriteHeader(http.StatusNoContent)
	})

	address := capacityEnv("HTTP", "127.0.0.1:19090")
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("capacity HTTP listen: %v", err)
	}
	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	t.Logf("CAPACITY_READY http=%s ice=%s/%s pid=%d", listener.Addr(), publicIP, formatPorts(ports), os.Getpid())

	signalCtx, cancelSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancelSignals()
	maximum := capacityDuration(t, "DURATION", 30*time.Minute)
	timer := time.NewTimer(maximum)
	defer timer.Stop()
	select {
	case <-stop:
	case <-signalCtx.Done():
	case <-timer.C:
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("capacity HTTP server: %v", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	t.Logf("CAPACITY_FINAL %+v", readCapacityMetrics(registry))
}

func runCapacityClient(t *testing.T) {
	baseURL := strings.TrimRight(capacityEnv("URL", "http://127.0.0.1:19090"), "/")
	count := capacityInt(t, "USERS", 100)
	rate := capacityInt(t, "RATE", 100)
	hold := capacityDuration(t, "HOLD", 30*time.Second)
	protocol := strings.ToLower(capacityEnv("PROTOCOL", "udp"))
	remotePort := capacityInt(t, "REMOTE_PORT", 0)
	if protocol != "udp" && protocol != "tcp" && protocol != "all" {
		t.Fatalf("capacity protocol must be udp, tcp, or all; got %q", protocol)
	}

	httpClient := &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        512,
			MaxIdleConnsPerHost: 512,
			IdleConnTimeout:     time.Minute,
		},
	}
	clientSettings := webrtc.SettingEngine{}
	switch protocol {
	case "udp":
		clientSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	case "tcp":
		clientSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeTCP4})
	default:
		clientSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
	}
	// Generators use literal host candidates and public server candidates. Per-
	// peer mDNS query sockets would consume the generator's ephemeral UDP range
	// around 15k clients and falsely look like a content-node capacity limit.
	clientSettings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(clientSettings))
	clients := make([]*webrtc.PeerConnection, 0, count)
	var clientsMu sync.Mutex
	var succeeded atomic.Int64
	var failed atomic.Int64
	inFlight := make(chan struct{}, maxConcurrentHandshakes)
	var wg sync.WaitGroup
	interval := time.Second / time.Duration(rate)
	if interval < time.Millisecond {
		interval = time.Millisecond
	}
	ticker := time.NewTicker(interval)
	started := time.Now()
	for i := 0; i < count; i++ {
		if i != 0 {
			<-ticker.C
		}
		inFlight <- struct{}{}
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			defer func() { <-inFlight }()
			pc, err := createCapacityClient(api, httpClient, baseURL, id, protocol, remotePort)
			if err != nil {
				failed.Add(1)
				if failed.Load() <= 10 {
					t.Logf("capacity user %d failed: %v", id, err)
				}
				return
			}
			clientsMu.Lock()
			clients = append(clients, pc)
			clientsMu.Unlock()
			succeeded.Add(1)
		}(i)
	}
	ticker.Stop()
	wg.Wait()
	rampElapsed := time.Since(started)

	metrics, metricsErr := fetchCapacityMetrics(httpClient, baseURL+"/metrics?gc=1")
	t.Logf("CAPACITY_PLATEAU requested=%d connected=%d failed=%d ramp=%s protocol=%s port=%d metrics=%+v metrics_error=%v",
		count, succeeded.Load(), failed.Load(), rampElapsed.Round(time.Millisecond), protocol, remotePort, metrics, metricsErr)
	if hold > 0 {
		timer := time.NewTimer(hold)
		<-timer.C
	}
	metrics, metricsErr = fetchCapacityMetrics(httpClient, baseURL+"/metrics?gc=1")
	t.Logf("CAPACITY_HELD requested=%d connected=%d failed=%d hold=%s metrics=%+v metrics_error=%v",
		count, succeeded.Load(), failed.Load(), hold, metrics, metricsErr)

	clientsMu.Lock()
	for _, pc := range clients {
		_ = pc.Close()
	}
	clients = nil
	clientsMu.Unlock()
	time.Sleep(3 * time.Second)

	if float64(succeeded.Load())/float64(count) < 0.995 {
		t.Fatalf("only %d/%d capacity clients connected", succeeded.Load(), count)
	}
}

func createCapacityClient(api *webrtc.API, httpClient *http.Client, baseURL string, id int, protocol string, remotePort int) (*webrtc.PeerConnection, error) {
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*webrtc.PeerConnection, error) {
		_ = pc.Close()
		return nil, err
	}
	opened := make(chan struct{})
	var openOnce sync.Once
	channel, err := pc.CreateDataChannel(laneLabelPrefix+"0", nil)
	if err != nil {
		return fail(err)
	}
	channel.OnOpen(func() { openOnce.Do(func() { close(opened) }) })

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fail(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return fail(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		return fail(errors.New("client ICE gathering timed out"))
	}
	local := pc.LocalDescription()
	if local == nil {
		return fail(errNoLocalDescription)
	}
	payload, err := json.Marshal(OfferBlob{SessionID: fmt.Sprintf("capacity-%d", id), SDP: local.SDP})
	if err != nil {
		return fail(err)
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+"/offer", bytes.NewReader(payload))
	if err != nil {
		return fail(err)
	}
	request.Header.Set("Content-Type", "application/json")
	// The production node receives offers over two shared Firebase streams, not
	// one HTTP socket per peer. Close this harness-only signaling connection so
	// its goroutine/FD cost is not misattributed to WebRTC.
	request.Close = true
	response, err := httpClient.Do(request)
	if err != nil {
		return fail(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fail(fmt.Errorf("offer response %s: %s", response.Status, strings.TrimSpace(string(message))))
	}
	var answer AnswerBlob
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&answer); err != nil {
		return fail(err)
	}
	answer.SDP, err = filterCapacityAnswer(answer.SDP, protocol, remotePort)
	if err != nil {
		return fail(err)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		return fail(err)
	}
	select {
	case <-opened:
		return pc, nil
	case <-time.After(12 * time.Second):
		return fail(errors.New("data channel did not open"))
	}
}

func filterCapacityAnswer(sdp, protocol string, remotePort int) (string, error) {
	if protocol == "all" && remotePort == 0 {
		return sdp, nil
	}
	lines := strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	kept := 0
	for _, line := range lines {
		if !strings.HasPrefix(line, "a=candidate:") {
			out = append(out, line)
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		candidatePort, err := strconv.Atoi(fields[5])
		if err != nil {
			continue
		}
		if protocol != "all" && !strings.EqualFold(fields[2], protocol) {
			continue
		}
		if remotePort != 0 && candidatePort != remotePort {
			continue
		}
		out = append(out, line)
		kept++
	}
	if kept == 0 {
		return "", fmt.Errorf("answer had no %s candidates for port %d", protocol, remotePort)
	}
	return strings.Join(out, "\r\n"), nil
}

func readCapacityMetrics(registry *peerRegistry) capacityMetrics {
	registry.mu.Lock()
	metrics := capacityMetrics{
		Timestamp:        time.Now().UTC(),
		Peers:            len(registry.peers),
		Connected:        registry.connected,
		Accepted:         registry.accepted,
		Failed:           registry.failed,
		ConnectTimeouts:  registry.timedOut,
		Handshakes:       registry.handshakesActive,
		HandshakeRejects: registry.handshakesRejected,
	}
	registry.mu.Unlock()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	metrics.Goroutines = runtime.NumGoroutine()
	metrics.HeapAllocBytes = memory.HeapAlloc
	metrics.HeapInUseBytes = memory.HeapInuse
	metrics.StackInUseBytes = memory.StackInuse
	metrics.RuntimeSystemBytes = memory.Sys
	metrics.RSSBytes = capacityRSS()
	if descriptors, err := os.ReadDir("/proc/self/fd"); err == nil {
		metrics.FDs = len(descriptors)
	}
	return metrics
}

func fetchCapacityMetrics(client *http.Client, url string) (capacityMetrics, error) {
	response, err := client.Get(url)
	if err != nil {
		return capacityMetrics{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return capacityMetrics{}, fmt.Errorf("metrics response %s", response.Status)
	}
	var metrics capacityMetrics
	err = json.NewDecoder(response.Body).Decode(&metrics)
	return metrics, err
}

func capacityRSS() uint64 {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(status), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0
		}
		kib, _ := strconv.ParseUint(fields[1], 10, 64)
		return kib * 1024
	}
	return 0
}

func capacityEnv(suffix, fallback string) string {
	return yurirtcEnv("CAPACITY_"+suffix, fallback)
}

func capacityInt(t *testing.T, name string, fallback int) int {
	t.Helper()
	raw := capacityEnv(name, strconv.Itoa(fallback))
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		t.Fatalf("YURIRTC_CAPACITY_%s must be a non-negative integer, got %q", name, raw)
	}
	return value
}

func capacityDuration(t *testing.T, name string, fallback time.Duration) time.Duration {
	t.Helper()
	raw := capacityEnv(name, fallback.String())
	value, err := time.ParseDuration(raw)
	if err != nil || value < 0 {
		t.Fatalf("YURIRTC_CAPACITY_%s must be a non-negative duration, got %q", name, raw)
	}
	return value
}
