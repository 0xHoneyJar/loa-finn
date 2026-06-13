<!--
  AtomTicker — peripheral telemetry strip: the last CostAtoms scrolling by.

  Ported from world-sprawl/apps/rektdrop/src/lib/components/DataTicker.svelte
  (CSS-only marquee, duplicated track for seamless loop, edge mask-image
  fades at 8%/92%, border-top/bottom void separators, baseline-aligned
  items, 40s linear loop).

  Divergences: entries are CostAtom events (id · class · gate reason ·
  micro-USD), not paper-loss rows; colors follow the observatory ladder
  (routed = phosphor, fail-closed/abstain = bone-dim); honors
  prefers-reduced-motion by pausing the scroll.
-->
<script lang="ts">
	interface AtomEvent {
		id: string;
		call_class: string;
		gate: string;
		total_micro: number;
		wall_ms: number;
	}

	interface Props {
		entries: AtomEvent[];
	}

	let { entries }: Props = $props();

	function gateShort(g: string): string {
		if (g.includes('routed')) return 'ROUTED';
		if (g.includes('not_requested')) return 'RELAY';
		if (g.includes('abstain')) return 'ABSTAIN';
		if (g.includes('kill_switch')) return 'KILL-SWITCH';
		return 'CLOSED';
	}
</script>

{#if entries.length > 0}
	<div class="ticker" aria-hidden="true">
		{#each [0, 1] as dup (dup)}
			<div class="ticker-track">
				{#each entries as a (dup + a.id)}
					<span class="ticker-item">
						<span class="ticker-id">#{a.id}</span>
						<span class="ticker-class">{a.call_class === 'A_relay' ? 'A' : 'B'}</span>
						<span class="ticker-gate" class:routed={a.gate.includes('routed')}>{gateShort(a.gate)}</span>
						<span class="ticker-cost">{a.total_micro}µ</span>
						<span class="ticker-sep">·</span>
					</span>
				{/each}
			</div>
		{/each}
	</div>
{/if}

<style>
	.ticker {
		display: flex;
		overflow: hidden;
		border-top: 1px solid var(--color-void-border);
		border-bottom: 1px solid var(--color-void-border);
		padding: var(--space-100) 0;
		gap: 2rem;
		mask-image: linear-gradient(90deg, transparent 0%, black 8%, black 92%, transparent 100%);
		-webkit-mask-image: linear-gradient(90deg, transparent 0%, black 8%, black 92%, transparent 100%);
	}

	.ticker-track {
		flex-shrink: 0;
		display: flex;
		gap: 2rem;
		animation: ticker-scroll 40s linear infinite;
	}

	@keyframes ticker-scroll {
		to { transform: translateX(calc(-100% - 2rem)); }
	}

	@media (prefers-reduced-motion: reduce) {
		.ticker-track { animation: none; }
	}

	.ticker-item {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}

	.ticker-id {
		color: var(--color-bone-ghost);
		letter-spacing: var(--tracking-data);
	}

	.ticker-class {
		color: var(--color-cyan-dim);
	}

	.ticker-gate {
		color: var(--color-bone-dim);
		letter-spacing: var(--tracking-emphasis);
	}

	.ticker-gate.routed {
		color: var(--color-phosphor-base);
	}

	.ticker-cost {
		color: var(--color-bone-base);
		font-variant-numeric: tabular-nums;
	}

	.ticker-sep {
		color: var(--color-void-border);
	}
</style>
