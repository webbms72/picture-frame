package library_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/MateEke/picture-frame/internal/library"
	"github.com/MateEke/picture-frame/internal/testutil"
)

func newFaceStore(t *testing.T, dir string) *library.FaceStore {
	t.Helper()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatalf("open root: %v", err)
	}
	t.Cleanup(func() { root.Close() })
	s, err := library.LoadFaceStore(testutil.NopLogger(), root)
	if err != nil {
		t.Fatalf("load face store: %v", err)
	}
	return s
}

func TestFaceStoreEmpty(t *testing.T) {
	s := newFaceStore(t, t.TempDir())
	faces, processed := s.Faces("a.jpg")
	if processed {
		t.Error("unknown name should report not-processed")
	}
	if faces != nil {
		t.Errorf("unknown name faces = %v, want nil", faces)
	}
}

func TestFaceStoreSetAndFaces(t *testing.T) {
	s := newFaceStore(t, t.TempDir())
	want := []library.FaceBox{{X0: 0.1, Y0: 0.2, X1: 0.3, Y1: 0.4}}
	s.Set("a.jpg", want)
	got, processed := s.Faces("a.jpg")
	if !processed {
		t.Fatal("Set name should be processed")
	}
	if len(got) != 1 || got[0] != want[0] {
		t.Errorf("Faces = %v, want %v", got, want)
	}
}

func TestFaceStoreSetNilIsEmptyNotDropped(t *testing.T) {
	s := newFaceStore(t, t.TempDir())
	s.Set("noface.jpg", nil)
	faces, processed := s.Faces("noface.jpg")
	if !processed {
		t.Fatal("Set(nil) should still mark the name processed")
	}
	if len(faces) != 0 {
		t.Errorf("Faces = %v, want empty slice", faces)
	}
}

func TestFaceStoreDelete(t *testing.T) {
	s := newFaceStore(t, t.TempDir())
	s.Set("a.jpg", []library.FaceBox{{X0: 0, Y0: 0, X1: 1, Y1: 1}})
	s.Delete("a.jpg")
	if _, processed := s.Faces("a.jpg"); processed {
		t.Error("deleted name should report not-processed")
	}
}

func TestFaceStoreMissing(t *testing.T) {
	s := newFaceStore(t, t.TempDir())
	s.Set("a.jpg", nil)
	got := s.Missing([]string{"a.jpg", "b.jpg", "c.jpg"})
	if len(got) != 2 || got[0] != "b.jpg" || got[1] != "c.jpg" {
		t.Errorf("Missing = %v, want [b.jpg c.jpg]", got)
	}
}

func TestLoadFaceStoreCorruptIndex(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".faces-index.json"), []byte("not json"), 0o600); err != nil {
		t.Fatalf("write corrupt index: %v", err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatalf("open root: %v", err)
	}
	defer root.Close()
	if _, err := library.LoadFaceStore(testutil.NopLogger(), root); err == nil {
		t.Error("expected error loading a corrupt index")
	}
}

func TestFaceStoreFlushRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := newFaceStore(t, dir)
	s.Set("a.jpg", []library.FaceBox{{X0: 0.1, Y0: 0.2, X1: 0.3, Y1: 0.4}})
	s.Set("noface.jpg", nil)
	if err := s.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	reloaded := newFaceStore(t, dir)
	faces, processed := reloaded.Faces("a.jpg")
	if !processed || len(faces) != 1 || faces[0].X0 != 0.1 {
		t.Errorf("reloaded Faces(a.jpg) = %v, processed=%v; want persisted", faces, processed)
	}
	noFaces, processed := reloaded.Faces("noface.jpg")
	if !processed || len(noFaces) != 0 {
		t.Errorf("reloaded Faces(noface.jpg) = %v, processed=%v; want empty+processed", noFaces, processed)
	}
	if _, processed := reloaded.Faces("never.jpg"); processed {
		t.Error("never-set name should remain not-processed after reload")
	}
}
