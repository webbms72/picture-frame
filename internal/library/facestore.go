package library

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"sync"
)

const facesIndexName = ".faces-index.json"

// FaceBox is one detected face, normalized 0-1 relative to the image's full dimensions.
type FaceBox struct {
	X0, Y0, X1, Y1 float64
}

// FaceStore caches detected face boxes per image name, as a JSON sidecar in the images
// directory, mirroring AspectStore's shape and lifecycle. Unlike AspectStore, presence in the
// index carries meaning on its own: a key present with an empty slice means "processed, no
// faces found" (a common, valid, terminal result — never retried). A key absent means "not yet
// processed." This distinction is why FaceStore is its own store rather than extra fields on
// AspectStore's meta{W,H}, which has no room for it. Safe for concurrent use.
type FaceStore struct {
	log     *slog.Logger
	root    *os.Root
	mu      sync.Mutex
	byName  map[string][]FaceBox
	flushMu sync.Mutex
}

// LoadFaceStore reads the sidecar index from root (empty when absent).
func LoadFaceStore(log *slog.Logger, root *os.Root) (*FaceStore, error) {
	s := &FaceStore{log: log, root: root, byName: make(map[string][]FaceBox)}
	f, err := root.OpenFile(facesIndexName, os.O_RDONLY, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("library: open faces index: %w", err)
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, fmt.Errorf("library: read faces index: %w", err)
	}
	if err := json.Unmarshal(data, &s.byName); err != nil {
		return nil, fmt.Errorf("library: parse faces index: %w", err)
	}
	return s, nil
}

// Faces reports the cached faces for name and whether it has ever been processed.
func (s *FaceStore) Faces(name string) (faces []FaceBox, processed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	faces, processed = s.byName[name]
	return faces, processed
}

// Set records the detection result for name (possibly empty, meaning "no faces found"). Call
// Flush to persist.
func (s *FaceStore) Set(name string, faces []FaceBox) {
	if faces == nil {
		faces = []FaceBox{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byName[name] = faces
}

// Delete drops name in memory; call Flush to persist. A later re-add is treated as
// unprocessed again.
func (s *FaceStore) Delete(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.byName, name)
}

// Missing returns the subset of names not yet present in the index, in the given order.
func (s *FaceStore) Missing(names []string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, n := range names {
		if _, ok := s.byName[n]; !ok {
			out = append(out, n)
		}
	}
	return out
}

// Flush writes the index atomically (tmp + rename) through the images root.
func (s *FaceStore) Flush() error {
	s.mu.Lock()
	data, err := json.Marshal(s.byName)
	s.mu.Unlock()
	if err != nil {
		return fmt.Errorf("library: marshal faces index: %w", err)
	}
	return writeFileAtomic(s.root, facesIndexName, &s.flushMu, data)
}
