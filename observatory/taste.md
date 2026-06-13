# Observatory Taste — EXP-001

> Extracted canon from 23 fragment survey (GECKO stage 1, cycle-053).
> Every value here is grounded in shipping code. Source paths cited per token.
> Register: **freeside** — the laboratory instrument register.
> This is not the game. This is the scientists watching the game.

---

## The One Register Decision

The observatory reads as a **science instrument**, not a game ceremony.
The correct CRT register is `freeside` (`[data-register='freeside']` on `<html>`).

Source: `world-sprawl/apps/rektdrop/src/app.css` lines 936–938:
```css
html[data-register='freeside'] [data-step] {
  --crt-scanline-opacity: 0.008;  /* near-zero */
  --crt-noise-opacity: 0.03;      /* barely present */
}
```

The rektdrop game register runs scanlines at 0.045–0.334 depending on phase.
The observatory never exceeds 0.008. The data is the signal; the CRT is texture.

**Anti-pattern (forbidden in observatory):**
- KANSEI tier escalation (`data-tier × data-step` composites) — game mechanics
- DarkPassage ceremony transitions — no drama in the lab
- EvaFlash violence register — not a loss event, never
- Smooth easing (cubic-bezier) — use `steps()` everywhere

---

## Chromatic Vocabulary

Source: `world-sprawl/packages/sprawlos-tokens/src/tokens.css`
Three-color vocabulary for the data layer: **Bone / Phosphor / Anomaly**.
Cyan is structural chrome. Void is silence.

### Bone — The Data Voice
```
--color-bone-bright:  oklch(0.97 0.005 95)   /* hero numbers, primary readouts */
--color-bone-base:    oklch(0.88 0.01  95)   /* body text, row labels */
--color-bone-dim:     oklch(0.68 0.008 95)   /* secondary: data labels */
--color-bone-muted:   oklch(0.48 0.006 95)   /* metadata, sub-rows */
--color-bone-ghost:   oklch(0.32 0.004 95)   /* disabled, corner telemetry, notes */
```

**TDR-007 (Restraint as Intensity):** Hero numbers are always `bone-bright`.
Never crimson on primary data readouts. The cost number carries the same weight
regardless of whether it signals health or pathology.

### Phosphor — Measured / Valid Signal
```
--color-phosphor-base:   oklch(0.72 0.18 155)         /* HELD verdicts, valid measurements */
--color-phosphor-dim:    oklch(0.52 0.12 155)         /* subdued phosphor */
--color-phosphor-bright: oklch(0.82 0.22 155)         /* emphasis */
--color-phosphor-glow:   oklch(0.72 0.18 155 / 0.35)  /* text-shadow value */
```

**Usage:** HELD hypothesis verdicts. Gate status `ROUTED` (cheval active).
Phosphor is "the measured signal" — the thing the instrument confirmed.

### Anomaly — Hypothesis Violation
```
--color-anomaly-base:   oklch(0.58 0.20 15)          /* FALSIFIED verdicts */
--color-anomaly-dim:    oklch(0.40 0.14 15)          /* subdued anomaly */
--color-anomaly-bright: oklch(0.68 0.24 15)          /* emphasis */
--color-anomaly-glow:   oklch(0.58 0.20 15 / 0.35)   /* text-shadow value */
```

**Usage:** FALSIFIED hypothesis verdicts. Bar fills when current_value > held_max.
Anomaly is "the ROX dye emission" — the thing the instrument flagged.

### Cyan — Structural Chrome
```
--color-cyan-base:   oklch(0.85 0.15 195)   /* panel labels, active states */
--color-cyan-dim:    oklch(0.65 0.12 195)   /* borders, dividers, bar markers */
--color-cyan-bright: oklch(0.92 0.18 195)   /* emphasis */
```

**Usage:** Panel labels (all uppercase, tracking-terminal).
Bar threshold markers. Column headers. The instrument's structural voice.

### Void — Background Silence
```
--color-void-base:    oklch(0.08 0.005 250)   /* page background */
--color-void-raised:  oklch(0.12 0.008 250)   /* panel outer shell */
--color-void-surface: oklch(0.16 0.01  250)   /* panel inner surface */
--color-void-border:  oklch(0.22 0.012 250)   /* borders, dividers */
```

---

## Panel Shell Material

Source: `world-sprawl/apps/sprawl-ui/src/lib/components/ui/DashboardCard.svelte` (F13)

```css
/* Outer gradient shell — the bezel */
background: linear-gradient(180deg,
  oklch(0.14 0.008 250) 0%,
  oklch(0.10 0.005 250) 100%
);
border: 1px solid var(--color-void-border);
border-radius: 0px;  /* No radii — die-stamped */
padding: 4px;

/* Inner surface */
background: oklch(0.11 0.005 250);
border: 1px solid oklch(0.22 0.012 250 / 0.6);
padding: 16px;
```

**No radii. No drop shadows.** Elevation is glow-based:
`box-shadow: 0 0 8px oklch(0.85 0.15 195 / 0.4)` (cyan glow).

---

## Typography

Source: `world-sprawl/apps/rektdrop/src/lib/design/taste.md` (F2)

```
--font-mono:    'IBM Plex Mono', monospace   /* terminal data — numbers, labels, all readouts */
--font-display: 'Basement Grotesque'         /* hero text only — not used in V1 observatory */
```

**Scale floor:** text-sm (0.6875rem / ~11px). Never below this.
**Data values:** tabular-nums, font-variant-numeric: tabular-nums.
**Labels:** UPPERCASE, tracking-terminal (0.10em).
**Corner telemetry:** tracking-whisper (0.25em), bone-ghost, opacity 0.5.

**IBM Plex Serif** (taste.md: "terminal data with authority, TDR-008") is the
rektdrop `--font-mono` alias for the game register. The observatory uses
**IBM Plex Mono** directly — the cleaner monospace at data density.

---

## Motion

Source: `world-sprawl/packages/sprawlos-tokens/src/tokens.css`

```
--duration-quantum: 83ms   /* the atomic unit */
--ease-snap:    steps(1)
--ease-step-4:  steps(4)   /* primary: data updates */
--ease-step-8:  steps(8)
```

**NixieCount** (F6) is the canonical cost readout component.
83ms quantum, frame-gated rAF, L→R digit settling with noise-fill.
Drop in for all micro-USD values.

**No smooth easing in the observatory.** `cubic-bezier` anywhere is a violation.
Steps are the institutional "no smooth" discipline — TDR-004.

---

## Cost Readout Pattern

Source: `world-sprawl/apps/rektdrop/src/lib/components/NixieCount.svelte` (F6)

```svelte
<NixieCount
  target={cost_in_dollars}
  duration={2000}
  format={(n) => `$${n.toFixed(6)}`}
/>
```

The component handles: frame-gating at 83ms, reduced-motion guard,
sequential digit settling L→R with random noise on unsettled digits.

---

## Hypothesis Bar Pattern

The bar track maps 0 to `bar_max_display`. Two threshold markers:
- Cyan line at `bar_held` (held threshold)
- Anomaly-dim line at `bar_falsified` (falsified threshold, if defined)

Fill color:
- Normal: `--color-phosphor-base` (measured signal)
- Over held threshold: `--color-anomaly-base` (violation signal)

The current value sits as a float label at bar-footer-right.
The verdict (HELD / FALSIFIED / PENDING) sits at bar-header-right.

**Bars are SHA-pinned** (cop-bars.json): set before data existed.
Editing the bars file = a different run. The observatory displays them
as ground truth, not recommendations.

---

## Corner Telemetry

Source: `world-sprawl/apps/rektdrop/src/lib/components/AmbientTelemetry.svelte` (F5)

Fixed position, pointer-events: none, z-index above content.
Bone-ghost, tracking-whisper, opacity 0.5.

```
Bottom-left:  EXP-001 // COST-OF-PLAY-V1 | cycle-053 // 2026-06-09 | FREESIDE.GRID // INSTRUMENT.PANEL
Bottom-right: UTC [wall-clock] | SNAPSHOT.FROZEN
```

The corner is the instrument's peripheral voice. It does not interrupt.
It is always there, showing the smallest useful context.

---

## What This Register Is Not

The freeside register is NOT:
- A loading screen (dark passages are for transitions, not data display)
- A game surface (no KANSEI modulation, no tier escalation, no ceremony)
- A decorative exercise (every element present because it carries information)

The observatory reads as a measurement instrument that happens to be
aesthetically continuous with the world being measured. The design
consistency is the proof of integrity: the instrument is built from the
same vocabulary as the subject.
