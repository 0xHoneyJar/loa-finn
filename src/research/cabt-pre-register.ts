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
// Pre-outcome timestamp for the 2026-06-21 session (the coliseum farm loop → gumi-v8-pilot farm). No ladder result yet.
const T_NOW_0621 = Date.parse("2026-06-21T18:00:00Z")
// Pre-outcome timestamp for the 2026-06-22 session (the gygax diagnostic deck-variant LADDER SWEEP). No ladder result yet.
const T_NOW_0622 = Date.parse("2026-06-22T18:00:00Z")
// Pre-outcome timestamp for the 2026-06-25 session (the TWO BIG SWINGS: pilot-on-the-patched-deck + the Alakazam
// counter-meta). No ladder result yet — both logged before any eval/pre-screen, p fixed from prior grounding only.
const T_NOW_0625 = Date.parse("2026-06-25T18:00:00Z")

/** Committed anchor of the registry head (over PRE_REGISTERED). `--write` checks the
 *  freshly-built head against this: editing a `p` (or any field) in PRE_REGISTERED
 *  changes the head, fails the rebuild, and forces a deliberate, reviewable
 *  `--force` + anchor bump — so a forecast cannot be silently revised after the
 *  fact, even if the on-disk registry is deleted first. Bump ONLY in the same commit
 *  that intentionally changes the registered set. */
const EXPECTED_REGISTRY_HEAD = "66f3d835d0f0425defd5c4129364337ff2a574e62e21a4d7fc934f4a6653835d"

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
  preregister({
    // NEW (2026-06-19, pilot-first). GAMES-006: the DECK is not the lever (2 deck bets falsified); v4's
    // bot-friendly 35-energy starter (719) wins because it's SIMPLE — the crude type-only heuristic can't
    // misplay it. The PILOT is the binding constraint. heuristic_v5 (the 6-term structural scorer: ko /
    // development / energy / pivot / attack-quality / tempo — it SEES the board where v4 is type-blind) is
    // now the SHIPPED default on v4's UNCHANGED deck — a clean ONE-VARIABLE ladder bet (pilot, same deck).
    // p=0.40: the board-awareness thesis has real merit (v4 is blind), BUT we are 0-for-2 + miscalibrated-high,
    // the bot-friendly lesson warns added pilot complexity may HURT a deck that rewards simplicity, and
    // self-play can't validate (anti-signal). Distinct from the narrower energy-target forecast (ONE feature;
    // this is the whole scorer) — that one is left unresolved, not conflated.
    decision_id: "heuristic-v5-pilot-on-v4-deck",
    label: "ship heuristic_v5 (6-term structural scorer) as the default pilot on v4's bot-friendly deck",
    action: "ship",
    proposition:
      "heuristic_v5 (the board-aware structural scorer) piloting v4's deck beats the v4 type-only heuristic baseline (~719 ladder) by a margin the games can resolve",
    prediction_ppm: 400_000,
    predicted_effect: "small", // a pilot refinement on a working deck; may land insufficient (below ladder resolution)
    local_evidence:
      "v5 SEES the board (6 weighted terms) vs v4's type-only blindness; does-it-run verified (legal moves on v4's deck, container). But 0-for-2 on cabt bets; bot-friendly lesson warns complexity may hurt the simple deck; self-play is anti-signal",
    created_ts: T_NOW_0619,
  }),
  preregister({
    // NEW (2026-06-19, GAMES-012 — the ghost arena × spike consilience). The imitation LEARNABILITY spike
    // said Lucario's PILOT is learnable, but Echelon v0 (254 real top-tier matches settled to Elo + a
    // matchup matrix) revealed Lucario is META-FOOD (0.38 wr, 0.19 vs Dwebble). The two axes are ORTHOGONAL:
    // Dwebble/Crustle is the KING deck (304 share; beats Lucario 0.81, Dragapult 0.78) AND the spike shows
    // v4's crude type-priors ALREADY match Dwebble/Crustle experts 0.57 top-1 (held-out, 8-seed CV) — pilot
    // already adequate. So the lever is the DECK, not a learned pilot. The list is CONVERGED (36 top winners
    // ran the byte-identical 60) and bot-friendly-leaning (31E/8P/21T) — unlike the trainer-heavy rebuild that
    // collapsed. p=0.45: the best-grounded deck bet yet (meta-king + converged + pilot-agreement evidence on
    // BOTH sides of the deck-vs-pilot tension), BUT deck swaps are 0-for-2 (mono 205, rebuild 225), the
    // Cook/Lillie's/Waitress engine still risks bot-fumble, and 0-for-4 overall demands humility.
    decision_id: "deck-dwebble-crustle-with-v4-pilot",
    label: "swap to the converged top-tier Dwebble/Crustle deck, piloted by the v4 type-only heuristic",
    action: "ship",
    proposition:
      "the converged Dwebble/Crustle deck piloted by the v4 type-only heuristic beats the v4 baseline (~719 ladder) by a margin the games can resolve",
    prediction_ppm: 450_000,
    predicted_effect: "large", // decks are the field's biggest lever; this is the DOMINANT meta deck
    local_evidence:
      "Echelon v0 (254 real top-tier matches): Dwebble/Crustle dominates (304 share, 0.81 vs Lucario, 0.78 vs Dragapult); the top list is CONVERGED (36 byte-identical winner copies); imitation spike: v4-class priors match Dwebble/Crustle experts 0.57 top-1 (held-out, 8-seed CV) = pilot already adequate; deck is bot-friendly-leaning (31E/8P/21T)",
    created_ts: T_NOW_0619,
  }),
  preregister({
    // NEW (2026-06-21, the coliseum FARM LOOP). The farm BUSTED the deck hypothesis (gumi's crustle deck ≈ ours
    // with v4: soju-crustle-v4 1182 < soju-dash 1252) AND exposed the coliseum as unseeded/noisy at low N — the
    // v6-on-Dwebble "1277 top" was a fluke (re-ran to 876, ≈ v4). The robust N=40 (~800-match) re-measure: gumi's
    // edge is the v8 PILOT (threat-aware + expert-sequencing), not the deck — v8-on-OUR-Dwebble (1136) beats our
    // v4 (1104) by ~32 Elo and TIES gumi's full crustle agent (1144). p=0.52: a better-engineered, ladder-proven
    // pilot (gumi's, teammate-farmed) on our best deck — but the ~32 Elo coliseum edge is NEAR THE NOISE FLOOR
    // (not decisive) and we are measurably over-confident on our own interventions (mean Brier 0.262 < base-rate 0.16).
    decision_id: "farm-gumi-v8-pilot-on-dwebble",
    label: "submit gumi's v8 threat-aware pilot on our Dwebble/Crustle deck (teammate-farmed)",
    action: "ship",
    proposition:
      "gumi's v8 threat-aware pilot on our Dwebble/Crustle deck beats the v4-Dwebble baseline (~787 ladder) by a margin the games can resolve",
    prediction_ppm: 520_000,
    predicted_effect: "small", // a better pilot on the same deck; the ~32 Elo coliseum edge is near the noise floor
    local_evidence:
      "coliseum N=40 (~800 matches; unseeded engine so high-N tames the per-match variance): v8-on-Dwebble Elo 1136 vs v4-Dwebble 1104 (~32 Elo, near noise) ≈ gumi's full crustle agent 1144; deck farm busted (our deck ≈ gumi's, soju-crustle-v4 1182 < soju-dash 1252); the v6-Dwebble 1277 was a low-N fluke (re-ran 876, ≈ v4)",
    created_ts: T_NOW_0621,
  }),
  preregister({
    // NEW (2026-06-22, the gygax DIAGNOSTIC deck-variant LADDER SWEEP). The deck is the lever (pilot flat); the
    // v4-Dwebble base eroded 807→754.9 (a hidden counter). gygax (cap-aware legal pool) designed do-no-harm variants
    // probing DISTINCT counter-mechanisms; 3 submitted as a sweep (the PATTERN of which clears the contemporaneous
    // v4-base localizes the eroder). cage = the named-Alakazam (0.80, ~16%) answer = gygax's highest-confidence read.
    decision_id: "deck-cage-vs-bench-spread",
    label: "crustle+Battle Cage — block bench damage-counters (the Alakazam bench-spread counter)",
    action: "ship",
    proposition:
      "crustle+Battle Cage (v4 pilot) beats the contemporaneous v4-Dwebble base (~754.9) on the ladder by a margin the games can resolve",
    prediction_ppm: 450_000,
    predicted_effect: "small", // within-noise of the base locally (coliseum lacks the counter) — a ladder-only test
    local_evidence:
      "gygax's highest-confidence read: Alakazam is the ONE empirically-named hard counter (0.80 vs Dwebble/Crustle, ~16% field) and bench-spread is its classic mechanism; Battle Cage [1264] prevents damage counters on benched Pokemon from attacks+abilities. Pre-screen N=30 v7: within-noise of the v4-PB (do-no-harm OK). DOUBT: protects bench only, not active-ability-damage (the unpatchable hole) — if Alakazam wins THAT way, dead.",
    created_ts: T_NOW_0622,
  }),
  preregister({
    // 2026-06-22 sweep #2 — active-damage-reduction (the bulk redirect; Hero's Cape cap-1, no {G} +HP tool legal).
    decision_id: "deck-charm-vs-ability-grind",
    label: "crustle+Sacred Charm — -30 from ability-attackers (active HP-race)",
    action: "ship",
    proposition:
      "crustle+Sacred Charm (v4 pilot) beats the contemporaneous v4-Dwebble base (~754.9) on the ladder by a margin the games can resolve",
    prediction_ppm: 400_000,
    predicted_effect: "small",
    local_evidence:
      "Sacred Charm [1177]: -30 from attacks by ability-having Pokemon (most strong non-ex grinders carry abilities) = recurring effective-HP on the active Crustle (the ex-only wall doesn't protect vs non-ex). Pre-screen N=30 v7: within-noise of the v4-PB (do-no-harm OK). DOUBT: dead vs ability-less attackers; a flat result is ambiguous — read jointly with cage.",
    created_ts: T_NOW_0622,
  }),
  preregister({
    // 2026-06-22 sweep #3 — status (the ex-wall is null vs poison/burn, placed between turns not 'by an attack').
    decision_id: "deck-cleanse-vs-status",
    label: "crustle+Switch+Lumiose Galette — clear special conditions (status counter)",
    action: "ship",
    proposition:
      "crustle+Switch+Lumiose Galette (v4 pilot) beats the contemporaneous v4-Dwebble base (~754.9) on the ladder by a margin the games can resolve",
    prediction_ppm: 380_000,
    predicted_effect: "small",
    local_evidence:
      "Switch [1123] (retreat clears conditions) + Lumiose Galette [1153] (heal 20 + remove a Special Condition) answer the one damage type the ex-wall can't stop (status, placed between turns). Paid from over-floored Basic {G} (the do-no-harm fix of the regressed pivotcleanse). Pre-screen N=30 v7: within-noise of the v4-PB. DOUBT: gygax's weakest read; the heal is only 20 (value is the status-clear); flat if no status in the meta.",
    created_ts: T_NOW_0622,
  }),
  preregister({
    // 2026-06-22 cycle-2 sweep — the NEXT-COUNTER explore (status answered by cleanse 986.1; now localize the
    // RESIDUAL loss). helmet = the resource-EXHAUSTION hypothesis, mutually-exclusive with pivot's burst. Built off
    // v4-base (not cleanse), so the bar is "beat the base DESPITE not fixing the known status counter" → humble p.
    decision_id: "deck-helmet-vs-exhaustion",
    label: "crustle+Lucky Helmet — draw 2 when active is damaged (card-economy vs resource-exhaustion)",
    action: "ship",
    proposition:
      "crustle+Lucky Helmet (v4 pilot) beats the contemporaneous v4-Dwebble base (~754.9) on the ladder by a margin the games can resolve",
    prediction_ppm: 420_000,
    predicted_effect: "small",
    local_evidence:
      "Lucky Helmet [1156]: when the Active is damaged by an attack, draw 2 (even if KO'd) = refuels the heal engine without a supporter, fires exactly vs the non-ex attackers that beat us. POOL FINDING: no universal {G} damage-reduction tool is legal → the heal-race is winnable only by card-supply (this) or recursion (recur, tried). Paid from over-floored Basic {G} (do-no-harm: draw+heal engines + Hero's Cape intact; energy 28>=27). Pre-screen N=30: coliseum #1 (0.74, robust over fg) but that's the band-pass/internal-field proxy (C2), NOT a ladder predictor. DOUBT: competes with Hero's Cape for the active tool slot; doesn't fix status, so a flat result is confounded; mutually-exclusive with pivot (only one should move if the loss mode is real).",
    created_ts: T_NOW_0622,
  }),
  preregister({
    // 2026-06-22 cycle-2 sweep — the NEXT-COUNTER explore, single-wall-BURST hypothesis (mutually-exclusive with
    // helmet's exhaustion). Air Balloon cheap-retreat rotates fresh 150HP walls; incidental status help (cheap
    // retreat clears conditions by rotation). WEAKEST pre-screen (0.48, within-noise at/below base) → lowest p.
    decision_id: "deck-pivot-vs-burst",
    label: "crustle+Air Balloon — retreat 3->1 to rotate fresh walls (tempo vs single-wall-burst)",
    action: "ship",
    proposition:
      "crustle+Air Balloon (v4 pilot) beats the contemporaneous v4-Dwebble base (~754.9) on the ladder by a margin the games can resolve",
    prediction_ppm: 300_000,
    predicted_effect: "small",
    local_evidence:
      "Air Balloon [1174]: Retreat Cost -{C}{C} → Crustle retreats 3->1 to rotate a fresh 150HP wall (manifold wall vs single-wall-burst); incidental status mitigation (cheap retreat clears conditions by rotation). Paid from over-floored Basic {G} (do-no-harm; energy 28>=27). Pre-screen N=30: WEAKEST variant (0.48, within-noise at/below the v4-base; lost h2h to base 0.40) → the local signal mildly dings it. DOUBT: depends on a manifold wall the slow setup may never field; competes with Hero's Cape for the tool slot; if BOTH helmet+pivot stay flat while cleanse banks status, the residual loss is un-teachable from our pool → the lever moves off the deck.",
    created_ts: T_NOW_0622,
  }),
  preregister({
    // NEW (2026-06-25, BIG SWING 1 — "Mirror Apex": the EV-dominant lever that ALSO un-flatlines our pilot). gygax's
    // #1 read + the EV math: the 65% Crustle MIRROR (50-50 over 494 games) dominates the 9% Alakazam hole — mirror
    // +5pt = +3.3% overall WR vs a full Alakazam solve's +2.7% at a fraction of the risk (touches only the mirror,
    // keeps the 91% we already win). The lever: +2 Boss's Orders [1182] (cut 15->13 Basic {G}). In the wall mirror,
    // gusting a benched Dwebble (70HP) lets Crustle (120) KO it BEFORE it evolves = setup-denial + prize tempo — AND
    // it is the ONE config where v7 stops being flat (it hands v7's dead Boss-target-best-KO feature a card to act
    // on). Co-designed deck+pilot. p=0.40 (POISONED-WELL discounted): this is gygax's CONFIDENT top pick, and his
    // confident picks have been anti-correlated (cage p=0.45 FALSIFIED, energy-term FALSIFIED-worst; his WEAKEST
    // read, cleanse, won biggest). The 50-50 mirror may mean the disruption washes; cutting 2 energy risks
    // consistency. Middling by design — the product is the calibration curve, not gygax's enthusiasm.
    decision_id: "cleanse-boss-orders-v7-mirror",
    label: "cleanse + 2 Boss's Orders + v7 — gust-before-evolve in the EV-dominant 65% mirror (activates v7)",
    action: "ship",
    proposition:
      "the cleanse deck + 2 Boss's Orders [1182] (cut 15->13 Basic {G}) piloted by our v7 threat-aware pilot beats the reigning cleanse PB (cleanse-deck + v4, ~956 contemporaneous / 986 peak) on the ladder by a margin the games can resolve",
    prediction_ppm: 400_000,
    predicted_effect: "small", // mirror +5pt ≈ +3.3% WR — real but small on the converged top deck (council §5.2)
    local_evidence:
      "EV: 65% mirror @ 50-50 (494 games) is the dominant matchup; Boss's Orders gusts a benched Dwebble (70HP) for a pre-evolution Crustle KO (120) = setup-denial + tempo, AND activates v7's Boss-target-best-KO (dead without a Boss card — cleanse runs zero, build_cleanse/deck.csv:1-60). Boss [1182] is engine-legal (deck_alakazam.csv runs x3). POISONED-WELL: gygax's CONFIDENT picks lose (cage/energy-term falsified); 50-50 mirror may wash the disruption; -2 energy risks consistency. Middling by design.",
    created_ts: T_NOW_0625,
  }),
  preregister({
    // NEW (2026-06-25, BIG SWING 2 — "Powerful Hand": the bold STRUCTURAL break — become the apex predator, made
    // BOT-PILOTABLE by encoding the win-con into a NEW pilot). FIELD: Alakazam = field-best 60.3% WR, beats our
    // 65%-share Crustle 80.3% (66 games) — the one robust hole no tech slot fixed (cage falsified -155). Council
    // 2026-06-22: "imitating the converged meta is a Red Queen treadmill; the move is COUNTER-META search" — this is
    // that move. RAW Alakazam is a TRAP (gygax p~0.15, mono/rebuild family): Powerful Hand does 20x hand-size, so
    // the optimal line is HOARD-then-swing, but v4/v7 do the OPPOSITE (play hand out, attack last). THE BUILD: a new
    // hand-size-aware v8 pilot — suppress draw/search/develop when Alakazam is Active + can attack + hand >= N, and
    // swing Powerful Hand on a full hand; Rare Candy -> Alakazam Stage-2 priority. The v8 rule fixes THE KILLER but
    // NOT the secondary hostility (Stage-2 line timing, Battle Cage zero-tempo, 7-energy curve). p=0.20: a huge-
    // upside, max-info, creative long shot — if it lands it BREAKS the Crustle ceiling (+200-class); if it fails it
    // fails large (deck is fundamentally bot-hostile, 20P/7E/33T). KILL-GATE (don't submit if pre-screen shows):
    // mean hand-size when Alakazam attacks <=4, OR Stage-2-online <60% / median evolve-turn >5, OR coliseum WR vs the
    // Crustle wall <45% (the field Alakazam wins 80% — if ours can't clear 50% the pilot threw the intrinsic edge).
    decision_id: "deck-alakazam-v8-powerful-hand",
    label: "become the predator — Alakazam deck + a new hand-size-aware v8 pilot (hoard for Powerful Hand)",
    action: "ship",
    proposition:
      "the converged top-tier Alakazam deck (deck_alakazam.csv) piloted by a NEW hand-size-aware v8 pilot (hoard-for-Powerful-Hand + Stage-2 priority) beats the reigning cleanse PB (~956 contemporaneous / 986 peak) on the ladder by a margin the games can resolve",
    prediction_ppm: 200_000,
    predicted_effect: "large", // a whole-deck structural break — lands big (+200, breaks the ceiling) or fails large
    local_evidence:
      "FIELD (754 real matches): Alakazam = field-best 60.3% WR, beats our Crustle 80.3% (66 games). Council 2026-06-22: counter-meta search is THE move (imitating the converged meta is a Red Queen treadmill). RISK (gygax): raw deck p~0.15 — Powerful Hand (20x hand-size, deck_alakazam.csv:24-26) is anti-correlated with the pilot's hand-dumping; mono(205)/rebuild(225) collapse family; 20P/7E/33T bot-hostile. The new v8 hand-size rule fixes THE KILLER, not the Stage-2/Cage/energy secondaries. KILL-GATE pre-screen before submit.",
    created_ts: T_NOW_0625,
  }),
  preregister({
    // NEW (2026-06-25, the MIRROR diversity-pair partner to Swing 1 — gygax's #2, the cleaner mirror lever). After
    // the Swing-1 pre-screen mildly DINGED Boss+v7 (point-estimate below the v4 control vs the wall — consistent with
    // gygax's "v7 hand-dumping is mildly counterproductive in the wall mirror" warning, though within-noise at N=8
    // SYNTHETIC), gygax's #2 is the lower-misplay-risk mirror lever: +2 Enhanced Hammer[1081] (cut 15->13 Basic {G}),
    // v4 pilot (no v7 hand-dumping liability). Asymmetric: the 65%-mirror runs 12 special energies; we run the hate,
    // they don't — strip their Crustle's fuel. gygax flagged this as TWO separate middling-confidence probes (Boss vs
    // Hammer) to let the ladder resolve which mirror mechanism is load-bearing. p=0.40, same poisoned-well discount:
    // the 50-50 mirror may mean the special energies WASH (stripping slows BOTH equally) — gygax's own caveat on his
    // own confident read. The operator picks ONE mirror swing (Boss+v7 OR Hammer+v4) + the Alakazam structural swing.
    decision_id: "cleanse-enhanced-hammer-v4-mirror",
    label: "cleanse + 2 Enhanced Hammer + v4 — strip the mirror's 12 special energies (gygax #2, low-misplay)",
    action: "ship",
    proposition:
      "the cleanse deck + 2 Enhanced Hammer [1081] (cut 15->13 Basic {G}) on the v4 type-only pilot beats the reigning cleanse PB (cleanse-deck + v4, ~956 contemporaneous / 986 peak) on the ladder by a margin the games can resolve",
    prediction_ppm: 400_000,
    predicted_effect: "small", // a single asymmetric tech vs the 65% mirror — real but small on the converged deck
    local_evidence:
      "gygax #2 (lowest misplay risk): the 65% Crustle mirror runs 12 special energies (deck_dwebble_crustle.csv:20-31); Enhanced Hammer [1081] (constructible — Alakazam runs x2, deck_alakazam.csv:31-32) is a simple item that strips their Crustle's fuel, no pilot dependence (v4, no v7 hand-dumping liability). The diversity-pair partner to Boss+v7 (orthogonal mechanism: resource-denial vs gust-tempo). POISONED-WELL: gygax flagged his own mirror-tech thesis as a confident expert pick; the 50-50 mirror may mean the special energies WASH. Middling by design.",
    created_ts: T_NOW_0625,
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
