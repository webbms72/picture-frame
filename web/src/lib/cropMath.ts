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

function centeredBox(
	s: number,
	imgW: number,
	imgH: number,
	boxW: number,
	boxH: number
): AutoCropBox {
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
