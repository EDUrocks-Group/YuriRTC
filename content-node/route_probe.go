package main

// The route probe lets a loader compare two already-encrypted WebRTC paths
// without depending on any file or application route in the hosted site.

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

const (
	routeProbeHeader       = "x-yurirtc-route-probe"
	routeProbePayloadBytes = 1 * 1024 * 1024
)

// Generated once and shared read-only by every request. Xorshift64* is used as
// a deterministic byte generator, not for security; DTLS supplies encryption.
// Its high-entropy output keeps the measurement representative of compressed
// game data without allocating or filling one MiB for each probe.
var routeProbePayload = func() []byte {
	payload := make([]byte, routeProbePayloadBytes)
	state := uint64(0x6a09e667f3bcc909)
	for index := range payload {
		state ^= state >> 12
		state ^= state << 25
		state ^= state >> 27
		value := state * 0x2545f4914f6cdd1d
		payload[index] = byte(value >> 56)
	}
	return payload
}()

func (h *Handler) routeProbe(
	ctx context.Context,
	out responseSender,
	id uint32,
	head RequestHead,
) error {
	value, _ := joinedHeaderValue(head.Headers, routeProbeHeader)
	if (head.Method != http.MethodGet && head.Method != http.MethodHead) ||
		value != strconv.Itoa(routeProbePayloadBytes) || head.HasBody {
		return sendRouteProbeStatus(out, id, http.StatusBadRequest, "Bad Request")
	}
	if claimer, ok := out.(routeProbeClaimer); ok && !claimer.ClaimRouteProbe() {
		return sendRouteProbeStatus(out, id, http.StatusTooManyRequests, "Too Many Requests")
	}

	if head.Method == http.MethodGet {
		if limiter, ok := out.(bulkResponseLimiter); ok {
			release, err := limiter.AcquireBulk(ctx)
			if err != nil {
				return err
			}
			defer release()
		}
		if h.bulkSlots != nil {
			select {
			case h.bulkSlots <- struct{}{}:
				defer func() { <-h.bulkSlots }()
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}

	headers := HeaderPairs{
		{"content-type", "application/octet-stream"},
		{"content-length", strconv.Itoa(routeProbePayloadBytes)},
		{"cache-control", "no-store"},
		{"date", time.Now().UTC().Format(http.TimeFormat)},
		{routeProbeHeader, strconv.Itoa(routeProbePayloadBytes)},
	}
	if err := out.SendHead(id, ResponseHead{
		Status: http.StatusOK, StatusText: "OK", Headers: headers,
	}); err != nil {
		return err
	}
	if head.Method == http.MethodGet {
		if err := streamEncodedBytes(ctx, out, id, routeProbePayload); err != nil {
			return err
		}
	}
	return out.SendEnd(id)
}

func sendRouteProbeStatus(out responseSender, id uint32, status int, text string) error {
	if err := out.SendHead(id, ResponseHead{
		Status: status, StatusText: text,
		Headers: HeaderPairs{
			{"content-type", "text/plain; charset=utf-8"},
			{"cache-control", "no-store"},
			{"date", time.Now().UTC().Format(http.TimeFormat)},
		},
	}); err != nil {
		return err
	}
	return out.SendEnd(id)
}
