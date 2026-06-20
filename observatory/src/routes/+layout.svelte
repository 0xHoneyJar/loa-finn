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
  import PixelMark from '$lib/PixelMark.svelte';
  import '../app.css';
  import { EXPERIMENT } from '$lib/data.js';
  import { page } from '$app/state';

  let { children } = $props();

  // Wall clock — updates every second
  let wallClock = $state(new Date().toISOString().slice(11, 19));

  $effect(() => {
    const id = setInterval(() => {
      wallClock = new Date().toISOString().slice(11, 19);
    }, 1000);
    return () => clearInterval(id);
  });

  // Global navbar — ONE name per room. Active = current path.
  const ROOMS = [
    { href: '/', label: 'PANEL' },
    { href: '/spine', label: 'SPINE' },
    { href: '/structure', label: 'MEMBRANE' }
  ];
</script>

<!-- Spatial field — drifting bone lattice behind everything (z-0) -->
<BackgroundLattice />

<!-- ── Global navbar — every room reaches every room (closes the dead end) ──
     Wordmark → /, three links in fixed order. Active page = cyan-bright +
     cyan underglow (box-shadow, no box outline). Transitions via steps(). -->
<nav class="obs-nav" aria-label="Observatory rooms">
  <a class="obs-nav-mark" href="/" aria-label="Observatory home">OBSERVATORY</a>
  <span class="obs-nav-links">
    {#each ROOMS as room}
      <a
        class="obs-nav-link"
        class:is-active={page.url.pathname === room.href}
        href={room.href}
        aria-current={page.url.pathname === room.href ? 'page' : undefined}
      >{room.label}</a>
    {/each}
  </span>
</nav>

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

<!-- Creative-director annotation overlay — Shift+drag to mark, themed to
     freeside (cyan rect · void-surface note input). Auto-portals to <body>,
     SSR-safe (browser-guarded), mounted ONCE here for every room. -->
<PixelMark />

<style>
  /* ── Global navbar — the ONE nav, on every page ──
     Sits above the content in normal flow (z-1, over the lattice). Mono,
     uppercase, tracking-terminal. Active marker is glow, never an outline
     box (taste.md: elevation is glow-based). Transitions step, never smooth. */
  .obs-nav {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: baseline;
    gap: var(--space-600);
    padding: var(--space-400) var(--space-600);
    border-bottom: 1px solid var(--color-void-border);
  }

  .obs-nav-mark {
    color: var(--color-bone-bright);
    font-family: var(--font-mono);
    font-size: var(--text-base);
    letter-spacing: var(--tracking-terminal);
    text-transform: uppercase;
    text-decoration: none;
    flex-shrink: 0;
    transition: color var(--duration-fast) var(--ease-snap);
  }

  .obs-nav-mark:hover {
    color: var(--color-cyan-base);
  }

  .obs-nav-links {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-500);
  }

  .obs-nav-link {
    color: var(--color-bone-dim);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    letter-spacing: var(--tracking-terminal);
    text-transform: uppercase;
    text-decoration: none;
    padding-bottom: var(--space-050);
    /* steps() — the institutional "no smooth" discipline (taste.md) */
    transition:
      color var(--duration-fast) var(--ease-snap),
      box-shadow var(--duration-fast) var(--ease-snap);
  }

  .obs-nav-link:hover {
    color: var(--color-cyan-base);
  }

  /* Active room: cyan-bright + 1px cyan underglow (glow, no box outline) */
  .obs-nav-link.is-active {
    color: var(--color-cyan-bright);
    box-shadow: 0 1px 0 0 var(--color-cyan-base),
                0 2px 6px -1px var(--color-cyan-base);
  }

  @media (max-width: 640px) {
    .obs-nav {
      flex-direction: column;
      gap: var(--space-300);
      align-items: flex-start;
    }
  }
</style>
