package library_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/MateEke/picture-frame/internal/library"
	"github.com/MateEke/picture-frame/internal/testutil"
)

func newDetector(t *testing.T, dir string, store *library.FaceStore, names []string) *library.Detector {
	t.Helper()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatalf("open root: %v", err)
	}
	t.Cleanup(func() { root.Close() })
	d, err := library.NewDetector(testutil.NopLogger(), store, func() []string { return names }, root)
	if err != nil {
		t.Fatalf("new detector: %v", err)
	}
	return d
}

func TestDetectorRunProcessesNoFaceImage(t *testing.T) {
	dir := t.TempDir()
	writeTestJPEG(t, dir, "blank.jpg", 64, 64)
	store := newFaceStore(t, dir)
	d := newDetector(t, dir, store, []string{"blank.jpg"})

	trigger := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		d.Run(ctx, trigger)
		close(done)
	}()

	// Run's initial synchronous backlog pass (before the select loop) processes "blank.jpg";
	// poll briefly for it to land rather than assuming a fixed delay is enough.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if faces, processed := store.Faces("blank.jpg"); processed {
			if len(faces) != 0 {
				t.Errorf("blank image faces = %v, want empty", faces)
			}
			cancel()
			<-done
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	t.Fatal("blank.jpg was never processed within the deadline")
}

func TestDetectorRunSkipsUndecodableWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "broken.jpg"), []byte("not an image"), 0o600); err != nil {
		t.Fatalf("write broken file: %v", err)
	}
	writeTestJPEG(t, dir, "ok.jpg", 32, 32)
	store := newFaceStore(t, dir)
	d := newDetector(t, dir, store, []string{"broken.jpg", "ok.jpg"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	trigger := make(chan struct{})
	done := make(chan struct{})
	go func() {
		d.Run(ctx, trigger)
		close(done)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, brokenProcessed := store.Faces("broken.jpg")
		_, okProcessed := store.Faces("ok.jpg")
		if brokenProcessed && okProcessed {
			cancel()
			<-done
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	t.Fatal("both images were not processed within the deadline; an undecodable file should not block the rest of the backlog")
}

func TestDetectorRunRespectsCancellation(t *testing.T) {
	dir := t.TempDir()
	names := make([]string, 5)
	for i := range names {
		name := fmt.Sprintf("img%d.jpg", i)
		names[i] = name
		writeTestJPEG(t, dir, name, 16, 16)
	}
	store := newFaceStore(t, dir)
	d := newDetector(t, dir, store, names)

	ctx, cancel := context.WithCancel(context.Background())
	trigger := make(chan struct{})
	done := make(chan struct{})
	go func() {
		d.Run(ctx, trigger)
		close(done)
	}()

	// Cancel almost immediately; detectionPause (500ms) between images means a full
	// 5-image backlog would take >2s if it ran to completion, so a prompt stop after
	// cancellation is verifiable within a much shorter bound.
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop promptly after ctx cancellation")
	}
}
