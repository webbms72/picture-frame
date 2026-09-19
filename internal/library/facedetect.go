package library

import (
	"context"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"log/slog"
	"os"
	"time"

	_ "embed"

	pigo "github.com/esimov/pigo/core"
)

//go:embed cascade/facefinder
var cascadeFile []byte

// detectionPause is a fixed, conservative gap between images during a backfill, so a large
// library doesn't peg a Pi Zero's CPU. Not a user setting — revisit only if real-device testing
// shows it's wrong.
const detectionPause = 500 * time.Millisecond

// downscaleWidth is the target width for the copy detection runs against. Only a normalized
// box is needed, not pixel-exact coordinates, so this keeps per-image detection time roughly
// constant regardless of the original photo's resolution.
const downscaleWidth = 320

// minDetectionQuality filters pigo's low-confidence detections, which are mostly noise.
const minDetectionQuality = 5.0

// Detector runs face detection over library images not yet in the FaceStore, in the
// background, one image at a time.
type Detector struct {
	log        *slog.Logger
	store      *FaceStore
	images     func() []string
	root       *os.Root
	classifier *pigo.Pigo
}

// NewDetector unpacks the embedded cascade once at construction (fail fast if it's corrupt).
// images returns the current list of image names in the library; root is used to open each
// image file for reading.
func NewDetector(log *slog.Logger, store *FaceStore, images func() []string, root *os.Root) (*Detector, error) {
	classifier, err := pigo.NewPigo().Unpack(cascadeFile)
	if err != nil {
		return nil, err
	}
	return &Detector{log: log, store: store, images: images, root: root, classifier: classifier}, nil
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
			d.log.Warn("face detection failed, treating as no faces found", "image", name, "err", err)
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
		d.log.Warn("face store flush failed", "err", err)
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
	sb := small.Bounds()
	cParams := pigo.CascadeParams{
		MinSize:     20,
		MaxSize:     1000,
		ShiftFactor: 0.1,
		ScaleFactor: 1.1,
		ImageParams: pigo.ImageParams{
			Pixels: gray,
			Rows:   sb.Dy(),
			Cols:   sb.Dx(),
			Dim:    sb.Dx(),
		},
	}
	dets := d.classifier.RunCascade(cParams, 0.0)
	dets = d.classifier.ClusterDetections(dets, 0.2)

	ob := img.Bounds()
	ow, oh := float64(ob.Dx()), float64(ob.Dy())
	faces := make([]FaceBox, 0, len(dets))
	for _, det := range dets {
		if det.Q < minDetectionQuality {
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

// downscaleTo resizes img (nearest-neighbor; this is for detection speed, not display quality)
// so its longer edge is targetWidth pixels, returning the resized copy and the scale factor
// applied (resized / original).
func downscaleTo(img image.Image, targetWidth int) (image.Image, float64) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	longEdge := w
	if h > longEdge {
		longEdge = h
	}
	if longEdge <= targetWidth {
		return img, 1.0
	}
	scale := float64(targetWidth) / float64(longEdge)
	dstW := int(float64(w) * scale)
	dstH := int(float64(h) * scale)
	if dstW < 1 {
		dstW = 1
	}
	if dstH < 1 {
		dstH = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	for y := 0; y < dstH; y++ {
		sy := b.Min.Y + int(float64(y)/scale)
		for x := 0; x < dstW; x++ {
			sx := b.Min.X + int(float64(x)/scale)
			dst.Set(x, y, img.At(sx, sy))
		}
	}
	return dst, scale
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
