// src/research/schemas/decision-forecast.ts — the REFLEXIVE calibration record:
// one of loa-finn's OWN decisions, turned into a falsifiable, ground-truth-scored
// forecast (Phase 2 — "study our own decision-making").
//
// loa-finn is an appraiser: it grades whether work is REAL, not whether a story
// about it is GOOD. The cabt competition (Kaggle Pokémon-TCG AI Battle) was run
// as a zero-cost, perfect-0/1-settle positive control for that thesis — and it
// produced a uniquely clean dataset: a long decision trace where, for some
// decisions, GROUND TRUTH (the real Kaggle ladder score) actually arrived later.
// This schema formalizes that trace so the calibration engine can grade the
// agent's OWN predictions against what later proved true.
//
// It mirrors the `src/research` ledger idiom EXACTLY (see indexing-experiment-row.ts
// + research-cost-atom.ts):
//   · probabilities + scores are integer parts-per-million (0..1e6) — no stored
//     floats (the same discipline the CostAtom integer-micro rule enforces).
//   · each record is wrapped in a hash-chained, append-only envelope (prev_hash +
//     entry_hash); a MIDDLE delete, a reorder, or any in-place tamper-without-rehash
//     is DETECTABLE on replay (calibration.ts verifies). NOT detectable without an
//     external anchor: TAIL truncation (dropping the last k whole lines leaves a
//     valid shorter chain) and a full rewrite with recomputed hashes — pass
//     `{ expectedHead, expectedLength }` to verifyCalibrationChain to catch those.
//   · validation is an `assert*` MECHANISM, not a sentence.
//
// IT IS A SIBLING TO TetlockForecast, NOT A REPLACEMENT. TetlockForecast scores a
// claimed on-chain realness probe (discovery / survival horizons). A DecisionForecast
// scores a BUILD DECISION against the real target. The shared core — a
// pre-registered probability, a deterministic resolution, a Brier score — is the
// same calibration discipline; the surrounding fields differ because the events
// differ (a settle is not a ship).

// ---------------------------------------------------------------------------
// Discriminants
// ---------------------------------------------------------------------------

/** What the agent DID at the decision. Distinguishes the kinds of bet:
 *  - `ship`   — committed a change to the live agent (a submission / default).
 *  - `reject` — killed a candidate change (the eval gate's "no").
 *  - `reframe`— a framing / scope / imported-belief call, NOT eval-gated. */
export type DecisionAction = "ship" | "reject" | "reframe"

/** The effect-size class — THE axis the cabt calibration rule (findings §5b) turns
 *  on. It is the property of the DIFFERENCE being judged, not of the decision:
 *  - `large`   — a coarse difference a low-N self-play eval CAN resolve, and which
 *                DOES transfer to the real ladder (heuristic-beats-PIMC, 0.77).
 *  - `small`   — a fine difference BELOW low-N resolution (the noise band); needs
 *                ladder-scale N (SPRT) or the ladder itself to settle (n4 vs n16).
 *  - `framing` — not an eval-measurable difference at all: a reframe, an imported
 *                belief, a scope call. The eval cannot produce OR resolve these. */
export type EffectSize = "large" | "small" | "framing"

/** Which instrument produced the ground-truth resolution. Trust ordering — a
 *  calibration verdict is only as trustworthy as its WEAKEST backing (the
 *  Ken-Thompson invariant the indexing ledger also encodes: a verdict inherits
 *  the weakest cost_source it rests on):
 *  - `ladder-measured`     — the REAL target spoke (a Kaggle public score). The
 *                            only instrument that resolves the actual question.
 *  - `local-eval-proxy`    — self-play winrate only. A proxy, NOT the target — it
 *                            resolves large effects but not small ones (§5b).
 *  - `structural-reasoning`— a deductive settle (deck⊗engine), not a measurement.
 *  - `operator-framing`    — a human reframe / judgment call. Lowest trust as an
 *                            *instrument* (it is not deterministic), highest
 *                            LEVERAGE in this dataset — the two are orthogonal. */
export type ResolutionInstrument =
  | "ladder-measured"
  | "local-eval-proxy"
  | "structural-reasoning"
  | "operator-framing"

export const RESOLUTION_TRUST: Record<ResolutionInstrument, number> = {
  "ladder-measured": 4,
  "local-eval-proxy": 2,
  "structural-reasoning": 2,
  "operator-framing": 1,
}

/** The instruments that resolve the REAL-target question ("is this right for the
 *  actual ladder?") with an objective measurement — the ONLY decisions that can be
 *  Brier-scored as calibration EVIDENCE. Everything else resolves a different,
 *  weaker proposition: `local-eval-proxy` settles "did the local gate classify
 *  this?" (the candidate never reached the target), `structural-reasoning` settles
 *  a deductive claim, `operator-framing` is a human judgment (not an objective
 *  settle at all). The calibration report scores those in a separate REFLECTION
 *  tier, never the headline — mixing subjective/proxy settlements with measured
 *  ones would dilute the ground truth (3-model review consensus, 2026-06-17). */
export const OBJECTIVE_INSTRUMENTS: readonly ResolutionInstrument[] = ["ladder-measured"]

/** The resolution outcome — it judges the PROPOSITION, not whether the agent was
 *  right (Brier scores the gap between them, so they must stay independent):
 *  - `held`        — the PROPOSITION resolved TRUE (binary 1), regardless of how
 *                    confident the prediction was. A low-confidence prediction
 *                    (p < 0.5) on a TRUE proposition is `held` AND a high Brier — a
 *                    miss — which is correct: the agent under-bet a truth.
 *  - `falsified`   — the PROPOSITION resolved FALSE (binary 0).
 *  - `insufficient`— the instrument COULD NOT resolve the proposition (within the
 *                    noise band). Recorded but NOT Brier-scored — abstain over
 *                    force, exactly the realness-verdict.ts INSUFFICIENT discipline.
 *                    Scoring an unresolvable difference as a miss is itself a
 *                    miscalibrated appraisal.
 *  WARNING: resolve against the proposition's truth, NEVER against "was the agent
 *  right" — confusing the two inverts the Brier score for any p < 0.5 (e.g. seed
 *  row build-in-repo: p=0.30, proposition TRUE → `held`, Brier 0.49). */
export type DecisionOutcome = "held" | "falsified" | "insufficient"

/** Was the probability LOGGED before the outcome was known, or RECONSTRUCTED
 *  post-hoc from the trace? Reconstructed predictions are hindsight-bias-prone —
 *  the honest caveat that bounds the whole first-pass ledger. The forward fix is
 *  to log `p` BEFORE the ladder speaks (the forecast-registry pre-registration
 *  guard); a reconstructed ledger is a method demo, not a calibrated track record. */
export type PredictionBasis = "logged" | "reconstructed"

export const DECISION_ACTIONS: readonly DecisionAction[] = ["ship", "reject", "reframe"]
export const EFFECT_SIZES: readonly EffectSize[] = ["large", "small", "framing"]
export const RESOLUTION_INSTRUMENTS: readonly ResolutionInstrument[] = [
  "ladder-measured",
  "local-eval-proxy",
  "structural-reasoning",
  "operator-framing",
]
export const DECISION_OUTCOMES: readonly DecisionOutcome[] = ["held", "falsified", "insufficient"]
export const PREDICTION_BASES: readonly PredictionBasis[] = ["logged", "reconstructed"]

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** A reflexive calibration record — one decision, its prediction-at-the-time, and
 *  (once known) its ground-truth resolution + Brier score. Resolution fields are
 *  null until a settle resolves the decision (the register → resolve two-step is
 *  the anti-hindsight discipline: the prediction is fixed BEFORE the outcome). */
export interface DecisionForecast {
  /** Stable kebab-case slug — reproducible (NOT a ulid), so the ledger re-hashes
   *  identically on re-run. */
  decision_id: string
  /** Human-readable decision label. */
  label: string
  action: DecisionAction
  /** The bet phrased as a falsifiable proposition resolved against the REAL
   *  target (not the local proxy) — e.g. "n_worlds=16 beats n_worlds=4 on the
   *  ladder", "the field's 'deck is the lever' transfers to our pilot". */
  proposition: string
  /** Prediction-at-the-time that `proposition` holds, integer ppm (0..1e6). */
  prediction_ppm: number
  prediction_basis: PredictionBasis
  effect_size: EffectSize
  /** The local-eval evidence the agent HAD at decision time (e.g. "0.65 vs greedy"),
   *  or null for a non-eval-gated framing call. Grounds `prediction_ppm`. */
  local_evidence: string | null
  // ---- resolution (null until resolved) ----
  resolution_instrument: ResolutionInstrument | null
  /** The deterministic ground truth, verbatim (e.g. "ladder 539.4 < n4 585.7;
   *  §5b proved within-noise"). Null until resolved. */
  ground_truth: string | null
  outcome: DecisionOutcome | null
  /** Brier score of `prediction_ppm` vs the binary outcome, integer ppm
   *  (0 = perfect, 1e6 = worst). NULL when the outcome is `insufficient`
   *  (unscored — abstain over force) or unresolved. */
  brier_ppm: number | null
  /** Unix epoch ms — the decision's HISTORICAL timestamp (backfilled), not now(). */
  created_ts: number
  /** Settlement timestamp; null until resolved. */
  resolved_ts: number | null
  /** Provenance binding: when this resolved record came from a PRE-REGISTERED
   *  forecast, the `entry_hash` of its registry envelope. It cryptographically
   *  proves the scored prediction equals the originally-LOGGED prediction — even if
   *  the registry is later rewritten (the rewrite changes the registry's hashes, so
   *  this committed binding no longer matches → the substitution is detectable).
   *  Null for the reconstructed rows and for registry entries themselves. */
  registered_entry_hash?: string | null
}

/** Hash-chained WAL envelope (one per JSONL line). Identical shape + formula to
 *  IndexingRowEnvelope / ResearchAtomEnvelope: `entry_hash` = sha256 of canonical
 *  `{ schema_version, prev_hash, forecast }`, `prev_hash` links to the prior
 *  envelope's `entry_hash` (GENESIS_HASH for the first). */
export interface DecisionForecastEnvelope {
  schema_version: 1
  prev_hash: string
  forecast: Record<string, unknown>
  entry_hash: string
}

// ---------------------------------------------------------------------------
// Pure helpers — Brier math + validation
// ---------------------------------------------------------------------------

/** Brier score (binary) as integer ppm, computed in the integer-ppm domain so no
 *  float ever reaches the ledger (the repo-wide no-float discipline). For a
 *  prediction `p` (ppm) and a binary outcome `o` ∈ {0,1}:
 *      Brier = (p − o)²  →  round((p_ppm − o·1e6)² / 1e6)
 *  Perfect (p matches o) = 0; worst (p maximally wrong) = 1e6; a p=0.5 guess on
 *  either outcome = 250000. `(1e6)²` = 1e12 < 2^53, so the product is exact. */
export function brierPpm(prediction_ppm: number, outcome01: 0 | 1): number {
  if (!Number.isInteger(prediction_ppm) || prediction_ppm < 0 || prediction_ppm > 1_000_000) {
    throw new Error(`brierPpm: prediction_ppm must be an integer in [0, 1_000_000], got ${prediction_ppm}`)
  }
  if (outcome01 !== 0 && outcome01 !== 1) {
    throw new Error(`brierPpm: outcome01 must be 0 or 1, got ${outcome01}`)
  }
  const diff = prediction_ppm - outcome01 * 1_000_000
  return Math.round((diff * diff) / 1_000_000)
}

/** The MECHANICAL effect-size rule (addresses the review's M5: effect_size must be
 *  a function of the EVIDENCE, not a narrator's post-hoc choice). Classifies by the
 *  self-play margin |winrate − 0.5| in ppm:
 *   · `large`  — margin ≥ 0.20 (winrate ≤ 0.30 or ≥ 0.70): a coarse difference a
 *                low-N eval CAN resolve, and which §5b found DOES transfer.
 *   · `small`  — margin < 0.20: below the resolution a low-N eval can be trusted on
 *                (conservative — anything not clearly large is treated as small/noisy).
 *   · `framing`— no measurable margin (marginPpm null): a reframe / imported belief
 *                / scope call the eval cannot produce or resolve.
 *  Applied at RESOLUTION time on the OBSERVED margin — so the regime label is data,
 *  not story. A pre-registered forecast may carry a PREDICTED effect_size as part of
 *  the bet; the resolver replaces it with this measured classification.
 *  CAVEAT (not oversold): the 0.20 THRESHOLD is itself a chosen parameter — M5 is
 *  addressed at "given a margin, the label is mechanical," but where to cut large/small
 *  still encodes a judgment. It is documented, not magic. */
export function classifyEffectFromMargin(marginPpm: number | null): EffectSize {
  if (marginPpm === null) return "framing"
  if (!Number.isInteger(marginPpm) || marginPpm < 0) {
    throw new Error(`classifyEffectFromMargin: marginPpm must be a non-negative integer (ppm) or null, got ${marginPpm}`)
  }
  // A margin is |winrate − 0.5|, so it cannot exceed 0.5 (500_000 ppm). A larger
  // value means a raw winrate (e.g. 800_000) was passed instead of a margin —
  // catch that confusion rather than silently classifying it "large".
  if (marginPpm > 500_000) {
    throw new Error(`classifyEffectFromMargin: marginPpm ${marginPpm} > 500_000 — a margin is |winrate−0.5| ≤ 0.5; did you pass a raw winrate?`)
  }
  return marginPpm >= 200_000 ? "large" : "small"
}

/** Map a resolved outcome to its binary value for Brier scoring, or null when the
 *  outcome carries no scoreable truth (`insufficient` — abstain over force). */
export function outcomeToBinary(outcome: DecisionOutcome): 0 | 1 | null {
  switch (outcome) {
    case "held":
      return 1
    case "falsified":
      return 0
    case "insufficient":
      return null
  }
}

/** Throws if a DecisionForecast is malformed — the write-time gate (a typo'd enum,
 *  a float/out-of-range probability, or an INCONSISTENT resolution survives
 *  neither the chain nor synthesis). Enforced invariants:
 *   · prediction_ppm is an integer in [0, 1e6].
 *   · all enum fields hold known values.
 *   · resolution is all-or-nothing: instrument, ground_truth, outcome, resolved_ts
 *     are either ALL set (resolved) or ALL null (unresolved).
 *   · brier_ppm is set IFF the outcome is held/falsified, and NULL when the
 *     outcome is insufficient or the record is unresolved. When set it must equal
 *     brierPpm(prediction_ppm, outcomeToBinary(outcome)). */
export function assertDecisionValid(f: DecisionForecast): void {
  if (!f.decision_id || typeof f.decision_id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.decision_id)) {
    throw new Error(`decision-forecast: decision_id must be a non-empty kebab-case string, got ${JSON.stringify(f.decision_id)}`)
  }
  for (const [name, v] of [["label", f.label], ["proposition", f.proposition]] as const) {
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`decision-forecast(${f.decision_id}): ${name} must be a non-empty string`)
    }
  }
  // Finite-integer timestamp guard — a Date.parse() that returned NaN (a typo'd
  // ISO string) would otherwise serialize to null and corrupt the ledger.
  if (!Number.isInteger(f.created_ts)) {
    throw new Error(`decision-forecast(${f.decision_id}): created_ts must be a finite integer (got ${f.created_ts})`)
  }
  if (!Number.isInteger(f.prediction_ppm) || f.prediction_ppm < 0 || f.prediction_ppm > 1_000_000) {
    throw new Error(`decision-forecast(${f.decision_id}): prediction_ppm must be an integer in [0, 1_000_000]`)
  }
  if (f.registered_entry_hash != null && !/^[0-9a-f]{64}$/.test(f.registered_entry_hash)) {
    throw new Error(`decision-forecast(${f.decision_id}): registered_entry_hash must be a sha256 hex string or null/absent`)
  }
  if (!DECISION_ACTIONS.includes(f.action)) {
    throw new Error(`decision-forecast(${f.decision_id}): unknown action "${f.action}"`)
  }
  if (!EFFECT_SIZES.includes(f.effect_size)) {
    throw new Error(`decision-forecast(${f.decision_id}): unknown effect_size "${f.effect_size}"`)
  }
  if (!PREDICTION_BASES.includes(f.prediction_basis)) {
    throw new Error(`decision-forecast(${f.decision_id}): unknown prediction_basis "${f.prediction_basis}"`)
  }

  // Loose `!= null` so `undefined` (a missing key from a foreign/hand-edited
  // producer) counts as UNSET, not "set" — otherwise a record with `outcome`
  // present but `resolved_ts` omitted would pass the partial-resolution guard.
  const resolvedFields = [f.resolution_instrument, f.ground_truth, f.outcome, f.resolved_ts]
  const anyResolved = resolvedFields.some((v) => v != null)
  const allResolved = resolvedFields.every((v) => v != null)
  if (anyResolved && !allResolved) {
    throw new Error(
      `decision-forecast(${f.decision_id}): partial resolution — instrument/ground_truth/outcome/resolved_ts must be all-set or all-null`,
    )
  }

  if (!allResolved) {
    // Unresolved: brier must be null.
    if (f.brier_ppm !== null) {
      throw new Error(`decision-forecast(${f.decision_id}): brier_ppm must be null while unresolved`)
    }
    return
  }

  // Resolved: validate the resolution enums + the Brier invariant.
  if (!Number.isInteger(f.resolved_ts)) {
    throw new Error(`decision-forecast(${f.decision_id}): resolved_ts must be a finite integer when resolved (got ${f.resolved_ts})`)
  }
  if ((f.resolved_ts as number) < f.created_ts) {
    throw new Error(`decision-forecast(${f.decision_id}): resolved_ts (${f.resolved_ts}) precedes created_ts (${f.created_ts}) — a bet cannot resolve before it is made`)
  }
  if (typeof f.ground_truth !== "string" || f.ground_truth.trim() === "") {
    throw new Error(`decision-forecast(${f.decision_id}): ground_truth must be a non-empty string when resolved`)
  }
  if (!RESOLUTION_INSTRUMENTS.includes(f.resolution_instrument as ResolutionInstrument)) {
    throw new Error(`decision-forecast(${f.decision_id}): unknown resolution_instrument "${f.resolution_instrument}"`)
  }
  if (!DECISION_OUTCOMES.includes(f.outcome as DecisionOutcome)) {
    throw new Error(`decision-forecast(${f.decision_id}): unknown outcome "${f.outcome}"`)
  }
  const binary = outcomeToBinary(f.outcome as DecisionOutcome)
  if (binary === null) {
    // insufficient → unscored.
    if (f.brier_ppm !== null) {
      throw new Error(
        `decision-forecast(${f.decision_id}): outcome "insufficient" must NOT be Brier-scored (brier_ppm must be null — abstain over force)`,
      )
    }
  } else {
    const expected = brierPpm(f.prediction_ppm, binary)
    if (f.brier_ppm !== expected) {
      throw new Error(
        `decision-forecast(${f.decision_id}): brier_ppm ${f.brier_ppm} ≠ expected ${expected} for prediction ${f.prediction_ppm} / outcome ${f.outcome}`,
      )
    }
  }
}
