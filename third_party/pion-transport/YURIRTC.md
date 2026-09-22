# YuriRTC transport fork

Complete source snapshot of github.com/pion/transport/v4 v4.0.2, retaining upstream
MIT licensing and tests. The only production change is netctx/packetconn.go:
ReadFromContext and WriteToContext register context.AfterFunc callbacks instead
of launching a watcher goroutine for every successful packet operation.

Cancellation still interrupts blocked I/O by setting its deadline. A racing
callback is joined before the deadline is reset, under the original direction
mutex, so it cannot contaminate the next operation. Partial-I/O and error
precedence are preserved. Contexts unsupported by AfterFunc may still require
a bridge; the accompanying DTLS fork supplies an embedded standard context.

Run tests through content-node/go.mod to exercise the combined replacements:

```sh
cd content-node
go test -race github.com/pion/transport/v4/netctx/... github.com/pion/dtls/v3/...
```

Keep this delta small when rebasing onto an upstream release.
