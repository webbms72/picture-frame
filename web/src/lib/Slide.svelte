<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { computeAutoCrop, type FaceBox } from './cropMath';
	import { apiImageFocus } from '$lib/api/sdk.gen';

	let {
		images,
		onAllLoad,
		onError,
		testId,
		vertical,
		blurredFill,
		window: win,
		autoCrop,
		maxCropPercent,
		class: className,
		...rest
	}: {
		images: string[];
		onAllLoad?: () => void;
		onError?: () => void;
		testId?: string;
		vertical?: boolean;
		// When true, each pane shows the full photo uncropped (object-contain) over
		// a blurred, zoomed copy of itself instead of cropping to fill (object-cover).
		blurredFill?: boolean;
		// Percent insets (0-45) shrinking the sharp foreground photo within its pane;
		// blurredFill only, ignored otherwise. Unset/all-zero fills the pane edge to edge.
		window?: { top: number; right: number; bottom: number; left: number };
		// When true, shift the crop window within `window`'s bounds to keep detected faces
		// in frame, reducing blur margin; blurredFill only, ignored otherwise. Falls back to
		// the plain window-inset box when no faces are known for an image (not yet processed,
		// none detected, or the fetch failed).
		autoCrop?: boolean;
		// Cap on how far autoCrop may zoom in past the no-crop fit, 0-100.
		maxCropPercent?: number;
	} & HTMLAttributes<HTMLDivElement> = $props();

	const ZERO_WINDOW = { top: 0, right: 0, bottom: 0, left: 0 };
	const w = $derived(win ?? ZERO_WINDOW);

	// The kiosk follows its viewport in pure CSS; the dashboard preview, whose
	// orientation is the frame's not the admin window's, sets vertical explicitly.
	function directionClass(v: boolean | undefined): string {
		if (v === undefined) return 'portrait:flex-col';
		return v ? 'flex-col' : 'flex-row';
	}
	const direction = $derived(directionClass(vertical));

	// JSON.stringify produces a properly quoted/escaped string, so a filename
	// containing a quote or backslash can't break out of the CSS url() value.
	function bgUrl(name: string): string {
		return `url(${JSON.stringify(`/img/${name}`)})`;
	}

	let container: HTMLDivElement;

	// Cached /focus results, keyed by image name; persists across slide changes so a name the
	// worker has already finished detecting on never refetches. A photo not yet processed (or a
	// failed fetch) is recorded as [] so autoCrop falls back to the plain window-inset box rather
	// than blocking on the network or showing a loading state, but is retried the next time this
	// name comes around in the rotation, picking up the background detector's result once it
	// catches up (see `done` below).
	let faceCache: Record<string, FaceBox[]> = $state({});
	// Non-reactive: tracks which names are in flight or done, so the effect below doesn't read
	// faceCache (a $state object it also writes to, which would re-trigger the same effect for
	// every image already requested that pass) and doesn't issue a second concurrent fetch for a
	// name whose first fetch hasn't resolved yet. Set true synchronously before each fetch, then
	// cleared back to false if the result says the image isn't detected yet, so it's retried the
	// next time this name comes around in the rotation.
	const done: Record<string, boolean> = {};

	$effect(() => {
		if (!blurredFill || !autoCrop) return;
		for (const name of images) {
			if (done[name]) continue;
			done[name] = true; // in-flight marker; cleared back to false below if not yet detected
			apiImageFocus({ path: { name } })
				.then(({ data }) => {
					faceCache[name] = data?.faces ?? [];
					if (!data?.detected) done[name] = false;
				})
				.catch(() => {
					faceCache[name] = [];
					done[name] = false;
				});
		}
	});

	// Per-pane live box size (px) and the loaded <img>'s natural size (px); both start at 0
	// (unknown), in which case autoCropBox falls back to the plain window-inset box.
	let paneW: number[] = $state([]);
	let paneH: number[] = $state([]);
	let naturalW: number[] = $state([]);
	let naturalH: number[] = $state([]);
	// Panes are keyed by index and their <img> element is reused across slide
	// transitions, so naturalW/H[i] can still hold the PREVIOUS photo's dimensions
	// for one render after `name` changes, until that element's onload fires for the
	// new src. Tracking which name each slot's naturalW/H actually belongs to lets
	// autoCropBox fall back to the plain window box instead of combining the new
	// photo's faces with the old photo's dimensions.
	let loadedName: string[] = $state([]);

	function autoCropBox(i: number, name: string) {
		if (!autoCrop) return null;
		const faces = faceCache[name];
		const pw = paneW[i];
		const ph = paneH[i];
		const nw = naturalW[i];
		const nh = naturalH[i];
		if (!faces || faces.length === 0 || !pw || !ph || !nw || !nh) return null;
		if (loadedName[i] !== name) return null;

		const boxW = pw * (1 - (w.left + w.right) / 100);
		const boxH = ph * (1 - (w.top + w.bottom) / 100);
		if (boxW <= 0 || boxH <= 0) return null;
		const boxTop = (ph * w.top) / 100;
		const boxLeft = (pw * w.left) / 100;

		const box = computeAutoCrop({
			boxW,
			boxH,
			imgW: nw,
			imgH: nh,
			faces,
			maxCropPercent: maxCropPercent ?? 20
		});
		return {
			top: boxTop + box.top,
			left: boxLeft + box.left,
			width: box.width,
			height: box.height
		};
	}

	function windowStyle(name: string, i: number): string {
		const crop = blurredFill ? autoCropBox(i, name) : null;
		if (crop) {
			return `top: ${crop.top}px; left: ${crop.left}px; width: ${crop.width}px; height: ${crop.height}px`;
		}
		return `top: ${w.top}%; left: ${w.left}%; width: calc(100% - ${w.left}% - ${w.right}%); height: calc(100% - ${w.top}% - ${w.bottom}%)`;
	}

	// Panes are rendered by the time this effect runs; decode() makes them paint-ready
	// (unlike complete) so the fade shows no black pane. Teardown cancels on slide change.
	$effect(() => {
		void images;
		const panes = [...container.querySelectorAll('img')];
		if (panes.length === 0) return;
		let cancelled = false;
		Promise.all(panes.map((img) => img.decode()))
			.then(() => {
				if (!cancelled) onAllLoad?.();
			})
			.catch(() => {
				if (!cancelled) onError?.();
			});
		return () => {
			cancelled = true;
		};
	});
</script>

<div
	bind:this={container}
	{...rest}
	class={['flex h-full w-full gap-2 bg-black', direction, className]}
>
	{#each images as name, i (i)}
		{#if blurredFill}
			<div
				class="relative min-h-0 min-w-0 flex-1 overflow-hidden"
				bind:clientWidth={paneW[i]}
				bind:clientHeight={paneH[i]}
			>
				<div
					class="absolute inset-0 scale-110 bg-cover bg-center blur-2xl brightness-50"
					style="background-image: {bgUrl(name)}"
					aria-hidden="true"
				></div>
				<img
					src="/img/{name}"
					alt=""
					decoding="async"
					class="absolute object-contain"
					style={windowStyle(name, i)}
					onload={(e) => {
						const target = e.currentTarget as HTMLImageElement;
						naturalW[i] = target.naturalWidth;
						naturalH[i] = target.naturalHeight;
						loadedName[i] = name;
					}}
					data-testid={i === 0 ? testId : undefined}
				/>
			</div>
		{:else}
			<img
				src="/img/{name}"
				alt=""
				decoding="async"
				class="min-h-0 min-w-0 flex-1 object-cover"
				data-testid={i === 0 ? testId : undefined}
			/>
		{/if}
	{/each}
</div>
