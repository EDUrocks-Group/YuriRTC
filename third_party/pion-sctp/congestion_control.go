// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-FileCopyrightText: 2026 EDUrocks contributors
// SPDX-License-Identifier: MIT

package sctp

import (
	"math"
	"time"
)

// CongestionControlAlgorithm selects the sender congestion controller.
type CongestionControlAlgorithm uint8

const (
	// CongestionControlReno preserves Pion's RFC 9260 linear congestion
	// avoidance and one-half fast-loss decrease. It remains the zero value so
	// upstream users of Config retain their original behavior.
	CongestionControlReno CongestionControlAlgorithm = iota
	// CongestionControlCUBIC uses the RFC 9438 window function and decrease
	// factor. The SCTP-specific four-MTU lower bound from RFC 9260 is retained.
	CongestionControlCUBIC
)

// CwndCAStepUseCUBIC is a compatibility selector for Pion WebRTC's existing
// SettingEngine.SetSCTPCwndCAStep hook. Upstream WebRTC does not yet expose a
// congestion-controller option, so YuriRTC sends this impossible fixed-step
// value through that hook and this fork converts it into explicit CUBIC.
// Normal numeric CA steps retain their original Reno meaning.
const CwndCAStepUseCUBIC uint32 = ^uint32(0)

const (
	cubicBeta              = 0.7
	cubicC                 = 0.4
	cubicFastConvergence   = (1 + cubicBeta) / 2
	immediateSACKCwndMTUs  = 10
	minimumSCTPSsthreshMTU = 4
)

type congestionController interface {
	algorithm() CongestionControlAlgorithm
	onAck(
		now time.Time,
		cwnd uint32,
		mtu uint32,
		bytesAcked uint32,
		srtt time.Duration,
		fullyUtilized bool,
		partialBytesAcked uint32,
	) (uint32, uint32)
	onFastLoss(now time.Time, cwnd, flightSize, mtu uint32) (uint32, uint32)
	onTimeout(now time.Time, cwnd, flightSize, mtu uint32) (uint32, uint32)
}

func newCongestionController(algorithm CongestionControlAlgorithm, cwndCAStep uint32) congestionController {
	if algorithm == CongestionControlCUBIC {
		return &cubicCongestionController{}
	}

	return &renoCongestionController{cwndCAStep: cwndCAStep}
}

func requestsImmediateSACK(cwnd, mtu uint32) bool {
	if mtu == 0 {
		return false
	}

	return uint64(cwnd) <= immediateSACKCwndMTUs*uint64(mtu)
}

func requestsImmediateSACKAtFloor(cwnd, mtu, floor uint32) bool {
	if requestsImmediateSACK(cwnd, mtu) {
		return true
	}

	return floor > 0 && cwnd <= floor
}

func windowWasFullyUtilized(flightSize, cwnd, mtu uint32, pending bool) bool {
	if cwnd == 0 || flightSize >= cwnd {
		return cwnd != 0
	}
	// DATA payload accounting excludes packet/chunk headers, so a sender with a
	// queued packet can be one MTU below the byte window while still having no
	// legal room for another chunk. Do not grant this tolerance without pending
	// data: that would let an application- or receiver-limited flow inflate cwnd.
	return pending && mtu > 0 && cwnd-flightSize <= mtu
}

func controllerWindowWasFullyUtilized(
	controller congestionController,
	flightSize, cwnd, mtu uint32,
	pending bool,
) bool {
	// Upstream Pion used queued DATA as its Reno growth condition. Keep that
	// behavior exactly for the zero-value/fallback controller; only CUBIC needs
	// RFC 9438's stricter application- and receiver-limited protection.
	if controller == nil || controller.algorithm() == CongestionControlReno {
		return pending
	}

	return windowWasFullyUtilized(flightSize, cwnd, mtu, pending)
}

type renoCongestionController struct {
	cwndCAStep uint32
}

func (*renoCongestionController) algorithm() CongestionControlAlgorithm {
	return CongestionControlReno
}

func (r *renoCongestionController) onAck(
	_ time.Time,
	cwnd uint32,
	mtu uint32,
	bytesAcked uint32,
	_ time.Duration,
	fullyUtilized bool,
	partialBytesAcked uint32,
) (uint32, uint32) {
	if !fullyUtilized {
		return cwnd, partialBytesAcked
	}

	partialBytesAcked = saturatingAdd32(partialBytesAcked, bytesAcked)
	if partialBytesAcked < cwnd {
		return cwnd, partialBytesAcked
	}

	partialBytesAcked -= cwnd

	return saturatingAdd32(cwnd, max(mtu, r.cwndCAStep)), partialBytesAcked
}

func (*renoCongestionController) onFastLoss(
	_ time.Time,
	cwnd uint32,
	_ uint32,
	mtu uint32,
) (uint32, uint32) {
	window := max32(cwnd/2, minimumSCTPSsthreshMTU*mtu)

	return window, window
}

func (*renoCongestionController) onTimeout(
	_ time.Time,
	cwnd uint32,
	_ uint32,
	mtu uint32,
) (uint32, uint32) {
	return mtu, max32(cwnd/2, minimumSCTPSsthreshMTU*mtu)
}

// cubicCongestionController is an RFC 9438 sender controller expressed in
// SMSS-sized segments. The association lock serializes calls into it.
//
// SCTP's ACK and loss detection remain in Association. This object owns only
// the congestion-window policy, making Reno fallback deterministic and keeping
// transport mechanics out of the CUBIC math.
type cubicCongestionController struct {
	epochStart time.Time
	wMax       float64
	wEst       float64
	cwndEpoch  float64
	cwndPrior  float64
	k          float64
	virtualCW  float64

	applicationLimitedSince time.Time
	afterTimeout            bool
}

func (*cubicCongestionController) algorithm() CongestionControlAlgorithm {
	return CongestionControlCUBIC
}

func (c *cubicCongestionController) onAck(
	now time.Time,
	cwnd uint32,
	mtu uint32,
	bytesAcked uint32,
	srtt time.Duration,
	fullyUtilized bool,
	_ uint32,
) (uint32, uint32) {
	if mtu == 0 || cwnd == 0 {
		return cwnd, 0
	}

	if !fullyUtilized {
		if c.applicationLimitedSince.IsZero() {
			c.applicationLimitedSince = now
		}

		return cwnd, 0
	}

	if !c.applicationLimitedSince.IsZero() {
		if !c.epochStart.IsZero() {
			c.epochStart = c.epochStart.Add(now.Sub(c.applicationLimitedSince))
		}
		c.applicationLimitedSince = time.Time{}
	}

	cwndSegments := float64(cwnd) / float64(mtu)
	if c.epochStart.IsZero() {
		c.startEpoch(now, cwndSegments, float64(cwnd))
	}
	if c.virtualCW < float64(cwnd) {
		c.virtualCW = float64(cwnd)
	}

	ackedSegments := float64(bytesAcked) / float64(mtu)
	alpha := 3 * (1 - cubicBeta) / (1 + cubicBeta)
	if c.wEst >= c.cwndPrior {
		alpha = 1
	}
	c.wEst += alpha * ackedSegments / cwndSegments

	elapsed := now.Sub(c.epochStart).Seconds()
	if elapsed < 0 {
		elapsed = 0
	}
	cubicNow := c.windowAt(elapsed)

	if cubicNow < c.wEst {
		c.virtualCW = max(c.virtualCW, c.wEst*float64(mtu))
	} else {
		if srtt <= 0 {
			srtt = time.Millisecond
		}
		target := c.windowAt(elapsed + srtt.Seconds())
		target = min(max(target, cwndSegments), 1.5*cwndSegments)
		incrementSegments := (target - cwndSegments) / cwndSegments
		c.virtualCW += incrementSegments * float64(mtu)
	}

	return boundedUint32(c.virtualCW, cwnd), 0
}

func (c *cubicCongestionController) onFastLoss(
	_ time.Time,
	cwnd uint32,
	flightSize uint32,
	mtu uint32,
) (uint32, uint32) {
	cwndSegments := float64(cwnd) / float64(mtu)
	if c.wMax > 0 && cwndSegments < c.wMax {
		c.wMax = cwndSegments * cubicFastConvergence
	} else {
		c.wMax = cwndSegments
	}
	c.cwndPrior = cwndSegments
	c.resetEpoch()
	c.afterTimeout = false

	window := cubicReducedWindow(flightSize, cwnd, mtu)
	c.virtualCW = float64(window)

	return window, window
}

func (c *cubicCongestionController) onTimeout(
	_ time.Time,
	cwnd uint32,
	flightSize uint32,
	mtu uint32,
) (uint32, uint32) {
	c.cwndPrior = float64(cwnd) / float64(mtu)
	c.resetEpoch()
	c.wMax = 0
	c.afterTimeout = true
	c.virtualCW = float64(mtu)

	return mtu, cubicReducedWindow(flightSize, cwnd, mtu)
}

func (c *cubicCongestionController) startEpoch(now time.Time, cwndSegments, cwndBytes float64) {
	c.epochStart = now
	c.cwndEpoch = cwndSegments
	c.wEst = cwndSegments
	c.virtualCW = cwndBytes

	if c.afterTimeout || c.wMax == 0 {
		c.wMax = cwndSegments
		c.k = 0
		c.afterTimeout = false
	} else if c.wMax > c.cwndEpoch {
		c.k = math.Cbrt((c.wMax - c.cwndEpoch) / cubicC)
	} else {
		c.k = 0
	}

	if c.cwndPrior == 0 {
		c.cwndPrior = cwndSegments
	}
}

func (c *cubicCongestionController) resetEpoch() {
	c.epochStart = time.Time{}
	c.cwndEpoch = 0
	c.wEst = 0
	c.k = 0
	c.applicationLimitedSince = time.Time{}
}

func (c *cubicCongestionController) windowAt(elapsed float64) float64 {
	offset := elapsed - c.k

	return cubicC*offset*offset*offset + c.wMax
}

func cubicReducedWindow(flightSize, cwnd, mtu uint32) uint32 {
	if flightSize == 0 || flightSize > cwnd {
		flightSize = cwnd
	}
	reduced := uint64(math.Floor(float64(flightSize) * cubicBeta))
	minimum := uint64(minimumSCTPSsthreshMTU) * uint64(mtu)
	if reduced < minimum {
		reduced = minimum
	}
	if reduced > math.MaxUint32 {
		return math.MaxUint32
	}

	return uint32(reduced)
}

func saturatingAdd32(a, b uint32) uint32 {
	result := uint64(a) + uint64(b)
	if result > math.MaxUint32 {
		return math.MaxUint32
	}

	return uint32(result)
}

func boundedUint32(value float64, floor uint32) uint32 {
	if value < float64(floor) {
		return floor
	}
	if value >= math.MaxUint32 {
		return math.MaxUint32
	}

	return uint32(math.Floor(value))
}

func boundedIntToUint32(value int) uint32 {
	if value <= 0 {
		return 0
	}
	if uint64(value) > math.MaxUint32 {
		return math.MaxUint32
	}

	return uint32(value)
}
