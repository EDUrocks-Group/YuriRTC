//go:build linux

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// hintSequentialRead tells the kernel that the next `length` bytes from
// `offset` will be read in order.
//
// This matters because of the shape of the library rather than the code: the
// served tree is far larger than the machine's RAM, so most asset reads miss
// the page cache and land on disk. The default readahead window is sized for
// mixed workloads; FADV_SEQUENTIAL doubles it, and FADV_WILLNEED starts the
// first window immediately instead of waiting for the first read to fault.
// Without them a cold 128 KiB frame read stalls the response lane on disk
// latency while the peer's send window sits idle.
//
// Deliberately no FADV_DONTNEED afterwards: popular games are requested
// repeatedly, and dropping their pages would convert cache hits back into
// disk reads. Eviction is left to the kernel, which can see the whole system.
//
// Advice only. Every failure here is non-fatal, so the caller ignores the
// error and serves the file the same way regardless.
func hintSequentialRead(file *os.File, offset, length int64) error {
	if file == nil || length <= 0 {
		return nil
	}
	fd := int(file.Fd())
	if err := unix.Fadvise(fd, offset, length, unix.FADV_SEQUENTIAL); err != nil {
		return err
	}
	return unix.Fadvise(fd, offset, length, unix.FADV_WILLNEED)
}
