package main

// Turns a RequestHead into bytes: static files from the configured site root
// and everything under /apiv2/ proxied to the configured HTTP backend.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// apiPrefix is stripped before proxying because backend routes mount at root.
const apiPrefix = "/apiv2"

const (
	// Below this size, scheduling overhead and latency matter more than bulk
	// congestion. Above it, limiting concurrent bodies prevents many cover/game
	// requests from collapsing one ordered SCTP association under loss.
	bulkResponseThreshold = 128 * 1024
	// This bounds aggregate disk readers and worst-case queued SCTP data while
	// leaving small shell/API assets outside the gate.
	// 256 active readers use at most 32 MiB of v3 frame buffers. Waiting
	// requests have not opened a file, so this raises aggregate throughput and
	// fairness without multiplying descriptors or buffers toward peer count.
	maxGlobalBulkResponses = 256
	// Non-SSE proxy bodies read in full-frame chunks so a large API response
	// pays one credit/lock/frame cycle per 128 KiB rather than four. Long-lived
	// streams are SSE and use the dedicated small pool below, so one of these
	// buffers is only retained while a body is actively streaming; regular
	// files avoid the copy entirely via PeerSession.StreamBody.
	proxyBufferBytes = maxPayloadBytes
	// SSE events are tiny and the Read blocks between events. A 1 KiB buffer
	// keeps each idle chat cheap while preserving incremental delivery; events
	// larger than the buffer continue across ordered response frames.
	sseBufferBytes = 1 * 1024
)

var streamBufferPool = sync.Pool{
	New: func() any { return make([]byte, proxyBufferBytes) },
}

var sseBufferPool = sync.Pool{
	New: func() any { return make([]byte, sseBufferBytes) },
}

type Handler struct {
	Root       string // dist/
	BackendURL string // http://127.0.0.1:1801
	// WebSocketURL is the one upstream a carried websocket may reach, e.g.
	// ws://127.0.0.1:1802. Empty disables websockets entirely, which is the
	// right default: a node that does not need to carry one should not be able
	// to open one.
	WebSocketURL string
	client       *http.Client
	bulkSlots    chan struct{}
}

// responseSender is the transport-facing subset Handler needs. Session is the
// production implementation; keeping the boundary small also lets status and
// framing behavior be tested without constructing a full WebRTC association.
type responseSender interface {
	SendHead(id uint32, head ResponseHead) error
	SendBody(ctx context.Context, id uint32, chunk []byte) error
	SendEnd(id uint32) error
}

// directResponseStreamer reads into the transport's frame payload area. The
// production PeerSession implements this to avoid a second response-sized
// buffer and copy; lightweight test senders can keep using SendBody.
type directResponseStreamer interface {
	StreamBody(ctx context.Context, id uint32, src io.Reader, limit int64) error
}

type bulkResponseLimiter interface {
	AcquireBulk(ctx context.Context) (release func(), err error)
}

// peerAddressSource supplies the visitor address this node states to the
// backend on the peer's behalf. PeerSession is the production implementation.
type peerAddressSource interface {
	PeerAddress() string
}

func NewHandler(root, backendURL string) *Handler {
	return &Handler{
		Root:       root,
		BackendURL: strings.TrimRight(backendURL, "/"),
		bulkSlots:  make(chan struct{}, maxGlobalBulkResponses),
		client: &http.Client{
			// No global timeout: /apiv2/ai and /apiv2/chat are SSE and stream
			// indefinitely. Cancellation comes from the request context.
			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout:   5 * time.Second,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				// The node has one loopback backend. Keeping a sizeable shared pool
				// avoids a TCP handshake for each API request during user bursts;
				// active SSE streams are not counted as idle connections.
				MaxIdleConns:        512,
				MaxIdleConnsPerHost: 256,
				IdleConnTimeout:     90 * time.Second,
				// The backend streams; buffering here would break SSE the same
				// way proxy_buffering on would.
				DisableCompression: true,
			},
		},
	}
}

func (h *Handler) Serve(ctx context.Context, out responseSender, id uint32, head RequestHead, body io.ReadCloser) error {
	path, query := splitPath(head.URL)
	if strings.HasPrefix(path, apiPrefix+"/") || path == apiPrefix {
		return h.proxy(ctx, out, id, head, path, query, body)
	}
	if body != nil {
		_ = body.Close()
	}
	return h.static(ctx, out, id, head, path)
}

func splitPath(raw string) (string, string) {
	if i := strings.IndexByte(raw, '?'); i >= 0 {
		return raw[:i], raw[i+1:]
	}
	return raw, ""
}

// resolve maps a URL path to a file, refusing anything that escapes the root.
// The library is reached through a symlink, so EvalSymlinks would reject every
// legitimate path — containment is enforced on the lexical path instead.
func (h *Handler) resolve(urlPath string) (string, error) {
	clean := filepath.Clean("/" + strings.TrimPrefix(urlPath, "/"))
	if strings.Contains(clean, "..") {
		return "", errors.New("path traversal")
	}
	full := filepath.Join(h.Root, clean)
	if full != h.Root && !strings.HasPrefix(full, h.Root+string(os.PathSeparator)) {
		return "", errors.New("path escapes root")
	}
	return full, nil
}

func (h *Handler) static(ctx context.Context, out responseSender, id uint32, head RequestHead, urlPath string) error {
	full, err := h.resolve(urlPath)
	if err != nil {
		return h.sendStatus(out, id, http.StatusForbidden, "Forbidden")
	}

	info, err := os.Stat(full)
	if err == nil && info.IsDir() {
		full = filepath.Join(full, "index.html")
		info, err = os.Stat(full)
	}
	if err != nil {
		if os.IsNotExist(err) {
			return h.sendStatus(out, id, http.StatusNotFound, "Not Found")
		}
		return err
	}

	size := info.Size()
	status := http.StatusOK
	statusText := "OK"
	start, end := int64(0), size-1

	// Range matters: large media in the library is requested with Range, and
	// without it seeking refetches from byte zero every time.
	if raw := headerValue(head.Headers, "range"); raw != "" {
		s, e, ok := parseRange(raw, size)
		if !ok {
			pairs := HeaderPairs{{"content-range", fmt.Sprintf("bytes */%d", size)}}
			if err := out.SendHead(id, ResponseHead{
				Status: http.StatusRequestedRangeNotSatisfiable, StatusText: "Range Not Satisfiable", Headers: pairs,
			}); err != nil {
				return err
			}
			return out.SendEnd(id)
		}
		start, end = s, e
		status, statusText = http.StatusPartialContent, "Partial Content"
	}

	length := end - start + 1
	if head.Method != http.MethodHead && length >= bulkResponseThreshold {
		if limiter, ok := out.(bulkResponseLimiter); ok {
			release, err := limiter.AcquireBulk(ctx)
			if err != nil {
				return err
			}
			defer release()
		}
		select {
		case h.bulkSlots <- struct{}{}:
			defer func() { <-h.bulkSlots }()
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	// Wait for bulk capacity before opening the file, so a large queue does not
	// consume one descriptor per waiting request. HEAD never needs to open it.
	var file *os.File
	if head.Method != http.MethodHead {
		file, err = os.Open(full)
		if err != nil {
			return err
		}
		defer file.Close()
		if start != 0 {
			if _, err := file.Seek(start, io.SeekStart); err != nil {
				return err
			}
		}
		// The served tree is much larger than RAM, so bulk asset reads miss the
		// page cache and stall the lane on disk latency. Warn the kernel that
		// this range is sequential so it widens readahead and starts the first
		// window now. Advice only: a failure changes nothing about the bytes
		// served, so it is not worth failing or logging a request over.
		if length >= bulkResponseThreshold {
			_ = hintSequentialRead(file, start, length)
		}
	}
	headers := HeaderPairs{
		{"content-type", contentType(full)},
		{"content-length", strconv.FormatInt(length, 10)},
		{"accept-ranges", "bytes"},
		{"last-modified", info.ModTime().UTC().Format(http.TimeFormat)},
	}
	if status == http.StatusPartialContent {
		headers = append(headers, [2]string{"content-range", fmt.Sprintf("bytes %d-%d/%d", start, end, size)})
	}
	if isImmutable(urlPath) {
		headers = append(headers, [2]string{"cache-control", "public, max-age=31536000, immutable"})
	}

	if err := out.SendHead(id, ResponseHead{Status: status, StatusText: statusText, Headers: headers}); err != nil {
		return err
	}
	if head.Method == http.MethodHead {
		return out.SendEnd(id)
	}
	// Only regular files use the direct 128 KiB frame path. Proxy readers may
	// block between chunks; reading those while holding a lane body lock would
	// stall every other response body on the same lane.
	if direct, ok := out.(directResponseStreamer); ok {
		err = direct.StreamBody(ctx, id, file, length)
	} else {
		err = streamN(ctx, out, id, file, length)
	}
	if err != nil {
		return err
	}
	return out.SendEnd(id)
}

func (h *Handler) proxy(ctx context.Context, out responseSender, id uint32, head RequestHead, path, query string, body io.ReadCloser) error {
	// The backend mounts its routes at the root: /apiv2/ai reaches it as /ai.
	// Forwarding the public prefix intact would make every API route miss.
	backendPath := strings.TrimPrefix(path, apiPrefix)
	if backendPath == "" {
		backendPath = "/"
	}

	target := h.BackendURL + backendPath
	if query != "" {
		target += "?" + query
	}

	var reader io.Reader
	if body != nil {
		reader = body
	}
	request, err := http.NewRequestWithContext(ctx, head.Method, target, reader)
	if err != nil {
		return err
	}
	for _, pair := range head.Headers {
		// Lowercase before every comparison: Header.Add canonicalises names, so
		// a peer sending "X-Forwarded-For" in any casing would otherwise reach
		// the backend under the same canonical key a case-sensitive check missed.
		name := strings.ToLower(pair[0])
		if isHopByHop(name) || name == "host" || isForwardingHeader(name) {
			continue
		}
		request.Header.Add(name, pair[1])
	}
	// The browser-facing transport always runs in a secure context, even though
	// this final hop to Express is loopback HTTP. Express uses this header (with
	// `trust proxy`) to decide whether it may emit Secure session cookies. Without
	// it login returns 200 but no sid is ever created.
	request.Header.Set("X-Forwarded-Proto", "https")
	// Deliberately no X-Forwarded-For or X-Real-IP yet, although the visitor's
	// address is available here through peerAddressSource.
	//
	// A backend may use the absence of those headers as proof that a request
	// arrived from this node rather than through its public reverse proxy,
	// because an edge proxy adds them to everything it forwards. Stating them
	// here makes every transported request look like an edge request, which
	// silently changes such a backend's behaviour -- in this deployment it
	// turned the carrier's websocket ticket into an address-bound one that the
	// upstream can only reject, because the upstream sees this node's address
	// and not the visitor's.
	//
	// Sending them requires the backend to identify this node positively
	// instead, by a shared secret it can verify, and both sides must agree
	// before either changes. Until then the backend attributes every
	// transported request to this node's own address, so per-visitor limits are
	// shared across the transport's whole user base.
	// The backend's session cookie is domain-scoped to its own host; the SW is
	// the service-worker jar and has already put the right Cookie header on the frame.
	request.Host = hostOf(h.BackendURL)

	response, err := h.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	headers := headerPairsFrom(response.Header)
	// Set-Cookie is deliberately preserved here: the SW reads it off the frame
	// and stores it, because the browser ignores it on a synthesized Response.
	if err := out.SendHead(id, ResponseHead{
		Status: response.StatusCode, StatusText: response.Status, Headers: headers,
	}); err != nil {
		return err
	}
	stream := streamN
	if strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		stream = streamSSE
	}
	if err := stream(ctx, out, id, response.Body, -1); err != nil {
		return err
	}
	return out.SendEnd(id)
}

// streamN copies at most limit bytes (-1 for all) as RES_BODY frames. Chunks
// are flushed as they are read so SSE responses arrive incrementally rather
// than at completion.
func streamN(ctx context.Context, out responseSender, id uint32, src io.Reader, limit int64) error {
	buf := streamBufferPool.Get().([]byte)
	defer streamBufferPool.Put(buf[:proxyBufferBytes])
	return streamBuffered(ctx, out, id, src, limit, buf)
}

func streamSSE(ctx context.Context, out responseSender, id uint32, src io.Reader, limit int64) error {
	buf := sseBufferPool.Get().([]byte)
	defer sseBufferPool.Put(buf[:sseBufferBytes])
	return streamBuffered(ctx, out, id, src, limit, buf)
}

func streamBuffered(ctx context.Context, out responseSender, id uint32, src io.Reader, limit int64, buf []byte) error {
	remaining := limit
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if remaining == 0 {
			return nil
		}
		size := len(buf)
		if remaining > 0 && remaining < int64(size) {
			size = int(remaining)
		}
		n, err := src.Read(buf[:size])
		if n > 0 {
			if sendErr := out.SendBody(ctx, id, buf[:n]); sendErr != nil {
				return sendErr
			}
			if remaining > 0 {
				remaining -= int64(n)
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func (h *Handler) sendStatus(out responseSender, id uint32, status int, text string) error {
	if err := out.SendHead(id, ResponseHead{
		Status: status, StatusText: text,
		Headers: HeaderPairs{{"content-type", "text/plain; charset=utf-8"}},
	}); err != nil {
		return err
	}
	return out.SendEnd(id)
}

// parseRange handles the single-range forms the browser actually sends.
// Multipart ranges are not supported and never requested by media elements.
func parseRange(raw string, size int64) (int64, int64, bool) {
	if !strings.HasPrefix(raw, "bytes=") || size == 0 {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(raw, "bytes=")
	if strings.Contains(spec, ",") {
		return 0, 0, false
	}
	dash := strings.IndexByte(spec, '-')
	if dash < 0 {
		return 0, 0, false
	}
	startText, endText := strings.TrimSpace(spec[:dash]), strings.TrimSpace(spec[dash+1:])

	if startText == "" {
		// Suffix form: the last N bytes.
		n, err := strconv.ParseInt(endText, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		if n > size {
			n = size
		}
		return size - n, size - 1, true
	}

	start, err := strconv.ParseInt(startText, 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	end := size - 1
	if endText != "" {
		parsed, err := strconv.ParseInt(endText, 10, 64)
		if err != nil || parsed < start {
			return 0, 0, false
		}
		if parsed < end {
			end = parsed
		}
	}
	return start, end, true
}

func isImmutable(urlPath string) bool {
	return strings.HasPrefix(urlPath, "/a/")
}

// isForwardingHeader lists the headers that describe who a request came
// through. Only this node may state them, because the backend trusts them to
// identify a visitor.
func isForwardingHeader(name string) bool {
	switch name {
	case "forwarded", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
		"x-forwarded-port", "x-forwarded-server", "x-real-ip", "x-client-ip",
		"cf-connecting-ip", "true-client-ip":
		return true
	}
	return false
}

func isHopByHop(name string) bool {
	switch name {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"te", "trailer", "transfer-encoding", "upgrade", "content-length":
		return true
	}
	return false
}

func hostOf(rawURL string) string {
	trimmed := strings.TrimPrefix(strings.TrimPrefix(rawURL, "http://"), "https://")
	if i := strings.IndexByte(trimmed, '/'); i >= 0 {
		trimmed = trimmed[:i]
	}
	return trimmed
}

var extraTypes = map[string]string{
	".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
	".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
	".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
	".ogg": "audio/ogg", ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
}

func contentType(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if t, ok := extraTypes[ext]; ok {
		return t
	}
	return "application/octet-stream"
}
