import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Slide from './Slide.svelte';

// Chromium normalizes the top/right/bottom/left inline style into the `inset`
// shorthand when serialized back out, so assert on computed values instead of
// the raw style attribute string.
function insetsOf(img: Element) {
	const s = getComputedStyle(img);
	return { top: s.top, right: s.right, bottom: s.bottom, left: s.left };
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
		expect(insetsOf(img as Element)).toEqual({ top: '0%', right: '0%', bottom: '0%', left: '0%' });
		expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
	});

	it('insets the foreground img by the given window percentages', async () => {
		const { container } = await render(Slide, {
			images: ['a.jpg'],
			blurredFill: true,
			window: { top: 10, right: 20, bottom: 30, left: 40 }
		});
		const img = container.querySelector('img');
		expect(img?.getAttribute('style')).toContain('10%');
		expect(img?.getAttribute('style')).toContain('20%');
		expect(img?.getAttribute('style')).toContain('30%');
		expect(img?.getAttribute('style')).toContain('40%');
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
