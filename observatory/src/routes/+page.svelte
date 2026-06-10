<!--
  Observatory — EXP-001 // COST-OF-PLAY-V1

  Four panels in a 2×2 grid:
    [COST.LEDGER]      [PROGRESSION]
    [HYPOTHESIS.BARS]  [LEARNINGS]

  Design decisions:
  - Register: freeside (CRT near-zero, data-forward)
  - Color: bone-bright for hero numbers (never crimson — TDR-007)
  - Verdicts: phosphor-base = HELD, anomaly-base = FALSIFIED, bone-ghost = PENDING
  - Motion: NixieCount at 83ms quantum for cost readouts
  - Steps() only — no smooth easing anywhere
  - No game ceremony. No KANSEI tier escalation. This reads as a laboratory.

  Source authority: world-sprawl/apps/rektdrop/src/lib/design/taste.md (F2)
-->
<script lang="ts">
  import NixieCount from '$lib/NixieCount.svelte';
  import {
    EXPERIMENT,
    COST_LEDGER,
    ATOMS,
    PHASES,
    BAR_RESULTS,
    LEARNINGS,
  } from '$lib/data.js';

  // Format micro-USD to display string
  function fmtMicro(micro: number): string {
    if (micro === 0) return '$0.000000';
    return `$${(micro / 1_000_000).toFixed(6)}`;
  }

  function fmtTokens(n: number): string {
    return n.toLocaleString();
  }

  // Bar fill percentage — clamp to [0, 1] relative to bar_max_display
  function barFillPct(
    current: number | null,
    max_display: number
  ): number {
    if (current === null) return 0;
    return Math.min(current / max_display, 1) * 100;
  }

  function barThresholdPct(threshold: number, max_display: number): number {
    return Math.min(threshold / max_display, 1) * 100;
  }
</script>

<!-- Static prerender declaration for adapter-static -->
<svelte:head>
  <title>OBSERVATORY // {EXPERIMENT.id} // {EXPERIMENT.name}</title>
</svelte:head>

<main class="obs-main" data-step="idle">
  <!-- ── Header strip ── -->
  <header class="obs-header">
    <span class="obs-header-id">
      OBSERVATORY.INSTRUMENT
      <span class="obs-header-sep">//</span>
      {EXPERIMENT.id}
      <span class="obs-header-sep">//</span>
      {EXPERIMENT.name}
    </span>
    <span class="obs-header-date">{EXPERIMENT.date}</span>
  </header>

  <!-- ── 2×2 Panel Grid ── -->
  <div class="obs-grid">

    <!-- ── Panel 1: COST LEDGER ── -->
    <div class="panel">
      <div class="panel-inner">
        <span class="panel-label">COST.LEDGER</span>

        <!-- INFERENCE -->
        <div class="data-row">
          <span class="data-label">INFERENCE (harness)</span>
          <span class="data-value-ghost">~$0 (subscription)</span>
        </div>
        <div class="data-row" style="border-bottom: none; padding-bottom: 0;">
          <span class="data-label" style="color: var(--color-bone-ghost); font-size: var(--text-2xs); letter-spacing: var(--tracking-whisper);">
            {fmtTokens(COST_LEDGER.inference_harness_tokens_in)}↑ / {fmtTokens(COST_LEDGER.inference_harness_tokens_out)}↓ TOKENS
          </span>
        </div>

        <div style="height: var(--space-300);"></div>

        <!-- INFRA — atoms -->
        <div class="data-row">
          <span class="data-label">INFRA (atoms snapshot)</span>
          <span class="data-value phosphor-glow-bone">
            <NixieCount
              target={COST_LEDGER.infra_atoms_micro_usd / 1_000_000}
              duration={2000}
              format={(n) => `$${n.toFixed(6)}`}
            />
          </span>
        </div>
        <div class="data-row" style="border-bottom: none; padding-bottom: 0;">
          <span class="data-label" style="color: var(--color-bone-ghost); font-size: var(--text-2xs); letter-spacing: var(--tracking-whisper);">
            {ATOMS.total} ATOMS · {ATOMS.a_relay} A_RELAY · {ATOMS.b_enrich} B_ENRICH
          </span>
        </div>

        <div style="height: var(--space-300);"></div>

        <!-- CLASS B live -->
        <div class="data-row">
          <span class="data-label">CLASS-B LIVE ENRICHMENTS</span>
          <span class="data-value phosphor-glow-bone">
            <NixieCount
              target={COST_LEDGER.class_b_live_micro_usd / 1_000_000}
              duration={1600}
              format={(n) => `≈$${n.toFixed(3)}`}
            />
          </span>
        </div>
        <div class="data-row" style="border-bottom: none; padding-bottom: 0;">
          <span class="data-label" style="color: var(--color-bone-ghost); font-size: var(--text-2xs); letter-spacing: var(--tracking-whisper);">
            10 BEDROCK PROBES + 2 FULL ENRICHMENTS (681 MICRO EACH)
          </span>
        </div>

        <div style="height: var(--space-300);"></div>

        <!-- Railway -->
        <div class="data-row">
          <span class="data-label">RAILWAY INFRA</span>
          <span class="data-value-ghost">
            &lt; ${COST_LEDGER.railway_est_usd_max.toFixed(2)} (est.)
          </span>
        </div>
        <div class="data-row" style="border-bottom: none; padding-bottom: 0;">
          <span class="data-label" style="color: var(--color-bone-ghost); font-size: var(--text-2xs); letter-spacing: var(--tracking-whisper);">
            2 SERVICES · ~1 SERVICE-DAY · USAGE API
          </span>
        </div>

        <div class="obs-divider"></div>

        <!-- Calibration -->
        <div class="data-row" style="border-bottom: none;">
          <span class="data-label" style="color: var(--color-bone-ghost); font-size: var(--text-2xs); letter-spacing: var(--tracking-whisper);">
            {COST_LEDGER.calibration_note}
          </span>
        </div>
      </div>
    </div>

    <!-- ── Panel 2: PROGRESSION ── -->
    <div class="panel">
      <div class="panel-inner">
        <span class="panel-label">PROGRESSION</span>

        <!-- Phase table -->
        <table class="prog-table">
          <thead>
            <tr>
              <th>PH</th>
              <th>CALLS</th>
              <th>A_RELAY</th>
              <th>B_ENRICH</th>
              <th>GATE</th>
            </tr>
          </thead>
          <tbody>
            {#each PHASES as row}
              <tr>
                <td class="phase-col">
                  {row.level !== undefined ? `${row.phase}.${row.level}` : String(row.phase)}
                </td>
                <td>{row.total_calls}</td>
                <td>{row.a_relay}</td>
                <td>{row.b_enrich}</td>
                <td class={row.b_gate_status === 'ROUTED' ? 'gate-routed' : 'gate-closed'}>
                  {row.b_gate_status === 'ROUTED' ? 'ROUTED' : 'CLOSED'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        <!-- Latency sub-section -->
        <div class="latency-group">
          <p class="latency-group-label">LATENCY P50 (PHASE 1 → PHASE 2)</p>
          {#each PHASES as row}
            <div class="data-row">
              <span class="data-label">
                PH {row.level !== undefined ? `${row.phase}.${row.level}` : String(row.phase)} A_RELAY
              </span>
              <span class="data-value">{row.a_relay_p50_ms}ms</span>
            </div>
            {#if row.b_enrich > 0}
              <div class="data-row">
                <span class="data-label">
                  PH {row.level !== undefined ? `${row.phase}.${row.level}` : String(row.phase)} B_ENRICH ({row.b_gate_status})
                </span>
                <span class="data-value" class:verdict-held={row.b_gate_status === 'ROUTED'} class:verdict-pending={row.b_gate_status === 'FAIL_CLOSED'}>
                  {row.b_p50_ms}ms
                </span>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    </div>

    <!-- ── Panel 3: HYPOTHESIS BARS ── -->
    <div class="panel">
      <div class="panel-inner">
        <span class="panel-label">HYPOTHESIS.BARS</span>
        <p class="obs-bars-provenance">SHA-PINNED · SET BEFORE DATA EXISTED · cop-bars.json</p>

        {#each BAR_RESULTS as bar}
          <div class="hypo-bar-block">
            <div class="hypo-bar-header">
              <span class="hypo-bar-id">{bar.id} — {bar.label}</span>
              <span class={bar.verdict === 'HELD' ? 'verdict-held' : bar.verdict === 'FALSIFIED' ? 'verdict-falsified' : 'verdict-pending'}>
                {bar.verdict}
              </span>
            </div>

            <!-- Bar track -->
            <div class="hypo-bar-track">
              <!-- Fill — current value -->
              {#if bar.current_value !== null}
                <div
                  class="hypo-bar-fill"
                  class:over-held={bar.current_value > bar.bar_held}
                  style="width: {barFillPct(bar.current_value, bar.bar_max_display)}%"
                ></div>
              {/if}

              <!-- Threshold: HELD line (cyan) -->
              <div
                class="hypo-bar-marker hypo-bar-marker-held"
                style="left: {barThresholdPct(bar.bar_held, bar.bar_max_display)}%"
              ></div>

              <!-- Threshold: FALSIFIED line (anomaly), if defined -->
              {#if bar.bar_falsified !== null}
                <div
                  class="hypo-bar-marker hypo-bar-marker-falsified"
                  style="left: {barThresholdPct(bar.bar_falsified, bar.bar_max_display)}%"
                ></div>
              {/if}
            </div>

            <div class="hypo-bar-footer">
              <span class="hypo-bar-threshold-label">
                HELD ≤ {bar.bar_held.toFixed(2)}
                {#if bar.bar_falsified !== null}
                  &nbsp;·&nbsp; FALSIFIED ≥ {bar.bar_falsified.toFixed(2)}
                {/if}
              </span>
              <span class="hypo-bar-threshold-label">
                {bar.current_value !== null ? bar.current_value.toFixed(3) : '···'}
              </span>
            </div>

            <p class="hypo-bar-note">{bar.verdict_note}</p>
          </div>
        {/each}
      </div>
    </div>

    <!-- ── Panel 4: LEARNINGS ── -->
    <div class="panel">
      <div class="panel-inner">
        <span class="panel-label">LEARNINGS — {LEARNINGS.length} DURABLE</span>

        <div class="obs-learnings-scroll">
          {#each LEARNINGS as learning}
            <div class="learning-entry">
              <p class="learning-id">{learning.id} · {learning.source}</p>
              <p class="learning-headline">{learning.headline}</p>
            </div>
          {/each}
        </div>
      </div>
    </div>

  </div>
</main>

<style>
  .obs-main {
    min-height: 100vh;
    padding: var(--space-600);
    padding-bottom: calc(6vh + 48px); /* clear corner telemetry */
    display: flex;
    flex-direction: column;
    gap: var(--space-500);
    position: relative;
    z-index: 1;
  }

  /* ── Header strip ── */
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
    flex-shrink: 0;
  }

  /* ── 2×2 grid ── */
  .obs-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: auto auto;
    gap: var(--space-500);
    flex: 1;
  }

  /* Responsive: single column on narrow viewports */
  @media (max-width: 900px) {
    .obs-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ── Divider ── */
  .obs-divider {
    height: 1px;
    background: var(--color-void-border);
    margin: var(--space-300) 0;
  }

  /* ── Bars provenance note ── */
  .obs-bars-provenance {
    color: var(--color-bone-ghost);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-whisper);
    text-transform: uppercase;
    margin-bottom: var(--space-300);
    padding-bottom: var(--space-200);
    border-bottom: 1px solid oklch(0.22 0.012 250 / 0.4);
  }

  /* ── Learnings scroll container ── */
  .obs-learnings-scroll {
    max-height: 480px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--color-void-surface) transparent;
  }

  .obs-learnings-scroll::-webkit-scrollbar {
    width: 3px;
  }

  .obs-learnings-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .obs-learnings-scroll::-webkit-scrollbar-thumb {
    background: var(--color-void-surface);
  }
</style>
