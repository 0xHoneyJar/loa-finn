// src/research/cabt-calibration-seed.ts — the first REAL loa-finn calibration
// ledger: the cabt session's own decision trace, formalized + Brier-scored.
//
// This is the dogfood the src/research probe + cost-atom + spine-ledger infra was
// built for, pointed reflexively at loa-finn itself (Phase 2). The cabt session
// (findings: grimoires/loa/context/2026-06-18-cabt-research-findings.md) produced a
// uniquely clean dataset: ~8 build decisions, each with a PREDICTION-AT-THE-TIME
// (a local-eval verdict or a framing call) AND, for some, a GROUND-TRUTH OUTCOME
// (the Kaggle ladder score that arrived later). "Grade the record, not the
// outcome" — applied to ourselves.
//
// Run:  npx tsx src/research/cabt-calibration-seed.ts            # print report
//       npx tsx src/research/cabt-calibration-seed.ts --write    # + write ledger
//
// DETERMINISTIC: stable decision_ids, fixed historical timestamps (Date.parse of
// fixed ISO strings — pure, never now()), no randomness. The ledger therefore
// re-hashes IDENTICALLY on every re-run — a small proof-of-integrity in itself.
//
// HONESTY BOUNDARY (the dominant caveat): every prediction here is RECONSTRUCTED
// post-hoc from the trace, not logged live before the outcome. Post-hoc
// probability assignment is hindsight-bias-prone — the exact bias pre-registration
// exists to defeat. So this first pass is a METHOD DEMO + a baseline, NOT a
// calibrated track record. The forward fix: log p BEFORE the ladder speaks, via
// the forecast-registry pre-registration guard (forecast-registry.ts). The
// register → resolve split below (build the prediction, THEN apply the resolution)
// models that two-step even though both happen in one backfill run.

import { rename, rm } from "node:fs/promises"
import {
  calibrationReport,
  resolveDecision,
  DecisionLedgerWriter,
  readCalibrationLedger,
  verifyCalibrationLedger,
  CALIBRATION_LEDGER_PATH,
  type DecisionResolution,
} from "./calibration.js"
import type { DecisionForecast } from "./schemas/decision-forecast.js"

// Fixed historical timestamps (pure: Date.parse of fixed strings, not now()).
const T_ARCH = Date.parse("2026-06-17T18:00:00Z") // architecture / framing
const T_BUILD = Date.parse("2026-06-18T02:00:00Z") // build + eval gating
const T_LADDER = Date.parse("2026-06-18T14:00:00Z") // the ladder spoke (resolution)

/** A decision = an unresolved prediction + its later resolution. The two halves
 *  are kept separate to model register → resolve (the prediction is fixed before
 *  the outcome is applied). */
interface Decision {
  forecast: DecisionForecast
  resolution: DecisionResolution
}

/** Helper to build an unresolved DecisionForecast (resolution fields null). */
function predict(p: Omit<DecisionForecast, "resolution_instrument" | "ground_truth" | "outcome" | "brier_ppm" | "resolved_ts">): DecisionForecast {
  return {
    ...p,
    resolution_instrument: null,
    ground_truth: null,
    outcome: null,
    brier_ppm: null,
    resolved_ts: null,
  }
}

// ---------------------------------------------------------------------------
// The 8-decision seed ledger — §8 of the findings doc, formalized. Each prediction
// probability is reconstructed from the trace with its rationale stated inline;
// where a local-eval winrate exists it anchors the number, otherwise the framing
// confidence is reconstructed and flagged.
// ---------------------------------------------------------------------------

const DECISIONS: Decision[] = [
  {
    // The agent LEANED worktree ("cleaner"); the operator reversed it to in-repo.
    // We score the AGENT's prediction — and it was wrong. Framing is the agent's
    // blind spot; the operator out-forecast it here.
    forecast: predict({
      decision_id: "build-in-repo-not-worktree",
      label: "build cabt in-repo, not in a git worktree",
      action: "reframe",
      proposition: "building in-repo (not a worktree) is the right call for cabt",
      prediction_ppm: 300_000, // agent preferred worktree ("cleaner") → low P(in-repo)
      prediction_basis: "reconstructed",
      effect_size: "framing",
      local_evidence: null,
      created_ts: T_ARCH,
    }),
    resolution: {
      // Resolved by an OBJECTIVE structural fact (the corpus-engine infra cabt needs
      // exists in-repo and was absent on main), NOT by the operator's opinion — the
      // operator REFRAMED the call, but what settled it is the verifiable infra
      // reality. So the instrument is structural-reasoning, not operator-framing.
      resolution_instrument: "structural-reasoning",
      ground_truth:
        "in-repo was right — cabt needs corpus-engine infra that exists in-repo and was absent on main (a verifiable structural fact); the worktree was over-engineering. The operator reframed the call; the infra reality settled it.",
      outcome: "held",
      resolved_ts: T_BUILD,
    },
  },
  {
    forecast: predict({
      decision_id: "ship-pimc-floor",
      label: "ship the determinized PIMC floor as the baseline agent",
      action: "ship",
      proposition: "a determinized PIMC engine over the real cg.api is a valid, live baseline",
      prediction_ppm: 900_000, // never-crash + legal picks → high confidence it's a valid floor
      prediction_basis: "reconstructed",
      effect_size: "large",
      local_evidence: "never-crash contract + legal fallback; ~585 self-play",
      created_ts: T_BUILD,
    }),
    resolution: {
      resolution_instrument: "ladder-measured",
      ground_truth: "live on the ladder, v2 = 585.7 — below μ₀=600 but a valid, legal, never-crash baseline.",
      outcome: "held",
      resolved_ts: T_LADDER,
    },
  },
  {
    forecast: predict({
      decision_id: "reject-card-aware-augury",
      label: "reject the card-aware (HP/KO-threat) value function",
      action: "reject",
      // Proposition is about the LOCAL GATE's call (resolved by the proxy), NOT a
      // ladder claim — this candidate never reached the ladder (review HIGH).
      proposition: "the local eval correctly rejects card-aware augury (it does not improve self-play)",
      prediction_ppm: 850_000, // 0.40 local margin below prize_only → strong reject
      prediction_basis: "reconstructed",
      effect_size: "large",
      local_evidence: "0.30 vs prize_only 0.70 vs greedy",
      created_ts: T_BUILD,
    }),
    resolution: {
      resolution_instrument: "local-eval-proxy",
      ground_truth: "killed locally with a 0.40 margin (a large effect); never reached the ladder.",
      outcome: "held",
      resolved_ts: T_BUILD,
    },
  },
  {
    // THE flagged decision. Shipped n16 on a local "win"; the ladder said n4>n16,
    // but §5b proved n4≈n16 is BELOW the resolution of any feasible-N self-play
    // eval — i.e. the difference was unresolvable. Outcome = insufficient → NOT
    // Brier-scored (abstain over force). The finding is the over-confidence: a
    // 0.65 call on a difference no instrument here could resolve.
    forecast: predict({
      decision_id: "ship-n-worlds-16",
      label: "ship n_worlds=16 (more determinizations) over n_worlds=4",
      action: "ship",
      // The proposition PRE-STATES the resolvability bar (a margin the available
      // games can distinguish), so `insufficient` is the criterion-honest verdict
      // — not a post-hoc reclassification of a falsified call (review BLOCKER #1).
      proposition: "n_worlds=16 beats n_worlds=4 on the ladder by a margin the available games can resolve",
      prediction_ppm: 650_000, // local A/B 0.65 vs greedy
      prediction_basis: "reconstructed",
      effect_size: "small",
      local_evidence: "0.65 vs 0.30 vs greedy (N≈30)",
      created_ts: T_BUILD,
    }),
    resolution: {
      resolution_instrument: "ladder-measured",
      ground_truth:
        "ladder v3 = 539.4 < v2(n4) = 585.7 — BUT §5b proved n4≈n16 is below the resolution of any feasible-N (N≈30) self-play eval; the apparent miss is noise on both ends. The difference was UNRESOLVABLE, not resolved-against.",
      outcome: "insufficient",
      resolved_ts: T_LADDER,
    },
  },
  {
    forecast: predict({
      decision_id: "reject-meta-aggro-decks",
      label: "reject the Mega Lucario ex + mono-Fighting aggro decks",
      action: "reject",
      // A claim about the local result + the structural deck⊗engine reading, NOT a
      // ladder verdict (the decks were rejected before any submission).
      proposition: "the stronger decks do not beat the sample deck in self-play for our weak pilot (correctly rejected)",
      prediction_ppm: 800_000, // both lost locally (0.40 / 0.33) — strong reject
      prediction_basis: "reconstructed",
      effect_size: "large",
      local_evidence: "0.40 (Lucario) / 0.33 (mono-F) vs sample deck",
      created_ts: T_BUILD,
    }),
    resolution: {
      resolution_instrument: "structural-reasoning",
      ground_truth:
        "both stronger decks LOST to the sample deck locally → the deck⊗engine insight: a setup deck needs a strong pilot, and ours was the bottleneck. Untested on the ladder (rejected before submission), so the resolution is structural, not ladder-measured.",
      outcome: "held",
      resolved_ts: T_BUILD,
    },
  },
  {
    forecast: predict({
      decision_id: "reject-funsearch-v1-blind",
      label: "reject the blind-authored FunSearch heuristic v1",
      action: "reject",
      // The local gate's call (resolved by the proxy), not a ladder claim.
      proposition: "the local eval correctly rejects the blind-authored heuristic v1 (it loses in self-play)",
      prediction_ppm: 900_000, // 0.17 vs greedy — clearly broken; the gate caught the blind author
      prediction_basis: "reconstructed",
      effect_size: "large",
      local_evidence: "0.17 vs greedy",
      created_ts: T_BUILD,
    }),
    resolution: {
      resolution_instrument: "local-eval-proxy",
      ground_truth:
        "killed; v1 was authored blind from an enum list and attacked before developing. Re-authored as v2 AFTER grounding on the real obs — the FunSearch loop's diagnose step.",
      outcome: "held",
      resolved_ts: T_BUILD,
    },
  },
  {
    // The keystone POSITIVE: the loop's biggest call (heuristic beats search), made
    // on a LARGE local effect (0.77), and it TRANSFERRED to the real ladder.
    forecast: predict({
      decision_id: "ship-funsearch-v2-heuristic",
      label: "ship the grounded FunSearch v2 heuristic as the default agent",
      action: "ship",
      proposition: "the grounded develop-first heuristic beats our PIMC search engine on the real ladder",
      prediction_ppm: 770_000, // local 0.77 vs PIMC
      prediction_basis: "reconstructed",
      effect_size: "large",
      local_evidence: "0.77 vs our PIMC engine",
      created_ts: T_BUILD,
    }),
    resolution: {
      resolution_instrument: "ladder-measured",
      ground_truth:
        "ladder v4 climbed to 648.1 — above μ₀=600 and clearly > v2(585.7)/v3(539.4). The only agent above baseline. The large local effect TRANSFERRED (confirming the §5b rule: large effects are real and resolve on the ladder).",
      outcome: "held",
      resolved_ts: T_LADDER,
    },
  },
  {
    // The worst Brier — and the most instructive. An IMPORTED belief (the field's
    // "deck is the biggest lever", 423→893), assumed transferable, NOT re-grounded
    // to our own context first. It LOST for our weak pilot. The grounding sin at
    // the belief level — the same failure mode as FunSearch v1's blind author.
    forecast: predict({
      decision_id: "deck-is-the-lever-imported",
      label: "import the field's belief that 'deck is the biggest lever'",
      action: "reframe",
      proposition: "the field's 'deck is the biggest lever' (423→893) transfers to our agent",
      prediction_ppm: 700_000, // high prior from the competitor-landscape dig
      prediction_basis: "reconstructed",
      effect_size: "framing",
      local_evidence: "field dig: deck swing 423→893; assumed transferable",
      created_ts: T_ARCH,
    }),
    resolution: {
      resolution_instrument: "structural-reasoning",
      ground_truth:
        "FALSIFIED for our pilot — both stronger decks lost to the sample deck (decision reject-meta-aggro-decks). The deck lever does NOT transfer to a weak pilot; the PILOT was the bottleneck. An imported belief, not re-grounded to our context.",
      outcome: "falsified",
      resolved_ts: T_BUILD,
    },
  },
]

/** Build the resolved ledger (pure — no I/O). */
export function buildCabtCalibrationLedger(): DecisionForecast[] {
  return DECISIONS.map((d) => resolveDecision(d.forecast, d.resolution))
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write")
  const resolved = buildCabtCalibrationLedger()
  const report = calibrationReport(resolved)

  if (write) {
    // SNAPSHOT, not an accumulating log: this seed is the canonical 8-record
    // ledger. Writing must be idempotent — re-running --write must NOT append a
    // second copy onto the committed file (a DecisionLedgerWriter would happily
    // continue the existing chain → 16 lines, still chain-valid, doubled counts).
    // So build a FRESH ledger in a temp file, then atomically replace the target.
    const tmp = `${CALIBRATION_LEDGER_PATH}.building`
    await rm(tmp, { force: true })
    const writer = new DecisionLedgerWriter(tmp)
    for (const f of resolved) await writer.append(f)
    await rename(tmp, CALIBRATION_LEDGER_PATH) // atomic replace — idempotent re-run
    const { envelopes } = await readCalibrationLedger(CALIBRATION_LEDGER_PATH)
    const v = verifyCalibrationLedger(envelopes, { expectedLength: resolved.length })
    console.log(`\n✓ wrote ${resolved.length} decisions → ${CALIBRATION_LEDGER_PATH} (snapshot, atomic replace)`)
    console.log(`  ledger: valid=${v.valid} length=${v.length} semantically_valid=${v.semantically_valid} head=${envelopes.at(-1)?.entry_hash.slice(0, 12)}…`)
  }

  // The report — grounded numbers for the CALIBRATION.md ledger. Lead with the
  // honesty gate: this is a retrospective demo, not a calibration track record.
  console.log("\n=== loa-finn cabt calibration report ===")
  console.log(`evidence_class : ${report.evidence_class}  (headline_eligible=${report.headline_eligible})`)
  console.log(`scored basis   : logged=${report.scored_prediction_basis.logged} reconstructed=${report.scored_prediction_basis.reconstructed}`)
  console.log(`OBJECTIVE (ladder-measured, the only calibration evidence): scored=${report.objective.n_scored} insufficient=${report.objective.n_insufficient} meanBrier=${report.objective.mean_brier_ppm}`)
  console.log(`REFLECTION (proxy/structural/framing, NOT evidence)       : scored=${report.reflection.n_scored} meanBrier=${report.reflection.mean_brier_ppm}`)
  console.log(`blended (illustrative only)                              : ${report.blended_mean_brier_ppm}`)
  console.log("\nfull report:")
  console.log(JSON.stringify(report, null, 2))

  // A compact per-decision Brier table.
  console.log("\n=== per-decision ===")
  for (const f of resolved) {
    const brier = f.brier_ppm === null ? "— (unscored: insufficient)" : `${f.brier_ppm} ppm`
    console.log(
      `${f.decision_id.padEnd(30)} ${f.action.padEnd(7)} ${f.effect_size.padEnd(8)} p=${f.prediction_ppm} → ${f.outcome}  Brier=${brier}`,
    )
  }
}

// Run as a script (tsx), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
