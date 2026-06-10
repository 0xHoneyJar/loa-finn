/**
 * Observatory Data — derived from canonical artifacts at build time.
 *
 * QUANTITATIVE data comes from `data.generated.json`, emitted by
 * `scripts/refresh-data.mjs` (predev/prebuild) from:
 *   tmp/cop-prod-atoms-snapshot.jsonl        — CostAtom envelopes
 *   scripts/playtest/out/driver-phase*.jsonl — driver records
 *   scripts/playtest/cop-bars.json           — sha-pinned bars
 *   scripts/playtest/out/readout.json        — cop-readout output (optional)
 *
 * VERDICT DISCIPLINE (non-negotiable): the observatory NEVER computes
 * H1/H2/H3 verdicts. Verdict panels render AWAITING READOUT until the
 * readout instrument writes its output; then they display it verbatim.
 *
 * LEARNINGS are curated (qualitative by nature) — edited by hand.
 */

import generated from './data.generated.json';

// ── Experiment metadata ──────────────────────────────────────────────

export const EXPERIMENT = {
  id: 'EXP-001',
  name: 'COST-OF-PLAY-V1',
  date: '2026-06-09',
  cycle: 'cycle-041',
  run_id: 'cost-of-play-0609b',
  data_generated_at: generated.generated_at,
} as const;

// ── Atoms snapshot (derived) ─────────────────────────────────────────

export const ATOMS = {
  total: generated.atoms.total,
  a_relay: generated.atoms.a_relay,
  b_enrich: generated.atoms.b_enrich,
  gates: generated.atoms.gates as Record<string, number>,
  malformed: generated.atoms.malformed,
  sum_inference_micro: generated.atoms.sum_inference_micro,
  sum_infra_micro: generated.atoms.sum_infra_micro,
  sum_orchestration_micro: generated.atoms.sum_orchestration_micro,
  sum_total_micro: generated.atoms.sum_total_micro,
};

// ── 3-ledger cost view per experiment ────────────────────────────────
// Lab-overhead rows are COARSE BY DOCTRINE (experiment-economics.md:
// precision goes to Finn's ledger; the operating surface is one
// calibration row, never itemized).

export const COST_LEDGER = {
  inference_harness_usd: null as null,
  inference_harness_tokens_in: 217318, // flatline harden run, model-invoke.jsonl
  inference_harness_tokens_out: 35309,
  infra_atoms_micro_usd: ATOMS.sum_total_micro,
  class_b_live_micro_usd: ATOMS.sum_inference_micro,
  railway_est_usd_max: 1.0, // reconciled at readout via usage API
  calibration_note: '~250K tokens / <$2 marginal → 1 instrument + 8 learnings',
} as const;

// ── Playtest progression (derived) ───────────────────────────────────

export type PhaseRow = {
  phase: number;
  level?: number;
  total_calls: number;
  a_relay: number;
  b_enrich: number;
  gate_routed: number;
  gate_closed: number;
  a_relay_p50_ms: number | null;
  b_p50_ms: number | null;
  b_gate_status: 'FAIL_CLOSED' | 'ROUTED' | 'N/A';
};

export const PHASES: PhaseRow[] = generated.phases as PhaseRow[];

// ── Pre-registered hypothesis bars (sha-pinned) ──────────────────────

export const BARS = {
  h1_held_max: generated.bars.h1_held_max,
  h1_falsified_min: generated.bars.h1_falsified_min,
  h2_flat_threshold: generated.bars.h2_flat_threshold,
  h2_crossover_min_r2: generated.bars.h2_crossover_min_r2,
  malformed_line_max_ratio: generated.bars.malformed_line_max_ratio,
  sha256: generated.bars.sha256 as string,
} as const;

// ── Bar results — verdicts ONLY from the readout instrument ──────────

export type VerdictLabel = 'HELD' | 'FALSIFIED' | 'INSUFFICIENT' | 'PENDING';

export type BarResult = {
  id: string;
  label: string;
  bar_held: number;
  bar_falsified: number | null;
  bar_max_display: number;
  current_value: number | null;
  verdict: VerdictLabel;
  verdict_note: string;
};

type Readout = {
  bars_sha256?: string;
  h1_cost_split?: { verdict: VerdictLabel; per_class_b_share: number | null; regime?: string };
  h2_scale_behavior?: { verdict: VerdictLabel; amortization_observed?: boolean | null };
  data?: { malformed_ratio?: number };
} | null;

const readout = generated.readout as Readout;
const AWAITING = 'AWAITING READOUT — verdicts render only from cop-readout output';

export const BAR_RESULTS: BarResult[] = [
  {
    id: 'H1',
    label: 'INFERENCE SHARE (PER-B, STEADY STATE)',
    bar_held: BARS.h1_held_max,
    bar_falsified: BARS.h1_falsified_min,
    bar_max_display: 1.0,
    current_value: readout?.h1_cost_split?.per_class_b_share ?? null,
    verdict: readout?.h1_cost_split?.verdict ?? 'PENDING',
    verdict_note: readout
      ? `regime: ${readout.h1_cost_split?.regime ?? 'unlabeled'}`
      : AWAITING,
  },
  {
    id: 'H2',
    label: 'UNIT-COST AMORTIZATION (3 LOAD LEVELS)',
    bar_held: BARS.h2_flat_threshold,
    bar_falsified: null,
    bar_max_display: 0.2,
    current_value: null,
    verdict: readout?.h2_scale_behavior?.verdict ?? 'PENDING',
    verdict_note: readout ? 'see readout levels table' : AWAITING,
  },
  {
    id: 'QDATA',
    label: 'MALFORMED ATOM LINES',
    bar_held: BARS.malformed_line_max_ratio,
    bar_falsified: null,
    bar_max_display: 0.05,
    current_value: readout?.data?.malformed_ratio ?? (ATOMS.total > 0 ? ATOMS.malformed / ATOMS.total : null),
    verdict: readout ? (((readout.data?.malformed_ratio ?? 0) > BARS.malformed_line_max_ratio) ? 'INSUFFICIENT' : 'HELD') : 'PENDING',
    verdict_note: readout ? `${ATOMS.malformed} / ${ATOMS.total} snapshot lines` : AWAITING,
  },
];


// ── Recent atom events (ticker feed) ────────────────────────────────

export type AtomEvent = {
  id: string;
  ts: number;
  call_class: string;
  gate: string;
  total_micro: number;
  wall_ms: number;
};

export const RECENT_ATOMS: AtomEvent[] = (generated as any).recent_atoms ?? [];

// ── Durable learnings (curated) ──────────────────────────────────────

export type Learning = {
  id: string;
  headline: string;
  source: string;
};

export const LEARNINGS: Learning[] = [
  {
    id: 'L1',
    headline: 'TypeBox FormatRegistry starts empty — Value.Check() silently passes invalid UUIDs without format registration. Defense-in-depth: side-effect import + runtime guard + test setupFiles.',
    source: 'cycle-033 · T-3.9',
  },
  {
    id: 'L2',
    headline: 'Routing vocabulary: 6 TaskTypes → 5 RoutingKeys. Summarization maps to analysis (same execution characteristics). No default branch in inner fn → compile error if union grows.',
    source: 'cycle-033 · T-3.9',
  },
  {
    id: 'L3',
    headline: 'KnownFoo Exhaustive Pattern: closed inner function (no default) + known Set for O(1) guard + open wrapper with fallback. Generalizes to any open TypeScript union that may grow upstream.',
    source: 'cycle-033 · T-4.4',
  },
  {
    id: 'L4',
    headline: 'Score-truth-agent reframe: first SKU = forensic integrity scoring (deterministic, no LLM). Real WTP = institutional provenance subscriptions (~$40M ARR comps). Demand-discovery first.',
    source: 'cycle-041 · 2026-06-08',
  },
  {
    id: 'L5',
    headline: 'DEFAULT_PRICING opus token rate 3× stale — latent billing bug found outside experiment scope. Pricing values require versioning; staleness is a silent budget error.',
    source: 'cycle-041 · 2026-06-10',
  },
  {
    id: 'L6',
    headline: 'Railway vCPU price 2× the assumption ($0.000463/min verified vs $0.000231 assumed). Infra cost rows must cite the pricing docs/usage API, never capacity folklore.',
    source: 'cycle-041 · 2026-06-10',
  },
  {
    id: 'L7',
    headline: 'H3 datum: cheval spawn overhead ≈ 128ms over provider latency (first measurement). Spawn is not the dominant latency — inference at ~4s P50 defines the Class-B profile.',
    source: 'cycle-041 · 2026-06-10',
  },
  {
    id: 'L8',
    headline: 'H1 signal: Class-B busy-time ≈ 95% inference at the cheapest tier when routed. Idle-cost treatment (unallocated_infra) is the load-bearing question for the verdict.',
    source: 'cycle-041 · 2026-06-10',
  },
];
