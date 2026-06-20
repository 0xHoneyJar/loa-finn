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

  Legibility (feel-and-apply 2026-06-13, operator: "labels … pure gibberish
  … right side gets cut off"). ROOT CAUSE was 23 rotated <text> labels
  rendered at 10.5px → overlap + viewBox overrun. FIX: the labels come OFF
  the chart. The staircase + dots stay as the at-rest read; each event's
  label appears ON HOVER/FOCUS as a single tooltip (one label, never 23
  competing). Right margin widened so the settled tail never clips.
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
  // right margin widened 36→132: the staircase runs to W-PAD.right and the
  // last settled tail used to clip at the frame. 132 gives the tail air.
  const W = 1180;
  const H = 420;
  const PAD = { top: 56, right: 132, bottom: 52, left: 56 };

  // hover/focus state — which event's label is showing (index, or null)
  let active = $state<number | null>(null);

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

  // verdict / kind short tag for the tooltip header
  function kindTag(e: SpineEvent): string {
    if (e.kind === 'settle') return e.verdict ?? 'SETTLE';
    if (e.kind === 'register') return e.tier === 'claimed' ? 'CLAIMED' : 'REGISTER';
    return e.warn ? 'PROBE ·!' : 'PROBE';
  }

  // y-axis gridline values
  const grid = $derived(Array.from({ length: maxOpenDisplay + 1 }, (_, i) => i));

  function gy(o: number): number {
    return H - PAD.bottom - (o / (maxOpenDisplay)) * (H - PAD.top - PAD.bottom);
  }

  // ── tooltip geometry ──
  // The card flips to the left of the dot when the dot sits in the right
  // third, so the card never overruns the (now-wide) right margin.
  const TT_W = 300;
  const TT_H = 64;
  function ttX(p: Pt): number {
    const right = p.x + 14;
    if (right + TT_W > W) return p.x - 14 - TT_W; // flip left
    return right;
  }
  function ttY(p: Pt): number {
    const top = p.y - TT_H / 2;
    if (top < 4) return 4;
    if (top + TT_H > H - 4) return H - 4 - TT_H;
    return top;
  }
</script>

<div class="spine-wrap">
  <svg
    viewBox="0 0 {W} {H}"
    preserveAspectRatio="xMidYMid meet"
    role="img"
    aria-label="Research spine — open beliefs over probe sequence. Hover an event dot for its label."
    onpointerleave={() => (active = null)}
  >
    <!-- gridlines -->
    {#each grid as o}
      <line x1={PAD.left} y1={gy(o)} x2={W - PAD.right} y2={gy(o)} class="gridline" />
      <text x={PAD.left - 10} y={gy(o) + 3} class="axis-tick" text-anchor="end">{o}</text>
    {/each}

    <!-- staircase -->
    <path d={path} class="staircase" />

    <!-- event dots — labels are now tooltip-only (no 23 rotated texts) -->
    {#each pts as p, i}
      {#if active === i}
        <circle cx={p.x} cy={p.y} r={p.kind === 'probe' ? 6 : 9} class="dot-halo" />
      {/if}
      <circle
        cx={p.x}
        cy={p.y}
        r={p.kind === 'probe' ? 3.5 : 6}
        class={dotClass(p)}
      />
      <!-- generous transparent hit target over each dot -->
      <circle
        cx={p.x}
        cy={p.y}
        r="13"
        class="dot-hit"
        role="button"
        tabindex="0"
        aria-label="{kindTag(p)} · {p.id} · {p.label}"
        onpointerenter={() => (active = i)}
        onfocus={() => (active = i)}
        onblur={() => (active = null)}
      />
    {/each}

    <!-- axes -->
    <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} class="axis" />
    <line x1={PAD.left} y1={PAD.top - 16} x2={PAD.left} y2={H - PAD.bottom} class="axis" />
    <text x={W - PAD.right} y={H - 16} class="axis-label" text-anchor="end">PROBE SEQUENCE →</text>
    <text x={18} y={PAD.top - 22} class="axis-label">OPEN.BELIEFS (LOWER = SETTLED)</text>

    <!-- hover tooltip — the ONE label, on demand -->
    {#if active !== null}
      {@const p = pts[active]}
      <g class="tooltip" transform="translate({ttX(p)} {ttY(p)})" pointer-events="none">
        <rect width={TT_W} height={TT_H} class="tt-bg" />
        <line x1="0" y1="0" x2="0" y2={TT_H} class="tt-edge {labelClass(p)}" />
        <text x="12" y="20" class="tt-head {labelClass(p)}">{kindTag(p)} · {p.id}</text>
        <text x="12" y="40" class="tt-body">
          {#each wrap(p.label, 42) as line, li}
            <tspan x="12" dy={li === 0 ? 0 : 15}>{line}</tspan>
          {/each}
        </text>
      </g>
    {/if}
  </svg>

  <!-- legend -->
  <div class="spine-legend">
    <span class="leg-hint">HOVER A DOT FOR ITS EVENT →</span>
    <span class="leg"><span class="swatch sw-register"></span> REGISTERED (BARS PINNED)</span>
    <span class="leg"><span class="swatch sw-claimed"></span> CLAIMED-TIER INFLOW</span>
    <span class="leg"><span class="swatch sw-probe"></span> PROBE</span>
    <span class="leg"><span class="swatch sw-held"></span> SETTLED · HELD</span>
    <span class="leg"><span class="swatch sw-falsified"></span> SETTLED · FALSIFIED</span>
  </div>
</div>

<script lang="ts" module>
  // simple word-wrap for the tooltip body (chars per line)
  export function wrap(s: string, n: number): string[] {
    const words = s.split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > n) {
        if (cur) lines.push(cur);
        cur = w;
      } else {
        cur = (cur + ' ' + w).trim();
      }
      if (lines.length === 2) break; // cap at 3 lines for the card
    }
    if (cur && lines.length < 3) lines.push(cur);
    return lines.length ? lines : [s];
  }
</script>

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

  /* hover affordance — transparent hit target + focus ring on keyboard nav */
  .dot-hit {
    fill: transparent;
    cursor: pointer;
    outline: none;
  }
  .dot-hit:focus-visible {
    stroke: var(--color-cyan-base);
    stroke-width: 1.5;
  }
  /* halo behind the active dot — cyan chrome, steps not smooth (it just snaps
     on via reactive render; no transition needed) */
  .dot-halo {
    fill: none;
    stroke: var(--color-cyan-base);
    stroke-width: 1;
    opacity: 0.6;
  }

  /* ── tooltip card ── */
  .tt-bg {
    fill: oklch(0.11 0.005 250);
    stroke: var(--color-void-border);
    stroke-width: 1;
  }
  .tt-edge { stroke-width: 2; }
  .tt-head {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.1em;
  }
  .tt-body {
    fill: var(--color-bone-base);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.02em;
  }

  /* ── label colors (now tooltip head + tooltip edge) ── */
  .lbl-register { fill: var(--color-cyan-dim); stroke: var(--color-cyan-dim); }
  .lbl-claimed  { fill: var(--color-cyan-dim); stroke: var(--color-cyan-dim); opacity: 0.85; }
  .lbl-probe    { fill: var(--color-bone-dim); stroke: var(--color-bone-ghost); }
  .lbl-held     { fill: var(--color-phosphor-base); stroke: var(--color-phosphor-base); }
  .lbl-falsified{ fill: var(--color-anomaly-base); stroke: var(--color-anomaly-base); }

  /* ── legend ── */
  .spine-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-400);
    align-items: center;
    padding-top: var(--space-300);
    border-top: 1px solid var(--color-void-border);
    margin-top: var(--space-300);
  }

  .leg-hint {
    color: var(--color-cyan-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-whisper);
    text-transform: uppercase;
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
