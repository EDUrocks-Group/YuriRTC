// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package dtls

import (
	"context"

	"github.com/pion/dtls/v3/pkg/protocol"
	"github.com/pion/dtls/v3/pkg/protocol/recordlayer"
)

// WriteBatch sends already-ready application records synchronously. It never
// waits for a batch to fill, retains datagram/MTU bounds, and consumes caller
// buffers before returning. An error is terminal to the calling association;
// some records may have reached the network before it was returned.
func (c *Conn) WriteBatch(payloads [][]byte) error {
	if c.isConnectionClosed() {
		return ErrConnClosed
	}
	if err := c.writeDeadline.Err(); err != nil {
		return errDeadlineExceeded
	}
	if err := c.Handshake(); err != nil {
		return err
	}
	ctx := c.applicationWriteContext()
	for len(payloads) > 0 {
		size := min(len(payloads), 8)
		if err := c.writeApplicationBatch(ctx, payloads[:size]); err != nil {
			return err
		}
		payloads = payloads[size:]
	}
	return nil
}

func (c *Conn) writeApplicationBatch(ctx context.Context, payloads [][]byte) error {
	var packets [8]packet
	var records [8]recordlayer.RecordLayer
	var contents [8]protocol.ApplicationData
	var pointers [8]*packet
	epoch := c.state.getLocalEpoch()
	for i, payload := range payloads {
		contents[i].Data = payload
		records[i] = recordlayer.RecordLayer{Header: recordlayer.Header{Epoch: epoch, Version: protocol.Version1_2}, Content: &contents[i]}
		packets[i] = packet{record: &records[i], shouldWrapCID: len(c.state.remoteConnectionID) > 0, shouldEncrypt: true}
		pointers[i] = &packets[i]
	}
	return c.writePackets(ctx, pointers[:len(payloads)])
}
