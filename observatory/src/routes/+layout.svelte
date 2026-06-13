<!--
  Observatory Layout — the ambient shell.

  CRT at freeside register: scanline-opacity 0.008, noise 0.03 — near-zero.
  The data is the signal. The atmosphere is texture.

  data-register="freeside" is set on <html> in app.html.
  data-step="idle" is set on <html> in app.html.
  This layout provides: scanlines + vignette overlays + corner telemetry.

  Pattern: apps/rektdrop/src/routes/+layout.svelte (F12)
  CRT register: apps/rektdrop/src/app.css line 936–938
-->
<script lang="ts">
  import BackgroundLattice from '$lib/BackgroundLattice.svelte';
  import '../app.css';
  import { EXPERIMENT } from '$lib/data.js';

  let { children } = $props();

  // Wall clock — updates every second
  let wallClock = $state(new Date().toISOString().slice(11, 19));

  $effect(() => {
    const id = setInterval(() => {
      wallClock = new Date().toISOString().slice(11, 19);
    }, 1000);
    return () => clearInterval(id);
  });
</script>

<!-- Spatial field — drifting bone lattice behind everything (z-0) -->
<BackgroundLattice />

<!-- CRT scanlines — fixed overlay, barely visible at freeside register -->
<div class="crt-scanlines crt-vignette" aria-hidden="true"></div>

<!-- Main content slot -->
{@render children()}

<!-- Corner telemetry — AmbientTelemetry pattern (F5) -->
<!-- Bottom-left: experiment identity -->
<div class="telemetry-bl" aria-hidden="true">
  <p>{EXPERIMENT.id} // {EXPERIMENT.name}</p>
  <p>{EXPERIMENT.cycle} // {EXPERIMENT.date}</p>
  <p>FREESIDE.GRID // INSTRUMENT.PANEL</p>
</div>

<!-- Bottom-right: wall-clock + sector -->
<div class="telemetry-br" aria-hidden="true">
  <p>UTC {wallClock}</p>
  <p>SNAPSHOT.FROZEN</p>
</div>
