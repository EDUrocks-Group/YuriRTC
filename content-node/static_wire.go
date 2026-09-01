package main

// Static-response validators and the private YuriRTC wire gzip layer live
// here rather than in protocol.go: they use ordinary v3 header pairs and do
// not add or reinterpret a frame type.

import (
	"bytes"
	"compress/gzip"
	"container/list"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	wireAcceptEncodingHeader = "x-yurirtc-accept-wire-encoding"
	wireEncodingHeader       = "x-yurirtc-wire-encoding"
	wireGzipEncoding         = "gzip"

	// Tiny payloads gain little after the gzip header and checksum, while the
	// compression setup would sit directly on their latency-sensitive path.
	minWireGzipBytes = 1 * 1024
	// Assets above this are compressed as a stream instead of being retained in
	// memory. This still accelerates large WASM/JSON files without letting one
	// game consume the complete cache budget during its first request.
	maxWireGzipCacheSourceBytes = 32 * 1024 * 1024
	maxWireGzipCacheEntryBytes  = 8 * 1024 * 1024
	maxWireGzipCacheBytes       = 64 * 1024 * 1024
	maxWireGzipCacheBuilds      = 4
)

type wireGzipCacheKey struct {
	path      string
	size      int64
	modTimeNS int64
}

type wireGzipCacheEntry struct {
	key  wireGzipCacheKey
	data []byte
}

type wireGzipFlight struct {
	done chan struct{}
	data []byte
	use  bool
	err  error
}

// wireGzipCache is a process-private LRU of compressed bytes. Its key follows
// the same identity as the static ETag, and concurrent misses for one identity
// share a build so a waterfall cannot make every peer recompress one asset.
type wireGzipCache struct {
	mu      sync.Mutex
	used    int64
	lru     *list.List
	entries map[wireGzipCacheKey]*list.Element
	flights map[wireGzipCacheKey]*wireGzipFlight
	builds  chan struct{}
}

func newWireGzipCache() *wireGzipCache {
	return &wireGzipCache{
		lru:     list.New(),
		entries: make(map[wireGzipCacheKey]*list.Element),
		flights: make(map[wireGzipCacheKey]*wireGzipFlight),
		builds:  make(chan struct{}, maxWireGzipCacheBuilds),
	}
}

func (c *wireGzipCache) load(
	ctx context.Context,
	key wireGzipCacheKey,
	build func() ([]byte, bool, error),
) ([]byte, bool, error) {
	c.mu.Lock()
	if element := c.entries[key]; element != nil {
		c.lru.MoveToFront(element)
		data := element.Value.(*wireGzipCacheEntry).data
		c.mu.Unlock()
		return data, true, nil
	}
	if flight := c.flights[key]; flight != nil {
		c.mu.Unlock()
		select {
		case <-flight.done:
			return flight.data, flight.use, flight.err
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
	}
	flight := &wireGzipFlight{done: make(chan struct{})}
	c.flights[key] = flight
	c.mu.Unlock()

	select {
	case c.builds <- struct{}{}:
		flight.data, flight.use, flight.err = build()
		<-c.builds
	case <-ctx.Done():
		flight.err = ctx.Err()
	}

	c.mu.Lock()
	if flight.err == nil && flight.use {
		c.storeLocked(key, flight.data)
	}
	delete(c.flights, key)
	close(flight.done)
	c.mu.Unlock()
	return flight.data, flight.use, flight.err
}

func (c *wireGzipCache) storeLocked(key wireGzipCacheKey, data []byte) {
	if len(data) == 0 || len(data) > maxWireGzipCacheEntryBytes {
		return
	}
	// A changed file at the same path must not retain its predecessor merely
	// because the total budget has room for both identities.
	for candidate, element := range c.entries {
		if candidate.path != key.path || candidate == key {
			continue
		}
		entry := element.Value.(*wireGzipCacheEntry)
		c.used -= int64(len(entry.data))
		delete(c.entries, candidate)
		c.lru.Remove(element)
	}
	entry := &wireGzipCacheEntry{key: key, data: data}
	c.entries[key] = c.lru.PushFront(entry)
	c.used += int64(len(data))
	for c.used > maxWireGzipCacheBytes {
		oldest := c.lru.Back()
		if oldest == nil {
			break
		}
		entry := oldest.Value.(*wireGzipCacheEntry)
		c.used -= int64(len(entry.data))
		delete(c.entries, entry.key)
		c.lru.Remove(oldest)
	}
}

func compressWireGzip(src io.Reader, length int64) ([]byte, bool, error) {
	var encoded bytes.Buffer
	writer, err := gzip.NewWriterLevel(&encoded, gzip.BestSpeed)
	if err != nil {
		return nil, false, err
	}
	written, copyErr := io.Copy(writer, io.LimitReader(src, length))
	closeErr := writer.Close()
	if copyErr != nil {
		return nil, false, copyErr
	}
	if closeErr != nil {
		return nil, false, closeErr
	}
	if written != length {
		return nil, false, io.ErrUnexpectedEOF
	}
	// Require a real saving rather than changing the wire form for a handful of
	// bytes that disappear into per-frame and DTLS overhead anyway.
	if int64(encoded.Len()+64) >= length {
		return nil, false, nil
	}
	return encoded.Bytes(), true, nil
}

type wireBodyWriter struct {
	ctx     context.Context
	out     responseSender
	id      uint32
	pending []byte
}

func (w *wireBodyWriter) Write(data []byte) (int, error) {
	written := 0
	for len(data) > 0 {
		if err := w.ctx.Err(); err != nil {
			return written, err
		}
		// Avoid turning flate's smaller internal writes into many undersized
		// response frames. A full source slice can be sent directly; otherwise
		// coalesce it into one maximum-sized YuriRTC payload.
		if len(w.pending) == 0 && len(data) >= maxPayloadBytes {
			if err := w.out.SendBody(w.ctx, w.id, data[:maxPayloadBytes]); err != nil {
				return written, err
			}
			written += maxPayloadBytes
			data = data[maxPayloadBytes:]
			continue
		}
		space := maxPayloadBytes - len(w.pending)
		size := min(len(data), space)
		w.pending = append(w.pending, data[:size]...)
		written += size
		data = data[size:]
		if len(w.pending) == maxPayloadBytes {
			if err := w.flush(); err != nil {
				return written - size, err
			}
		}
	}
	return written, nil
}

func (w *wireBodyWriter) flush() error {
	if len(w.pending) == 0 {
		return nil
	}
	if err := w.out.SendBody(w.ctx, w.id, w.pending); err != nil {
		return err
	}
	w.pending = w.pending[:0]
	return nil
}

func streamEncodedBytes(ctx context.Context, out responseSender, id uint32, data []byte) error {
	for len(data) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		size := min(len(data), maxPayloadBytes)
		if err := out.SendBody(ctx, id, data[:size]); err != nil {
			return err
		}
		data = data[size:]
	}
	return nil
}

func streamWireGzip(ctx context.Context, out responseSender, id uint32, src io.Reader, length int64) error {
	destination := &wireBodyWriter{ctx: ctx, out: out, id: id, pending: make([]byte, 0, maxPayloadBytes)}
	writer, err := gzip.NewWriterLevel(destination, gzip.BestSpeed)
	if err != nil {
		return err
	}
	buffer := streamBufferPool.Get().([]byte)
	written, copyErr := io.CopyBuffer(writer, io.LimitReader(src, length), buffer)
	streamBufferPool.Put(buffer[:proxyBufferBytes])
	closeErr := writer.Close()
	if copyErr != nil {
		return copyErr
	}
	if written != length {
		return io.ErrUnexpectedEOF
	}
	if closeErr != nil {
		return closeErr
	}
	return destination.flush()
}

func acceptsWireGzip(headers HeaderPairs) bool {
	for _, pair := range headers {
		if !equalFold(pair[0], wireAcceptEncodingHeader) {
			continue
		}
		for _, item := range strings.Split(pair[1], ",") {
			parts := strings.Split(item, ";")
			if !strings.EqualFold(strings.TrimSpace(parts[0]), wireGzipEncoding) {
				continue
			}
			allowed := true
			for _, parameter := range parts[1:] {
				name, value, found := strings.Cut(strings.TrimSpace(parameter), "=")
				if found && strings.EqualFold(strings.TrimSpace(name), "q") && strings.TrimSpace(value) == "0" {
					allowed = false
				}
			}
			if allowed {
				return true
			}
		}
	}
	return false
}

func cacheControlHasDirective(value, wanted string) bool {
	for _, item := range strings.Split(value, ",") {
		name, _, _ := strings.Cut(strings.TrimSpace(item), "=")
		if strings.EqualFold(strings.TrimSpace(name), wanted) {
			return true
		}
	}
	return false
}

func requestCacheControlHasDirective(headers HeaderPairs, wanted string) bool {
	value, _ := joinedHeaderValue(headers, "cache-control")
	return cacheControlHasDirective(value, wanted)
}

func isWireInternalHeader(name string) bool {
	return equalFold(name, wireAcceptEncodingHeader) ||
		equalFold(name, wireEncodingHeader) ||
		equalFold(name, routeProbeHeader)
}

func isWireGzipType(value string) bool {
	mediaType, _, _ := strings.Cut(strings.ToLower(value), ";")
	mediaType = strings.TrimSpace(mediaType)
	if strings.HasPrefix(mediaType, "text/") || strings.HasSuffix(mediaType, "+json") || strings.HasSuffix(mediaType, "+xml") {
		return true
	}
	switch mediaType {
	case "application/javascript", "application/x-javascript", "application/json",
		"application/manifest+json", "application/wasm", "application/xml",
		"image/svg+xml":
		return true
	}
	return false
}

func staticETag(info os.FileInfo) string {
	// Weak is deliberate: size and nanosecond mtime identify a representation
	// cheaply without hashing a multi-gigabyte game on its first request.
	return fmt.Sprintf(`W/"%x-%x"`, info.Size(), info.ModTime().UnixNano())
}

func requestNotModified(head RequestHead, etag string, modTime time.Time) bool {
	if head.Method != http.MethodGet && head.Method != http.MethodHead {
		return false
	}
	if value, present := joinedHeaderValue(head.Headers, "if-none-match"); present {
		return ifNoneMatch(value, etag)
	}
	if value := headerValue(head.Headers, "if-modified-since"); value != "" {
		if since, err := http.ParseTime(value); err == nil {
			return !modTime.UTC().Truncate(time.Second).After(since.UTC())
		}
	}
	return false
}

func joinedHeaderValue(headers HeaderPairs, name string) (string, bool) {
	values := make([]string, 0, 1)
	for _, pair := range headers {
		if equalFold(pair[0], name) {
			values = append(values, pair[1])
		}
	}
	return strings.Join(values, ","), len(values) > 0
}

func ifNoneMatch(value, current string) bool {
	for _, candidate := range strings.Split(value, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || weakETag(candidate) == weakETag(current) {
			return true
		}
	}
	return false
}

func weakETag(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && (value[0] == 'W' || value[0] == 'w') && value[1] == '/' {
		return strings.TrimSpace(value[2:])
	}
	return value
}
