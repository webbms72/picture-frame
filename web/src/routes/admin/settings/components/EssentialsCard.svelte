<script lang="ts">
	import type { SlideshowDto, DisplayDto, SensorDto } from '$lib/api/types.gen';
	import { SlidersHorizontalIcon } from '@lucide/svelte';
	import { DURATION_STOPS } from '$lib/duration';
	import { eq, hasMotionSensor } from '../utils';
	import DurationSlider from './DurationSlider.svelte';
	import LocaleCombobox from './LocaleCombobox.svelte';
	import TimezoneCombobox from './TimezoneCombobox.svelte';
	import Field from './Field.svelte';
	import ToggleRow from './ToggleRow.svelte';
	import PercentSlider from './PercentSlider.svelte';

	let {
		slideshow = $bindable(),
		display = $bindable(),
		savedSlideshow,
		savedDisplay,
		sensors
	}: {
		slideshow: SlideshowDto;
		display: DisplayDto;
		savedSlideshow: SlideshowDto;
		savedDisplay: DisplayDto;
		sensors: SensorDto[] | null;
	} = $props();

	const motion = $derived(hasMotionSensor(sensors));
	const randomizeChanged = $derived(slideshow.randomize !== savedSlideshow.randomize);
	const splitChanged = $derived(slideshow.split_screen !== savedSlideshow.split_screen);
	const blurredFillChanged = $derived(slideshow.blurred_fill !== savedSlideshow.blurred_fill);
	// structural compare so a new label field is covered without touching this
	const labelsChanged = $derived(!eq(display.labels, savedDisplay.labels));
	// structural compare, same as labelsChanged, for the four window sides as a group
	const windowChanged = $derived(!eq(slideshow.window, savedSlideshow.window));

	// Editing aid only, not a saved setting: when on, dragging one side of an
	// opposite pair carries the other side along, keeping the window centered.
	let linkOpposite = $state(false);

	function setTop(v: number): void {
		slideshow.window.top = v;
		if (linkOpposite) slideshow.window.bottom = v;
	}
	function setBottom(v: number): void {
		slideshow.window.bottom = v;
		if (linkOpposite) slideshow.window.top = v;
	}
	function setLeft(v: number): void {
		slideshow.window.left = v;
		if (linkOpposite) slideshow.window.right = v;
	}
	function setRight(v: number): void {
		slideshow.window.right = v;
		if (linkOpposite) slideshow.window.left = v;
	}
</script>

<div class="card bg-surface-100-900 space-y-5 p-6">
	<h2 class="h4 flex items-center gap-2">
		<SlidersHorizontalIcon class="text-primary-500 size-5" /> Essentials
	</h2>

	<DurationSlider
		label="Advance photo every"
		stops={DURATION_STOPS.slideshowInterval}
		bind:value={slideshow.interval}
		changed={slideshow.interval !== savedSlideshow.interval}
		onrevert={() => (slideshow.interval = savedSlideshow.interval)}
	/>

	<ToggleRow
		label="Shuffle photos"
		checked={slideshow.randomize}
		changed={randomizeChanged}
		onchange={(v) => (slideshow.randomize = v)}
		onrevert={() => (slideshow.randomize = savedSlideshow.randomize)}
	/>

	<ToggleRow
		label="Split-screen pairing"
		checked={slideshow.split_screen}
		changed={splitChanged}
		onchange={(v) => (slideshow.split_screen = v)}
		onrevert={() => (slideshow.split_screen = savedSlideshow.split_screen)}
		testId="split-screen-switch"
	/>

	<ToggleRow
		label="Blurred fill (no cropping)"
		checked={slideshow.blurred_fill}
		changed={blurredFillChanged}
		onchange={(v) => (slideshow.blurred_fill = v)}
		onrevert={() => (slideshow.blurred_fill = savedSlideshow.blurred_fill)}
		testId="blurred-fill-switch"
	/>

	{#if slideshow.blurred_fill}
		<Field
			label="Display window"
			help="Shrinks the sharp photo within the screen (the blur still fills edge to edge) — use this if your frame's visible opening is smaller than the panel, or a different aspect ratio."
			changed={windowChanged}
			onrevert={() => (slideshow.window = { ...savedSlideshow.window })}
			class="pl-4"
		>
			<div class="space-y-3">
				<ToggleRow
					label="Link opposite sides"
					checked={linkOpposite}
					changed={false}
					onchange={(v) => (linkOpposite = v)}
					onrevert={() => {}}
					testId="window-link-switch"
				/>
				<PercentSlider
					label="Top"
					value={slideshow.window.top}
					onchange={setTop}
					testId="window-top-slider"
				/>
				<PercentSlider
					label="Right"
					value={slideshow.window.right}
					onchange={setRight}
					testId="window-right-slider"
				/>
				<PercentSlider
					label="Bottom"
					value={slideshow.window.bottom}
					onchange={setBottom}
					testId="window-bottom-slider"
				/>
				<PercentSlider
					label="Left"
					value={slideshow.window.left}
					onchange={setLeft}
					testId="window-left-slider"
				/>
			</div>
		</Field>
	{/if}

	<DurationSlider
		label="Turn screen off when idle"
		help="A motion sensor wakes the screen after it blanks."
		stops={DURATION_STOPS.blankAfter}
		zeroLabel="Never"
		disabled={!motion}
		bind:value={display.blank_after}
		changed={display.blank_after !== savedDisplay.blank_after}
		onrevert={() => (display.blank_after = savedDisplay.blank_after)}
	/>
	{#if !motion}
		<p class="text-surface-500-400 -mt-3 text-xs">
			Add a motion sensor to enable idle blanking. Without one, the screen couldn't wake again.
		</p>
	{/if}

	<Field
		label="Language"
		help="Date and clock format on the frame."
		changed={display.locale !== savedDisplay.locale}
		onrevert={() => (display.locale = savedDisplay.locale)}
	>
		<LocaleCombobox bind:value={display.locale} />
	</Field>

	<Field
		label="Time zone"
		help="Time zone for the clock and date on the frame. Leave as browser default to follow the device."
		changed={display.timezone !== savedDisplay.timezone}
		onrevert={() => (display.timezone = savedDisplay.timezone)}
	>
		<TimezoneCombobox bind:value={display.timezone} />
	</Field>

	<ToggleRow
		label="Hide clock and date"
		checked={display.hide_clock_date}
		changed={display.hide_clock_date !== savedDisplay.hide_clock_date}
		onchange={(v) => (display.hide_clock_date = v)}
		onrevert={() => (display.hide_clock_date = savedDisplay.hide_clock_date)}
		testId="hide-clock-date-switch"
	/>

	<Field
		label="Reading labels"
		help="Captions under the readings on the frame, in your own words. Leave one empty to hide it."
		changed={labelsChanged}
		onrevert={() => (display.labels = { ...savedDisplay.labels })}
	>
		<div class="grid grid-cols-3 gap-2">
			<input
				class="input"
				type="text"
				bind:value={display.labels.outside}
				placeholder="Outside"
				aria-label="Outside reading label"
				data-testid="setting-label-outside"
			/>
			<input
				class="input"
				type="text"
				bind:value={display.labels.inside}
				placeholder="Inside"
				aria-label="Inside reading label"
			/>
			<input
				class="input"
				type="text"
				bind:value={display.labels.humidity}
				placeholder="Humidity"
				aria-label="Humidity reading label"
			/>
		</div>
	</Field>
</div>
