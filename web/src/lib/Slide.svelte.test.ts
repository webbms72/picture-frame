import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Slide from './Slide.svelte';

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
});
