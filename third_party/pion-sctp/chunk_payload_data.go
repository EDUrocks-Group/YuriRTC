// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package sctp

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"time"
)

/*
chunkPayloadData represents an SCTP Chunk of type DATA

	 0                   1                   2                   3
	 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	|   Type = 0    | Reserved|U|B|E|    Length                     |
	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	|                              TSN                              |
	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	|      Stream Identifier S      |   Stream Sequence Number n    |
	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	|                  Payload Protocol Identifier                  |
	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
	|                                                               |
	|                 User Data (seq n of Stream S)                 |
	|                                                               |
	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

An unfragmented user message shall have both the B and E bits set to
'1'.  Setting both B and E bits to '0' indicates a middle fragment of
a multi-fragment user message, as summarized in the following table:

	   B E                  Description
	============================================================
	|  1 0 | First piece of a fragmented user message          |
	+----------------------------------------------------------+
	|  0 0 | Middle piece of a fragmented user message         |
	+----------------------------------------------------------+
	|  0 1 | Last piece of a fragmented user message           |
	+----------------------------------------------------------+
	|  1 1 | Unfragmented message                              |
	============================================================
	|             Table 1: Fragment Description Flags          |
	============================================================
*/
type chunkPayloadData struct {
	chunkHeader

	unordered         bool
	beginningFragment bool
	endingFragment    bool
	immediateSack     bool

	tsn                    uint32
	streamIdentifier       uint16
	streamSequenceNumber   uint16
	messageIdentifier      uint32
	fragmentSequenceNumber uint32
	payloadType            PayloadProtocolIdentifier
	userData               []byte
	iData                  bool

	// Whether this data chunk was acknowledged (received by peer)
	acked         bool
	missIndicator uint32

	// Partial-reliability parameters used only by sender
	since        time.Time
	nSent        uint32 // number of transmission made for this chunk
	_abandoned   bool
	_allInflight bool // valid only with the first fragment

	// Retransmission flag set when T1-RTX timeout occurred and this
	// chunk is still in the inflight queue
	retransmit bool

	head *chunkPayloadData // link to the head of the fragment

	rackPrev   *chunkPayloadData
	rackNext   *chunkPayloadData
	rackInList bool
}

func (p *chunkPayloadData) StreamIdentifier() uint16 {
	return p.streamIdentifier
}

func (p *chunkPayloadData) UserDataLen() int {
	return len(p.userData)
}

func (p *chunkPayloadData) IsStreamReset() bool {
	return p.userData == nil
}

func (p *chunkPayloadData) chunkPayloadData() *chunkPayloadData {
	return p
}

const (
	payloadDataEndingFragmentBitmask   = 1
	payloadDataBeginingFragmentBitmask = 2
	payloadDataUnorderedBitmask        = 4
	payloadDataImmediateSACK           = 8

	payloadDataHeaderSize = 12
	iDataHeaderSize       = 16
)

// PayloadProtocolIdentifier is an enum for DataChannel payload types.
type PayloadProtocolIdentifier uint32

// PayloadProtocolIdentifier enums
// https://www.iana.org/assignments/sctp-parameters/sctp-parameters.xhtml#sctp-parameters-25
const (
	PayloadTypeUnknown           PayloadProtocolIdentifier = 0
	PayloadTypeWebRTCDCEP        PayloadProtocolIdentifier = 50
	PayloadTypeWebRTCString      PayloadProtocolIdentifier = 51
	PayloadTypeWebRTCBinary      PayloadProtocolIdentifier = 53
	PayloadTypeWebRTCStringEmpty PayloadProtocolIdentifier = 56
	PayloadTypeWebRTCBinaryEmpty PayloadProtocolIdentifier = 57
)

// Data chunk errors.
var (
	ErrChunkPayloadSmall    = errors.New("packet is smaller than the header size")
	ErrChunkPayloadTooLarge = errors.New("DATA chunk exceeds the 16-bit chunk length")
)

func (p PayloadProtocolIdentifier) String() string {
	switch p {
	case PayloadTypeWebRTCDCEP:
		return "WebRTC DCEP"
	case PayloadTypeWebRTCString:
		return "WebRTC String"
	case PayloadTypeWebRTCBinary:
		return "WebRTC Binary"
	case PayloadTypeWebRTCStringEmpty:
		return "WebRTC String (Empty)"
	case PayloadTypeWebRTCBinaryEmpty:
		return "WebRTC Binary (Empty)"
	default:
		return fmt.Sprintf("Unknown Payload Protocol Identifier: %d", p)
	}
}

func (p *chunkPayloadData) unmarshal(raw []byte) error {
	if err := p.chunkHeader.unmarshal(raw); err != nil {
		return err
	}

	p.immediateSack = p.flags&payloadDataImmediateSACK != 0
	p.unordered = p.flags&payloadDataUnorderedBitmask != 0
	p.beginningFragment = p.flags&payloadDataBeginingFragmentBitmask != 0
	p.endingFragment = p.flags&payloadDataEndingFragmentBitmask != 0

	switch p.typ {
	case ctPayloadData:
		if len(p.raw) < payloadDataHeaderSize {
			return ErrChunkPayloadSmall
		}
		p.tsn = binary.BigEndian.Uint32(p.raw[0:])
		p.streamIdentifier = binary.BigEndian.Uint16(p.raw[4:])
		p.streamSequenceNumber = binary.BigEndian.Uint16(p.raw[6:])
		p.payloadType = PayloadProtocolIdentifier(binary.BigEndian.Uint32(p.raw[8:]))
		p.userData = p.raw[payloadDataHeaderSize:]
		p.iData = false
	case ctIData:
		if len(p.raw) < iDataHeaderSize {
			return ErrChunkPayloadSmall
		}
		p.tsn = binary.BigEndian.Uint32(p.raw[0:])
		p.streamIdentifier = binary.BigEndian.Uint16(p.raw[4:])
		p.messageIdentifier = binary.BigEndian.Uint32(p.raw[8:])
		if p.beginningFragment {
			p.payloadType = PayloadProtocolIdentifier(binary.BigEndian.Uint32(p.raw[12:]))
			p.fragmentSequenceNumber = 0
		} else {
			p.fragmentSequenceNumber = binary.BigEndian.Uint32(p.raw[12:])
			p.payloadType = PayloadTypeUnknown
		}
		p.streamSequenceNumber = uint16(p.messageIdentifier) //nolint:gosec // lower 16 bits for API exposure
		p.userData = p.raw[iDataHeaderSize:]
		p.iData = true
	default:
		return fmt.Errorf("%w: unsupported payload data chunk type %d", ErrChunkTypeUnhandled, p.typ)
	}

	return nil
}

func (p *chunkPayloadData) marshal() ([]byte, error) { //nolint:cyclop
	headerSize := payloadDataHeaderSize
	if p.isIData() {
		headerSize = iDataHeaderSize
	}

	return p.marshalAppend(make([]byte, 0, chunkHeaderSize+headerSize+len(p.userData)))
}

// marshalAppend serializes DATA directly into the final packet backing array.
// The upstream marshal path allocated both a payload buffer and a chunk-header
// buffer before copying both into a third packet buffer. DATA is the hot path,
// so writing it once removes two full-packet allocations without changing
// ownership or net.Conn.Write lifetime rules.
func (p *chunkPayloadData) marshalAppend(raw []byte) ([]byte, error) { //nolint:cyclop
	payloadHeaderSize := payloadDataHeaderSize
	chunkType := ctPayloadData
	if p.isIData() {
		payloadHeaderSize = iDataHeaderSize
		chunkType = ctIData
	}

	chunkLength := chunkHeaderSize + payloadHeaderSize + len(p.userData)
	if chunkLength > math.MaxUint16 {
		return nil, fmt.Errorf("%w: length %d exceeds %d", ErrChunkPayloadTooLarge, chunkLength, math.MaxUint16)
	}

	flags := uint8(0)
	if p.endingFragment {
		flags = payloadDataEndingFragmentBitmask
	}
	if p.beginningFragment {
		flags |= payloadDataBeginingFragmentBitmask
	}
	if p.unordered {
		flags |= payloadDataUnorderedBitmask
	}
	if p.immediateSack {
		flags |= payloadDataImmediateSACK
	}

	start := len(raw)
	raw = append(raw, make([]byte, chunkLength)...)
	raw[start] = uint8(chunkType)
	raw[start+1] = flags
	binary.BigEndian.PutUint16(raw[start+2:], uint16(chunkLength)) //nolint:gosec // checked above

	payload := raw[start+chunkHeaderSize:]
	binary.BigEndian.PutUint32(payload[0:], p.tsn)
	binary.BigEndian.PutUint16(payload[4:], p.streamIdentifier)
	if p.isIData() {
		binary.BigEndian.PutUint16(payload[6:], 0)
		binary.BigEndian.PutUint32(payload[8:], p.messageIdentifier)
		if p.beginningFragment {
			binary.BigEndian.PutUint32(payload[12:], uint32(p.payloadType))
		} else {
			binary.BigEndian.PutUint32(payload[12:], p.fragmentSequenceNumber)
		}
	} else {
		binary.BigEndian.PutUint16(payload[6:], p.streamSequenceNumber)
		binary.BigEndian.PutUint32(payload[8:], uint32(p.payloadType))
	}
	copy(payload[payloadHeaderSize:], p.userData)

	p.chunkHeader.flags = flags
	p.chunkHeader.typ = chunkType

	return raw, nil
}

func (p *chunkPayloadData) check() (abort bool, err error) {
	return false, nil
}

// String makes chunkPayloadData printable.
func (p *chunkPayloadData) String() string {
	if p.isIData() {
		return fmt.Sprintf("%s\ntsn=%d mid=%d fsn=%d", p.chunkHeader, p.tsn, p.messageIdentifier, p.fragmentSequenceNumber)
	}

	return fmt.Sprintf("%s\n%d", p.chunkHeader, p.tsn)
}

func (p *chunkPayloadData) abandoned() bool {
	if p.head != nil {
		return p.head._abandoned && p.head._allInflight
	}

	return p._abandoned && p._allInflight
}

func (p *chunkPayloadData) setAbandoned(abandoned bool) {
	if p.head != nil {
		p.head._abandoned = abandoned

		return
	}
	p._abandoned = abandoned
}

func (p *chunkPayloadData) setAllInflight() {
	if p.endingFragment {
		if p.head != nil {
			p.head._allInflight = true
		} else {
			p._allInflight = true
		}
	}
}

func (p *chunkPayloadData) isFragmented() bool {
	return p.head != nil || !p.beginningFragment || !p.endingFragment
}

func (p *chunkPayloadData) isIData() bool {
	return p.iData || p.typ == ctIData
}

func (p *chunkPayloadData) chunkSize() int {
	if p.isIData() {
		return chunkHeaderSize + iDataHeaderSize + len(p.userData)
	}

	return chunkHeaderSize + payloadDataHeaderSize + len(p.userData)
}

func (p *chunkPayloadData) chunkSizeInPacket() int {
	chunkSize := p.chunkSize()

	return chunkSize + getPadding(chunkSize)
}
