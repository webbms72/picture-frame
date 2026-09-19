# Subject-aware auto-crop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Auto-crop to subject" mode to blurred-fill: detect faces per photo (cached), then
crop in on them client-side (bounded by an admin max-crop%) to shrink the blurred margin, while
guaranteeing every detected face stays fully in frame and biasing toward the image's true center.

**Architecture:** New `FaceStore` (mirrors the existing `AspectStore` sidecar-JSON-cache pattern)
+ a background detection worker using the pure-Go `pigo` face detector, a new
`GET /img/{name}/focus` endpoint serving cached boxes, two new `Slideshow` config fields
(`auto_crop`, `max_crop_percent`) plumbed through the exact path already established for
`blurred_fill`/`window`, and a pure, independently-testable crop-math function in the frontend
that `Slide.svelte` calls to compute an explicit crop box.

**Tech Stack:** Go (backend, `github.com/esimov/pigo` for face detection), Svelte 5 + TypeScript
(frontend), existing project conventions throughout (huma for HTTP, vitest for frontend tests).

**Spec:** `docs/superpowers/specs/2026-09-19-subject-aware-auto-crop-design.md`

## Global Constraints

- Pure Go only — no cgo, anywhere (spec: "New dependency" section). `pigo` satisfies this; do not
  substitute a cgo-based CV library.
- `FaceStore` must distinguish "not yet processed" (key absent) from "processed, no faces found"
  (key present, empty slice) — this is load-bearing for the worker's queue logic and the
  `/focus` endpoint's fallback behavior (spec: "Error handling").
- Detection never blocks the upload HTTP response or the Immich sync loop (spec: "Detection:
  background worker, not inline").
- `slideshow.window`'s Top/Right/Bottom/Left meaning is unchanged — auto-crop operates inside
  that box, never touches those four values (spec: "Non-goals").
- Config field names: `auto_crop` (bool, toml), `max_crop_percent` (float64, toml, 0-100,
  default 20).
- Follow the exact existing plumbing path for new `Slideshow` config fields — see
  `internal/config/config.go`'s `BlurredFill`/`Window` fields,
  `internal/config/validate.go`'s `SlideshowConfig.validate()`,
  `internal/httpapi/configdto.go`'s `SlideshowDTO`/`toDTO`/`applySlideshowDTO`,
  `internal/httpapi/config.go`'s `copyTier1`, `internal/state/events.go`'s `KioskPayload`, and
  `internal/httpapi/configdto.go`'s `KioskEventPayload` — every one of those six files gets the
  same two-line addition pattern already used for `BlurredFill`/`Window` in each.

---

## Task 1: `FaceStore`

**Files:**
- Create: `internal/library/facestore.go`
- Test: `internal/library/facestore_test.go`

**Interfaces:**
- Consumes: nothing new (stdlib `encoding/json`, `os`, `sync`; follows `internal/library/aspect.go`'s
  existing atomic-write helper — reuse `writeFileAtomic` from that file, same package).
- Produces: `type FaceBox struct{ X0, Y0, X1, Y1 float64 }`, `type FaceStore struct{...}`,
  `NewFaceStore(root *os.Root) *FaceStore`, `(*FaceStore) Faces(name string) (faces []FaceBox, processed bool)`,
  `(*FaceStore) Set(name string, faces []FaceBox)`, `(*FaceStore) Delete(name string)`,
  `(*FaceStore) Flush() error`, `(*FaceStore) Missing(names []string) []string` — used by Task 2's
  worker to find unprocessed images. These exact names are consumed by Tasks 2 and 3.

- [ ] **Step 1: Read `internal/library/aspect.go` in full** to copy its exact sidecar-file pattern
  (atomic write, mutex, load-on-construct, `Missing`/`BackfillMissing`-style scan). `FaceStore`
  must structurally mirror `AspectStore` — same `os.Root`-based file access, same JSON shape
  style (a top-level `map[string]...]`), same file name convention but `.faces-index.json`
  instead of `.aspect-index.json`.

- [ ] **Step 2: Write `internal/library/facestore.go`**

```go
package library

import (
	"encoding/json"
	"os"
	"sync"
)

// FaceBox is one detected face, normalized 0-1 relative to the image's full dimensions.
type FaceBox struct {
	X0, Y0, X1, Y1 float64
}

const facesIndexFile = ".faces-index.json"

// FaceStore caches detected face boxes per image name. A key present in the index with an
// empty slice means "processed, no faces found" — a common, valid, terminal result, never
// retried. A key absent means "not yet processed." This distinction is load-bearing: it's how
// the detection worker (facedetect.go) knows what to queue, and how the /focus HTTP handler
// tells "no faces" apart from "haven't gotten to it yet."
type FaceStore struct {
	root *os.Root
	mu   sync.Mutex
	idx  map[string][]FaceBox
}

// NewFaceStore loads the index from root's .faces-index.json if present; a missing or corrupt
// file starts empty (best-effort, matches AspectStore's posture — never fail startup over this).
func NewFaceStore(root *os.Root) *FaceStore {
	s := &FaceStore{root: root, idx: map[string][]FaceBox{}}
	f, err := root.Open(facesIndexFile)
	if err != nil {
		return s
	}
	defer f.Close()
	_ = json.NewDecoder(f).Decode(&s.idx)
	return s
}

// Faces reports the cached faces for name and whether it has ever been processed.
func (s *FaceStore) Faces(name string) ([]FaceBox, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	faces, ok := s.idx[name]
	return faces, ok
}

// Set records the detection result for name (possibly empty, meaning "no faces found").
// Callers must call Flush to persist.
func (s *FaceStore) Set(name string, faces []FaceBox) {
	if faces == nil {
		faces = []FaceBox{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.idx[name] = faces
}

// Delete removes name from the index (e.g. the photo was deleted), so a later re-add is
// treated as unprocessed again.
func (s *FaceStore) Delete(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.idx, name)
}

// Missing returns the subset of names not yet present in the index, in the given order.
func (s *FaceStore) Missing(names []string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, n := range names {
		if _, ok := s.idx[n]; !ok {
			out = append(out, n)
		}
	}
	return out
}

// Flush persists the index atomically (temp file + rename, same as AspectStore.Flush).
func (s *FaceStore) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.Marshal(s.idx)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.root, facesIndexFile, data)
}
```

  If `writeFileAtomic` in `aspect.go` has a different exact signature than assumed above, match
  the real one — read the file first, don't guess.

- [ ] **Step 3: Write `internal/library/facestore_test.go`** mirroring `aspect_test.go`'s test
  package style (external `library_test` package, real temp dir via `os.OpenRoot`). Cover:
  - `Faces` on an unset name returns `(nil, false)`.
  - `Set` then `Faces` returns the recorded slice and `true`.
  - `Set(name, nil)` then `Faces` returns `([]FaceBox{}, true)` — nil is normalized to empty, not
    dropped.
  - `Delete` then `Faces` returns `(nil, false)` again.
  - `Missing` returns only names absent from the index, preserving input order.
  - `Flush` then a fresh `NewFaceStore` on the same root sees the persisted data.

- [ ] **Step 4: Run `go test ./internal/library/... -run FaceStore -v`** and fix until green.

- [ ] **Step 5: Commit**

```bash
git add internal/library/facestore.go internal/library/facestore_test.go
git commit -m "feat(library): add FaceStore, a cache for per-image detected face boxes"
```

---

## Task 2: pigo dependency + background detection worker

**Files:**
- Modify: `go.mod`, `go.sum` (via `go get github.com/esimov/pigo`)
- Create: `internal/library/facedetect.go`
- Test: `internal/library/facedetect_test.go`

**Interfaces:**
- Consumes: `FaceStore` from Task 1 (`Missing`, `Set`, `Flush`); the library's existing image-name
  listing mechanism (read `internal/library/syncer.go` and `internal/library/adapter/fs.go` to
  find the exact function/interface that lists current image names — reuse it, don't invent a
  new one).
- Produces: `type Detector struct{...}`,
  `NewDetector(store *FaceStore, images func() []string, root *os.Root) (*Detector, error)`,
  `(*Detector) Run(ctx context.Context, trigger <-chan struct{})` — a blocking loop, meant to run
  in its own goroutine from `cmd/picture-frame/wiring.go` (Task 3 wires it up). `NewDetector`
  returns an error if the embedded cascade fails to unpack (fail fast at construction, not at
  first use).

- [ ] **Step 1: Add the dependency**

```bash
go get github.com/esimov/pigo@latest
```

Confirm in `go.mod` afterward that no transitive dependency requires cgo (check `go list -deps
github.com/esimov/pigo/core` for anything suspicious — there shouldn't be, pigo is documented
pure-Go, but verify rather than assume).

- [ ] **Step 2: Get pigo's face cascade file working.** pigo needs an embedded classifier cascade
  (a binary file, typically `facefinder` from the pigo repo's `cascade/` directory). Download it
  and commit it to `internal/library/testdata/` or a new `internal/library/cascade/` directory
  (small binary, a few hundred KB — check the actual pigo repo for the current recommended file
  and its license before committing; pigo's cascade files are typically MIT/BSD but verify), then
  `//go:embed` it in `facedetect.go`. This resolves the spec's "open implementation question"
  about build-time vs. committed cascade — commit it, since fetching a binary at build time adds
  a new external dependency to the release pipeline for no real benefit (it's small and static).

- [ ] **Step 3: Write `internal/library/facedetect.go`**

```go
package library

import (
	"context"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"log/slog"
	"os"
	"time"

	pigo "github.com/esimov/pigo/core"
)

//go:embed cascade/facefinder
var cascadeFile []byte

// detectionPause is a fixed, conservative gap between images during a backfill, so a large
// library doesn't peg a Pi Zero's CPU. Not a user setting (spec: "Open implementation
// questions" — revisit only if real-device testing shows it's wrong).
const detectionPause = 500 * time.Millisecond

// downscaleWidth is the target width for the copy detection runs against. Only a normalized
// box is needed, not pixel-exact coordinates, so this keeps per-image detection time roughly
// constant regardless of the original photo's resolution.
const downscaleWidth = 320

// Detector runs face detection over library images not yet in the FaceStore, in the
// background, one image at a time.
type Detector struct {
	store    *FaceStore
	images   func() []string
	root     *os.Root
	classifier *pigo.Pigo
}

// NewDetector unpacks the embedded cascade once at construction (fail fast if it's corrupt).
// images returns the current list of image names in the library; root is used to open each
// image file for reading.
func NewDetector(store *FaceStore, images func() []string, root *os.Root) (*Detector, error) {
	p := pigo.NewPigo()
	classifier, err := p.Unpack(cascadeFile)
	if err != nil {
		return nil, err
	}
	return &Detector{store: store, images: images, root: root, classifier: classifier}, nil
}

// Run processes the backlog once immediately, then again each time trigger fires (a sync or
// upload completing), until ctx is cancelled. One image at a time, paused between each.
func (d *Detector) Run(ctx context.Context, trigger <-chan struct{}) {
	d.processBacklog(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-trigger:
			d.processBacklog(ctx)
		}
	}
}

func (d *Detector) processBacklog(ctx context.Context) {
	missing := d.store.Missing(d.images())
	if len(missing) == 0 {
		return
	}
	for _, name := range missing {
		if ctx.Err() != nil {
			return
		}
		faces, err := d.detectOne(name)
		if err != nil {
			slog.Warn("face detection failed, treating as no faces found", "image", name, "err", err)
			faces = nil
		}
		d.store.Set(name, faces)
		select {
		case <-ctx.Done():
			return
		case <-time.After(detectionPause):
		}
	}
	if err := d.store.Flush(); err != nil {
		slog.Warn("face store flush failed", "err", err)
	}
}

func (d *Detector) detectOne(name string) ([]FaceBox, error) {
	f, err := d.root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, err
	}
	small, scale := downscaleTo(img, downscaleWidth)
	gray := pigo.RgbToGrayscale(small)
	bounds := small.Bounds()
	cParams := pigo.CascadeParams{
		MinSize:     20,
		MaxSize:     1000,
		ShiftFactor: 0.1,
		ScaleFactor: 1.1,
		ImageParams: pigo.ImageParams{
			Pixels: gray,
			Rows:   bounds.Dy(),
			Cols:   bounds.Dx(),
			Dim:    bounds.Dx(),
		},
	}
	dets := d.classifier.RunCascade(cParams, 0.0)
	dets = d.classifier.ClusterDetections(dets, 0.2)

	origBounds := img.Bounds()
	ow, oh := float64(origBounds.Dx()), float64(origBounds.Dy())
	faces := make([]FaceBox, 0, len(dets))
	for _, det := range dets {
		if det.Q < 5.0 { // pigo quality threshold; low-confidence detections are noise
			continue
		}
		// det.Row/Col are the center, in the downscaled image's pixel space; det.Scale is the
		// side length of the (square) detected region.
		half := float64(det.Scale) / 2 / scale
		cx, cy := float64(det.Col)/scale, float64(det.Row)/scale
		faces = append(faces, FaceBox{
			X0: clamp01((cx - half) / ow),
			Y0: clamp01((cy - half) / oh),
			X1: clamp01((cx + half) / ow),
			Y1: clamp01((cy + half) / oh),
		})
	}
	return faces, nil
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
```

  `downscaleTo` is a small helper — write it too, in the same file: resize `img` so its longer
  edge is `targetWidth` pixels (nearest-neighbor is fine, this is for detection speed, not
  display quality) and return the resized image plus the scale factor applied. If a suitable
  resize helper already exists elsewhere in the codebase (check `internal/library` and
  `internal/httpapi/images.go`, which re-encodes uploads), reuse it instead of writing a new one.

  Note: the exact pigo API (`pigo.NewPigo()`, `CascadeParams` field names, `Detection.Q/Row/Col/Scale`)
  may differ slightly from the above by version — **read the actual installed
  `github.com/esimov/pigo/core` package's godoc/source after `go get` and correct the calls to
  match**; the algorithm structure (grayscale downscaled copy → RunCascade → ClusterDetections →
  map back to normalized full-image coordinates) is the part that must not change.

- [ ] **Step 4: Write `internal/library/facedetect_test.go`.** Cover, using real small test JPEGs
  (a face photo and a plain-color no-face photo — check if a suitable test fixture already exists
  under `internal/library/testdata/`, add one if not, keeping it tiny):
  - `NewDetector` with a corrupt/empty cascade byte slice returns an error (don't panic).
  - `Run` with a `trigger` channel: seed a temp images dir with one no-face image, confirm after
    `processBacklog` runs the `FaceStore` has an empty-but-present entry for it.
  - `Run` respects `ctx` cancellation — cancel mid-backlog with multiple queued images, confirm it
    stops promptly rather than draining the whole queue.
  - A corrupt/undecodable image file in the backlog is recorded as "no faces" (empty slice, not
    left unprocessed) rather than blocking the rest of the backlog.

- [ ] **Step 5: Run `go test ./internal/library/... -run Detect -v`** and fix until green.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/library/facedetect.go internal/library/facedetect_test.go internal/library/cascade
git commit -m "feat(library): background face-detection worker using pigo"
```

---

## Task 3: config plumbing, wiring, and the `/focus` HTTP endpoint

**Files:**
- Modify: `internal/config/config.go` (add `AutoCrop`, `MaxCropPercent` to `SlideshowConfig`)
- Modify: `internal/config/validate.go` (validate `MaxCropPercent` is 0-100)
- Modify: `internal/httpapi/configdto.go` (add to `SlideshowDTO`, `toDTO`, `applySlideshowDTO`,
  and `KioskEventPayload`)
- Modify: `internal/httpapi/config.go` (add to `copyTier1`)
- Modify: `internal/state/events.go` (add to `KioskPayload`)
- Modify: `internal/httpapi/images.go` (new `GET /img/{name}/focus` route)
- Modify: `cmd/picture-frame/wiring.go` (construct `FaceStore`/`Detector`, start `Detector.Run` in
  a goroutine, wire the sync/upload-complete trigger channel)
- Test: `internal/config/config_test.go`, `internal/httpapi/configdto_test.go`,
  `internal/httpapi/config_test.go`, `internal/httpapi/images_test.go` (extend existing files)

**Interfaces:**
- Consumes: `FaceStore.Faces(name) ([]FaceBox, bool)` from Task 1; `Detector.Run` from Task 2.
- Produces: HTTP `GET /img/{name}/focus` → JSON
  `{"detected": bool, "faces": [{"x0":f64,"y0":f64,"x1":f64,"y1":f64}, ...]}`. This exact shape
  (field names `x0/y0/x1/y1`, lowercase, `detected` top-level bool) is consumed by Task 4/5's
  frontend code — do not rename without updating those tasks.

- [ ] **Step 1: `internal/config/config.go`** — add exactly the same shape of two fields as
  `BlurredFill`/`Window` (see lines defining those in the current file for the precedent):

```go
	AutoCrop       bool    `toml:"auto_crop"`
	MaxCropPercent float64 `toml:"max_crop_percent"`
```

  Add a `defaults()` entry so `MaxCropPercent` defaults to `20` (unlike `BlurredFill`/`Window`,
  whose zero values are already the desired default — `MaxCropPercent`'s zero value would mean
  "no crop allowed ever," which is a valid but probably-not-intended default; make the explicit
  default `20` in the `defaults()` function, same place `SplitScreen`/`PairThreshold` get their
  defaults).

- [ ] **Step 2: `internal/config/validate.go`** — in `SlideshowConfig.validate()`, add:

```go
	if s.MaxCropPercent < 0 || s.MaxCropPercent > 100 {
		return fmt.Errorf("max_crop_percent must be 0-100, got %v", s.MaxCropPercent)
	}
```

- [ ] **Step 3: `internal/httpapi/configdto.go`** — add to `SlideshowDTO`:

```go
	AutoCrop       bool    `json:"auto_crop"`
	MaxCropPercent float64 `json:"max_crop_percent" minimum:"0" maximum:"100"`
```

  Add corresponding lines in `toDTO`'s `Slideshow: SlideshowDTO{...}` literal and
  `applySlideshowDTO` (copy the exact two-line pattern used for `BlurredFill` in both places), and
  add `AutoCrop: cfg.Slideshow.AutoCrop` to `KioskEventPayload`'s returned `state.KioskPayload{...}`
  literal (`MaxCropPercent` does NOT need to go to the kiosk payload as a top-level field if the
  frontend fetches it from `/api/config` instead — but simplest and consistent with how
  `BlurredFill`/`Window` already reach the kiosk is to add it to `KioskPayload` too; do that,
  matching the existing pattern exactly rather than introducing a different data path for this one
  field).

- [ ] **Step 4: `internal/httpapi/config.go`** — in `copyTier1`, add:

```go
	dst.Slideshow.AutoCrop = src.Slideshow.AutoCrop             // re-published on the kiosk SSE event
	dst.Slideshow.MaxCropPercent = src.Slideshow.MaxCropPercent // re-published on the kiosk SSE event
```

- [ ] **Step 5: `internal/state/events.go`** — add to `KioskPayload`:

```go
	AutoCrop       bool    `json:"auto_crop"`
	MaxCropPercent float64 `json:"max_crop_percent"`
```

- [ ] **Step 6: Write/extend Go tests for steps 1-5** — mirror the existing `blurred_fill` test
  cases in each of `config_test.go`, `configdto_test.go`, `config_test.go` (httpapi) exactly, one
  new test/case per existing `blurred_fill`-covering test, for `auto_crop`+`max_crop_percent`.
  Add one new validate-rejection test: `max_crop_percent` of `150` (or `-1`) fails `Validate()`.

- [ ] **Step 7: `internal/httpapi/images.go`** — read the file's existing `GET /img/{name}` route
  registration first (exact huma.Register call, path parameter binding style), then add a new
  route immediately after it, following the same registration style:

```go
	huma.Register(api, huma.Operation{
		OperationID: "get-image-focus",
		Method:      http.MethodGet,
		Path:        "/img/{name}/focus",
		Summary:     "Detected face boxes for an image, if auto-crop has processed it",
	}, func(_ context.Context, in *struct {
		Name string `path:"name"`
	}) (*struct{ Body FocusResponse }, error) {
		faces, processed := s.faces.Faces(in.Name) // s.faces is the *library.FaceStore, wired in server construction
		out := FocusResponse{Detected: processed && len(faces) > 0}
		for _, f := range faces {
			out.Faces = append(out.Faces, FaceBoxDTO{X0: f.X0, Y0: f.Y0, X1: f.X1, Y1: f.Y1})
		}
		return &struct{ Body FocusResponse }{Body: out}, nil
	})
```

  Add the `FocusResponse`/`FaceBoxDTO` types near the other DTOs in this file:

```go
	type FaceBoxDTO struct {
		X0 float64 `json:"x0"`
		Y0 float64 `json:"y0"`
		X1 float64 `json:"x1"`
		Y1 float64 `json:"y1"`
	}
	type FocusResponse struct {
		Detected bool         `json:"detected"`
		Faces    []FaceBoxDTO `json:"faces"`
	}
```

  Wire `s.faces *library.FaceStore` into the `server` struct (find where `s.aspect` or similar is
  already stored on the struct, in `internal/httpapi/server.go`, and add `faces` alongside it the
  same way).

- [ ] **Step 8: Write `internal/httpapi/images_test.go` cases** for the new route: a name never
  processed returns `{"detected": false, "faces": []}`; a name processed with two faces returns
  both boxes; a name processed with zero faces returns `{"detected": false, "faces": []}` (same
  shape as never-processed — by design, per spec's error-handling section, the frontend treats
  both identically).

- [ ] **Step 9: `cmd/picture-frame/wiring.go`** — read the file to find where `AspectStore` is
  currently constructed and where the Immich syncer / upload handler are wired together, then:
  construct `FaceStore` the same way `AspectStore` is constructed (same images-dir `os.Root`);
  construct `Detector` from Task 2 (`NewDetector(faceStore, libraryImageNamesFunc, root)`); start
  `detector.Run(ctx, triggerCh)` in a goroutine using the app's existing shutdown-context pattern
  (find how other background services in this file get their `ctx` and follow it exactly); wire
  `triggerCh` to fire after each Immich sync cycle completes and after each fs upload — find the
  existing point(s) where `aspect.Flush()` gets called after those events and send on `triggerCh`
  (non-blocking, buffered size 1, drop-if-full) right after.

- [ ] **Step 10: Run the full backend test suite**

```bash
go build ./internal/... ./cmd/...
go vet ./internal/... ./cmd/...
go test ./internal/... ./cmd/...
```

Fix until green (the two pre-existing unrelated failures documented in earlier PRs —
`TestSPACacheHeaders` needing `make build-ui`, `TestRunAutoAppliesOnSchedule` flaky timing — are
expected and not this task's concern).

- [ ] **Step 11: Regenerate the OpenAPI spec and frontend types**

```bash
cd cmd/openapi && go run .
cd ../../web && npm run prepare
```

- [ ] **Step 12: Commit**

```bash
git add internal/config/config.go internal/config/validate.go internal/config/config_test.go \
  internal/httpapi/configdto.go internal/httpapi/configdto_test.go internal/httpapi/config.go \
  internal/httpapi/config_test.go internal/state/events.go internal/httpapi/images.go \
  internal/httpapi/images_test.go internal/httpapi/server.go cmd/picture-frame/wiring.go \
  web/openapi.json web/src/lib/api
git commit -m "feat: wire auto-crop settings and /img/{name}/focus endpoint end to end"
```

---

## Task 4: crop-math function (frontend, pure/testable)

**Files:**
- Create: `web/src/lib/cropMath.ts`
- Test: `web/src/lib/cropMath.test.ts`

**Interfaces:**
- Consumes: nothing (pure function, no imports beyond types).
- Produces: `computeAutoCrop(input: AutoCropInput): AutoCropBox`, where:

```ts
export type FaceBox = { x0: number; y0: number; x1: number; y1: number }; // normalized 0-1

export type AutoCropInput = {
	boxW: number; // pane's live pixel width
	boxH: number; // pane's live pixel height
	imgW: number; // image's natural pixel width
	imgH: number; // image's natural pixel height
	faces: FaceBox[]; // empty array = no faces / not processed
	maxCropPercent: number; // 0-100
};

export type AutoCropBox = {
	width: number; // px, to apply as the foreground img's explicit width
	height: number; // px
	top: number; // px, offset within the pane
	left: number; // px
};
```

  This exact function name and these exact field names are consumed by Task 5's `Slide.svelte`
  integration.

- [ ] **Step 1: Write the failing test file `web/src/lib/cropMath.test.ts`**, table-driven over:
  no faces (must behave exactly like plain contain — 0% crop, centered); a single tiny centered
  face with a generous `maxCropPercent` (should hit the `maxCropPercent` ceiling, not the
  face-fit ceiling); a face near an edge (crop window must still fully contain it — assert the
  recovered normalized crop rectangle is a superset of the face's own bounds, not exact pixel
  values, since the padding constant is an implementation detail); a wide multi-face union versus
  a narrow single-face union at the same generous `maxCropPercent` (the wide-union case must
  render less zoomed in — larger width — than the narrow-union case, since it needs more room to
  keep both faces visible); a degenerate union spanning the whole image (falls back to
  `S_contain`, i.e. today's plain-contain box, since even zero crop is needed to contain it).
  Write real numeric assertions for every case — work out each expected value by hand from the
  algorithm in Step 3 before writing the assertion, rather than writing the assertion first and
  discovering the algorithm doesn't match it.

- [ ] **Step 2: Run the test file to confirm it fails** (module doesn't exist yet)

```bash
cd web && npx vitest run src/lib/cropMath.test.ts
```

Expected: fails to resolve `./cropMath`.

- [ ] **Step 3: Write `web/src/lib/cropMath.ts`**, implementing exactly the algorithm from the
  spec's "Client-side crop algorithm" section:

```ts
export type FaceBox = { x0: number; y0: number; x1: number; y1: number };

export type AutoCropInput = {
	boxW: number;
	boxH: number;
	imgW: number;
	imgH: number;
	faces: FaceBox[];
	maxCropPercent: number;
};

export type AutoCropBox = {
	width: number;
	height: number;
	top: number;
	left: number;
};

// Padding added around the union of all detected faces, as a fraction of the union's own
// size, so faces don't sit flush against the crop edge and there's a little natural
// background around them.
const UNION_PADDING = 0.18;

export function computeAutoCrop(input: AutoCropInput): AutoCropBox {
	const { boxW, boxH, imgW, imgH, faces, maxCropPercent } = input;

	const sContain = Math.min(boxW / imgW, boxH / imgH);
	const sCover = Math.max(boxW / imgW, boxH / imgH);
	const sCapped = Math.min(sCover, sContain * (1 + maxCropPercent / 100));

	if (faces.length === 0) {
		return centeredBox(sContain, imgW, imgH, boxW, boxH);
	}

	const union = paddedUnion(faces, UNION_PADDING);
	const sFaceFit = faceFitScale(union, imgW, imgH, boxW, boxH, sContain, sCover);

	const sFinal = Math.min(sCapped, sFaceFit);
	return positionedBox(sFinal, union, imgW, imgH, boxW, boxH);
}

function centeredBox(s: number, imgW: number, imgH: number, boxW: number, boxH: number): AutoCropBox {
	const width = imgW * s;
	const height = imgH * s;
	return { width, height, left: (boxW - width) / 2, top: (boxH - height) / 2 };
}

function paddedUnion(faces: FaceBox[], padFraction: number): FaceBox {
	let x0 = Math.min(...faces.map((f) => f.x0));
	let y0 = Math.min(...faces.map((f) => f.y0));
	let x1 = Math.max(...faces.map((f) => f.x1));
	let y1 = Math.max(...faces.map((f) => f.y1));
	const padX = (x1 - x0) * padFraction;
	const padY = (y1 - y0) * padFraction;
	x0 = Math.max(0, x0 - padX);
	y0 = Math.max(0, y0 - padY);
	x1 = Math.min(1, x1 + padX);
	y1 = Math.min(1, y1 + padY);
	return { x0, y0, x1, y1 };
}

// The largest S such that the crop window (in image pixels, boxW/S x boxH/S) is still >= the
// union's size (also in image pixels: (x1-x0)*imgW x (y1-y0)*imgH). Clamped to [sContain, sCover]
// so a degenerate/impossible union can never push S outside the normal contain..cover range.
function faceFitScale(
	union: FaceBox,
	imgW: number,
	imgH: number,
	boxW: number,
	boxH: number,
	sContain: number,
	sCover: number
): number {
	const unionWpx = (union.x1 - union.x0) * imgW;
	const unionHpx = (union.y1 - union.y0) * imgH;
	if (unionWpx <= 0 || unionHpx <= 0) return sContain;
	// crop window at scale S has size (boxW/S, boxH/S) in image px; solve boxW/S >= unionWpx
	// and boxH/S >= unionHpx for the largest S satisfying both:
	const sForW = boxW / unionWpx;
	const sForH = boxH / unionHpx;
	const s = Math.min(sForW, sForH);
	return Math.max(sContain, Math.min(sCover, s));
}

function positionedBox(
	s: number,
	union: FaceBox,
	imgW: number,
	imgH: number,
	boxW: number,
	boxH: number
): AutoCropBox {
	const width = imgW * s;
	const height = imgH * s;

	// Crop window size in normalized image coordinates at this scale:
	const cropWNorm = boxW / s / imgW;
	const cropHNorm = boxH / s / imgH;

	// Valid range for the crop window's center (normalized image coords) such that it still
	// fully contains the union box, intersected with staying inside [0,1] image bounds.
	const cxMin = Math.max(cropWNorm / 2, union.x1 - cropWNorm / 2);
	const cxMax = Math.min(1 - cropWNorm / 2, union.x0 + cropWNorm / 2);
	const cyMin = Math.max(cropHNorm / 2, union.y1 - cropHNorm / 2);
	const cyMax = Math.min(1 - cropHNorm / 2, union.y0 + cropHNorm / 2);

	// Pick the point in range closest to true center (0.5), clamping if the range is
	// inverted (cxMin > cxMax) by falling back to the union's own center — this can only
	// happen if faceFitScale's clamp to sContain didn't fully prevent an over-tight window,
	// which shouldn't occur given faceFitScale's derivation, but guard defensively anyway.
	const cx = cxMin <= cxMax ? clamp(0.5, cxMin, cxMax) : (union.x0 + union.x1) / 2;
	const cy = cyMin <= cyMax ? clamp(0.5, cyMin, cyMax) : (union.y0 + union.y1) / 2;

	// cx/cy are the crop window's center in normalized image coords; convert to the
	// rendered <img>'s top/left offset within the pane (the img is rendered at its full
	// width/height=imgW*s/imgH*s, and top/left shift it so the desired crop window aligns
	// with the pane's [0,boxW]x[0,boxH] visible area).
	const left = boxW / 2 - cx * width;
	const top = boxH / 2 - cy * height;

	return { width, height, top, left };
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(Math.max(v, min), max);
}
```

- [ ] **Step 4: Run the test file, fix until it passes**

```bash
cd web && npx vitest run src/lib/cropMath.test.ts
```

  Work through each failure individually. Pay particular attention to the sign conventions in
  `positionedBox`'s `left`/`top` computation — an off-by-sign-flip here is the most likely bug
  (the near-edge-face test is specifically designed to catch this: get the sign wrong and the
  crop window moves *away* from the face instead of toward it).

- [ ] **Step 5: Run the full frontend unit suite to confirm no regressions**

```bash
cd web && npm run test:unit -- --run
```

- [ ] **Step 6: Commit**

```bash
cd /path/to/repo/root
git add web/src/lib/cropMath.ts web/src/lib/cropMath.test.ts
git commit -m "feat(web): pure crop-math function for subject-aware auto-crop"
```

---

## Task 5: `Slide.svelte` integration

**Files:**
- Modify: `web/src/lib/Slide.svelte`
- Modify: `web/src/lib/Slide.svelte.test.ts` (extend)
- Modify: `web/src/routes/kiosk/components/Images.svelte` (pass `autoCrop`/`maxCropPercent` props
  through, same pattern as `blurredFill`/`window`)
- Modify: `web/src/routes/admin/components/NowPlaying.svelte` (same, for the dashboard preview)
- Modify: `web/src/routes/admin/+page.svelte` (same, reading from `data.config.slideshow`)

**Interfaces:**
- Consumes: `computeAutoCrop` from Task 4; the existing `blurredFill`/`window` prop pattern
  already in `Slide.svelte` (read the current file — this session already modified it twice, for
  the centering fix and the window-inset feature — before changing it again).
- Produces: `Slide.svelte` gains `autoCrop?: boolean` and `maxCropPercent?: number` props.

- [ ] **Step 1: Read the current `web/src/lib/Slide.svelte` in full** before editing — it has
  changed twice already this session (explicit width/height calc fix, then the window-inset
  feature), so do not assume its shape from the spec doc alone.

- [ ] **Step 2: Add a per-image-name focus fetch.** In the `{#if blurredFill}` branch, when
  `autoCrop` is true, fetch `/img/{name}/focus` once per unique `name` (use a small in-component
  cache, e.g. `$state<Record<string, FaceBox[]>>({})`, keyed by name, populated by an `$effect`
  that fires when a new name appears and isn't already cached — don't refetch on every re-render).
  On fetch failure or while pending, treat as `faces: []` (matches the spec's "no loading state,
  no flash" error-handling requirement — never block rendering on this fetch).

- [ ] **Step 3: Compute the crop box.** For each pane, when `blurredFill && autoCrop &&`
  faces are non-empty for that image, call `computeAutoCrop` with the pane's live box dimensions
  (read via `bind:clientWidth`/`clientHeight` on the wrapper div, or the existing mechanism
  already used for the window-inset feature if one exists — check first) and the loaded `<img>`'s
  `naturalWidth`/`naturalHeight`. Apply the result as explicit `width`/`height`/`top`/`left`
  inline styles on the foreground `<img>`, replacing (only when auto-crop actually applies for
  that image) the existing window-inset-based `width: calc(...)`/`height: calc(...)` styles.
  When `autoCrop` is false, or faces are empty for that image, fall through to the existing
  window-inset rendering unchanged — auto-crop must be strictly additive, never regressing the
  already-shipped window-inset behavior.

- [ ] **Step 4: Extend `Slide.svelte.test.ts`** with cases: `autoCrop` off renders the existing
  window-inset box, ignoring any mocked `/focus` response; `autoCrop` on with a mocked
  no-faces-found `/focus` response renders identically to `autoCrop` off (same fallback the pure
  function already guarantees, but assert it end-to-end through the component too); `autoCrop` on
  with a mocked single-face response renders a crop box distinct from the plain window-inset box.
  Mock `fetch` for the `/focus` calls (check how other component tests in this repo mock network
  calls — follow that existing pattern, don't introduce a new mocking approach).

- [ ] **Step 5: Thread the two new props through `Images.svelte`, `NowPlaying.svelte`, and
  `admin/+page.svelte`**, exactly matching the existing `blurredFill`/`window` prop-threading
  pattern in each of those three files (read each file's current state first — all three were
  modified for `window` earlier this session).

- [ ] **Step 6: Run tests, check, lint**

```bash
cd web
npm run test:unit -- --run
npm run check
npm run lint
```

Fix until all green.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/Slide.svelte web/src/lib/Slide.svelte.test.ts \
  web/src/routes/kiosk/components/Images.svelte \
  web/src/routes/admin/components/NowPlaying.svelte web/src/routes/admin/+page.svelte
git commit -m "feat(web): apply subject-aware auto-crop in Slide.svelte"
```

---

## Task 6: admin UI + docs

**Files:**
- Modify: `web/src/routes/admin/settings/components/EssentialsCard.svelte`
- Modify: `web/src/routes/admin/settings/utils.ts`, `utils.test.ts` (add `auto_crop`/
  `max_crop_percent: 20` to the `createEmptyConfig()`/test fixtures, matching how `window` was
  added there earlier this session)
- Modify: `web/src/lib/config.test.ts` (same fixture addition)
- Modify: `docs/src/content/docs/manual/slideshow-display.md`
- Modify: `docs/src/content/docs/reference/configuration.md`

**Interfaces:**
- Consumes: `SlideshowDto.auto_crop`/`max_crop_percent` from Task 3's regenerated types;
  `PercentSlider`/`ToggleRow` components already present in this directory.

- [ ] **Step 1: Read the current `EssentialsCard.svelte` in full** (modified twice already this
  session — the window-inset feature, then the Zoom→link-toggle redesign).

- [ ] **Step 2: Add an "Auto-crop to subject" `ToggleRow`** inside the existing
  `{#if slideshow.blurred_fill}` block, above or below the "Display window" `Field` (either
  ordering is fine — pick whichever reads better next to the existing controls), bound to
  `slideshow.auto_crop`, following the exact `changed`/`onrevert` pattern every other toggle in
  this file already uses.

- [ ] **Step 3: Add a "Max crop" `PercentSlider`**, shown only when `slideshow.auto_crop` is true
  (`{#if slideshow.blurred_fill && slideshow.auto_crop}`), `max={100}` (note: this is the one
  `PercentSlider` in the file that isn't capped at 45 — pass `max={100}` explicitly, the
  component already supports a `max` prop per its existing definition), bound to
  `slideshow.max_crop_percent`, default-displayed value `20`.

- [ ] **Step 4: Update `createEmptyConfig()` in `utils.ts`** and the fixtures in `utils.test.ts`/
  `config.test.ts` to include `auto_crop: false, max_crop_percent: 20` in the `slideshow` object,
  matching exactly how `blurred_fill`/`window` were added to those same fixtures earlier this
  session.

- [ ] **Step 5: Run tests, check, lint** (same three commands as Task 5 Step 6). Fix until green.

- [ ] **Step 6: Update docs.** In `slideshow-display.md`'s existing "Display window" section (or a
  new adjacent section), add a paragraph explaining Auto-crop: what it does, that it only shows
  up when Blurred fill is on, that it never clips a detected face, and that Max crop bounds how
  aggressively it's allowed to zoom in. In `configuration.md`'s slideshow config reference table,
  add rows for `auto_crop` and `max_crop_percent` matching the existing table's format for
  `blurred_fill`/`window`.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/admin/settings/components/EssentialsCard.svelte \
  web/src/routes/admin/settings/utils.ts web/src/routes/admin/settings/utils.test.ts \
  web/src/lib/config.test.ts docs/src/content/docs/manual/slideshow-display.md \
  docs/src/content/docs/reference/configuration.md
git commit -m "feat(web): admin UI and docs for subject-aware auto-crop"
```

---

## Final integration check (do this once, after all six tasks)

- [ ] Full repo build/test pass from a clean checkout of the feature branch:

```bash
go build ./internal/... ./cmd/...
go vet ./internal/... ./cmd/...
go test ./internal/... ./cmd/...
cd web && npm run test:unit -- --run && npm run check && npm run lint
```

- [ ] Self-review the full diff (`git diff main`) against the spec's "Non-goals" section
  specifically — confirm `slideshow.window`'s four sliders are untouched by any of this, and that
  turning `auto_crop` off produces byte-identical rendering to before this feature existed.
