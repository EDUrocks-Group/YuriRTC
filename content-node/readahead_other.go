//go:build !linux

package main

import "os"

// hintSequentialRead is a no-op away from Linux; posix_fadvise is the only
// mechanism used and the deployment target is Linux.
func hintSequentialRead(file *os.File, offset, length int64) error {
	_, _, _ = file, offset, length
	return nil
}
