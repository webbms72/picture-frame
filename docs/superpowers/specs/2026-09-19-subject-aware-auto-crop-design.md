# Subject-aware auto-crop for blurred fill

Status: approved for implementation.

## Problem

`slideshow.blurred_fill` (and the `slideshow.window` insets) show each photo at its full,
uncropped aspect ratio, with a heavily blurred copy of the photo filling whatever margin is
left. That margin can be large for a badly-mismatched aspect ratio (e.g. a portrait photo on a
landscape screen), and today it's always centered — no awareness of what's actually in the
photo.

This feature adds an "Auto" fit mode: detect faces in each photo once (cached), then crop in on
them — bounded by an admin-configurable maximum — to shrink the blurred margin, while
guaranteeing every detected face stays fully in frame and the crop stays as close to the image's
true center as that constraint allows.

## Non-goals

- Generic saliency/object detection for photos with no faces (landscapes, pets, objects) — those
  fall back to today's full-photo centered behavior, unchanged.
- Any change to the meaning of `slideshow.window`'s Top/Right/Bottom/Left sliders — they remain
  the outer mat/bezel correction, identical for every photo. Auto-crop operates entirely inside
  the box those sliders already define.
- On-device training, per-user face recognition/identity, or any cloud API — detection is a
  stock face-*detector* (bounding boxes only, no identity), fully local.

## Architecture

### New dependency: `github.com/esimov/pigo`

Pure-Go face detection (pixel-intensity comparison trees), no cgo. This project cross-compiles
statically for arm/armv6/armv7/arm64 via goreleaser with zero cgo anywhere today (WiFi, BLE, etc.
all use pure-Go bindings); OpenCV (gocv) or a TFLite/ONNX runtime would need a C toolchain per
target and would meaningfully complicate the release pipeline. `pigo` is the first
image-processing dependency this project has taken on — worth naming explicitly as a real,
if modest, new-dependency decision, not a hidden one.

### `internal/library`: `FaceStore`

Mirrors `AspectStore`'s existing shape and lifecycle (`aspect.go`) but is its own store, not an
extension of `AspectStore`'s `meta{W,H}`:

```go
type FaceBox struct{ X0, Y0, X1, Y1 float64 } // normalized 0-1, image-relative

type FaceStore struct {
    mu  sync.Mutex
    idx map[string][]FaceBox // key: image filename; absent = not yet processed
}
```

- Persisted as a JSON sidecar (`.faces-index.json`) in the images root, same
  atomic-write-then-rename pattern as `.aspect-index.json`.
- **Presence in the map, not just the value, carries meaning**: a key present with an empty
  slice means "processed, no faces found" (a common, valid, terminal outcome — must not be
  retried forever). A key absent means "not yet processed." This is the distinction
  `AspectStore.meta{W,H}` has no room for, which is why this is a separate store rather than an
  extra field bolted onto the existing one.
- `Faces(name) ([]FaceBox, bool)` — bool is "was this ever processed" (not "were faces found").

### Detection: background worker, not inline

Aspect-ratio reads a JPEG header — cheap enough to run inline in the upload handler and the
Immich sync loop (see `httpapi/images.go`'s `recordAspect`, `syncer.go`'s `download`). Face
detection is CPU-real work; running it inline would add real latency to every upload and slow
every Immich sync cycle, and would peg a Pi Zero's CPU during a large library's first backfill.

Instead: a new background service (`internal/library/facedetect.go`, or similar) that:

1. On startup and after each sync/upload event (a channel signal, same style as this codebase's
   existing event-driven services), scans `FaceStore` for image names present in the library but
   absent from the store.
2. Processes one at a time, with a short pause between images (bounded, tunable constant — not a
   user setting) so a large backfill doesn't starve the kiosk-backend process or overheat a
   Pi Zero.
3. Detects on a downscaled copy of the image (~320px on the long edge) — only a normalized
   face-center/box is needed, not pixel-exact coordinates, so resolution doesn't matter and this
   keeps per-image detection time roughly constant regardless of the original photo's megapixel
   count.
4. Respects the same shutdown/cancellation context pattern already used by other long-running
   services in `internal/startup`.

Invalidation follows `AspectStore`'s existing pattern: `Delete()` on file removal
(`syncer.go`/`images.go`'s existing delete hooks get one more call each), naturally re-queuing on
re-add since a deleted key is "absent" again.

### Serving face data to the kiosk

The pane's actual pixel box (screen size, split-screen state, orientation) is runtime,
client-side information the server doesn't have — so the crop-window math itself
(Section "Client-side crop algorithm") happens in `Slide.svelte`, not on the backend. The backend's
job is only to make the cached face boxes available per image:

```
GET /img/{name}/focus  →  { "detected": true, "faces": [{"x0":.., "y0":.., "x1":.., "y1":..}, ...] }
```

Mirrors the existing `/img/{name}` route's shape (`internal/httpapi/images.go`). `Slide.svelte`
fetches this once per unique image name, only when Auto mode is on (avoids the extra request
entirely for everyone not using the feature).

### Settings

Follows the exact plumbing already established for `blurred_fill`/`window` — same file-by-file
path (`config.go` → `validate.go` → `configdto.go` → live-apply in `httpapi/config.go` →
`KioskEventPayload`/`state.KioskPayload` → SSE → kiosk):

```go
type SlideshowConfig struct {
    // ...existing fields...
    AutoCrop       bool    `toml:"auto_crop"`        // default false
    MaxCropPercent float64 `toml:"max_crop_percent"` // default 20, validated 0-100
}
```

Admin UI: a new fit-mode control in `EssentialsCard.svelte`'s "Display window" section — a
`ToggleRow` "Auto-crop to subject" (only meaningful, so only shown, when Blurred fill is on) plus
a `PercentSlider` "Max crop" (0-100%, default 20) shown when Auto-crop is on.

### Client-side crop algorithm (`Slide.svelte`)

Runs only when `blurredFill && autoCrop` and the image's cached faces (fetched via
`/img/{name}/focus`) include at least one box; otherwise renders exactly as today (full-bleed
centered contain, unaffected).

Given the pane's live box (`boxW`, `boxH`) and the loaded `<img>`'s natural dimensions
(`imgW`, `imgH`, available directly from the loaded element — no new data needed for these):

```
S_contain = min(boxW/imgW, boxH/imgH)               // today's behavior: 0% crop
S_cover   = max(boxW/imgW, boxH/imgH)                // 0% blur, uncapped crop
S_capped  = min(S_cover, S_contain × (1 + maxCropPercent/100))

union     = bounding box of all detected FaceBoxes, padded ~15-20% on each side
S_faceFit = largest S at which the crop window (size boxW/S × boxH/S, in image px)
            is still ≥ union's size — i.e. the crop window can just contain the
            padded union at that zoom. (Monotonic in S; solve directly, no search.)

S_final   = min(S_capped, S_faceFit)

// Center: the range of crop-window centers that still fully contain the padded
// union box (non-empty whenever the crop window ≥ union, which S_faceFit guarantees),
// intersected with the range that keeps the crop window inside the image bounds.
// Pick the point in that (intersected) range closest to true center (0.5, 0.5).
cx, cy    = clamp_to_valid_range(0.5, 0.5)
```

Rendered as explicit `width`/`height` (`imgW × S_final`, `imgH × S_final`) and `top`/`left`
(derived from `cx`/`cy`) on the foreground `<img>` — same "explicit box, not
relying-on-object-fit-keyword-auto-stretch" approach as the existing centering fix in
`Slide.svelte`, for the same cross-engine-consistency reason (WebKit/Cog on-device).

Two properties fall out of this without special-casing:

- **Group photos back off automatically.** A wide spread of faces makes `union` wide, which caps
  `S_faceFit` low — the algorithm naturally chooses less crop (more blur) rather than clipping
  anyone, with no group-size-aware logic needed.
- **"Impossible" cases degrade to today's behavior.** If even `S_contain` can't fit the union
  (a face detector false-positive spanning the whole frame, pathological photo, etc.),
  `S_final` bottoms out at `S_contain` — the full photo, centered, exactly like Auto-crop being
  off. There's no failure mode worse than today's behavior.

## Data flow summary

```
photo added (upload or Immich sync)
  → FaceStore: absent (queued)
  → background worker: downscale, detect, cache [FaceBox...] (possibly empty)
  → kiosk requests /img/{name}/focus (only if auto_crop is on)
  → Slide.svelte: compute S_final, cx, cy from faces + live pane box + maxCropPercent
  → render foreground <img> at explicit width/height/top/left; blur background unchanged (full pane, edge to edge)
```

## Error handling

- Detection failure on a single image (corrupt file, decode error) → cache `[]FaceBox{}` (treated
  identically to "processed, no faces found"), logged, never retried automatically. Matches
  `AspectStore`'s existing "best effort, don't block the pipeline" posture.
- `/img/{name}/focus` for an image never processed (race: photo just added, worker hasn't reached
  it yet) → `{"detected": false, "faces": []}`; `Slide.svelte` treats this identically to "no
  faces," i.e. renders full-bleed centered. No loading state, no flash — the next slide rotation
  naturally picks up the cached result once the worker catches up.
- Client-side math is defensive against a degenerate `union` (zero-size, out-of-bounds) by
  clamping `S_faceFit` to `[S_contain, S_cover]` before use.

## Testing

- `internal/library/facedetect_test.go` (new): mirrors `aspect_test.go`'s style — real JPEGs in a
  temp dir via `os.OpenRoot`, asserts via `FaceStore`'s public API. Covers: not-yet-processed vs.
  processed-empty vs. processed-with-faces; `Delete()` re-queuing; the background worker
  processing a batch without blocking on a slow image.
- `internal/httpapi`: new test for the `/img/{name}/focus` route (mirrors existing `images_test.go`
  patterns), including the "never processed" fallback response.
- Go config/DTO round-trip tests for `auto_crop`/`max_crop_percent`, mirroring the existing
  `blurred_fill` tests.
- `web/src/lib/Slide.svelte.test.ts`: new cases for the crop-math function (extracted as a plain,
  independently-testable function rather than inlined in the component, given its complexity) —
  table-driven over: no faces (unchanged behavior), single face near an edge (clamped, not
  face-centered), wide multi-face union (backs off crop), degenerate/impossible union (falls back
  to `S_contain`).
- Admin settings UI tests mirroring the existing `blurred_fill`/`window` toggle test patterns.

## Open implementation questions (for the plan, not blocking this design)

- Exact `pigo` API surface and whether its embedded cascade file needs to be committed to the
  repo or fetched at build time (goreleaser build step) — a build-pipeline detail to resolve
  during planning, not a design-level decision.
- Whether the background worker's inter-image pause should be a fixed constant or scale with
  detected CPU core count — default to a fixed, conservative constant for v1; revisit only if
  real-device testing shows it's wrong.
