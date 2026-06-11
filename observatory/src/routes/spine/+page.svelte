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
    <span class="obs-header-right">
      <a class="obs-header-link" href="../">EXP-001 PANEL</a>
      <span class="obs-header-date">UPDATED {spine.updated_at}</span>
    </span>
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

  <!-- ── the staircase ── -->
  <div class="panel beam-enter">
    <div class="panel-inner">
      <span class="panel-label">BELIEF.LEDGER — REGISTERED vs SETTLED</span>
      <p class="spine-provenance">
        EVERY EVENT CITES A COMMITTED ARTIFACT · VERDICTS ONLY FROM READOUT INSTRUMENTS · A FALSIFICATION IS PROGRESS
      </p>
      <ResearchSpine events={spine.events} />
    </div>
  </div>

  <!-- ── steering queue ── -->
  <div class="panel beam-enter">
    <div class="panel-inner">
      <span class="panel-label">STEERING.QUEUE — {spine.queue.length} CANDIDATES · OPERATOR SELECTS</span>
      <div class="queue-grid">
        {#each spine.queue as c}
          <div class="queue-entry">
            <p class="queue-id">{c.id} · <span class="queue-lens">{c.lens}</span></p>
            <p class="queue-label">{c.label}</p>
          </div>
        {/each}
      </div>
    </div>
  </div>
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

  .obs-header-right {
    display: inline-flex;
    align-items: center;
    gap: var(--space-400);
  }

  .obs-header-link {
    color: var(--color-cyan-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-whisper);
    text-decoration: none;
    border: 1px solid var(--color-void-border);
    padding: 2px 8px;
  }

  .obs-header-link:hover {
    color: var(--color-cyan-base);
    border-color: var(--color-cyan-dim);
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
    gap: var(--space-100);
  }

  .stat-value {
    color: var(--color-bone-bright);
    font-family: var(--font-mono);
    font-size: var(--text-2xl);
  }

  .stat-phosphor { color: var(--color-phosphor-base); }
  .stat-anomaly { color: var(--color-anomaly-base); }
  .stat-ghost { color: var(--color-bone-muted); }

  .stat-label {
    color: var(--color-bone-ghost);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-whisper);
  }

  .spine-provenance {
    color: var(--color-bone-ghost);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-whisper);
    text-transform: uppercase;
    margin-bottom: var(--space-300);
    padding-bottom: var(--space-200);
    border-bottom: 1px solid oklch(0.22 0.012 250 / 0.4);
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
