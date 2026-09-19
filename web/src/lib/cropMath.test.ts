import { describe, expect, it } from 'vitest';
import { computeAutoCrop, type AutoCropBox, type AutoCropInput, type FaceBox } from './cropMath';

// Recovers the crop window's visible rectangle, in normalized image coordinates, from the
// box computeAutoCrop returned — the inverse of positionedBox's left/top math. Used to assert
// "the crop window fully contains the face" without hardcoding the padding-constant-dependent
// exact pixel values.
function visibleRect(box: AutoCropBox, imgW: number, imgH: number, boxW: number, boxH: number) {
	return {
		x0: -box.left / box.width,
		x1: (boxW - box.left) / box.width,
		y0: -box.top / box.height,
		y1: (boxH - box.top) / box.height
	};
}

describe('computeAutoCrop', () => {
	it('with no faces, behaves exactly like plain contain (0% crop, centered)', () => {
		const input: AutoCropInput = {
			boxW: 400,
			boxH: 300,
			imgW: 800,
			imgH: 400,
			faces: [],
			maxCropPercent: 20
		};
		const got = computeAutoCrop(input);
		// sContain = min(400/800, 300/400) = min(0.5, 0.75) = 0.5
		expect(got).toEqual({ width: 400, height: 200, left: 0, top: 50 });
	});

	it('a single tiny centered face with a generous cap hits the maxCropPercent ceiling, not the face-fit ceiling', () => {
		const boxW = 600,
			boxH = 400,
			imgW = 1200,
			imgH = 1200;
		const faces: FaceBox[] = [{ x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 }];
		// sContain = min(0.5, 0.3333) = 0.3333; sCapped = min(sCover, sContain*1.2) = min(0.5, 0.4) = 0.4.
		// A face this tiny lets face-fit scale up all the way to sCover (0.5), so the cap (0.4) binds first.
		const got = computeAutoCrop({ boxW, boxH, imgW, imgH, faces, maxCropPercent: 20 });
		const wantWidth = imgW * 0.4;
		expect(got.width).toBeCloseTo(wantWidth, 6);
		expect(got.height).toBeCloseTo(imgH * 0.4, 6);

		// A much larger cap should let face-fit (not the cap) become the binding constraint instead,
		// producing a *larger* scale (more zoom) than the 20%-cap case above.
		const uncapped = computeAutoCrop({ boxW, boxH, imgW, imgH, faces, maxCropPercent: 1000 });
		expect(uncapped.width).toBeGreaterThan(got.width);
	});

	it('keeps a near-edge face fully inside the recovered crop window', () => {
		const boxW = 500,
			boxH = 1000,
			imgW = 1000,
			imgH = 1000;
		const faces: FaceBox[] = [{ x0: 0.8, y0: 0.4, x1: 0.95, y1: 0.6 }];
		const box = computeAutoCrop({ boxW, boxH, imgW, imgH, faces, maxCropPercent: 50 });
		const rect = visibleRect(box, imgW, imgH, boxW, boxH);

		expect(rect.x0).toBeLessThanOrEqual(0.8);
		expect(rect.x1).toBeGreaterThanOrEqual(0.95);
		expect(rect.y0).toBeLessThanOrEqual(0.4);
		expect(rect.y1).toBeGreaterThanOrEqual(0.6);
	});

	it('renders a wide multi-face union less zoomed in (smaller scale, more of the original image kept) than a narrow single-face union', () => {
		// A tall pane relative to the (square) image, so sCover is height-driven: a face union
		// wide enough approaches sContain, well below a tiny union's sCover-clamped scale, and the
		// difference in rendered scale is unambiguous.
		const base = { boxW: 400, boxH: 600, imgW: 1200, imgH: 1200, maxCropPercent: 100 };
		const wide = computeAutoCrop({
			...base,
			faces: [
				{ x0: 0.05, y0: 0.45, x1: 0.15, y1: 0.55 },
				{ x0: 0.85, y0: 0.45, x1: 0.95, y1: 0.55 }
			]
		});
		const narrow = computeAutoCrop({
			...base,
			faces: [{ x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 }]
		});
		// Less zoomed in = smaller S = a smaller rendered image (.width), and thus a bigger crop
		// window in image pixels, giving both far-apart faces enough room to stay in frame.
		expect(wide.width).toBeLessThan(narrow.width);
	});

	it('falls back to sContain when the face union spans the whole image', () => {
		const boxW = 400,
			boxH = 300,
			imgW = 800,
			imgH = 400;
		const faces: FaceBox[] = [{ x0: 0, y0: 0, x1: 1, y1: 1 }];
		const got = computeAutoCrop({ boxW, boxH, imgW, imgH, faces, maxCropPercent: 20 });
		// Same as the no-faces case: sContain = 0.5, centered, zero crop.
		expect(got).toEqual({ width: 400, height: 200, left: 0, top: 50 });
	});
});
