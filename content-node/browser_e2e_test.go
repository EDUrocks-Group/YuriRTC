package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const browserE2EEnvironment = "YURIRTC_BROWSER_E2E"

// TestBrowserV3EndToEnd is opt-in because it builds the browser packages and
// launches real browser engines. Unlike the fast TypeScript carrier test, this path uses the
// real service worker, real loader bundle, a real Pion association, the real Go
// handler, and a streaming loopback API backend. It first preserves a browser
// context across a previous-to-current worker update, then runs the clean large-transfer
// scenario in a separate profile. Run it before a release with:
//
//	YURIRTC_BROWSER_E2E=1 go test -count=1 -run TestBrowserV3EndToEnd -v
func TestBrowserV3EndToEnd(t *testing.T) {
	if os.Getenv(browserE2EEnvironment) != "1" {
		t.Skip("set YURIRTC_BROWSER_E2E=1 to run the browser-to-Go transport test")
	}
	if testing.Short() {
		t.Skip("browser end-to-end test is disabled in short mode")
	}

	contentNodeDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	repositoryRoot := filepath.Clean(filepath.Join(contentNodeDir, ".."))
	carrierDir := t.TempDir()
	bundledCarrierDir := t.TempDir()
	pointerPath := filepath.Join(t.TempDir(), "loader.json")
	manifestPrivateKey, manifestPublicKey := browserE2EManifestKeys(t)
	testManifestEnvironment := []string{
		"YURIRTC_BROWSER_E2E_BUILD=1",
		"YURIRTC_MANIFEST_SIGNING_PRIVATE_KEY=" + manifestPrivateKey,
		"YURIRTC_TEST_MANIFEST_PUBLIC_KEY=" + manifestPublicKey,
	}

	runBrowserE2ECommand(t, repositoryRoot, []string{
		"YURIRTC_FIREBASE_API_KEY=browser-e2e-build-key",
		"YURIRTC_FIREBASE_PROJECT_ID=browser-e2e-build-project",
		"YURIRTC_FIREBASE_DATABASE_URL=https://browser-e2e-build.invalid",
	}, "npm", "run", "build",
		"-w", "@yurirtc/protocol",
		"-w", "@yurirtc/signaling",
		"-w", "@advwebrec/grainloading")
	runBrowserE2ECommand(t, repositoryRoot, testManifestEnvironment,
		"node", "packages/integrity/build.mjs", "--out-file", pointerPath,
		"--test-manifest-public-key")
	root := t.TempDir()
	testAssetDir := filepath.Join(root, "yurirtc-e2e")
	if err := os.Mkdir(testAssetDir, 0o700); err != nil {
		t.Fatalf("create browser E2E asset directory: %v", err)
	}
	copyBrowserE2EAsset(t, pointerPath, filepath.Join(testAssetDir, "loader.json"))
	copyBrowserE2EAsset(
		t,
		filepath.Join(repositoryRoot, "packages/loader/dist/bundle/client.js"),
		filepath.Join(testAssetDir, "client.js"),
	)
	copyBrowserE2EAsset(
		t,
		filepath.Join(repositoryRoot, "packages/loader/dist/assets/rot13.woff"),
		filepath.Join(testAssetDir, "rot13.woff"),
	)
	if err := os.WriteFile(
		filepath.Join(testAssetDir, "icons.css"),
		[]byte(".material-symbols-rounded{font-family:system-ui}"),
		0o600,
	); err != nil {
		t.Fatalf("write browser E2E icon stylesheet: %v", err)
	}
	const downloadBytes = 12 * 1024 * 1024
	download := make([]byte, downloadBytes)
	for i := range download {
		download[i] = byte((i*31 + 7) % 251)
	}
	if err := os.WriteFile(filepath.Join(root, "asset.bin"), download, 0o600); err != nil {
		t.Fatalf("write download fixture: %v", err)
	}
	downloadDigest := sha256.Sum256(download)

	// A highly compressible generic asset proves private wire gzip is decoded
	// before the hosted site sees it. It deliberately is not an EDUrocks path.
	compressible := bytes.Repeat([]byte(`{"engine":"yurirtc","payload":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n`), 32*1024)
	compressibleDigest := sha256.Sum256(compressible)
	if err := os.WriteFile(filepath.Join(root, "compressible.json"), compressible, 0o600); err != nil {
		t.Fatalf("write compressible fixture: %v", err)
	}

	const mutableInitial = "cache-version-one\n"
	const mutableUpdated = "cache-version-two-updated\n"
	mutablePath := filepath.Join(root, "mutable.txt")
	if err := os.WriteFile(mutablePath, []byte(mutableInitial), 0o600); err != nil {
		t.Fatalf("write mutable cache fixture: %v", err)
	}

	const (
		uploadChunks     = 64
		uploadChunkBytes = 64 * 1024
		uploadPauseMS    = 900
	)
	upload := make([]byte, uploadChunks*uploadChunkBytes)
	for chunk := 0; chunk < uploadChunks; chunk++ {
		for i := 0; i < uploadChunkBytes; i++ {
			upload[chunk*uploadChunkBytes+i] = byte(chunk % 251)
		}
	}
	uploadDigest := sha256.Sum256(upload)

	application := fmt.Sprintf(`<!doctype html>
<html><head><meta charset="utf-8"><title>YuriRTC v3 real transport test</title><link rel="icon" href="data:,"></head>
<body><output id="result" data-status="running">running</output>
<script type="module">
const result = document.getElementById("result");
const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const harnessGate = (name) => new Promise((resolve) =>
  addEventListener(name, resolve, { once: true })
);
try {
  result.dataset.phase = "download";
  const downloadStarted = performance.now();
  const downloaded = await fetch("/asset.bin", { cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error("download status " + response.status);
    return response.arrayBuffer();
  });
  const downloadMS = performance.now() - downloadStarted;
  if (downloaded.byteLength !== %d) throw new Error("download length " + downloaded.byteLength);
  if (hex(await crypto.subtle.digest("SHA-256", downloaded)) !== %q) {
    throw new Error("download digest mismatch");
  }

  result.dataset.phase = "compression";
  const compressedRepresentation = await fetch("/compressible.json", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("compressed status " + response.status);
      return response.arrayBuffer();
    });
  if (compressedRepresentation.byteLength !== %d) {
    throw new Error("decoded compressed length " + compressedRepresentation.byteLength);
  }
  if (hex(await crypto.subtle.digest("SHA-256", compressedRepresentation)) !== %q) {
    throw new Error("decoded compressed digest mismatch");
  }

  // Generic assets are stored only after the foreground finishes consuming
  // them, then validator-checked. Mutating the backing file proves the worker
  // does not turn an arbitrary hosted path into an immutable EDUrocks asset.
  if (localStorage.getItem("yurirtc-cache-e2e") !== "complete") {
    const startCacheCheck = harnessGate("yurirtc-cache-e2e-start");
    result.dataset.phase = "cache-ready";
    await startCacheCheck;
    const mutableUrl = new URL("/mutable.txt", location.href).href;
    const initialResponse = await fetch(mutableUrl);
    const initial = await initialResponse.text();
    if (initial !== %q && initial !== %q) {
      throw new Error("initial cache value " + JSON.stringify(initial));
    }
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const stored = await caches.match(mutableUrl);
      if (stored && await stored.text() === initial) break;
      if (attempt === 299) {
        const names = await caches.keys();
        const entries = [];
        for (const name of names) {
          const cache = await caches.open(name);
          entries.push([name, ...(await cache.keys()).map((request) => request.url)]);
        }
        throw new Error("generic response was not committed to bounded cache " + JSON.stringify(entries));
      }
      await delay(10);
    }
    const mutation = await fetch("/apiv2/mutate-cache-fixture", { method: "POST" });
    if (!mutation.ok) throw new Error("cache mutation status " + mutation.status);
    const updated = await fetch(mutableUrl, { cache: "no-cache" }).then((response) => response.text());
    if (updated !== %q) throw new Error("stale cache value " + JSON.stringify(updated));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const stored = await caches.match(mutableUrl);
      if (stored && await stored.text() === updated) break;
      if (attempt === 99) throw new Error("revalidated response did not replace cached body");
      await delay(10);
    }
    const unchanged = await fetch(mutableUrl, { cache: "no-cache" }).then((response) => response.text());
    if (unchanged !== updated) throw new Error("304 cache reuse changed the body");
    localStorage.setItem("yurirtc-cache-e2e", "complete");
    const finishCacheCheck = harnessGate("yurirtc-cache-e2e-finish");
    result.dataset.phase = "cache-complete";
    await finishCacheCheck;
  }

  const supportsStreamingUpload = (() => {
    let duplexRead = false;
    try {
      new Request(location.href, {
        method: "POST",
        body: new ReadableStream(),
        get duplex() {
          duplexRead = true;
          return "half";
        }
      });
      return duplexRead;
    } catch {
      return false;
    }
  })();
  let chunk = 0;
  const body = supportsStreamingUpload ? new ReadableStream({
    async pull(controller) {
      if (chunk >= %d) {
        controller.close();
        return;
      }
      // Two chunks fill the first YuriRTC frame. Pause before the third so a
      // streaming transport reaches the backend before this gap, while an
      // eager whole-body implementation cannot send anything until after it.
      if (chunk === 2) await delay(%d);
      const bytes = new Uint8Array(%d);
      bytes.fill(chunk %% 251);
      chunk += 1;
      controller.enqueue(bytes);
    }
  }) : (() => {
    const bytes = new Uint8Array(%d * %d);
    for (let index = 0; index < %d; index += 1) {
      bytes.fill(index %% 251, index * %d, (index + 1) * %d);
    }
    return bytes;
  })();
  const uploadStarted = performance.now();
  result.dataset.phase = "upload";
  const uploadInit = {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body
  };
  if (supportsStreamingUpload) uploadInit.duplex = "half";
  const uploadResponse = await fetch("/apiv2/upload", uploadInit);
  const uploadMS = performance.now() - uploadStarted;
  if (!uploadResponse.ok) throw new Error("upload status " + uploadResponse.status);
  const uploaded = await uploadResponse.json();
  if (uploaded.bytes !== %d) throw new Error("upload length " + uploaded.bytes);
  if (uploaded.sha256 !== %q) throw new Error("upload digest mismatch");
  if (supportsStreamingUpload && uploaded.receiveSpanMs < 600) {
    throw new Error("upload was buffered before transport (" + uploaded.receiveSpanMs + "ms receive span)");
  }

  result.dataset.status = "ok";
  result.dataset.downloadBytes = String(downloaded.byteLength);
  result.dataset.compressedBytes = String(compressedRepresentation.byteLength);
  result.dataset.cacheRevalidated = "true";
  result.dataset.uploadBytes = String(uploaded.bytes);
  result.dataset.receiveSpanMs = String(uploaded.receiveSpanMs);
  result.dataset.streamingUpload = String(supportsStreamingUpload);
  result.dataset.downloadMs = String(Math.round(downloadMS));
  result.dataset.uploadMs = String(Math.round(uploadMS));
  result.dataset.phase = "complete";
  result.textContent = "ok";
} catch (error) {
  result.dataset.status = "error";
  result.dataset.failurePhase = result.dataset.phase || "unknown";
  result.dataset.phase = "error";
  result.textContent = String(error) + "\n" + String(error?.stack ?? "");
}
</script></body></html>`,
		downloadBytes,
		hex.EncodeToString(downloadDigest[:]),
		len(compressible),
		hex.EncodeToString(compressibleDigest[:]),
		mutableInitial,
		mutableUpdated,
		mutableUpdated,
		uploadChunks,
		uploadPauseMS,
		uploadChunkBytes,
		uploadChunks,
		uploadChunkBytes,
		uploadChunks,
		uploadChunkBytes,
		uploadChunkBytes,
		len(upload),
		hex.EncodeToString(uploadDigest[:]),
	)
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte(application), 0o600); err != nil {
		t.Fatalf("write application fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "favicon.ico"), nil, 0o600); err != nil {
		t.Fatalf("write favicon fixture: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "upgrade-probe.txt"),
		[]byte("YuriRTC v3 service-worker request ok\n"),
		0o600,
	); err != nil {
		t.Fatalf("write service-worker upgrade fixture: %v", err)
	}

	type uploadGateState struct {
		claimed     chan struct{}
		release     chan struct{}
		claimOnce   sync.Once
		releaseOnce sync.Once
	}
	newUploadGate := func() *uploadGateState {
		return &uploadGateState{
			claimed: make(chan struct{}),
			release: make(chan struct{}),
		}
	}
	var uploadGateMu sync.RWMutex
	uploadGate := newUploadGate()
	resetUploadGate := func() {
		uploadGateMu.Lock()
		uploadGate = newUploadGate()
		uploadGateMu.Unlock()
	}
	currentUploadGate := func() *uploadGateState {
		uploadGateMu.RLock()
		defer uploadGateMu.RUnlock()
		return uploadGate
	}
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/mutate-cache-fixture" && request.Method == http.MethodPost {
			if err := os.WriteFile(mutablePath, []byte(mutableUpdated), 0o600); err != nil {
				http.Error(response, "mutate cache fixture", http.StatusInternalServerError)
				return
			}
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if request.URL.Path == "/release-upload-gate" && request.Method == http.MethodPost {
			gate := currentUploadGate()
			select {
			case <-gate.claimed:
			case <-request.Context().Done():
				return
			}
			gate.releaseOnce.Do(func() { close(gate.release) })
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if request.URL.Path != "/upload" || request.Method != http.MethodPost {
			http.NotFound(response, request)
			return
		}
		gate := currentUploadGate()
		gateResponse := false
		gate.claimOnce.Do(func() {
			gateResponse = true
			close(gate.claimed)
		})
		defer request.Body.Close()
		digest := sha256.New()
		buffer := make([]byte, 32*1024)
		var firstByte time.Time
		var lastByte time.Time
		var received int64
		for {
			n, readErr := request.Body.Read(buffer)
			if n > 0 {
				now := time.Now()
				if firstByte.IsZero() {
					firstByte = now
				}
				lastByte = now
				received += int64(n)
				_, _ = digest.Write(buffer[:n])
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				http.Error(response, "read upload", http.StatusBadRequest)
				return
			}
		}
		span := int64(0)
		if !firstByte.IsZero() {
			span = lastByte.Sub(firstByte).Milliseconds()
		}
		if gateResponse {
			select {
			case <-gate.release:
			case <-request.Context().Done():
				return
			}
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{
			"bytes":         received,
			"sha256":        hex.EncodeToString(digest.Sum(nil)),
			"receiveSpanMs": span,
		})
	}))
	defer backend.Close()

	protocols := e2eList("YURIRTC_BROWSER_E2E_PROTOCOLS", []string{"udp", "tcp"})
	bindIP := browserE2EBindIP(t)
	transports := make(map[string]*iceTransport, len(protocols))
	for _, protocol := range protocols {
		if _, exists := transports[protocol]; exists {
			continue
		}
		var networkTypes []webrtc.NetworkType
		switch protocol {
		case "udp":
			networkTypes = []webrtc.NetworkType{webrtc.NetworkTypeUDP4}
		case "tcp":
			networkTypes = []webrtc.NetworkType{webrtc.NetworkTypeTCP4}
		case "all":
			networkTypes = []webrtc.NetworkType{
				webrtc.NetworkTypeUDP4,
				webrtc.NetworkTypeTCP4,
			}
		default:
			t.Fatalf("unsupported browser E2E protocol %q", protocol)
		}
		ports := freeDualPorts(t, bindIP, 1)
		rtc, buildErr := buildTransport(options{
			bindIP:       bindIP.String(),
			publicIP:     bindIP.String(),
			ports:        ports,
			networkTypes: networkTypes,
		})
		if buildErr != nil {
			t.Fatalf("build browser E2E %s transport: %v", protocol, buildErr)
		}
		transports[protocol] = rtc
		defer rtc.Close()
	}
	registry := newPeerRegistry()
	defer registry.CloseAll()
	handler := NewHandler(root, backend.URL)

	var signalMu sync.Mutex
	signalProtocol := ""
	signalAnswers := make(map[string]AnswerBlob)
	const firestorePrefix = "/firestore/v1/projects/browser-e2e-project/databases/(default)/documents/signal/"
	exchange := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/configure" && request.Method == http.MethodPost {
			protocol := request.URL.Query().Get("protocol")
			if transports[protocol] == nil {
				http.Error(response, "invalid transport protocol", http.StatusBadRequest)
				return
			}
			signalMu.Lock()
			signalProtocol = protocol
			clear(signalAnswers)
			signalMu.Unlock()
			response.WriteHeader(http.StatusNoContent)
			return
		}

		if strings.HasPrefix(request.URL.Path, firestorePrefix) {
			response.Header().Set("Access-Control-Allow-Origin", "*")
			response.Header().Set("Access-Control-Allow-Headers", "content-type")
			response.Header().Set("Access-Control-Allow-Methods", "GET,PATCH,OPTIONS")
			if request.Method == http.MethodOptions {
				response.WriteHeader(http.StatusNoContent)
				return
			}
			if values := request.URL.Query()["mask.fieldPaths"]; len(values) != 1 || values[0] != "answer" {
				http.Error(response, "invalid Firestore projection", http.StatusBadRequest)
				return
			}
			capability := strings.TrimPrefix(request.URL.Path, firestorePrefix)
			if !browserE2ECapability(capability) {
				http.Error(response, "invalid Firestore capability", http.StatusBadRequest)
				return
			}

			switch request.Method {
			case http.MethodPatch:
				defer request.Body.Close()
				var document struct {
					Fields struct {
						Offer struct {
							StringValue string `json:"stringValue"`
						} `json:"offer"`
					} `json:"fields"`
				}
				if err := json.NewDecoder(io.LimitReader(request.Body, 64*1024)).Decode(&document); err != nil {
					http.Error(response, "invalid Firestore document", http.StatusBadRequest)
					return
				}
				var offer OfferBlob
				if err := json.Unmarshal([]byte(document.Fields.Offer.StringValue), &offer); err != nil {
					http.Error(response, "invalid offer", http.StatusBadRequest)
					return
				}
				signalMu.Lock()
				protocol := signalProtocol
				signalMu.Unlock()
				t.Logf("browser E2E %s offer candidates: %s", protocol, browserE2ECandidateSummary(offer.SDP))
				rtc := transports[protocol]
				if rtc == nil {
					http.Error(response, "browser E2E protocol is not configured", http.StatusConflict)
					return
				}
				answer, err := answerOffer(request.Context(), rtc.API, handler, registry, offer)
				if err != nil {
					http.Error(response, "answer failed", http.StatusInternalServerError)
					return
				}
				if err := validateBrowserE2EAnswerProtocol(answer, protocol); err != nil {
					t.Logf("rejecting browser E2E signaling answer: %v", err)
					http.Error(response, err.Error(), http.StatusInternalServerError)
					return
				}
				signalMu.Lock()
				signalAnswers[capability] = answer
				signalMu.Unlock()
				response.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(response).Encode(map[string]any{"fields": map[string]any{}})
				return
			case http.MethodGet:
				signalMu.Lock()
				answer, ok := signalAnswers[capability]
				signalMu.Unlock()
				if !ok {
					http.NotFound(response, request)
					return
				}
				answerJSON, err := json.Marshal(answer)
				if err != nil {
					http.Error(response, "encode answer", http.StatusInternalServerError)
					return
				}
				response.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(response).Encode(map[string]any{
					"fields": map[string]any{
						"answer": map[string]any{"stringValue": string(answerJSON)},
					},
				})
				return
			default:
				response.Header().Set("Allow", "GET, PATCH, OPTIONS")
				response.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
		}

		if request.Method != http.MethodPost || request.URL.Path != "/exchange" {
			http.NotFound(response, request)
			return
		}
		defer request.Body.Close()
		var offer OfferBlob
		if err := json.NewDecoder(io.LimitReader(request.Body, 64*1024)).Decode(&offer); err != nil {
			http.Error(response, "invalid offer", http.StatusBadRequest)
			return
		}
		protocol := request.URL.Query().Get("protocol")
		t.Logf("browser E2E %s exchange candidates: %s", protocol, browserE2ECandidateSummary(offer.SDP))
		rtc := transports[protocol]
		if rtc == nil {
			http.Error(response, "invalid transport protocol", http.StatusBadRequest)
			return
		}
		answer, err := answerOffer(request.Context(), rtc.API, handler, registry, offer)
		if err != nil {
			http.Error(response, "answer failed", http.StatusInternalServerError)
			return
		}
		if err := validateBrowserE2EAnswerProtocol(answer, protocol); err != nil {
			t.Logf("rejecting browser E2E exchange answer: %v", err)
			http.Error(response, err.Error(), http.StatusInternalServerError)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(answer)
	}))
	defer exchange.Close()

	firestoreBaseURL := exchange.URL + "/firestore"
	runBrowserE2ECommand(t, repositoryRoot, append([]string{
		"YURIRTC_FIREBASE_API_KEY=browser-e2e-public-key",
		"YURIRTC_FIREBASE_PROJECT_ID=browser-e2e-project",
		"YURIRTC_FIREBASE_DATABASE_URL=https://browser-e2e.invalid",
	}, testManifestEnvironment...), "node", "deploy/npm/build.mjs", "--release",
		"--out-dir", carrierDir,
		"--test-worker-cdn-base", "/npm/@advwebrec/grainloading",
		"--test-firestore-base-url", firestoreBaseURL,
		"--test-local-asset-base", "/yurirtc-e2e",
		"--test-manifest-public-key")
	runBrowserE2ECommand(t, repositoryRoot, append([]string{
		"YURIRTC_FIREBASE_API_KEY=browser-e2e-public-key",
		"YURIRTC_FIREBASE_PROJECT_ID=browser-e2e-project",
		"YURIRTC_FIREBASE_DATABASE_URL=https://browser-e2e.invalid",
	}, testManifestEnvironment...), "node", "deploy/npm/build.mjs", "--release",
		"--bundled-loader",
		"--out-dir", bundledCarrierDir,
		"--test-firestore-base-url", firestoreBaseURL,
		"--test-local-asset-base", "/yurirtc-e2e",
		"--test-manifest-public-key")

	engines := e2eList("YURIRTC_BROWSER_E2E_ENGINES", []string{"chromium"})
	for _, engine := range engines {
		engine := engine
		t.Run(engine, func(t *testing.T) {
			for _, protocol := range protocols {
				protocol := protocol
				t.Run(protocol, func(t *testing.T) {
					variants := []struct {
						name string
						dir  string
					}{
						{name: "cdn", dir: carrierDir},
						{name: "bundled", dir: bundledCarrierDir},
					}
					for _, variant := range variants {
						variant := variant
						t.Run(variant.name, func(t *testing.T) {
							resetUploadGate()
							if err := os.WriteFile(mutablePath, []byte(mutableInitial), 0o600); err != nil {
								t.Fatalf("reset mutable cache fixture: %v", err)
							}
							commandContext, cancelCommand := context.WithTimeout(t.Context(), 5*time.Minute)
							defer cancelCommand()
							command := newBrowserE2ECommand(commandContext, "node", "content-node/testdata/browser_e2e.mjs")
							command.Dir = repositoryRoot
							command.Env = append(os.Environ(),
								"YURIRTC_E2E_EXCHANGE_URL="+exchange.URL+"/exchange?protocol="+protocol,
								"YURIRTC_E2E_CARRIER_DIR="+variant.dir,
								"YURIRTC_E2E_CARRIER_VARIANT="+variant.name,
								"YURIRTC_E2E_REPOSITORY_ROOT="+repositoryRoot,
								"YURIRTC_E2E_POINTER_PATH="+pointerPath,
								"YURIRTC_E2E_MANIFEST_PUBLIC_KEY="+manifestPublicKey,
								"YURIRTC_E2E_FIRESTORE_BASE_URL="+firestoreBaseURL,
								"YURIRTC_E2E_ICE_HOST="+bindIP.String(),
								"YURIRTC_E2E_PROTOCOL="+protocol,
								"YURIRTC_E2E_BROWSER="+engine,
							)
							output, err := command.CombinedOutput()
							if err != nil {
								t.Fatalf("real %s %s %s carrier transport E2E: %v\n%s", engine, protocol, variant.name, err, output)
							}
							t.Logf("real %s %s %s carrier transport E2E: %s", engine, protocol, variant.name, output)
						})
					}
				})
			}
		})
	}
}

func browserE2ECapability(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func browserE2EBindIP(t *testing.T) net.IP {
	t.Helper()
	if configured := strings.TrimSpace(os.Getenv("YURIRTC_BROWSER_E2E_BIND_IP")); configured != "" {
		ip := net.ParseIP(configured)
		if ip == nil || ip.To4() == nil || ip.IsUnspecified() {
			t.Fatalf("YURIRTC_BROWSER_E2E_BIND_IP %q is not a specific IPv4 address", configured)
		}
		return ip.To4()
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Logf("enumerate browser E2E interfaces: %v; using loopback", err)
		return net.IPv4(127, 0, 0, 1)
	}
	for _, networkInterface := range interfaces {
		if networkInterface.Flags&net.FlagUp == 0 || networkInterface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, addressErr := networkInterface.Addrs()
		if addressErr != nil {
			continue
		}
		for _, address := range addresses {
			ip, _, parseErr := net.ParseCIDR(address.String())
			if parseErr == nil && ip.To4() != nil && ip.IsPrivate() {
				t.Logf("browser E2E ICE transport uses local interface %s", ip.To4())
				return ip.To4()
			}
		}
	}
	t.Log("no private non-loopback IPv4 interface found; browser E2E ICE transport uses loopback")
	return net.IPv4(127, 0, 0, 1)
}

func validateBrowserE2EAnswerProtocol(answer AnswerBlob, expected string) error {
	found := false
	for _, line := range strings.Split(strings.ReplaceAll(answer.SDP, "\r\n", "\n"), "\n") {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			return fmt.Errorf("browser E2E answer has malformed candidate %q", line)
		}
		found = true
		if !strings.EqualFold(fields[2], expected) {
			return fmt.Errorf("browser E2E %s answer contains %s candidate", expected, fields[2])
		}
	}
	if !found {
		return fmt.Errorf("browser E2E %s answer contains no candidates", expected)
	}
	return nil
}

func browserE2ECandidateSummary(sdp string) string {
	candidates := make(map[string]struct{})
	for _, line := range strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n") {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 8 {
			continue
		}
		tcpType := ""
		for index := 8; index+1 < len(fields); index += 2 {
			if strings.EqualFold(fields[index], "tcptype") {
				tcpType = "/" + strings.ToLower(fields[index+1])
				break
			}
		}
		candidates[strings.ToLower(fields[2])+"/"+strings.ToLower(fields[7])+tcpType+"/port-"+fields[5]] = struct{}{}
	}
	values := make([]string, 0, len(candidates))
	for candidate := range candidates {
		values = append(values, candidate)
	}
	slices.Sort(values)
	return strings.Join(values, ",")
}

func browserE2EManifestKeys(t *testing.T) (string, string) {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate browser E2E manifest key: %v", err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatalf("encode browser E2E manifest private key: %v", err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		t.Fatalf("encode browser E2E manifest public key: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(privateDER),
		base64.RawURLEncoding.EncodeToString(publicDER)
}

func copyBrowserE2EAsset(t *testing.T, source, destination string) {
	t.Helper()
	contents, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("read browser E2E asset %s: %v", source, err)
	}
	if err := os.WriteFile(destination, contents, 0o600); err != nil {
		t.Fatalf("write browser E2E asset %s: %v", destination, err)
	}
}

func e2eList(name string, fallback []string) []string {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	items := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	})
	if len(items) == 0 {
		return fallback
	}
	return items
}

func runBrowserE2ECommand(t *testing.T, directory string, extraEnvironment []string, name string, arguments ...string) {
	t.Helper()
	commandContext, cancelCommand := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancelCommand()
	command := newBrowserE2ECommand(commandContext, name, arguments...)
	command.Dir = directory
	command.Env = append(os.Environ(), extraEnvironment...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, arguments, err, output)
	}
}

// newBrowserE2ECommand isolates each build/browser subprocess in a process
// group. If a deadline expires, killing the group also reaps npm/Node children
// and Chrome instead of leaving them orphaned after a failed release gate.
func newBrowserE2ECommand(ctx context.Context, name string, arguments ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, name, arguments...)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	command.WaitDelay = 5 * time.Second
	return command
}
