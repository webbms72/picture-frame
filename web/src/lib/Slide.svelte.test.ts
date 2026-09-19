import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import Slide from './Slide.svelte';

// Simulates a successful image load for autoCrop's natural-size capture, without depending on
// a real backend (unavailable in this test environment: /img/* proxies to nothing, so a real
// image load never fires). naturalWidth/naturalHeight are configurable IDL attributes, so
// shadowing them with an own property and dispatching a synthetic 'load' event exercises the
// component's real onload handler exactly as a genuine image load would.
function fakeImageLoad(img: HTMLImageElement, naturalWidth: number, naturalHeight: number) {
	Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true });
	Object.defineProperty(img, 'naturalHeight', { value: naturalHeight, configurable: true });
	img.dispatchEvent(new Event('load'));
}

describe('Slide', () => {
	it('renders a plain object-cover img per pane when blurredFill is off', async () => {
		const { container } = await render(Slide, { images: ['a.jpg', 'b.jpg'] });
		const imgs = container.querySelectorAll('img');
		expect(imgs).toHaveLength(2);
		for (const img of imgs) {
			expect(img.className).toContain('object-cover');
			expect(img.className).not.toContain('object-contain');
			expect(img.getAttribute('style')).toBeNull();
		}
		// No blurred background layer without blurredFill.
		expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
	});

	it('defaults to a full-bleed (all-zero) window when blurredFill is on', async () => {
		const { container } = await render(Slide, { images: ['a.jpg'], blurredFill: true });
		const img = container.querySelector('img');
		expect(img?.className).toContain('object-contain');
		expect(img).toBeTruthy();
		// Explicit width/height (via calc()), not left/right/bottom auto-stretch: a
		// replaced element's opposing-inset auto-stretch isn't consistent across
		// engines (notably WebKit/Cog on-device), which is what caused the photo to
		// render off-center instead of contained-and-centered on the real frame.
		// The browser pre-resolves a percentage-only calc() to a single percentage.
		const style = img?.getAttribute('style') ?? '';
		expect(style).toContain('top: 0%');
		expect(style).toContain('left: 0%');
		expect(style).toContain('width: calc(100%)');
		expect(style).toContain('height: calc(100%)');
		expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
	});

	it('insets the foreground img by the given window percentages', async () => {
		const { container } = await render(Slide, {
			images: ['a.jpg'],
			blurredFill: true,
			window: { top: 10, right: 20, bottom: 30, left: 40 }
		});
		const img = container.querySelector('img');
		const style = img?.getAttribute('style') ?? '';
		expect(style).toContain('top: 10%');
		expect(style).toContain('left: 40%');
		// width = 100% - left(40%) - right(20%) = 40%; height = 100% - top(10%) - bottom(30%) = 60%.
		expect(style).toContain('width: calc(40%)');
		expect(style).toContain('height: calc(60%)');
	});

	it('ignores the window prop when blurredFill is off', async () => {
		const { container } = await render(Slide, {
			images: ['a.jpg'],
			blurredFill: false,
			window: { top: 10, right: 20, bottom: 30, left: 40 }
		});
		const img = container.querySelector('img');
		expect(img?.className).toContain('object-cover');
		expect(img?.getAttribute('style')).toBeNull();
	});

	describe('autoCrop', () => {
		it('does not fetch /focus when autoCrop is off', async () => {
			const fetchStub = vi.fn();
			vi.stubGlobal('fetch', fetchStub);
			await render(Slide, { images: ['a.jpg'], blurredFill: true, autoCrop: false });
			await tick();
			expect(fetchStub).not.toHaveBeenCalled();
			vi.unstubAllGlobals();
		});

		it('renders the plain window-inset box when /focus reports no faces', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ detected: true, faces: [] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					})
				)
			);
			const { container } = await render(Slide, {
				images: ['a.jpg'],
				blurredFill: true,
				autoCrop: true
			});
			const img = container.querySelector('img') as HTMLImageElement;
			fakeImageLoad(img, 2000, 1000);
			await vi.waitFor(() => {
				expect(img.getAttribute('style') ?? '').toContain('top: 0%');
			});
			const style = img.getAttribute('style') ?? '';
			expect(style).toContain('width: calc(100%)');
			vi.unstubAllGlobals();
		});

		it('renders a distinct crop box once /focus returns a face and the image has loaded', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue(
					new Response(
						JSON.stringify({
							detected: true,
							faces: [{ x0: 0.8, y0: 0.4, x1: 0.95, y1: 0.6 }]
						}),
						{ status: 200, headers: { 'Content-Type': 'application/json' } }
					)
				)
			);
			const { container } = await render(Slide, {
				images: ['a.jpg'],
				blurredFill: true,
				autoCrop: true,
				maxCropPercent: 50
			});
			const img = container.querySelector('img') as HTMLImageElement;
			// A wide image so contain vs. cover scales clearly differ, guaranteeing autoCropBox
			// has room to pick a distinct (non-window-inset) box for this near-edge face.
			fakeImageLoad(img, 2000, 1000);
			await vi.waitFor(() => {
				const style = img.getAttribute('style') ?? '';
				expect(style).not.toContain('calc(');
			});
			const style = img.getAttribute('style') ?? '';
			expect(style).toMatch(/width: [\d.]+px/);
			expect(style).toMatch(/height: [\d.]+px/);
			vi.unstubAllGlobals();
		});
	});
});
