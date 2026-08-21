package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const (
	// A reconnect starts with one root snapshot. RTDB's 100-connection Spark
	// ceiling times the rule-bounded offer size can legitimately exceed 2MiB,
	// while 8MiB still prevents an unbounded scanner allocation.
	defaultRTDBStreamMaxEventBytes = 8 * 1024 * 1024
	maxRTDBStreamUIDBytes          = 128
)

var (
	ErrRTDBStreamCancelled   = errors.New("rtdb stream cancelled")
	ErrRTDBStreamAuthRevoked = errors.New("rtdb stream authentication revoked")
	ErrRTDBStreamEventTooBig = errors.New("rtdb stream event exceeds size limit")
)

// firebaseRTDBRedirect preserves the OAuth bearer token across Firebase's
// documented 307 redirect to a shard host, but refuses to forward credentials
// anywhere outside Firebase Database's own HTTPS domains.
func firebaseRTDBRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("too many RTDB redirects")
	}
	host := strings.ToLower(req.URL.Hostname())
	trusted := strings.HasSuffix(host, ".firebaseio.com") ||
		strings.HasSuffix(host, ".firebasedatabase.app")
	if req.URL.Scheme != "https" || !trusted {
		return fmt.Errorf("refusing RTDB credential redirect to %s", req.URL.Redacted())
	}
	if len(via) > 0 {
		if authorization := via[len(via)-1].Header.Get("Authorization"); authorization != "" {
			req.Header.Set("Authorization", authorization)
		}
	}
	req.Header.Set("Accept", "text/event-stream")
	return nil
}

// RTDBOfferEvent is one complete offer observed under /signal/{uid}/offer.
type RTDBOfferEvent struct {
	UID   string
	Offer OfferBlob
}

// RTDBOfferStream consumes one authenticated Realtime Database REST stream.
// Authentication belongs to the injected HTTP client's transport; this type
// neither loads credentials nor adds tokens itself.
type RTDBOfferStream struct {
	client        *http.Client
	endpoint      string
	maxEventBytes int
}

// NewRTDBOfferStream builds a single-connection listener. Listen returns on
// EOF, cancellation, auth revocation, HTTP failure, or callback failure; retry
// and credential refresh policy deliberately stay with its caller.
func NewRTDBOfferStream(client *http.Client, databaseURL string) (*RTDBOfferStream, error) {
	if client == nil {
		return nil, errors.New("rtdb stream requires an HTTP client")
	}

	endpoint, err := rtdbSignalStreamURL(databaseURL)
	if err != nil {
		return nil, err
	}
	return &RTDBOfferStream{
		client:        client,
		endpoint:      endpoint,
		maxEventBytes: defaultRTDBStreamMaxEventBytes,
	}, nil
}

func rtdbSignalStreamURL(databaseURL string) (string, error) {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return "", fmt.Errorf("parse RTDB URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("RTDB URL must use http or https")
	}
	if parsed.Host == "" {
		return "", errors.New("RTDB URL is missing a host")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/signal.json"
	parsed.RawPath = ""
	return parsed.String(), nil
}

// Listen opens one SSE response and invokes handle for every complete offer it
// contains. The callback runs inline, preserving Firebase event ordering.
func (s *RTDBOfferStream) Listen(
	ctx context.Context,
	handle func(RTDBOfferEvent) error,
) error {
	if handle == nil {
		return errors.New("rtdb stream requires an offer handler")
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint, nil)
	if err != nil {
		return fmt.Errorf("create RTDB stream request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")

	response, err := s.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("open RTDB stream: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("open RTDB stream: unexpected HTTP status %s", response.Status)
	}

	return s.consume(ctx, response.Body, handle)
}

func (s *RTDBOfferStream) consume(
	ctx context.Context,
	reader io.Reader,
	handle func(RTDBOfferEvent) error,
) error {
	maxBytes := s.maxEventBytes
	if maxBytes <= 0 {
		maxBytes = defaultRTDBStreamMaxEventBytes
	}

	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maxBytes+1024)

	var eventName string
	var eventData strings.Builder
	hasData := false
	dataBytes := 0
	reset := func() {
		eventName = ""
		eventData.Reset()
		hasData = false
		dataBytes = 0
	}
	dispatch := func() error {
		defer reset()
		if !hasData {
			return nil
		}
		data := []byte(eventData.String())
		return dispatchRTDBStreamEvent(ctx, eventName, data, handle)
	}

	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}

		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		} else if strings.HasPrefix(value, " ") {
			value = value[1:]
		}
		switch field {
		case "event":
			eventName = value
		case "data":
			additional := len(value)
			if hasData {
				additional++ // newline inserted by the SSE data-field rules
			}
			if dataBytes+additional > maxBytes {
				return ErrRTDBStreamEventTooBig
			}
			if hasData {
				eventData.WriteByte('\n')
			}
			eventData.WriteString(value)
			hasData = true
			dataBytes += additional
		}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("read RTDB stream: %w", err)
	}
	if err := dispatch(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return io.EOF
}

func dispatchRTDBStreamEvent(
	ctx context.Context,
	eventName string,
	data []byte,
	handle func(RTDBOfferEvent) error,
) error {
	switch eventName {
	case "", "message", "keep-alive":
		return nil
	case "cancel":
		return streamControlError(ErrRTDBStreamCancelled, data)
	case "auth_revoked":
		return streamControlError(ErrRTDBStreamAuthRevoked, data)
	case "put", "patch":
		// handled below
	default:
		return nil
	}

	var envelope struct {
		Path string          `json:"path"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return fmt.Errorf("decode RTDB %s event: %w", eventName, err)
	}

	offers, err := offersFromRTDBEnvelope(envelope.Path, envelope.Data)
	if err != nil {
		return fmt.Errorf("decode RTDB %s payload at %q: %w", eventName, envelope.Path, err)
	}
	for _, offer := range offers {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := handle(offer); err != nil {
			return fmt.Errorf("handle RTDB offer %q: %w", offer.UID, err)
		}
	}
	return nil
}

func streamControlError(kind error, data []byte) error {
	var detail string
	if err := json.Unmarshal(data, &detail); err != nil {
		detail = strings.TrimSpace(string(data))
	}
	if detail == "" || detail == "null" {
		return kind
	}
	return fmt.Errorf("%w: %s", kind, detail)
}

func offersFromRTDBEnvelope(path string, data json.RawMessage) ([]RTDBOfferEvent, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil, nil
	}

	parts := splitRTDBStreamPath(path)
	switch {
	case len(parts) == 0:
		return offersFromRTDBRoot(data)
	case len(parts) == 1:
		return offerFromRTDBNode(parts[0], data), nil
	case len(parts) == 2 && parts[1] == "offer":
		return offerFromRTDBValue(parts[0], data), nil
	default:
		return nil, nil
	}
}

func splitRTDBStreamPath(path string) []string {
	path = strings.Trim(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

func offersFromRTDBRoot(data json.RawMessage) ([]RTDBOfferEvent, error) {
	var children map[string]json.RawMessage
	if err := json.Unmarshal(data, &children); err != nil {
		return nil, err
	}

	offers := make([]RTDBOfferEvent, 0)
	for key, child := range children {
		parts := splitRTDBStreamPath(key)
		switch {
		case len(parts) == 1:
			offers = append(offers, offerFromRTDBNode(parts[0], child)...)
		case len(parts) == 2 && parts[1] == "offer":
			offers = append(offers, offerFromRTDBValue(parts[0], child)...)
		}
	}
	return offers, nil
}

func offerFromRTDBNode(uid string, data json.RawMessage) []RTDBOfferEvent {
	if !validRTDBStreamUID(uid) {
		return nil
	}
	var node struct {
		Offer  json.RawMessage `json:"offer"`
		Answer json.RawMessage `json:"answer"`
	}
	if err := json.Unmarshal(data, &node); err != nil {
		return nil
	}
	answer := bytes.TrimSpace(node.Answer)
	if len(answer) > 0 && !bytes.Equal(answer, []byte("null")) {
		return nil // an initial snapshot can contain answers awaiting cleanup
	}
	return offerFromRTDBValue(uid, node.Offer)
}

func offerFromRTDBValue(uid string, data json.RawMessage) []RTDBOfferEvent {
	data = bytes.TrimSpace(data)
	if !validRTDBStreamUID(uid) || len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil
	}
	var offer OfferBlob
	if err := json.Unmarshal(data, &offer); err != nil {
		return nil
	}
	return []RTDBOfferEvent{{UID: uid, Offer: offer}}
}

func validRTDBStreamUID(uid string) bool {
	return uid != "" && len(uid) <= maxRTDBStreamUIDBytes && !strings.Contains(uid, "/")
}
