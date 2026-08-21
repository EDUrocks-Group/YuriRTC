package main

import (
	"context"
	"crypto/sha256"
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
	"syscall"
	"testing"
	"time"
)

const browserE2EEnvironment = "YURIRTC_BROWSER_E2E"

// TestBrowserV3EndToEnd is opt-in because it builds the browser packages and
// launches Chrome. Unlike the fast TypeScript carrier test, this path uses the
// real service worker, real loader bundle, a real Pion association, the real Go
// handler, and a streaming loopback API backend. It first preserves a browser
// context across a previous-to-current worker update, then runs the clean large-transfer
// scenario in a separate profile. Run it before a release with:
//
//	YURIRTC_BROWSER_E2E=1 go test -count=1 -run TestBrowserV3EndToEnd -v
func TestBrowserV3EndToEnd(t *testing.T) {
	if os.Getenv(browserE2EEnvironment) != "1" {
		t.Skip("set YURIRTC_BROWSER_E2E=1 to run the Chrome-to-Go transport test")
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

	runBrowserE2ECommand(t, repositoryRoot, []string{
		"YURIRTC_FIREBASE_API_KEY=browser-e2e-build-key",
		"YURIRTC_FIREBASE_PROJECT_ID=browser-e2e-build-project",
		"YURIRTC_FIREBASE_DATABASE_URL=https://browser-e2e-build.invalid",
	}, "npm", "run", "build",
		"-w", "@yurirtc/protocol",
		"-w", "@yurirtc/signaling",
		"-w", "@edurocks-group/loader")
	runBrowserE2ECommand(t, repositoryRoot, []string{
		"YURIRTC_FIREBASE_API_KEY=browser-e2e-public-key",
		"YURIRTC_FIREBASE_PROJECT_ID=browser-e2e-project",
		"YURIRTC_FIREBASE_DATABASE_URL=https://browser-e2e.invalid",
	}, "node", "deploy/npm/build.mjs", "--release", "--out-dir", carrierDir)

	root := t.TempDir()
	const downloadBytes = 12 * 1024 * 1024
	download := make([]byte, downloadBytes)
	for i := range download {
		download[i] = byte((i*31 + 7) % 251)
	}
	if err := os.WriteFile(filepath.Join(root, "asset.bin"), download, 0o600); err != nil {
		t.Fatalf("write download fixture: %v", err)
	}
	downloadDigest := sha256.Sum256(download)

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

  let chunk = 0;
  const body = new ReadableStream({
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
  });
  const uploadStarted = performance.now();
  result.dataset.phase = "upload";
  const uploadResponse = await fetch("/apiv2/upload", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
    duplex: "half"
  });
  const uploadMS = performance.now() - uploadStarted;
  if (!uploadResponse.ok) throw new Error("upload status " + uploadResponse.status);
  const uploaded = await uploadResponse.json();
  if (uploaded.bytes !== %d) throw new Error("upload length " + uploaded.bytes);
  if (uploaded.sha256 !== %q) throw new Error("upload digest mismatch");
  if (uploaded.receiveSpanMs < 600) {
    throw new Error("upload was buffered before transport (" + uploaded.receiveSpanMs + "ms receive span)");
  }

  result.dataset.status = "ok";
  result.dataset.downloadBytes = String(downloaded.byteLength);
  result.dataset.uploadBytes = String(uploaded.bytes);
  result.dataset.receiveSpanMs = String(uploaded.receiveSpanMs);
  result.dataset.downloadMs = String(Math.round(downloadMS));
  result.dataset.uploadMs = String(Math.round(uploadMS));
  result.dataset.phase = "complete";
  result.textContent = "ok";
} catch (error) {
  result.dataset.status = "error";
  result.dataset.phase = "error";
  result.textContent = String(error && error.stack || error);
}
</script></body></html>`,
		downloadBytes,
		hex.EncodeToString(downloadDigest[:]),
		uploadChunks,
		uploadPauseMS,
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

	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/upload" || request.Method != http.MethodPost {
			http.NotFound(response, request)
			return
		}
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
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{
			"bytes":         received,
			"sha256":        hex.EncodeToString(digest.Sum(nil)),
			"receiveSpanMs": span,
		})
	}))
	defer backend.Close()

	bindIP := net.IPv4(127, 0, 0, 1)
	ports := freeDualPorts(t, bindIP, 1)
	rtc, err := buildTransport(options{
		bindIP: bindIP.String(), publicIP: bindIP.String(), ports: ports,
	})
	if err != nil {
		t.Fatalf("build browser E2E transport: %v", err)
	}
	defer rtc.Close()
	registry := newPeerRegistry()
	defer registry.CloseAll()
	handler := NewHandler(root, backend.URL)

	exchange := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
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
		answer, err := answerOffer(request.Context(), rtc.API, handler, registry, offer)
		if err != nil {
			http.Error(response, "answer failed", http.StatusInternalServerError)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(answer)
	}))
	defer exchange.Close()

	for _, protocol := range []string{"udp", "tcp"} {
		protocol := protocol
		t.Run(protocol, func(t *testing.T) {
			commandContext, cancelCommand := context.WithTimeout(t.Context(), 3*time.Minute)
			defer cancelCommand()
			command := newBrowserE2ECommand(commandContext, "node", "content-node/testdata/browser_e2e.mjs")
			command.Dir = repositoryRoot
			command.Env = append(os.Environ(),
				"YURIRTC_E2E_EXCHANGE_URL="+exchange.URL+"/exchange",
				"YURIRTC_E2E_CARRIER_DIR="+carrierDir,
				"YURIRTC_E2E_REPOSITORY_ROOT="+repositoryRoot,
				"YURIRTC_E2E_PROTOCOL="+protocol,
			)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("real browser %s transport E2E: %v\n%s", protocol, err, output)
			}
			t.Logf("real browser %s transport E2E: %s", protocol, output)
		})
	}
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
