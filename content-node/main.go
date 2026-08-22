// Command content-node serves a YuriRTC virtual origin over WebRTC data channels.
//
// One process, three UDP and three TCP listeners, all muxed so every client can
// let ICE choose among ports 443, 80, and 49152 without allocating a listening
// socket per peer.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	firebase "firebase.google.com/go/v4"
	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
	"google.golang.org/api/option"
	"google.golang.org/api/transport"
)

const (
	firebaseDatabaseScope = "https://www.googleapis.com/auth/firebase.database"
	userInfoEmailScope    = "https://www.googleapis.com/auth/userinfo.email"
	defaultICEPorts       = "443,80,49152"
	// Packets buffered between an ICE-TCP connection's read loop and its DTLS
	// consumer. pion/ice blocks (it does not drop) when this queue is full, so
	// the value only sets how much burst a school-network TCP client can land
	// before backpressure reaches the kernel; the queue memory is per accepted
	// connection and only while occupied.
	tcpMuxReadBuffer = 64
	udpSocketBuffer  = 16 * 1024 * 1024
	// Pion defaults to a 1 MiB SCTP receive window, which can throttle uploads
	// before V3's bounded request-credit window or the network path is full on a
	// high-RTT connection. Four MiB preserves the application-level bounds while
	// leaving enough association-level headroom for concurrent request bodies.
	sctpMaxReceiveBufferSize uint32 = 4 * 1024 * 1024
	// Pion's RFC 4960 default starts near 4.7 KiB. A 12 KiB floor matches the
	// roughly ten-packet initial window used by modern TCP, reducing slow-start
	// latency on both ICE/UDP and ICE/TCP without an unsafe large initial burst.
	sctpMinimumCongestionWindow = 12 * 1024
)

type options struct {
	publicIP     string
	bindIP       string
	ports        []int
	root         string
	backendURL   string
	webSocketURL string
	projectID    string
	databaseURL  string
	credentials  string
}

func main() {
	log.SetPrefix("YuriRTC: ")

	var opt options
	var portList string
	var legacyPort int
	flag.StringVar(&opt.publicIP, "public-ip", yurirtcEnv("PUBLIC_IP", ""), "public IPv4 advertised in ICE candidates (required)")
	flag.StringVar(&opt.bindIP, "bind-ip", yurirtcEnv("BIND_IP", ""), "local address to bind (defaults to public-ip; never the wildcard)")
	flag.StringVar(&portList, "ports", yurirtcEnv("PORTS", defaultICEPorts), "comma-separated ports for both UDP and TCP listeners")
	flag.IntVar(&legacyPort, "port", 0, "deprecated single-port override (takes precedence over -ports)")
	flag.StringVar(&opt.root, "root", yurirtcEnv("ROOT", "/var/lib/yurirtc/site"), "directory served as the site root")
	flag.StringVar(&opt.backendURL, "backend", yurirtcEnv("BACKEND", "http://127.0.0.1:1801"), "HTTP backend for /apiv2/")
	flag.StringVar(&opt.webSocketURL, "websocket-backend", yurirtcEnv("WEBSOCKET_BACKEND", ""), "websocket upstream for carried sockets under /apiv2/, e.g. ws://127.0.0.1:1802; empty disables them")
	flag.StringVar(&opt.projectID, "project", yurirtcEnv("PROJECT", ""), "Firebase project id (required)")
	flag.StringVar(&opt.databaseURL, "database-url", yurirtcEnv("DATABASE_URL", ""), "RTDB URL (required)")
	flag.StringVar(&opt.credentials, "credentials", yurirtcEnv("CREDENTIALS", envOr("GOOGLE_APPLICATION_CREDENTIALS", "")), "service account JSON path")
	flag.Parse()

	if opt.publicIP == "" || opt.projectID == "" || opt.databaseURL == "" {
		log.Fatal("public-ip, project, and database-url are all required")
	}
	if opt.bindIP == "" {
		opt.bindIP = opt.publicIP
	}
	ports, err := resolveICEPorts(portList, legacyPort)
	if err != nil {
		log.Fatalf("ports: %v", err)
	}
	opt.ports = ports
	if _, err := os.Stat(opt.root); err != nil {
		log.Fatalf("root %s is not readable: %v", opt.root, err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rtc, err := buildTransport(opt)
	if err != nil {
		log.Fatalf("building webrtc transport: %v", err)
	}
	defer func() {
		if err := rtc.Close(); err != nil {
			log.Printf("closing webrtc transport: %v", err)
		}
	}()

	handler := NewHandler(opt.root, opt.backendURL)
	handler.WebSocketURL = strings.TrimRight(opt.webSocketURL, "/")
	peers := newPeerRegistry()
	defer peers.CloseAll()
	go peers.LogUntil(ctx)

	firebaseOpts := []option.ClientOption{}
	if opt.credentials != "" {
		firebaseOpts = append(firebaseOpts, option.WithCredentialsFile(opt.credentials))
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{
		ProjectID:   opt.projectID,
		DatabaseURL: opt.databaseURL,
	}, firebaseOpts...)
	if err != nil {
		log.Fatalf("firebase init: %v", err)
	}
	streamOpts := append([]option.ClientOption{}, firebaseOpts...)
	streamOpts = append(streamOpts, option.WithScopes(firebaseDatabaseScope, userInfoEmailScope))
	rtdbHTTP, _, err := transport.NewHTTPClient(ctx, streamOpts...)
	if err != nil {
		log.Fatalf("firebase RTDB stream auth: %v", err)
	}
	rtdbHTTP.CheckRedirect = firebaseRTDBRedirect

	signaler, err := NewSignaler(ctx, app, opt.databaseURL, rtdbHTTP, func(ctx context.Context, offer OfferBlob) (AnswerBlob, error) {
		return answerOffer(ctx, rtc.API, handler, peers, offer)
	})
	if err != nil {
		log.Fatalf("signaling init: %v", err)
	}
	signaler.Run(ctx)

	log.Printf("content node listening on %s ports %s (udp+tcp), advertising %s, root=%s",
		opt.bindIP, formatPorts(opt.ports), opt.publicIP, opt.root)
	<-ctx.Done()
	log.Print("shutting down")
}

// iceTransport owns the API and the muxes behind it. webrtc.API has no Close
// method, so the muxes must be retained explicitly to release all six sockets
// during shutdown and in tests.
type iceTransport struct {
	API    *webrtc.API
	udpMux *ice.MultiUDPMuxDefault
	tcpMux *ice.MultiTCPMuxDefault
	once   sync.Once
	err    error
}

func (t *iceTransport) Close() error {
	t.once.Do(func() {
		t.err = errors.Join(t.udpMux.Close(), t.tcpMux.Close())
	})
	return t.err
}

// buildTransport creates one muxed UDP and TCP listener for every configured
// port and combines them into one Pion API.
//
// Both are required and they are why this is pion: libdatachannel gates
// enableIceUdpMux on libjuice and enableIceTcp on libnice, so no single backend
// there can do both. Without muxing, the second concurrent client cannot bind
// the port at all.
func buildTransport(opt options) (*iceTransport, error) {
	loggerFactory := logging.NewDefaultLoggerFactory()

	// Bind the specific address, never the wildcard. A wildcard listener would
	// collide with any service using the same ports on another local address; a
	// specific bind cannot coexist with that wildcard even with SO_REUSEADDR.
	bindIP := net.ParseIP(opt.bindIP)
	if bindIP == nil || bindIP.To4() == nil {
		return nil, fmt.Errorf("bind-ip %q is not a valid IPv4 address", opt.bindIP)
	}
	bindIP = bindIP.To4()
	if bindIP.IsUnspecified() {
		return nil, errors.New("bind-ip must be a specific IPv4 address, not 0.0.0.0")
	}
	publicIP := net.ParseIP(opt.publicIP)
	if publicIP == nil || publicIP.To4() == nil {
		return nil, fmt.Errorf("public-ip %q is not a valid IPv4 address", opt.publicIP)
	}
	publicIP = publicIP.To4()
	if err := validateICEPorts(opt.ports); err != nil {
		return nil, err
	}

	udpListeners, tcpListeners, err := bindICEListeners(bindIP, opt.ports)
	if err != nil {
		return nil, err
	}

	udpMuxes := make([]ice.UDPMux, 0, len(opt.ports))
	tcpMuxes := make([]ice.TCPMux, 0, len(opt.ports))
	for i, port := range opt.ports {
		udpMuxes = append(udpMuxes, webrtc.NewICEUDPMux(
			loggerFactory.NewLogger(fmt.Sprintf("udpmux-%d", port)),
			udpListeners[i],
		))
		tcpMuxes = append(tcpMuxes, webrtc.NewICETCPMux(
			loggerFactory.NewLogger(fmt.Sprintf("tcpmux-%d", port)),
			tcpListeners[i],
			tcpMuxReadBuffer,
		))
	}
	udpMux := ice.NewMultiUDPMuxDefault(udpMuxes...)
	tcpMux := ice.NewMultiTCPMuxDefault(tcpMuxes...)

	settings := webrtc.SettingEngine{LoggerFactory: loggerFactory}
	settings.SetICEUDPMux(udpMux)
	settings.SetICETCPMux(tcpMux)

	// MultiTCPMuxDefault intentionally has no LocalAddr method, so Pion cannot
	// infer which address its child listeners use. Without this exact filter it
	// gathers a set of passive TCP candidates for every address on a multi-homed
	// host. The catch-all NAT rewrite would then make those wrong candidates look
	// identical to the real ones and could strand incoming TCP on an unread conn.
	settings.SetIPFilter(func(ip net.IP) bool { return ip.Equal(bindIP) })

	// Scope the rewrite to the actual local address rather than using a catch-all
	// external IP. That prevents a future interface from being advertised by
	// accident while keeping a bind-ip behind 1:1 NAT supported.
	settings.SetNAT1To1IPs(
		[]string{publicIP.String() + "/" + bindIP.String()},
		webrtc.ICECandidateTypeHost,
	)
	settings.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4,
		webrtc.NetworkTypeTCP4,
	})
	// YuriRTC v3 frames are 128 KiB and Chrome currently negotiates 256 KiB. Advertising
	// the exact application cap rejects oversized inbound messages before they
	// can create attacker-controlled reassembly pressure.
	settings.SetSCTPMaxMessageSize(maxFrameBytes)
	settings.SetSCTPMaxReceiveBufferSize(sctpMaxReceiveBufferSize)
	settings.SetSCTPMinCwnd(sctpMinimumCongestionWindow)
	// This public server never advertises .local candidates. Query-only mDNS is
	// otherwise Pion's default and opens three UDP descriptors per peer merely to
	// resolve browser host candidates. Browser-initiated checks against our
	// public candidates still create the required peer-reflexive route.
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	// Loopback is useful for the real integration tests and remains excluded in
	// production because the production bind address is not loopback.
	settings.SetIncludeLoopbackCandidate(bindIP.IsLoopback())

	return &iceTransport{
		API:    webrtc.NewAPI(webrtc.WithSettingEngine(settings)),
		udpMux: udpMux,
		tcpMux: tcpMux,
	}, nil
}

// bindICEListeners is all-or-nothing: a conflict on the sixth socket releases
// the first five before returning. This matters on restart because a partially
// live process would otherwise advertise ports it never successfully opened.
func bindICEListeners(bindIP net.IP, ports []int) ([]*net.UDPConn, []*net.TCPListener, error) {
	udpListeners := make([]*net.UDPConn, 0, len(ports))
	tcpListeners := make([]*net.TCPListener, 0, len(ports))
	rollback := func() {
		for _, listener := range udpListeners {
			_ = listener.Close()
		}
		for _, listener := range tcpListeners {
			_ = listener.Close()
		}
	}

	for _, port := range ports {
		udpListener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: bindIP, Port: port})
		if err != nil {
			rollback()
			return nil, nil, fmt.Errorf("udp %s:%d: %w", bindIP, port, err)
		}
		udpListeners = append(udpListeners, udpListener)
		if err := udpListener.SetReadBuffer(udpSocketBuffer); err != nil {
			rollback()
			return nil, nil, fmt.Errorf("udp %s:%d read buffer: %w", bindIP, port, err)
		}
		if err := udpListener.SetWriteBuffer(udpSocketBuffer); err != nil {
			rollback()
			return nil, nil, fmt.Errorf("udp %s:%d write buffer: %w", bindIP, port, err)
		}

		tcpListener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: bindIP, Port: port})
		if err != nil {
			rollback()
			return nil, nil, fmt.Errorf("tcp %s:%d: %w", bindIP, port, err)
		}
		tcpListeners = append(tcpListeners, tcpListener)
	}

	return udpListeners, tcpListeners, nil
}

func resolveICEPorts(list string, legacyPort int) ([]int, error) {
	if legacyPort != 0 {
		ports := []int{legacyPort}
		if err := validateICEPorts(ports); err != nil {
			return nil, fmt.Errorf("-port: %w", err)
		}
		return ports, nil
	}

	parts := strings.Split(list, ",")
	ports := make([]int, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, errors.New("port list contains an empty value")
		}
		port, err := strconv.Atoi(part)
		if err != nil {
			return nil, fmt.Errorf("invalid port %q", part)
		}
		ports = append(ports, port)
	}
	if err := validateICEPorts(ports); err != nil {
		return nil, err
	}
	return ports, nil
}

func validateICEPorts(ports []int) error {
	if len(ports) == 0 {
		return errors.New("at least one ICE port is required")
	}
	seen := make(map[int]struct{}, len(ports))
	for _, port := range ports {
		if port < 1 || port > 65535 {
			return fmt.Errorf("port %d is outside 1..65535", port)
		}
		if _, duplicate := seen[port]; duplicate {
			return fmt.Errorf("duplicate port %d", port)
		}
		seen[port] = struct{}{}
	}
	return nil
}

func formatPorts(ports []int) string {
	values := make([]string, len(ports))
	for i, port := range ports {
		values[i] = strconv.Itoa(port)
	}
	return strings.Join(values, ",")
}

func answerOffer(ctx context.Context, api *webrtc.API, handler *Handler, peers *peerRegistry, offer OfferBlob) (AnswerBlob, error) {
	releaseHandshake, err := peers.BeginHandshake(ctx)
	if err != nil {
		return AnswerBlob{}, err
	}
	defer releaseHandshake()

	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{}})
	if err != nil {
		return AnswerBlob{}, err
	}
	peers.Add(pc)
	connectedDeadline := time.AfterFunc(45*time.Second, func() {
		peers.CloseIfUnconnected(pc)
	})
	var closeOnce sync.Once
	var session *PeerSession
	closePeer := func() {
		closeOnce.Do(func() {
			connectedDeadline.Stop()
			peers.Remove(pc)
			if session != nil {
				session.Close()
			}
			_ = pc.Close()
		})
	}
	session = NewPeerSession(handler, closePeer)

	capturePeerAddress := func() {
		session.SetPeerAddress(selectedRemoteAddress(pc))
	}

	pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		capturePeerAddress()
		if err := session.Attach(channel); err != nil {
			// Rejections are counted in the aggregate health line. Logging each
			// attacker-created channel would create an avoidable log-ingestion DoS.
			_ = channel.Close()
			return
		}
		// Receiving a valid DCEP channel means ICE, DTLS and SCTP are already
		// carrying authenticated application traffic. Some Pion/Chrome paths can
		// leave the aggregate PeerConnection callback in "connecting" even though
		// this channel is open; treating that callback as the only proof caused the
		// 45-second handshake reaper to close healthy, actively transferring peers.
		connectedDeadline.Stop()
		peers.MarkConnected(pc)
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			connectedDeadline.Stop()
			capturePeerAddress()
			peers.MarkConnected(pc)
		case webrtc.PeerConnectionStateFailed:
			connectedDeadline.Stop()
			peers.MarkFailed()
			peers.Remove(pc)
			go closePeer()
		case webrtc.PeerConnectionStateClosed:
			connectedDeadline.Stop()
			peers.Remove(pc)
			session.Close()
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer, SDP: offer.SDP,
	}); err != nil {
		closePeer()
		return AnswerBlob{}, err
	}
	for _, raw := range offer.Candidates {
		var candidate webrtc.ICECandidateInit
		if err := json.Unmarshal(raw, &candidate); err != nil || candidate.Candidate == "" {
			continue
		}
		if err := pc.AddICECandidate(candidate); err != nil {
			log.Printf("session %s: rejected candidate: %v", offer.SessionID, err)
		}
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		closePeer()
		return AnswerBlob{}, err
	}

	// Collect candidates as they are gathered. Registered before
	// SetLocalDescription, which is what starts gathering.
	var candidateMu sync.Mutex
	// Three ports over UDP+TCP currently produce twelve SDP candidates because
	// Pion emits component aliases. Pre-size the burst hot path accordingly.
	candidates := make([]json.RawMessage, 0, 12)
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		encoded, err := json.Marshal(c.ToJSON())
		if err != nil {
			return
		}
		candidateMu.Lock()
		candidates = append(candidates, encoded)
		candidateMu.Unlock()
	})

	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		closePeer()
		return AnswerBlob{}, err
	}

	// Non-trickle, with a timeout. Waiting forever on gathering-complete is a
	// real hang; sending what we have is always better than never answering.
	gatherTimer := time.NewTimer(2 * time.Second)
	defer gatherTimer.Stop()
	select {
	case <-gathered:
	case <-gatherTimer.C:
		log.Printf("session %s: ICE gathering timed out, answering with what we have", offer.SessionID)
	case <-ctx.Done():
		closePeer()
		return AnswerBlob{}, ctx.Err()
	}

	local := pc.LocalDescription()
	if local == nil {
		closePeer()
		return AnswerBlob{}, errNoLocalDescription
	}

	// Candidates travel inside the SDP for non-trickle, but the client applies
	// the explicit list too, so send both.
	candidateMu.Lock()
	out := append([]json.RawMessage(nil), candidates...)
	candidateMu.Unlock()

	return AnswerBlob{SDP: local.SDP, Candidates: out}, nil
}

// selectedRemoteAddress reports the visitor's address from the nominated ICE
// candidate pair, or "" while no pair is selected. Every intermediate value is
// checked because this runs on connection-state callbacks, where a peer that is
// already tearing down can leave any of them nil.
func selectedRemoteAddress(pc *webrtc.PeerConnection) string {
	sctp := pc.SCTP()
	if sctp == nil {
		return ""
	}
	dtls := sctp.Transport()
	if dtls == nil {
		return ""
	}
	iceTransport := dtls.ICETransport()
	if iceTransport == nil {
		return ""
	}
	pair, err := iceTransport.GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Remote == nil {
		return ""
	}
	return pair.Remote.Address
}

var errNoLocalDescription = errorString("no local description after gathering")

type errorString string

func (e errorString) Error() string { return string(e) }

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

// yurirtcEnv reads the current YuriRTC name first and then the corresponding
// legacy name. Keeping this precedence in one place lets existing deployments
// migrate one variable at a time without changing command-line behavior.
func yurirtcEnv(suffix, fallback string) string {
	if value := os.Getenv("YURIRTC_" + suffix); value != "" {
		return value
	}
	if value := os.Getenv("EDUROCKS_" + suffix); value != "" {
		return value
	}
	return fallback
}
