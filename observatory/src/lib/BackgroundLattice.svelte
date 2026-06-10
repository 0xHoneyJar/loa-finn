<!--
  Background Lattice — the spatial field behind the instrument panels.

  Ported from world-sprawl/apps/rektdrop/src/lib/components/BackgroundLattice.svelte
  (container anatomy: fixed inset-0, z-0, pointer-events none, 300% oversize)
  + rektdrop app.css .lattice-grid base rule (L1099-1125) and idle phase
  parameters (L1046-1055).

  Deliberate divergences for the freeside register (observatory/taste.md —
  lab instrument, data-forward):
    - idle-only, single phase: no data-step plumbing, no daemon-sample pulse
    - opacity 0.06 (vs rektdrop idle 0.10) — the field recedes behind data
    - NO checksum rain (composition spec: "lattice only, no checksum rain")
    - moiré layers carried at alpha 0 (geometry present, interference silent)
  Grid + drift CSS lives in app.css (.lattice-grid / @keyframes lattice-drift).
-->
<div class="lattice-container" aria-hidden="true">
	<div class="lattice-grid"></div>
</div>

<style>
	.lattice-container {
		position: fixed;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
		user-select: none;
	}
</style>
