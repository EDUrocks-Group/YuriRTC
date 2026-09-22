package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// One identity per registry, rotated daily for new peers. Pion copies the
// immutable certificate into each connection; rotation never changes an
// established connection's identity or its independent DTLS session keys.
type certificateCache struct {
	mu           sync.Mutex
	certificate  *webrtc.Certificate
	refreshAfter time.Time
}

func (c *certificateCache) get(now time.Time) (webrtc.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.certificate != nil && now.Before(c.refreshAfter) && now.Add(time.Hour).Before(c.certificate.Expires()) {
		return *c.certificate, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return webrtc.Certificate{}, err
	}
	certificate, err := webrtc.GenerateCertificate(key)
	if err != nil {
		return webrtc.Certificate{}, err
	}
	c.certificate = certificate
	c.refreshAfter = now.Add(24 * time.Hour)
	return *certificate, nil
}
