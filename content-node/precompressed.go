package main

// Sidecars live outside the public site root. All hashes and gzip contents are
// checked once at startup; requests only compare file identity/size/mtime.
import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

type precompressedEntry struct {
	Path         string `json:"path"`
	SourceSHA256 string `json:"sourceSHA256"`
	Size         int64  `json:"size"`
	ModTimeNS    int64  `json:"modTimeNS"`
	GzipSHA256   string `json:"gzipSHA256"`
	GzipBytes    int64  `json:"gzipBytes"`
	sourceInfo   os.FileInfo
	gzipInfo     os.FileInfo
}
type precompressedManifest struct {
	Version int                  `json:"version"`
	Entries []precompressedEntry `json:"entries"`
}
type precompressedAssets struct {
	directory string
	entries   map[string]precompressedEntry
}

func separateAssetDirectory(root, directory string) (string, error) {
	site, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	dir, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", err
	}
	site, err = filepath.Abs(site)
	if err != nil {
		return "", err
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(site, dir)
	if err != nil {
		return "", err
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return "", errors.New("precompressed directory must be outside the public site root")
	}
	return dir, nil
}

func fileDigest(reader io.Reader) (string, int64, error) {
	hash := sha256.New()
	n, err := io.Copy(hash, reader)
	return hex.EncodeToString(hash.Sum(nil)), n, err
}
func validSHA256(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && strings.ToLower(value) == value
}
func sameAsset(info, expected os.FileInfo) bool {
	return info != nil && expected != nil && info.Mode().IsRegular() && os.SameFile(info, expected) && info.Size() == expected.Size() && info.ModTime().Equal(expected.ModTime())
}

func (h *Handler) LoadPrecompressed(directory string) error {
	dir, err := separateAssetDirectory(h.Root, directory)
	if err != nil {
		return err
	}
	sidecars, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer sidecars.Close()
	sources, err := os.OpenRoot(h.Root)
	if err != nil {
		return err
	}
	defer sources.Close()
	manifestFile, err := sidecars.Open("manifest.json")
	if err != nil {
		return err
	}
	defer manifestFile.Close()
	decoder := json.NewDecoder(io.LimitReader(manifestFile, 16*1024*1024))
	decoder.DisallowUnknownFields()
	var manifest precompressedManifest
	if err := decoder.Decode(&manifest); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("trailing precompressed manifest data")
	}
	if manifest.Version != 1 || len(manifest.Entries) > 100000 {
		return errors.New("unsupported precompressed manifest")
	}
	assets := &precompressedAssets{directory: dir, entries: make(map[string]precompressedEntry)}
	for _, entry := range manifest.Entries {
		if !fs.ValidPath(entry.Path) || strings.Contains(entry.Path, "\\") || !validSHA256(entry.SourceSHA256) || !validSHA256(entry.GzipSHA256) || entry.Size < minWireGzipBytes || entry.GzipBytes <= 0 || entry.GzipBytes+64 >= entry.Size {
			return fmt.Errorf("invalid precompressed entry %q", entry.Path)
		}
		if _, exists := assets.entries[entry.Path]; exists {
			return fmt.Errorf("duplicate precompressed entry %q", entry.Path)
		}
		if err := verifyPrecompressedEntry(sources, sidecars, &entry); err != nil {
			return fmt.Errorf("precompressed %s: %w", entry.Path, err)
		}
		assets.entries[entry.Path] = entry
	}
	h.precompressed = assets
	return nil
}

func verifyPrecompressedEntry(sources, sidecars *os.Root, entry *precompressedEntry) error {
	source, err := sources.Open(entry.Path)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != entry.Size || info.ModTime().UnixNano() != entry.ModTimeNS {
		return errors.New("source metadata changed; rebuild sidecars")
	}
	digest, _, err := fileDigest(source)
	if err != nil {
		return err
	}
	if digest != entry.SourceSHA256 {
		return errors.New("source hash mismatch")
	}
	encoded, err := sidecars.Open(entry.GzipSHA256 + ".gz")
	if err != nil {
		return err
	}
	defer encoded.Close()
	encodedInfo, err := encoded.Stat()
	if err != nil {
		return err
	}
	if !encodedInfo.Mode().IsRegular() || encodedInfo.Size() != entry.GzipBytes {
		return errors.New("gzip metadata mismatch")
	}
	digest, _, err = fileDigest(encoded)
	if err != nil {
		return err
	}
	if digest != entry.GzipSHA256 {
		return errors.New("gzip hash mismatch")
	}
	if _, err := encoded.Seek(0, io.SeekStart); err != nil {
		return err
	}
	reader, err := gzip.NewReader(encoded)
	if err != nil {
		return err
	}
	defer reader.Close()
	digest, decodedSize, err := fileDigest(io.LimitReader(reader, entry.Size+1))
	if err != nil {
		return err
	}
	if decodedSize != entry.Size || digest != entry.SourceSHA256 {
		return errors.New("gzip does not reproduce source")
	}
	after, err := source.Stat()
	if err != nil || !sameAsset(after, info) {
		return errors.New("source changed during verification")
	}
	after, err = encoded.Stat()
	if err != nil || !sameAsset(after, encodedInfo) {
		return errors.New("gzip changed during verification")
	}
	entry.sourceInfo, entry.gzipInfo = info, encodedInfo
	return nil
}

func (h *Handler) openPrecompressed(full string, info os.FileInfo) (*os.File, int64) {
	if h.precompressed == nil {
		return nil, 0
	}
	relative, err := filepath.Rel(h.Root, full)
	if err != nil {
		return nil, 0
	}
	entry, ok := h.precompressed.entries[filepath.ToSlash(relative)]
	if !ok || !sameAsset(info, entry.sourceInfo) {
		return nil, 0
	}
	root, err := os.OpenRoot(h.precompressed.directory)
	if err != nil {
		return nil, 0
	}
	file, err := root.Open(entry.GzipSHA256 + ".gz")
	root.Close()
	if err != nil {
		return nil, 0
	}
	current, err := file.Stat()
	if err != nil || !sameAsset(current, entry.gzipInfo) {
		file.Close()
		return nil, 0
	}
	return file, entry.GzipBytes
}

// GeneratePrecompressed publishes a content-addressed set and atomically
// replaces its manifest last. Existing manifests remain usable during builds.
func GeneratePrecompressed(root, directory string) error {
	if err := os.MkdirAll(directory, 0750); err != nil {
		return err
	}
	dir, err := separateAssetDirectory(root, directory)
	if err != nil {
		return err
	}
	manifest := precompressedManifest{Version: 1, Entries: []precompressedEntry{}}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !d.Type().IsRegular() || !isWireGzipType(mime.TypeByExtension(filepath.Ext(path))) {
			return nil
		}
		entry, err := generatePrecompressedEntry(root, path, dir)
		if err != nil {
			return err
		}
		if entry != nil {
			manifest.Entries = append(manifest.Entries, *entry)
		}
		return nil
	})
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".manifest-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err := json.NewEncoder(temp).Encode(manifest); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), filepath.Join(dir, "manifest.json"))
}

func generatePrecompressedEntry(root, path, dir string) (*precompressedEntry, error) {
	source, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < minWireGzipBytes {
		return nil, nil
	}
	temp, err := os.CreateTemp(dir, ".gzip-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	sourceHash, encodedHash := sha256.New(), sha256.New()
	writer, err := gzip.NewWriterLevel(io.MultiWriter(temp, encodedHash), gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	n, err := io.Copy(writer, io.TeeReader(source, sourceHash))
	closeErr := writer.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	after, err := source.Stat()
	if err != nil || !sameAsset(after, info) || n != info.Size() {
		return nil, errors.New("source changed during compression")
	}
	encodedInfo, err := temp.Stat()
	if err != nil {
		return nil, err
	}
	if encodedInfo.Size()+64 >= n {
		return nil, nil
	}
	if err := temp.Sync(); err != nil {
		return nil, err
	}
	if err := temp.Close(); err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return nil, err
	}
	entry := &precompressedEntry{Path: filepath.ToSlash(relative), SourceSHA256: hex.EncodeToString(sourceHash.Sum(nil)), Size: n, ModTimeNS: info.ModTime().UnixNano(), GzipSHA256: hex.EncodeToString(encodedHash.Sum(nil)), GzipBytes: encodedInfo.Size()}
	if err := os.Rename(temp.Name(), filepath.Join(dir, entry.GzipSHA256+".gz")); err != nil {
		return nil, err
	}
	return entry, nil
}
