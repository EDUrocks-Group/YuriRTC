package main

// Node-side signaling for the RTDB and Firestore compatibility legs.
//
// Two legs, both answered by this process with one service account. The admin
// SDK bypasses security rules, so it watches the whole /signal tree while each
// client can only see its own branch.
//
// Racing the legs means the *same* offer can arrive twice, once per path. The
// node dedupes on sessionId — carried inside the payload, because the legs
// address clients differently and there is no shared uid to key on.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/db"
	"google.golang.org/api/iterator"
)

type OfferBlob struct {
	SessionID  string            `json:"sessionId"`
	SDP        string            `json:"sdp"`
	Candidates []json.RawMessage `json:"candidates"`
}

type AnswerBlob struct {
	SDP        string            `json:"sdp"`
	Candidates []json.RawMessage `json:"candidates"`
}

// AnswerFunc turns an offer into an answer. Returning an error means the node
// could not build a peer connection; the offer is dropped.
type AnswerFunc func(ctx context.Context, offer OfferBlob) (AnswerBlob, error)

// Dedupe keeps recently answered sessionIds so a raced offer produces one peer
// connection rather than two, one of which would leak.
type Dedupe struct {
	mu    sync.Mutex
	seen  map[string]*dedupeEntry
	order []dedupeRecord
	head  int
	ttl   time.Duration
}

// dedupeRecord is an append-only expiry index. Records are chronological, so
// Join only removes expired entries from the front instead of scanning every
// connected/recent session for every new offer.
type dedupeRecord struct {
	sessionID string
	entry     *dedupeEntry
}

type dedupeEntry struct {
	at     time.Time
	ready  chan struct{}
	once   sync.Once
	answer AnswerBlob
	err    error
}

func NewDedupe(ttl time.Duration) *Dedupe {
	return &Dedupe{seen: make(map[string]*dedupeEntry), ttl: ttl}
}

// Join returns the shared result slot and whether this caller must produce it.
// Duplicate signaling legs then reuse one peer connection's answer instead of
// deleting the fallback offer and making the fallback unable to win.
func (d *Dedupe) Join(sessionID string) (*dedupeEntry, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now()
	d.pruneLocked(now)
	if entry, exists := d.seen[sessionID]; exists {
		return entry, false
	}
	entry := &dedupeEntry{at: now, ready: make(chan struct{})}
	d.seen[sessionID] = entry
	d.order = append(d.order, dedupeRecord{sessionID: sessionID, entry: entry})
	return entry, true
}

func (d *Dedupe) pruneLocked(now time.Time) {
	for d.head < len(d.order) {
		record := d.order[d.head]
		if now.Sub(record.entry.at) <= d.ttl {
			break
		}
		// The pointer check keeps this safe if the same session id was inserted
		// again after an older record expired.
		if d.seen[record.sessionID] == record.entry {
			delete(d.seen, record.sessionID)
		}
		d.head++
	}

	// Periodically reclaim the consumed prefix without making the common Join
	// path copy the queue. Peak storage is bounded to roughly twice the live
	// dedupe window.
	if d.head >= 1024 && d.head*2 >= len(d.order) {
		copy(d.order, d.order[d.head:])
		d.order = d.order[:len(d.order)-d.head]
		d.head = 0
	}
}

func (e *dedupeEntry) complete(answer AnswerBlob, err error) {
	e.once.Do(func() {
		e.answer = answer
		e.err = err
		close(e.ready)
	})
}

func (e *dedupeEntry) wait(ctx context.Context) (AnswerBlob, error) {
	select {
	case <-ctx.Done():
		return AnswerBlob{}, ctx.Err()
	case <-e.ready:
		return e.answer, e.err
	}
}

type Signaler struct {
	rtdb       *db.Client
	rtdbStream *RTDBOfferStream
	firestore  *firestore.Client
	dedupe     *Dedupe
	answer     AnswerFunc

	mu        sync.Mutex
	firstSeen map[string]time.Time
}

func NewSignaler(ctx context.Context, app *firebase.App, databaseURL string, streamHTTP *http.Client, answer AnswerFunc) (*Signaler, error) {
	// Pass the URL explicitly. An empty string does not fall back to the app's
	// configured DatabaseURL — it fails with "invalid database url".
	rtdbClient, err := app.DatabaseWithURL(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	fsClient, err := app.Firestore(ctx)
	if err != nil {
		return nil, err
	}
	rtdbStream, err := NewRTDBOfferStream(streamHTTP, databaseURL)
	if err != nil {
		return nil, err
	}
	return &Signaler{
		rtdb:       rtdbClient,
		rtdbStream: rtdbStream,
		firestore:  fsClient,
		// Both answer documents are removed after 30 seconds. Two minutes is
		// ample for a delayed racing leg while avoiding retention of SDP and
		// candidate blobs for the lifetime of long-lived peer connections.
		dedupe:    NewDedupe(2 * time.Minute),
		answer:    answer,
		firstSeen: make(map[string]time.Time),
	}, nil
}

func (s *Signaler) Run(ctx context.Context) {
	go s.watchRTDB(ctx)
	go s.watchFirestore(ctx)
	go s.sweep(ctx)
}

// RTDB leg. One authenticated REST SSE connection replaces the former 500ms
// conditional poll (172,800 HTTP requests/day while idle). A reconnect begins
// with a root snapshot, so no offers are lost while the stream is down.
func (s *Signaler) watchRTDB(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		connectedAt := time.Now()
		err := s.rtdbStream.Listen(ctx, func(event RTDBOfferEvent) error {
			s.handleRTDBOffer(ctx, event)
			return nil
		})
		if ctx.Err() != nil {
			return
		}
		if time.Since(connectedAt) > 30*time.Second {
			backoff = time.Second
		}
		if !errors.Is(err, io.EOF) {
			log.Printf("rtdb stream: %v (reconnecting in %s)", err, backoff)
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func (s *Signaler) handleRTDBOffer(ctx context.Context, event RTDBOfferEvent) {
	uid := event.UID
	removeRTDB := func() {
		_ = s.rtdb.NewRef("signal/" + uid).Delete(context.Background())
	}
	go s.handle(ctx, "rtdb", event.Offer, func(answer AnswerBlob) error {
		if err := s.rtdb.NewRef("signal/"+uid+"/answer").Set(ctx, answer); err != nil {
			return err
		}
		// Delete after answering. Abandoned offers are small but they
		// accumulate against the 1GB cap and slow the initial sync.
		time.AfterFunc(30*time.Second, removeRTDB)
		return nil
	}, removeRTDB)
}

// Firestore leg. Unlike RTDB, the admin SDK talks gRPC and gets a real snapshot
// listener — so only the browser polls, and the node side is a single stream.
func (s *Signaler) watchFirestore(ctx context.Context) {
	for ctx.Err() == nil {
		snapshots := s.firestore.Collection("signal").Snapshots(ctx)
		for {
			snapshot, err := snapshots.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("firestore listener: %v (retrying)", err)
					time.Sleep(2 * time.Second)
				}
				break
			}
			for _, change := range snapshot.Changes {
				if change.Kind == firestore.DocumentRemoved {
					continue
				}
				doc := change.Doc
				// Replacing the offer with the answer emits one modified snapshot.
				// Check this before validating offer so that completed documents are
				// ignored rather than mistaken for malformed input and deleted before
				// the browser can collect them.
				if _, err := doc.DataAt("answer"); err == nil {
					continue
				}
				ref := doc.Ref
				removeDoc := func() {
					_, _ = ref.Delete(context.Background())
				}
				raw, err := doc.DataAt("offer")
				if err != nil {
					go removeDoc()
					continue
				}
				text, ok := raw.(string)
				if !ok {
					go removeDoc()
					continue
				}
				var offer OfferBlob
				if err := json.Unmarshal([]byte(text), &offer); err != nil {
					go removeDoc()
					continue
				}
				go s.handle(ctx, "firestore", offer, func(answer AnswerBlob) error {
					fields, err := firestoreAnswerDocument(answer, time.Now())
					if err != nil {
						return err
					}
					// Replace rather than merge: the browser only needs the answer,
					// and retaining the duplicated SDP offer wastes document storage
					// and listener bandwidth until cleanup runs.
					if _, err := ref.Set(ctx, fields); err != nil {
						return err
					}
					time.AfterFunc(30*time.Second, removeDoc)
					return nil
				}, removeDoc)
			}
		}
		snapshots.Stop()
	}
}

func (s *Signaler) handle(ctx context.Context, leg string, offer OfferBlob, reply func(AnswerBlob) error, discard func()) {
	if offer.SessionID == "" || offer.SDP == "" {
		discard()
		return
	}
	entry, leader := s.dedupe.Join(offer.SessionID)
	if leader {
		answer, err := s.answer(ctx, offer)
		entry.complete(answer, err)
	}
	answer, err := entry.wait(ctx)
	if err != nil {
		if leader && !errors.Is(err, context.Canceled) {
			log.Printf("[%s] answering %s: %v", leg, offer.SessionID, err)
		}
		if errors.Is(err, context.Canceled) {
			return
		}
		discard()
		return
	}
	if err := reply(answer); err != nil {
		log.Printf("[%s] writing answer for %s: %v", leg, offer.SessionID, err)
		discard()
		return
	}
}

func firestoreAnswerDocument(answer AnswerBlob, now time.Time) (map[string]any, error) {
	encoded, err := json.Marshal(answer)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"answer":   string(encoded),
		"expireAt": now.Add(5 * time.Minute),
	}, nil
}

// sweep clears entries abandoned by clients that never came back. Firestore
// also has a native TTL policy, but that is best-effort within 24 hours, so it
// is a backstop rather than the mechanism.
func (s *Signaler) sweep(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		cutoff := time.Now().Add(-60 * time.Second)
		docs := s.firestore.Collection("signal").Where("expireAt", "<", cutoff).Documents(ctx)
		for {
			doc, err := docs.Next()
			if err != nil {
				break
			}
			_, _ = doc.Ref.Delete(ctx)
		}
		docs.Stop()

		// RTDB too. Without this, offers from clients that never came back stay
		// forever — and because the poller reads the whole subtree, every
		// abandoned entry permanently inflates the cost of every read.
		s.sweepRTDB(ctx)
	}
}

// sweepRTDB removes /signal entries that no client is waiting on.
//
// Keys are listed shallow — just the uids, not their payloads — so the sweep
// itself never downloads SDP blobs. Anything first seen more than a minute ago
// is gone: a client that has not collected its answer by then has given up.
func (s *Signaler) sweepRTDB(ctx context.Context) {
	var keys map[string]bool
	if err := s.rtdb.NewRef("signal").GetShallow(ctx, &keys); err != nil {
		log.Printf("rtdb sweep: %v", err)
		return
	}

	now := time.Now()
	s.mu.Lock()
	for uid := range keys {
		if _, known := s.firstSeen[uid]; !known {
			s.firstSeen[uid] = now
		}
	}
	stale := make([]string, 0)
	for uid, at := range s.firstSeen {
		if _, present := keys[uid]; !present {
			delete(s.firstSeen, uid)
			continue
		}
		if now.Sub(at) > time.Minute {
			stale = append(stale, uid)
			delete(s.firstSeen, uid)
		}
	}
	s.mu.Unlock()

	for _, uid := range stale {
		if err := s.rtdb.NewRef("signal/" + uid).Delete(ctx); err != nil {
			log.Printf("rtdb sweep %s: %v", uid, err)
			continue
		}
		log.Printf("rtdb swept abandoned offer %s", uid)
	}
}
