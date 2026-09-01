// SPDX-FileCopyrightText: 2026 EDUrocks contributors
// SPDX-License-Identifier: MIT

package sctp

import (
	"math"
	"testing"
	"time"
)

func TestCwndCAStepCUBICCompatibilitySelector(t *testing.T) {
	config := &Config{}
	option := WithCwndCAStep(CwndCAStepUseCUBIC)
	if err := option.applyClient(config); err != nil {
		t.Fatalf("apply CUBIC selector: %v", err)
	}
	if config.CongestionControl != CongestionControlCUBIC {
		t.Fatalf("controller = %d, want CUBIC", config.CongestionControl)
	}
	if config.CwndCAStep != 0 {
		t.Fatalf("fixed CA step = %d, want zero under CUBIC", config.CwndCAStep)
	}

	config = &Config{}
	if err := WithCwndCAStep(4 * 1191).applyServer(config); err != nil {
		t.Fatalf("apply Reno CA step: %v", err)
	}
	if config.CongestionControl != CongestionControlReno || config.CwndCAStep != 4*1191 {
		t.Fatalf("ordinary CA step changed algorithm: %+v", config)
	}
}

func TestCongestionControllerDefaultRemainsReno(t *testing.T) {
	if got := newCongestionController(CongestionControlReno, 0).algorithm(); got != CongestionControlReno {
		t.Fatalf("zero-value controller = %d, want Reno", got)
	}
	if got := newCongestionController(CongestionControlCUBIC, 0).algorithm(); got != CongestionControlCUBIC {
		t.Fatalf("explicit controller = %d, want CUBIC", got)
	}
}

func TestCUBICFastLossUsesStandardsDecrease(t *testing.T) {
	const (
		mtu  = uint32(1200)
		cwnd = uint32(1_200_000)
	)
	controller := &cubicCongestionController{}
	window, threshold := controller.onFastLoss(time.Unix(1, 0), cwnd, cwnd, mtu)
	want := uint32(math.Floor(float64(cwnd) * cubicBeta))
	if window != want || threshold != want {
		t.Fatalf("CUBIC loss window = (%d, %d), want (%d, %d)", window, threshold, want, want)
	}
	if window <= cwnd/2 {
		t.Fatalf("CUBIC reduced to %d, no better than Reno half-window %d", window, cwnd/2)
	}
}

func TestCUBICRecoversTowardPriorWindowFasterThanReno(t *testing.T) {
	const (
		mtu      = uint32(1200)
		prior    = uint32(1_200_000)
		rtt      = 128 * time.Millisecond
		ackBytes = 2 * mtu
	)
	started := time.Unix(10, 0)
	cubic := &cubicCongestionController{}
	cubicWindow, _ := cubic.onFastLoss(started, prior, prior, mtu)
	reno := &renoCongestionController{}
	renoWindow, renoPartial := reno.onFastLoss(started, prior, prior, mtu)

	// Feed each controller the same delayed-SACK clock for four seconds. This is
	// long enough to enter CUBIC's concave recovery but short enough that neither
	// controller should exceed the pre-loss path estimate by a large burst.
	for ack := 1; ack <= 4000; ack++ {
		now := started.Add(time.Duration(ack) * time.Millisecond)
		cubicWindow, _ = cubic.onAck(now, cubicWindow, mtu, ackBytes, rtt, true, 0)
		renoWindow, renoPartial = reno.onAck(
			now, renoWindow, mtu, ackBytes, rtt, true, renoPartial,
		)
	}
	if cubicWindow <= renoWindow {
		t.Fatalf("CUBIC window %d did not exceed Reno window %d", cubicWindow, renoWindow)
	}
	if cubicWindow < prior*9/10 {
		t.Fatalf("CUBIC recovered only to %d, want at least 90%% of prior %d", cubicWindow, prior)
	}
}

func TestCUBICPausesEpochWhileApplicationLimited(t *testing.T) {
	const mtu = uint32(1200)
	controller := &cubicCongestionController{}
	started := time.Unix(20, 0)
	window, _ := controller.onFastLoss(started, 120_000, 120_000, mtu)
	window, _ = controller.onAck(started.Add(time.Second), window, mtu, mtu, 100*time.Millisecond, true, 0)
	epochBefore := controller.epochStart
	window, _ = controller.onAck(started.Add(2*time.Second), window, mtu, mtu, 100*time.Millisecond, false, 0)
	window, _ = controller.onAck(started.Add(7*time.Second), window, mtu, mtu, 100*time.Millisecond, true, 0)
	if shift := controller.epochStart.Sub(epochBefore); shift != 5*time.Second {
		t.Fatalf("application-limited epoch shift = %s, want 5s", shift)
	}
}

func TestImmediateSACKThreshold(t *testing.T) {
	const mtu = uint32(1191)
	if !requestsImmediateSACK(10*mtu, mtu) {
		t.Fatal("ten-MTU window did not request Immediate-SACK")
	}
	if requestsImmediateSACK(10*mtu+1, mtu) {
		t.Fatal("window above ten MTUs requested Immediate-SACK")
	}
	if requestsImmediateSACK(mtu, 0) {
		t.Fatal("zero MTU requested Immediate-SACK")
	}
}

func TestImmediateSACKRefreshesForAlreadyQueuedDataAfterCollapse(t *testing.T) {
	const mtu = uint32(1191)
	association := &Association{
		mtu:                  mtu,
		cwnd:                 20 * mtu,
		congestionController: newCongestionController(CongestionControlCUBIC, 0),
	}
	queued := &chunkPayloadData{userData: []byte("queued before congestion")}
	association.bundleDataChunksIntoPackets([]*chunkPayloadData{queued})
	if queued.immediateSack {
		t.Fatal("high-window DATA unexpectedly requested Immediate-SACK")
	}

	association.setCWND(10 * mtu)
	association.bundleDataChunksIntoPackets([]*chunkPayloadData{queued})
	if !queued.immediateSack {
		t.Fatal("already-queued DATA did not refresh I-bit after cwnd collapse")
	}
}

func TestImmediateSACKIncludesConfiguredCongestionFloor(t *testing.T) {
	const mtu = uint32(1191)
	const floor = uint32(12 * 1024)
	if !requestsImmediateSACKAtFloor(floor, mtu, floor) {
		t.Fatal("configured low-window floor did not request Immediate-SACK")
	}
	if requestsImmediateSACKAtFloor(floor+1, mtu, floor) {
		t.Fatal("window above configured floor requested Immediate-SACK")
	}
}

func TestWindowUtilizationRequiresOutstandingBytesAndPendingData(t *testing.T) {
	const mtu = uint32(1200)
	const cwnd = uint32(12_000)
	if !windowWasFullyUtilized(cwnd, cwnd, mtu, false) {
		t.Fatal("full byte window was not treated as utilized")
	}
	if !windowWasFullyUtilized(cwnd-mtu, cwnd, mtu, true) {
		t.Fatal("one packet of serialization slack was not treated as utilized")
	}
	if windowWasFullyUtilized(cwnd-mtu, cwnd, mtu, false) {
		t.Fatal("application-limited flight used packet slack without pending data")
	}
	if windowWasFullyUtilized(cwnd-2*mtu, cwnd, mtu, true) {
		t.Fatal("receiver-limited flight was treated as a full congestion window")
	}
}

func TestRenoRetainsUpstreamQueuedDataGrowthCondition(t *testing.T) {
	reno := newCongestionController(CongestionControlReno, 0)
	cubic := newCongestionController(CongestionControlCUBIC, 0)
	if !controllerWindowWasFullyUtilized(reno, 0, 12_000, 1200, true) {
		t.Fatal("Reno no longer treats queued DATA as its upstream growth condition")
	}
	if controllerWindowWasFullyUtilized(cubic, 0, 12_000, 1200, true) {
		t.Fatal("CUBIC treated an empty flight as fully utilized")
	}
	if controllerWindowWasFullyUtilized(reno, 12_000, 12_000, 1200, false) {
		t.Fatal("Reno grew without upstream's queued DATA condition")
	}
}

func TestBoundedIntToUint32(t *testing.T) {
	if got := boundedIntToUint32(-1); got != 0 {
		t.Fatalf("negative conversion = %d, want zero", got)
	}
	if got := boundedIntToUint32(1234); got != 1234 {
		t.Fatalf("ordinary conversion = %d, want 1234", got)
	}
	if ^uint(0) > uint(math.MaxUint32) {
		overflow := int(uint64(math.MaxUint32) + 1)
		if got := boundedIntToUint32(overflow); got != math.MaxUint32 {
			t.Fatalf("overflow conversion = %d, want %d", got, uint32(math.MaxUint32))
		}
	}
}
