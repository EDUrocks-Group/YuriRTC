import assert from "node:assert/strict";
import test from "node:test";

import {
  installCanaryProtocolFilter,
  normalizeCanaryProtocol
} from "../../prod-canary-protocol.mjs";

test("canary protocol selection defaults to all and rejects unknown values", () => {
  assert.equal(normalizeCanaryProtocol(undefined), "all");
  assert.equal(normalizeCanaryProtocol(" UDP "), "udp");
  assert.equal(normalizeCanaryProtocol("tcp"), "tcp");
  assert.equal(normalizeCanaryProtocol("all"), "all");
  assert.throws(
    () => normalizeCanaryProtocol("quic"),
    /YURIRTC_CANARY_PROTOCOL must be udp, tcp, or all/
  );
});

for (const forcedProtocol of ["udp", "tcp"]) {
  test(`the ${forcedProtocol} canary filters SDP and trickled server candidates`, async () => {
    const priorPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
    const descriptions = [];
    const candidates = [];
    class FakePeerConnection {
      setRemoteDescription(description) {
        descriptions.push(description);
        return Promise.resolve();
      }

      addIceCandidate(candidate) {
        candidates.push(candidate);
        return Promise.resolve();
      }
    }
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      configurable: true,
      writable: true,
      value: FakePeerConnection
    });

    const udp = {
      candidate: "candidate:udp 1 UDP 2130706431 203.0.113.10 443 typ host"
    };
    const tcp = {
      candidate: "candidate:tcp 1 TCP 2130706430 203.0.113.10 443 typ host tcptype passive"
    };
    const matching = forcedProtocol === "udp" ? udp : tcp;
    const rejected = forcedProtocol === "udp" ? tcp : udp;
    const answer = [
      "v=0",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      `a=${udp.candidate}`,
      `a=${tcp.candidate}`,
      "a=end-of-candidates",
      ""
    ].join("\r\n");

    try {
      installCanaryProtocolFilter({ forcedProtocol });
      const peer = new FakePeerConnection();
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      await peer.addIceCandidate(rejected);
      await peer.addIceCandidate(matching);
      await peer.addIceCandidate({ candidate: "candidate:malformed" });
      await peer.addIceCandidate({ candidate: "" });
      await peer.addIceCandidate(null);

      assert.equal(descriptions.length, 1);
      assert.match(descriptions[0].sdp, new RegExp(`a=${matching.candidate}`, "i"));
      assert.doesNotMatch(descriptions[0].sdp, new RegExp(`a=${rejected.candidate}`, "i"));
      assert.match(descriptions[0].sdp, /a=end-of-candidates\r\n$/);
      assert.deepEqual(candidates, [matching, { candidate: "" }, null]);
    } finally {
      if (priorPeerConnection) {
        Object.defineProperty(globalThis, "RTCPeerConnection", priorPeerConnection);
      } else {
        delete globalThis.RTCPeerConnection;
      }
    }
  });
}

test("the all-protocol canary leaves RTCPeerConnection untouched", () => {
  const priorPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  class FakePeerConnection {
    setRemoteDescription() {}
    addIceCandidate() {}
  }
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    writable: true,
    value: FakePeerConnection
  });
  const originalSetRemoteDescription = FakePeerConnection.prototype.setRemoteDescription;
  const originalAddIceCandidate = FakePeerConnection.prototype.addIceCandidate;

  try {
    installCanaryProtocolFilter({ forcedProtocol: "all" });
    assert.equal(FakePeerConnection.prototype.setRemoteDescription, originalSetRemoteDescription);
    assert.equal(FakePeerConnection.prototype.addIceCandidate, originalAddIceCandidate);
  } finally {
    if (priorPeerConnection) {
      Object.defineProperty(globalThis, "RTCPeerConnection", priorPeerConnection);
    } else {
      delete globalThis.RTCPeerConnection;
    }
  }
});

test("a forced canary does not patch RTCPeerConnection inside a child frame", () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorPeerConnection = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  class FakePeerConnection {
    setRemoteDescription() {}
    addIceCandidate() {}
  }
  const childWindow = { top: {} };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: childWindow
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    writable: true,
    value: FakePeerConnection
  });
  const originalSetRemoteDescription = FakePeerConnection.prototype.setRemoteDescription;
  const originalAddIceCandidate = FakePeerConnection.prototype.addIceCandidate;

  try {
    installCanaryProtocolFilter({ forcedProtocol: "tcp" });
    assert.equal(FakePeerConnection.prototype.setRemoteDescription, originalSetRemoteDescription);
    assert.equal(FakePeerConnection.prototype.addIceCandidate, originalAddIceCandidate);
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else delete globalThis.window;
    if (priorPeerConnection) {
      Object.defineProperty(globalThis, "RTCPeerConnection", priorPeerConnection);
    } else {
      delete globalThis.RTCPeerConnection;
    }
  }
});
