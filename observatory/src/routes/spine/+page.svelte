<!--
  Observatory — RESEARCH.SPINE // AGENTIC-ECONOMY program view

  The autoresearch staircase (karpathy/autoresearch reference shape),
  inverted for a research program: y = open beliefs, settled is down.
  Human steers the ship; experiments burn the belief debt; research
  inflow (claimed-tier) raises it. Below the chart: the steering queue —
  lens-attributed EXP-003 candidates awaiting operator selection.

  Same register as the EXP-001 panel: freeside, steps() only, no ceremony.
-->
<script lang="ts">
  import ResearchSpine from '$lib/ResearchSpine.svelte';
  import spine from '$lib/spine-data.json';

  const settled = spine.events.filter((e) => e.kind === 'settle');
  const open = spine.events.reduce((n, e) => n + (e.delta ?? 0), 0);
</script>

<svelte:head>
  <title>OBSERVATORY // RESEARCH.SPINE // {spine.program}</title>
</svelte:head>

<main class="obs-main" data-step="idle">
  <header class="obs-header">
    <span class="obs-header-id">
      OBSERVATORY.INSTRUMENT
      <span class="obs-header-sep">//</span>
      RESEARCH.SPINE
      <span class="obs-header-sep">//</span>
      {spine.program}
    </span>
    <span class="obs-header-date">UPDATED {spine.updated_at}</span>
  </header>

  <!-- ── headline strip ── -->
  <div class="spine-stats">
    <span class="stat">
      <span class="stat-value">{spine.events.length}</span>
      <span class="stat-label">SPINE EVENTS</span>
    </span>
    <span class="stat">
      <span class="stat-value stat-phosphor">{settled.filter((e) => e.verdict === 'HELD').length}</span>
      <span class="stat-label">HELD</span>
    </span>
    <span class="stat">
      <span class="stat-value stat-anomaly">{settled.filter((e) => e.verdict === 'FALSIFIED').length}</span>
      <span class="stat-label">FALSIFIED</span>
    </span>
    <span class="stat">
      <span class="stat-value">{open}</span>
      <span class="stat-label">OPEN BELIEFS</span>
    </span>
    <span class="stat">
      <span class="stat-value stat-ghost">{spine.queue.length}</span>
      <span class="stat-label">QUEUE</span>
    </span>
  </div>

  <!-- ── the staircase — the hero, at rest ── -->
  <div class="panel beam-enter">
    <div class="panel-inner">
      <span class="panel-label">BELIEF.LEDGER — REGISTERED vs SETTLED</span>
      <ResearchSpine events={spine.events} />

      <!-- TUCK: methodology caption — the second read, behind the caret -->
      <details class="tuck">
        <summary>METHODOLOGY</summary>
        <div class="tuck-body">
          <p class="data-subnote">
            Every event cites a committed artifact · verdicts only from readout instruments · a falsification is progress.
          </p>
        </div>
      </details>
    </div>
  </div>

  <!-- ── steering queue — operator-internal, tucked off the reader path ── -->
  <details class="panel beam-enter queue-panel">
    <summary class="panel-inner queue-summary">
      <span class="tuck-caret" aria-hidden="true">▸</span>
      <span class="panel-label queue-panel-label">STEERING QUEUE — {spine.queue.length} CANDIDATES · OPERATOR SELECTS</span>
    </summary>
    <div class="panel-inner queue-body">
      <div class="queue-grid">
        {#each spine.queue as c}
          <div class="queue-entry">
            <p class="queue-id">{c.id} · <span class="queue-lens">{c.lens}</span></p>
            <p class="queue-label">{c.label}</p>
          </div>
        {/each}
      </div>
    </div>
  </details>
</main>

<style>
  .obs-main {
    min-height: 100vh;
    padding: var(--space-600);
    display: flex;
    flex-direction: column;
    gap: var(--space-500);
    position: relative;
    z-index: 1;
  }

  .obs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--color-void-border);
    padding-bottom: var(--space-300);
    gap: var(--space-400);
    flex-shrink: 0;
  }

  .obs-header-id {
    color: var(--color-bone-dim);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    letter-spacing: var(--tracking-terminal);
    text-transform: uppercase;
  }

  .obs-header-sep {
    color: var(--color-bone-ghost);
    margin: 0 var(--space-200);
  }

  .obs-header-date {
    color: var(--color-bone-ghost);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    letter-spacing: var(--tracking-whisper);
    text-transform: uppercase;
  }

  /* ── headline stats ── */
  .spine-stats {
    display: flex;
    gap: var(--space-600);
    flex-wrap: wrap;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: var(--space-150);
  }

  .stat-value {
    color: var(--color-bone-bright);
    font-family: var(--font-mono);
    font-size: var(--text-2xl);
    line-height: 1;
  }

  .stat-phosphor { color: var(--color-phosphor-base); }
  .stat-anomaly { color: var(--color-anomaly-base); }
  .stat-ghost { color: var(--color-bone-muted); }

  /* The stat LABEL was bone-ghost / text-2xs / tracking-whisper -- that is the
     corner-telemetry register (tokens.css:60, "text-2xs corner telemetry
     ONLY"), and it read as illegible (feel-and-apply 2026-06-13). Lift it onto
     the legible ladder: bone-DIM (clears the chrome floor), text-xs (12px,
     sub-annotation), tracking-EMPHASIS (whisper smears caps at this size). The
     value already owns the hierarchy at text-2xl; the label only needs to be
     readable, not loud. */
  .stat-label {
    color: var(--color-bone-dim);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-emphasis);
    text-transform: uppercase;
  }

  /* ── steering queue panel — tucked (operator-internal, not reader-facing) ──
     The whole panel is a <details>; the panel-label is the summary. Caret
     rotates via steps(1). No smooth easing (taste.md). */
  .queue-panel {
    padding: 4px; /* match .panel shell reveal */
  }

  .queue-summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: var(--space-300);
    /* override .panel-inner's full height for the collapsed header */
    height: auto;
    margin-bottom: 0;
  }

  .queue-summary::-webkit-details-marker {
    display: none;
  }

  .tuck-caret {
    color: var(--color-cyan-dim);
    font-family: var(--font-mono);
    font-size: var(--text-base);
    transition: transform var(--duration-fast) var(--ease-snap);
  }

  .queue-panel[open] .tuck-caret {
    transform: rotate(90deg);
  }

  .queue-panel-label {
    border-bottom: none;
    padding-bottom: 0;
    margin-bottom: 0;
  }

  .queue-summary:hover .queue-panel-label {
    color: var(--color-cyan-base);
  }

  /* the queue body sits as a second inner surface below the summary */
  .queue-body {
    border-top: none;
    margin-top: 4px;
  }

  /* ── queue ── */
  .queue-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-400);
  }

  @media (max-width: 900px) {
    .queue-grid {
      grid-template-columns: 1fr;
    }
  }

  .queue-entry {
    border: 1px dashed var(--color-void-border);
    padding: var(--space-300);
  }

  .queue-id {
    color: var(--color-bone-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-whisper);
    margin-bottom: var(--space-200);
  }

  .queue-lens {
    color: var(--color-cyan-dim);
  }

  .queue-label {
    color: var(--color-bone-base);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
</style>
