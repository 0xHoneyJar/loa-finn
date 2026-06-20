<!--
  Observatory — EXP-001 // COST-OF-PLAY-V1

  Four panels in a 2×2 grid:
    [COST.LEDGER]    [PROGRESSION]
    [BELIEF.BARS]    [LEARNINGS]

  Design decisions:
  - Register: freeside (CRT near-zero, data-forward)
  - Color: bone-bright for hero numbers (never crimson — TDR-007)
  - Verdicts: phosphor-base = HELD, anomaly-base = FALSIFIED, bone-ghost = PENDING
    (PENDING = not run; INSUFFICIENT = ran-couldn't-decide — kept DISTINCT)
  - Glossary: BELIEF (the unit) · BAR (the pre-registered line) · the loop
    PROBE → REGISTER → DESIGN → SETTLE → CALIBRATE
  - Motion: NixieCount at 83ms quantum for cost readouts
  - Steps() only — no smooth easing anywhere
  - No game ceremony. No KANSEI tier escalation. This reads as a laboratory.

  Source authority: world-sprawl/apps/rektdrop/src/lib/design/taste.md (F2)
-->
<script lang="ts">
  import NixieCount from '$lib/NixieCount.svelte';
  import AtomTicker from '$lib/AtomTicker.svelte';
  import {
    EXPERIMENT,
    COST_LEDGER,
    ATOMS,
    PHASES,
    BAR_RESULTS,
    LEARNINGS,
    RECENT_ATOMS,
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

  function barLinePct(line: number, max_display: number): number {
    return Math.min(line / max_display, 1) * 100;
  }
</script>

<!-- Static prerender declaration for adapter-static -->
<svelte:head>
  <title>OBSERVATORY // {EXPERIMENT.id} // {EXPERIMENT.name}</title>
</svelte:head>

<main class="obs-main" data-step="idle">
  <!-- ── Identity strip — pure context line (the navbar carries navigation) ── -->
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

  <!-- ── Hero — the experiment's one result, at rest above the detail grid ──
       Weight from SIZE, bone-bright only (TDR-007). The 2×2 grid below is the
       detail tier; this line is what the page leads with. -->
  <div class="obs-hero">
    <p class="obs-hero-line">
      THIS EXPERIMENT COST
      <span class="obs-hero-cost phosphor-glow-bone">
        ≈ <NixieCount
          target={COST_LEDGER.class_b_live_micro_usd / 1_000_000}
          duration={2000}
          format={(n) => `$${n.toFixed(3)}`}
        />
      </span>
    </p>
    <p class="obs-hero-support">LIVE CLASS-B INFERENCE · &lt;$5 INFRA · ~$0 HARNESS (SUBSCRIPTION)</p>
  </div>

  <!-- ── 2×2 Panel Grid — the detail tier ── -->
  <div class="obs-grid">

    <!-- ── Panel 1: COST LEDGER ── -->
    <div class="panel beam-enter">
      <div class="panel-inner">
        <span class="panel-label">COST.LEDGER</span>

        <!-- INFERENCE -->
        <div class="data-row">
          <span class="data-label">INFERENCE (harness)</span>
          <span class="data-value-ghost">~$0 (subscription)</span>
        </div>

        <div style="height: var(--space-300);"></div>

        <!-- INFRA — atoms -->
        <div class="data-row">
          <span class="data-label">INFRA (atoms snapshot)</span>
          <span class="data-value data-value--hero phosphor-glow-bone">
            <NixieCount
              target={COST_LEDGER.infra_atoms_micro_usd / 1_000_000}
              duration={2000}
              format={(n) => `$${n.toFixed(6)}`}
            />
          </span>
        </div>

        <div style="height: var(--space-300);"></div>

        <!-- CLASS B live -->
        <div class="data-row">
          <span class="data-label">CLASS-B LIVE ENRICHMENTS</span>
          <span class="data-value data-value--hero phosphor-glow-bone">
            <NixieCount
              target={COST_LEDGER.class_b_live_micro_usd / 1_000_000}
              duration={1600}
              format={(n) => `≈$${n.toFixed(3)}`}
            />
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

        <!-- TUCK: derivations + calibration — the second read, behind the caret -->
        <details class="tuck">
          <summary>METHODOLOGY / CALIBRATION</summary>
          <div class="tuck-body">
            <p class="data-subnote">
              INFERENCE: {fmtTokens(COST_LEDGER.inference_harness_tokens_in)}↑ / {fmtTokens(COST_LEDGER.inference_harness_tokens_out)}↓ TOKENS
            </p>
            <p class="data-subnote">
              ATOMS: {ATOMS.total} TOTAL · {ATOMS.a_relay} A_RELAY · {ATOMS.b_enrich} B_ENRICH
            </p>
            <p class="data-subnote">
              CLASS-B: 10 BEDROCK PROBES + 2 FULL ENRICHMENTS (681 MICRO EACH)
            </p>
            <p class="data-subnote">
              RAILWAY: 2 SERVICES · ~1 SERVICE-DAY · USAGE API
            </p>
            <p class="data-subnote tuck-calibration">
              {COST_LEDGER.calibration_note}
            </p>
          </div>
        </details>
      </div>
    </div>

    <!-- ── Panel 2: PROGRESSION ── -->
    <div class="panel beam-enter">
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

        <!-- TUCK: latency P50 sub-table — the second read, behind the caret -->
        <details class="tuck">
          <summary>LATENCY P50 (PHASE 1 → PHASE 2)</summary>
          <div class="tuck-body">
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
        </details>
      </div>
    </div>

    <!-- ── Panel 3: BELIEF BARS ── -->
    <div class="panel beam-enter">
      <div class="panel-inner">
        <span class="panel-label">BELIEF.BARS</span>
        <p class="obs-bars-provenance">SHA-PINNED · SET BEFORE DATA EXISTED · cop-bars.json</p>

        {#each BAR_RESULTS as bar}
          <div class="belief-bar-block">
            <div class="belief-bar-header">
              <span class="belief-bar-id">{bar.id} — {bar.label}</span>
              <span class={bar.verdict === 'HELD' ? 'verdict-held' : bar.verdict === 'FALSIFIED' ? 'verdict-falsified' : 'verdict-pending'}>
                {bar.verdict}
              </span>
            </div>

            <!-- Bar track -->
            <div class="belief-bar-track">
              <!-- Fill — current value -->
              {#if bar.current_value !== null}
                <div
                  class="belief-bar-fill"
                  class:over-held={bar.current_value > bar.bar_held}
                  style="width: {barFillPct(bar.current_value, bar.bar_max_display)}%"
                ></div>
              {/if}

              <!-- BAR: HELD line (cyan) -->
              <div
                class="belief-bar-marker belief-bar-marker-held"
                style="left: {barLinePct(bar.bar_held, bar.bar_max_display)}%"
              ></div>

              <!-- BAR: FALSIFIED line (anomaly), if defined -->
              {#if bar.bar_falsified !== null}
                <div
                  class="belief-bar-marker belief-bar-marker-falsified"
                  style="left: {barLinePct(bar.bar_falsified, bar.bar_max_display)}%"
                ></div>
              {/if}
            </div>

            <div class="belief-bar-footer">
              <span class="belief-bar-line-label">
                HELD ≤ {bar.bar_held.toFixed(2)}
                {#if bar.bar_falsified !== null}
                  &nbsp;·&nbsp; FALSIFIED ≥ {bar.bar_falsified.toFixed(2)}
                {/if}
              </span>
              <span class="belief-bar-line-label">
                {bar.current_value !== null ? bar.current_value.toFixed(3) : '···'}
              </span>
            </div>

            <p class="belief-bar-note">{bar.verdict_note}</p>
          </div>
        {/each}
      </div>
    </div>

    <!-- ── Panel 4: LEARNINGS ──
         Scannable units (ALEXANDER legibility spec): a tight TAG + a
         one-line GIST sit at the data floor; the full statement is tucked
         behind ▸ DETAILS. The reader scans tags, opens only what earns it —
         not a wall of mono. -->
    <div class="panel beam-enter">
      <div class="panel-inner">
        <span class="panel-label">LEARNINGS — {LEARNINGS.length} DURABLE</span>

        <div class="obs-learnings-scroll">
          {#each LEARNINGS as learning}
            <details class="learning-entry">
              <summary class="learning-summary">
                <span class="learning-caret" aria-hidden="true">▸</span>
                <span class="learning-tag">{learning.id} · {learning.tag}</span>
                <span class="learning-gist">{learning.gist}</span>
              </summary>
              <div class="learning-detail">
                <p class="learning-headline">{learning.headline}</p>
                <p class="learning-source">{learning.source}</p>
              </div>
            </details>
          {/each}
        </div>
      </div>
    </div>

  </div>

  <!-- Peripheral telemetry — last atoms scrolling by (DataTicker port) -->
  <AtomTicker entries={RECENT_ATOMS} />
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

  /* ── Hero — the experiment's one result, at rest above the grid ──
     One hero per page (research type system): the cost line leads, the 2×2
     grid is the detail tier below it. Weight from SIZE, bone-bright (TDR-007). */
  .obs-hero {
    display: flex;
    flex-direction: column;
    gap: var(--space-150);
    flex-shrink: 0;
  }

  .obs-hero-line {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-300);
    color: var(--color-bone-bright);
    font-family: var(--font-mono);
    font-size: var(--text-2xl);
    line-height: var(--leading-tight);
    letter-spacing: var(--tracking-emphasis);
    text-transform: uppercase;
  }

  .obs-hero-cost {
    color: var(--color-bone-bright);
    font-variant-numeric: tabular-nums;
  }

  .obs-hero-support {
    color: var(--color-bone-muted);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    letter-spacing: var(--tracking-whisper);
    text-transform: uppercase;
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

  /* Tucked subnotes get breathing room between lines */
  .tuck-body .data-subnote + .data-subnote {
    margin-top: var(--space-150);
  }

  .tuck-calibration {
    margin-top: var(--space-300);
    padding-top: var(--space-200);
    border-top: 1px solid oklch(0.22 0.012 250 / 0.4);
    color: var(--color-bone-dim);
  }

  /* ── Bars provenance — a quiet muted caption, NOT a result-weight divider.
     text-2xs, bone-muted; no border (it is context, not a section break). ── */
  .obs-bars-provenance {
    color: var(--color-bone-muted);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-whisper);
    text-transform: uppercase;
    margin-bottom: var(--space-300);
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
