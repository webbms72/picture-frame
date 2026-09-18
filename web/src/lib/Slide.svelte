<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		images,
		onAllLoad,
		onError,
		testId,
		vertical,
		blurredFill,
		window: win,
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
			<div class="relative min-h-0 min-w-0 flex-1 overflow-hidden">
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
					style="top: {w.top}%; right: {w.right}%; bottom: {w.bottom}%; left: {w.left}%"
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
