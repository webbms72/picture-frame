<script lang="ts">
	import { Slider } from '@skeletonlabs/skeleton-svelte';
	import Field from './Field.svelte';

	let {
		value,
		onchange,
		label,
		help,
		max = 45,
		changed = false,
		onrevert,
		testId
	}: {
		value: number;
		onchange: (value: number) => void;
		label: string;
		help?: string;
		max?: number;
		changed?: boolean;
		onrevert?: () => void;
		testId?: string;
	} = $props();
</script>

<Field {label} {help} {changed} {onrevert}>
	{#snippet trailing()}
		<span class="text-sm font-medium tabular-nums">{value}%</span>
	{/snippet}
	<Slider
		value={[value]}
		min={0}
		{max}
		step={1}
		onValueChange={(e) => onchange(e.value[0] ?? value)}
		data-testid={testId}
	>
		<Slider.Control>
			<Slider.Track><Slider.Range /></Slider.Track>
			<Slider.Thumb index={0}><Slider.HiddenInput /></Slider.Thumb>
		</Slider.Control>
	</Slider>
</Field>
