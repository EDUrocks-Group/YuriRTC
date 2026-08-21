const VALID_PROTOCOLS = new Set(["all", "udp", "tcp"]);

export function normalizeCanaryProtocol(value) {
  const protocol = value === undefined ? "all" : String(value).trim().toLowerCase();
  if (!VALID_PROTOCOLS.has(protocol)) {
    throw new Error("YURIRTC_CANARY_PROTOCOL must be udp, tcp, or all");
  }
  return protocol;
}

/**
 * Runs as a Playwright init script, so it must remain self-contained: imported
 * module bindings are not available when Playwright serializes this function.
 */
export function installCanaryProtocolFilter({ forcedProtocol }) {
  if (forcedProtocol === "all") return;
  if (forcedProtocol !== "udp" && forcedProtocol !== "tcp") {
    throw new Error("invalid forced canary protocol");
  }

  // Playwright installs init scripts in child frames as well as the top-level
  // carrier. Never change RTCPeerConnection for the transported application:
  // it may legitimately use WebRTC itself, and the canary must remain passive
  // outside YuriRTC's carrier connection. `window` is absent in the Node unit
  // tests, where exercising the self-contained wrapper is still useful.
  const browserWindow = globalThis.window;
  if (browserWindow && browserWindow.top !== browserWindow) return;

  const candidateProtocol = (candidate) => {
    const match = String(candidate).trim().match(
      /^(?:a=)?candidate:\S+\s+\d+\s+([^\s]+)/i
    );
    return match?.[1]?.toLowerCase();
  };
  const candidateMatches = (candidate) => candidateProtocol(candidate) === forcedProtocol;
  const filterAnswerSdp = (sdp) => sdp.replace(
    /^a=candidate:[^\r\n]*(?:\r\n|\n|$)/gim,
    (line) => candidateMatches(line) ? line : ""
  );

  const PeerConnection = globalThis.RTCPeerConnection;
  if (!PeerConnection) throw new Error("RTCPeerConnection is unavailable");
  const prototype = PeerConnection.prototype;
  const setRemoteDescription = prototype.setRemoteDescription;
  const addIceCandidate = prototype.addIceCandidate;

  prototype.setRemoteDescription = function (description) {
    if (!description || typeof description.sdp !== "string") {
      return Reflect.apply(setRemoteDescription, this, arguments);
    }
    return Reflect.apply(setRemoteDescription, this, [{
      type: description.type,
      sdp: filterAnswerSdp(description.sdp)
    }]);
  };

  prototype.addIceCandidate = function (candidate) {
    const value = typeof candidate === "string" ? candidate : candidate?.candidate;
    // Null and empty candidates signal end-of-candidates and must still reach
    // Chrome. A non-empty malformed candidate is dropped while forcing a route
    // because its transport cannot be proven to match the requested protocol.
    if (typeof value === "string" && value.length > 0 && !candidateMatches(value)) {
      return Promise.resolve();
    }
    return Reflect.apply(addIceCandidate, this, arguments);
  };
}
