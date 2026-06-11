<!--
  ResearchSpine — the autoresearch staircase, inverted for a research program.

  Reference shape: karpathy/autoresearch progress chart (83 experiments,
  15 kept, running-best line). Adaptation: y = OPEN.BELIEFS — registered,
  not-yet-settled beliefs. Research inflow steps UP; experiment verdicts
  burn DOWN. Lower = more settled knowledge. The chart is the race between
  question-generation and answer-settlement, with the operator steering.

  Register: freeside (taste.md) — steps() only, three-voice chromatic
  vocabulary (bone data / phosphor HELD / anomaly FALSIFIED), cyan as
  structural chrome. Probes are bone-ghost: present, never loud.
-->
<script lang="ts">
  type SpineEvent = {
    seq: number;
    date: string;
    kind: 'register' | 'probe' | 'settle';
    verdict?: 'HELD' | 'FALSIFIED' | 'INSUFFICIENT';
    id: string;
    label: string;
    delta?: number;
    source?: string;
    tier?: string;
    warn?: boolean;
  };

  let { events }: { events: SpineEvent[] } = $props();

  // ── layout constants ──
  const W = 1180;
  const H = 460;
  const PAD = { top: 96, right: 36, bottom: 44, left: 56 };

  // ── derive open-belief count per event (steps-after) ──
  type Pt = SpineEvent & { open: number; x: number; y: number };

  const pts: Pt[] = $derived.by(() => {
    let open = 0;
    const maxSeq = Math.max(...events.map((e) => e.seq), 1);
    const maxOpen = Math.max(
      1,
      ...events.reduce<number[]>((acc, e) => {
        const prev = acc.length ? acc[acc.length - 1] : 0;
        acc.push(prev + (e.delta ?? 0));
        return acc;
      }, [])
    );
    const xs = (seq: number) =>
      PAD.left + (seq / maxSeq) * (W - PAD.left - PAD.right);
    const ys = (o: number) =>
      H - PAD.bottom - (o / (maxOpen + 1)) * (H - PAD.top - PAD.bottom);
    return events.map((e) => {
      open += e.delta ?? 0;
      return { ...e, open, x: xs(e.seq), y: ys(open) };
    });
  });

  const maxOpenDisplay = $derived(Math.max(...pts.map((p) => p.open), 1) + 1);

  // staircase path — steps-after (horizontal then vertical), no easing
  const path = $derived.by(() => {
    if (!pts.length) return '';
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` H ${pts[i].x} V ${pts[i].y}`;
    }
    d += ` H ${W - PAD.right}`;
    return d;
  });

  function dotClass(e: SpineEvent): string {
    if (e.kind === 'settle')
      return e.verdict === 'HELD' ? 'dot-held' : 'dot-falsified';
    if (e.kind === 'register') return e.tier === 'claimed' ? 'dot-claimed' : 'dot-register';
    return e.warn ? 'dot-probe-warn' : 'dot-probe';
  }

  function labelClass(e: SpineEvent): string {
    if (e.kind === 'settle')
      return e.verdict === 'HELD' ? 'lbl-held' : 'lbl-falsified';
    if (e.kind === 'register') return e.tier === 'claimed' ? 'lbl-claimed' : 'lbl-register';
    return 'lbl-probe';
  }

  // y-axis gridline values
  const grid = $derived(Array.from({ length: maxOpenDisplay + 1 }, (_, i) => i));

  function gy(o: number): number {
    return H - PAD.bottom - (o / (maxOpenDisplay)) * (H - PAD.top - PAD.bottom);
  }
</script>

<div class="spine-wrap">
  <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Research spine — open beliefs over probe sequence">
    <!-- gridlines -->
    {#each grid as o}
      <line x1={PAD.left} y1={gy(o)} x2={W - PAD.right} y2={gy(o)} class="gridline" />
      <text x={PAD.left - 10} y={gy(o) + 3} class="axis-tick" text-anchor="end">{o}</text>
    {/each}

    <!-- staircase -->
    <path d={path} class="staircase" />

    <!-- event dots + labels -->
    {#each pts as p}
      {#if p.kind === 'probe'}
        <circle cx={p.x} cy={p.y} r="3.5" class={dotClass(p)} />
        <text
          x={p.x + 6}
          y={p.y + 16}
          class="evt-label {labelClass(p)}"
          transform="rotate(28 {p.x + 6} {p.y + 16})"
        >{p.label}</text>
      {:else}
        <circle cx={p.x} cy={p.y} r="6" class={dotClass(p)} />
        <text
          x={p.x + 4}
          y={p.y - 10}
          class="evt-label {labelClass(p)}"
          transform="rotate(-28 {p.x + 4} {p.y - 10})"
        >{p.label}</text>
      {/if}
    {/each}

    <!-- axes -->
    <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} class="axis" />
    <line x1={PAD.left} y1={PAD.top - 60} x2={PAD.left} y2={H - PAD.bottom} class="axis" />
    <text x={W - PAD.right} y={H - 14} class="axis-label" text-anchor="end">PROBE SEQUENCE →</text>
    <text x={18} y={PAD.top - 64} class="axis-label">OPEN.BELIEFS (LOWER = SETTLED)</text>
  </svg>

  <!-- legend -->
  <div class="spine-legend">
    <span class="leg"><span class="swatch sw-register"></span> REGISTERED (BARS PINNED)</span>
    <span class="leg"><span class="swatch sw-claimed"></span> CLAIMED-TIER INFLOW</span>
    <span class="leg"><span class="swatch sw-probe"></span> PROBE</span>
    <span class="leg"><span class="swatch sw-held"></span> SETTLED · HELD</span>
    <span class="leg"><span class="swatch sw-falsified"></span> SETTLED · FALSIFIED</span>
  </div>
</div>

<style>
  .spine-wrap {
    width: 100%;
  }

  svg {
    width: 100%;
    height: auto;
    display: block;
  }

  .gridline {
    stroke: var(--color-void-border);
    stroke-width: 0.5;
    stroke-dasharray: 2 6;
  }

  .axis {
    stroke: var(--color-void-border);
    stroke-width: 1;
  }

  .axis-tick {
    fill: var(--color-bone-ghost);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .axis-label {
    fill: var(--color-bone-dim);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.14em;
  }

  .staircase {
    fill: none;
    stroke: var(--color-bone-dim);
    stroke-width: 1.5;
  }

  /* ── dots ── */
  .dot-register {
    fill: var(--color-cyan-dim);
    stroke: var(--color-cyan-base);
    stroke-width: 1;
  }

  .dot-claimed {
    fill: var(--color-void-raised);
    stroke: var(--color-cyan-dim);
    stroke-width: 1.5;
    stroke-dasharray: 2 2;
  }

  .dot-probe {
    fill: var(--color-bone-ghost);
  }

  .dot-probe-warn {
    fill: var(--color-bone-ghost);
    stroke: var(--color-anomaly-dim);
    stroke-width: 1.5;
  }

  .dot-held {
    fill: var(--color-phosphor-base);
    filter: drop-shadow(0 0 4px var(--color-phosphor-glow));
  }

  .dot-falsified {
    fill: var(--color-anomaly-base);
    filter: drop-shadow(0 0 4px var(--color-anomaly-glow));
  }

  /* ── labels ── */
  .evt-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.04em;
  }

  .lbl-register { fill: var(--color-cyan-dim); }
  .lbl-claimed  { fill: var(--color-cyan-dim); opacity: 0.75; }
  .lbl-probe    { fill: var(--color-bone-ghost); }
  .lbl-held     { fill: var(--color-phosphor-base); }
  .lbl-falsified{ fill: var(--color-anomaly-base); }

  /* ── legend ── */
  .spine-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-400);
    padding-top: var(--space-300);
    border-top: 1px solid var(--color-void-border);
    margin-top: var(--space-300);
  }

  .leg {
    color: var(--color-bone-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-whisper);
    display: inline-flex;
    align-items: center;
    gap: var(--space-200);
  }

  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }

  .sw-register { background: var(--color-cyan-dim); }
  .sw-claimed { background: transparent; border: 1.5px dashed var(--color-cyan-dim); }
  .sw-probe { background: var(--color-bone-ghost); }
  .sw-held { background: var(--color-phosphor-base); }
  .sw-falsified { background: var(--color-anomaly-base); }
</style>
