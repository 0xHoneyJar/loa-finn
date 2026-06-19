// src/research/cabt-pre-register.ts — the FORWARD FIX, made real: pre-register a
// few GENUINE cabt decisions as LOGGED forecasts (p fixed BEFORE the outcome).
//
// The retrospective ledger (cabt-calibration-seed.ts) could only RECONSTRUCT
// predictions post-hoc — which the 3-model review correctly barred from being
// calibration evidence (`evidence_class: retrospective-demo`). The only genuine
// out-of-sample evidence there was n=2. This file fattens the OBJECTIVE pipeline
// the honest way: real, open cabt decisions (no ladder result exists yet),
// forecast BLIND (p logged here, before any eval or submission), with a
// ladder-resolvable criterion. They resolve LATER — when a submission's ladder
// score settles — via resolveRegisteredDecision, which appends the scored record
// to cabt-calibration.jsonl. So this grows the objective PIPELINE now; the objective
// SCORED count grows when the ladder speaks.
//
// DISCIPLINE: p is assigned PRE-OUTCOME and pre-eval — deliberately WITHOUT running
// the local self-play eval first. Peeking at the margin before logging p would
// contaminate the "logged before outcome" guarantee (the whole point). The local
// eval is a downstream coarse pre-filter; the ladder is the resolver. (These are
// honest pre-outcome priors, NOT "blind" in the experimental sense — they draw on
// deep prior cabt work; pre-registration does not require ignorance of the domain,
// only that the outcome is unknown when p is fixed.)
//
// Run:  npx tsx src/research/cabt-pre-register.ts            # print the registry
//       npx tsx src/research/cabt-pre-register.ts --write    # + (re)write it (idempotent)
//
// The decisions are grounded in the real agent (src/cabt/heuristic.py — the live
// default, v4 ladder = 648.1, flat-priority develop-first pilot; the PIMC engine in
// policy.py is benched) and the README's open "what's next" items.

import { rename, rm } from "node:fs/promises"
import {
  registerDecision,
  readDecisionRegistry,
  DecisionLedgerWriter,
  verifyCalibrationLedger,
  readCalibrationLedger,
  CABT_FORECAST_REGISTRY_PATH,
} from "./calibration.js"
import type { DecisionForecast } from "./schemas/decision-forecast.js"

// Fixed timestamp (pure: Date.parse of a fixed string, never now()) — these bets
// are logged "now" (this session, 2026-06-17), before any of their outcomes exist.
// (created_ts is author-chosen and "pre-outcome" is a discipline asserted in code,
// not mechanically enforced — both reduce to git-commit timing + author honesty.
// That git precedence IS the trust root; this constant + the chain are the witnesses.)
const T_NOW = Date.parse("2026-06-17T22:00:00Z")
// A second pre-outcome timestamp for forecasts logged in the 2026-06-18 session (the
// real-cabt deck probe, METABOLISM-003). Still pre-outcome — no ladder result exists yet.
const T_NOW_0618 = Date.parse("2026-06-18T23:00:00Z")
// Pre-outcome timestamp for the 2026-06-19 session (the real-games deck diagnosis + gygax rebuild).
const T_NOW_0619 = Date.parse("2026-06-19T18:00:00Z")

/** Committed anchor of the registry head (over PRE_REGISTERED). `--write` checks the
 *  freshly-built head against this: editing a `p` (or any field) in PRE_REGISTERED
 *  changes the head, fails the rebuild, and forces a deliberate, reviewable
 *  `--force` + anchor bump — so a forecast cannot be silently revised after the
 *  fact, even if the on-disk registry is deleted first. Bump ONLY in the same commit
 *  that intentionally changes the registered set. */
const EXPECTED_REGISTRY_HEAD = "e8e21269508ffcc526c83e73f7558605675c9dc499e2d30de67956efc77471a5"

/** Build a LOGGED, unresolved pre-registration. `effect_size` here is the PREDICTED
 *  effect (part of the bet); resolveRegisteredDecision replaces it with the measured
 *  classification from the observed margin at resolution. */
function preregister(p: {
  decision_id: string
  label: string
  action: DecisionForecast["action"]
  proposition: string
  prediction_ppm: number
  predicted_effect: DecisionForecast["effect_size"]
  local_evidence: string | null
  created_ts?: number
}): DecisionForecast {
  return {
    decision_id: p.decision_id,
    label: p.label,
    action: p.action,
    proposition: p.proposition,
    prediction_ppm: p.prediction_ppm,
    prediction_basis: "logged", // the whole point — logged before the outcome
    effect_size: p.predicted_effect,
    local_evidence: p.local_evidence,
    resolution_instrument: null,
    ground_truth: null,
    outcome: null,
    brier_ppm: null,
    created_ts: p.created_ts ?? T_NOW,
    resolved_ts: null,
  }
}

// ---------------------------------------------------------------------------
// The genuine, open, ladder-resolvable decisions. p is an HONEST blind forecast —
// no eval was run first. The rationale for each p is stated; the bet is falsifiable.
// ---------------------------------------------------------------------------

export const PRE_REGISTERED: DecisionForecast[] = [
  preregister({
    // The deck⊗engine retest. Last session a stronger deck LOST with the weak PIMC
    // pilot, and the insight was "a strong deck needs a strong pilot." We now have a
    // competent pilot (heuristic v4=648). Does the deck lever finally transfer? The
    // heuristic is develop-first but FLAT (no card-specific sequencing), so it may
    // still under-pilot a setup-heavy meta deck. Genuinely uncertain → p ≈ 0.45.
    decision_id: "deck-lucario-with-heuristic-pilot",
    label: "swap the sample deck for Mega Lucario ex, piloted by the heuristic",
    action: "ship",
    proposition:
      "the Mega Lucario ex deck piloted by the heuristic beats the heuristic+sample-deck baseline (648.1) on the ladder, by a margin the games can resolve",
    prediction_ppm: 450_000,
    predicted_effect: "large", // decks are the field's biggest lever (423→893)
    local_evidence: "prior: the meta deck LOST to sample with the weak PIMC pilot; pilot now stronger but flat",
  }),
  preregister({
    // A refinement of an already-decent flat heuristic: attach energy toward the
    // attacker closest to its attack threshold (vs the current flat ATTACH=50).
    // Refinements of a working pilot are usually SMALL effects, and §5b says small
    // effects often do not resolve on the ladder. p = 0.40 is P(CLEAR ladder win) —
    // I actually expect it most likely lands `insufficient` (below ladder resolution),
    // which is itself the §5b prediction; 0.40 is the residual chance it's a clear win.
    decision_id: "heuristic-v5-energy-target-attach",
    label: "heuristic v5: attach energy toward the attacker nearest its attack cost",
    action: "ship",
    proposition:
      "heuristic v5 (energy-target attachment) beats heuristic v4 (648.1) on the ladder, by a margin the games can resolve",
    prediction_ppm: 400_000,
    predicted_effect: "small", // a refinement of a working pilot — likely below ladder resolution
    local_evidence: "v4 = flat priorities {ATTACH:50,EVOLVE:48,…}; v5 adds energy-target shaping",
  }),
  preregister({
    // Deeper ISMCTS (tree + rollouts) over the same search_begin/search_step, vs the
    // heuristic. The competitor-landscape dig AND this session both found search
    // UNDERPERFORMS hand-tuned heuristics here. I bet AGAINST it → p ≈ 0.25.
    decision_id: "deeper-ismcts-vs-heuristic",
    label: "build a deeper ISMCTS (tree + rollouts) and pit it against the heuristic",
    action: "ship",
    proposition:
      "a deeper ISMCTS (tree + rollouts) beats the heuristic v4 (648.1) on the ladder, by a margin the games can resolve",
    prediction_ppm: 250_000,
    predicted_effect: "large", // if search won it'd be a clear swing; I predict it loses
    local_evidence: "dig + session: rule-based heuristics > search/RL/neural here; the pilot, not search depth, wins",
  }),
  preregister({
    // NEW (2026-06-18, METABOLISM-003 — real-cabt deck probe in a linux container). The
    // SAMPLE deck is a FLAT instrument (heuristic ≈ greedy, 0.46) while monofighting REWARDS
    // policy (heuristic 0.76 vs greedy) AND beats the sample deck 0.60 deck-on-deck (greedy
    // both sides). Our submission currently SHIPS the flat sample deck — so this swap is
    // strictly better LOCALLY on both deck-strength AND policy-expression (stronger evidence
    // than the lucario bet above, which LOSES deck-on-deck 0.39). p ≈ 0.62: likelier than not
    // to help, but self-play-vs-greedy is a proxy and the field may counter monofighting
    // (overfit risk — the honest residual the ladder will resolve).
    decision_id: "deck-monofighting-with-heuristic-pilot",
    label: "swap the sample deck for monofighting, piloted by the heuristic",
    action: "ship",
    proposition:
      "the monofighting deck piloted by the heuristic beats the heuristic+sample-deck baseline (648.1) on the ladder, by a margin the games can resolve",
    prediction_ppm: 620_000,
    predicted_effect: "large", // decks are the field's biggest lever; local margins are large
    local_evidence:
      "real-cabt N=60-300: monofighting>sample 0.60 [0.51,0.68] deck-on-deck (greedy both); heuristic 0.76 [0.67,0.83] vs greedy on monofighting vs FLAT 0.46 on sample",
    created_ts: T_NOW_0618,
  }),
  preregister({
    // NEW (2026-06-19, GAMES-003 — real-game diagnosis + gygax rebuild via /compose). 52 real ladder games
    // showed the live v4 deck is the competition's 35-energy STARTER deck that can't build a board (bench 0.8
    // in losses) → fast aggro (Lucario, 40% of the field) KOs our lone Pokemon. gygax rebuilt it to 13E/34T/13P
    // with a grafted draw/search engine; the container test CONFIRMED the board fix (avg max bench 1.0→3.5).
    // p=0.55: a principled, LOW-DOWNSIDE consistency fix of our BEST deck (same attackers) — but self-play
    // CANNOT validate the ladder impact (old deck = 0.588 self-play / 0.33 ladder). Deliberately humble after
    // the monofighting overconfidence (p=0.62 → falsified, Brier 0.384).
    decision_id: "deck-abomasnow-rebuild-consistent",
    label: "rebuild Abomasnow: cut energy 35->13 + graft a draw/search engine, piloted by the heuristic",
    action: "ship",
    proposition:
      "the rebuilt consistent Mega Abomasnow ex deck (13 energy / 34 trainer / 13 Pokemon) piloted by the heuristic beats the v4 starter-deck baseline (~712 ladder) by a margin the games can resolve",
    prediction_ppm: 550_000,
    predicted_effect: "small", // a consistency fix of a working deck; humble — may even land insufficient on the ladder
    local_evidence:
      "container (heuristic held constant, vs the real extracted Lucario decklist): board fix CONFIRMED (avg max bench 1.0->3.5); self-play win-rate indistinguishable (0.525 vs 0.588) but BLIND to the real field (old = 0.588 self-play / 0.33 ladder)",
    created_ts: T_NOW_0619,
  }),
]

async function main(): Promise<void> {
  const write = process.argv.includes("--write")

  if (write) {
    const force = process.argv.includes("--force")
    // Build a fresh registry in a UNIQUE temp file (pid-scoped, so two --write runs
    // don't collide on a fixed path), then anchor-check before publishing. Because
    // the build is deterministic, an unchanged seed re-hashes to EXPECTED_REGISTRY_HEAD.
    // A head that differs from the committed anchor means PRE_REGISTERED was edited —
    // a forecast revision, which must be a deliberate, reviewable --force + anchor bump,
    // NOT a silent fixture edit (a published pre-registration is evidence).
    const tmp = `${CABT_FORECAST_REGISTRY_PATH}.building.${process.pid}`
    await rm(tmp, { force: true })
    for (const f of PRE_REGISTERED) await registerDecision(f, tmp)
    const freshHead = (await readCalibrationLedger(tmp)).envelopes.at(-1)?.entry_hash
    const existingHead = (await readCalibrationLedger(CABT_FORECAST_REGISTRY_PATH)).envelopes.at(-1)?.entry_hash

    if (freshHead !== EXPECTED_REGISTRY_HEAD && !force) {
      await rm(tmp, { force: true })
      throw new Error(
        `seed head ${freshHead?.slice(0, 12)}… ≠ committed anchor ${EXPECTED_REGISTRY_HEAD.slice(0, 12)}…: PRE_REGISTERED was edited. ` +
          `A registered forecast is evidence, not a mutable fixture — re-run with --force AND bump EXPECTED_REGISTRY_HEAD in the same commit.`,
      )
    }
    if (existingHead === freshHead) {
      await rm(tmp, { force: true }) // identical — idempotent no-op
      console.log(`\n✓ registry already current (idempotent no-op) → ${CABT_FORECAST_REGISTRY_PATH}`)
    } else {
      await rename(tmp, CABT_FORECAST_REGISTRY_PATH)
      console.log(`\n${force ? "⚠ --force: (RE)WROTE" : "✓ pre-registered"} ${PRE_REGISTERED.length} forecasts → ${CABT_FORECAST_REGISTRY_PATH}`)
    }
    const { envelopes } = await readCalibrationLedger(CABT_FORECAST_REGISTRY_PATH)
    const v = verifyCalibrationLedger(envelopes, { expectedHead: EXPECTED_REGISTRY_HEAD, expectedLength: PRE_REGISTERED.length })
    console.log(`  ledger: valid=${v.valid} length=${v.length} head=${envelopes.at(-1)?.entry_hash.slice(0, 12)}…`)
  }

  const registry = write ? await readDecisionRegistry(CABT_FORECAST_REGISTRY_PATH) : PRE_REGISTERED
  console.log("\n=== cabt pre-registered forecasts (LOGGED, awaiting ladder) ===")
  for (const f of registry) {
    console.log(
      `${f.decision_id.padEnd(34)} p=${(f.prediction_ppm / 1e6).toFixed(2)}  predicted-effect=${f.effect_size.padEnd(7)}  [${f.prediction_basis}, unresolved]`,
    )
    console.log(`    ${f.proposition}`)
  }
  console.log(
    `\nThese resolve when the ladder speaks: resolveRegisteredDecision(id, {instrument:"ladder-measured", …}, observedMarginPpm)`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
