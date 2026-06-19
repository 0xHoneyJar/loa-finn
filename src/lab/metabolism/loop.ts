// src/lab/metabolism/loop.ts — the LOOP + the judges (SEGMENT C — completes bd-ryza).
//
// runMetabolism() wires every organ from Segments A+B into the proven PSRO double-
// oracle loop (a faithful TypeScript port of psro_min.py:152-201). Each iteration:
//
//   (a) Hand        → build the matchup matrix over the population (winrate_ppm/cell),
//                     each cell custody-stamped by the Custodian as a MatchReceipt.
//   (b) Cartographer→ center to payoff (winrate_ppm/1e6 − 0.5) and solveZeroSum →
//                     mixture + game_value.
//   (c) Loyal Traitor→ exploitability(pop, mixture, hand, threshold) — the active
//                     anti-fox; reads the EXTERNAL Hand, not a self-score.
//   (d) Oracle      → bestResponse(pop, mixture, hand) forges a counter. If it beats
//                     the mix by margin AND is novel, the Archivist appends it to the
//                     population ledger.
//   (e) Custodian   → the matrix cells are already stamped (a); the iteration SUMMARY
//                     (mixture as ppm, game_value/exploitability as micro) is recorded
//                     integer-domain in the RunRecord history (verify.ts re-derives it).
//   (f) Adjudicator → records the trend (game_value, exploitability) + a brierPpm hook
//                     wired — "is the needle moving?".
//   (g) Leader      → the stopping rule: REST when exploitability < threshold &&
//                     !blocks_convergence && iter > 1 (psro_min.py:196-198).
//
// ANTI-FOX (enforced by SHAPE, not assertion):
//   · The Leader reads exploitability from the Loyal Traitor and the trend from the
//     Adjudicator — SEPARATE organs. The Oracle that GENERATES the population never
//     pronounces convergence.
//   · The Adjudicator scores ONLY custody-stamped matches (the matrix cells written
//     to the metabolism ledger), never an in-memory float the loop happened to hold.
//   · SETTLE is deterministic: the seed fixes the initial strategy; ToyHand + the
//     grid Oracle are deterministic ⇒ same seed ⇒ same run. There is NO LLM and NO
//     Math.random anywhere in the loop or verify path.
//
// INTEGER-DOMAIN: the solver works in floats internally (Segment B contract), but
// EVERYTHING that touches a ledger or the RunRecord history is integer — winrate is
// ppm, mixture is ppm (largest-remainder reconciled to sum 1_000_000), game_value /
// exploitability are signed/non-negative MICRO. No float is ever serialized.
//
// DETERMINISM BOUNDARY (read before diffing ledger bytes across runs): "same seed ⇒
// same run" applies to the COMPUTED run — RunRecord.history and final_population_milli
// are bit-identical for a fixed seed (they carry no wall-clock). The LEDGER FILES are
// intentionally NOT byte-reproducible: every receipt embeds `ts: Date.now()` (wall
// clock), which is canonicalized into the entry_hash, so the chain heads of two
// same-seed runs differ. This is by design — the ledger is a CUSTODY trail (when a
// measurement was stamped is part of custody), not a deterministic artifact. A caller
// that needs reproducible ledger bytes should thread a fixed clock through the Hand's
// receipt-stamping; the verify path (verify.ts) re-derives every win-rate and never
// compares timestamps, so a ledger's non-reproducibility does NOT weaken verification.

import { solveZeroSum } from "./cartographer.js"
import type { Hand } from "./hand.js"
import { bestResponse } from "./oracle.js"
import { exploitability } from "./loyal-traitor.js"
import {
  MetabolismLedgerWriter,
  METABOLISM_LEDGER_PATH,
} from "./metabolism-ledger.js"
import {
  PopulationLedgerWriter,
  POPULATION_LEDGER_PATH,
  strategyIdFor,
} from "./population-ledger.js"
import {
  fromMilli,
  PPM_SCALE,
  toMilli,
  type PopulationRecord,
  type Strategy,
} from "./types.js"

// ---------------------------------------------------------------------------
// The micro scale — game_value / exploitability are stored as signed/non-negative
// integer micro (×1e6), the same idiom the spec names ("game_value/exploitability
// as micro"). A value of 1.0 is 1_000_000 micro.
// ---------------------------------------------------------------------------
export const MICRO_SCALE = 1_000_000 as const

/** Map a signed float to integer micro (round(x·1e6)) — the seam where a solver
 *  float (game_value, exploitability) becomes a serializable integer. */
export function toMicro(x: number): number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new Error(`toMicro: value must be a finite number, got ${x}`)
  }
  return Math.round(x * MICRO_SCALE)
}

/** Map a float probability mixture in [0,1] to an integer-ppm mixture that sums to
 *  EXACTLY 1_000_000, via the largest-remainder method (locked decision #5). Naive
 *  per-entry rounding can drift the sum by ±k; largest-remainder distributes the
 *  residual to the entries with the biggest fractional parts, so the stored mixture
 *  is a true probability vector in ppm (the property verify.ts checks). */
export function mixtureToPpm(mixture: number[]): number[] {
  const n = mixture.length
  if (n === 0) return []
  // Floor each scaled weight; track the fractional remainder for reconciliation.
  const scaled = mixture.map((w) => {
    const v = Math.max(0, w) * PPM_SCALE // clamp tiny negative float noise to 0.
    return { floor: Math.floor(v), frac: v - Math.floor(v) }
  })
  const floors = scaled.map((s) => s.floor)
  let used = 0
  for (const f of floors) used += f
  let residual = PPM_SCALE - used
  // Distribute the residual to the largest fractional parts (largest-remainder).
  if (residual > 0) {
    const order = scaled
      .map((s, i) => ({ i, frac: s.frac }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i)
    for (let k = 0; k < residual && k < order.length; k++) floors[order[k].i] += 1
    // If residual exceeds n (only possible with all-zero input), the loop above
    // tops out; fall back to dumping the rest on index 0 so the sum is exact.
    if (residual > order.length) floors[0] += residual - order.length
  } else if (residual < 0) {
    // Over-allocation (clamping pushed a sum above scale): trim from the smallest
    // fractional parts so the result stays a valid ppm vector summing to scale.
    const order = scaled
      .map((s, i) => ({ i, frac: s.frac }))
      .sort((a, b) => a.frac - b.frac || a.i - b.i)
    let toTrim = -residual
    for (let k = 0; k < order.length && toTrim > 0; k++) {
      const take = Math.min(floors[order[k].i], toTrim)
      floors[order[k].i] -= take
      toTrim -= take
    }
  }
  return floors
}

/** One iteration's SUMMARY — the Adjudicator's custody-grade trend record. Every
 *  numeric field is integer-domain (ppm / micro / counts), so a history serialized
 *  to JSONL carries no float. verify.ts re-derives every field of this. */
export interface IterationRecord {
  /** PSRO iteration index (0-based), matching psro_min's `t`. */
  iter: number
  /** Population size at the START of this iteration (before any append). */
  pop_size: number
  /** The Cartographer's mixture, integer ppm summing to 1_000_000. */
  mixture_ppm: number[]
  /** The maximin game value, signed integer MICRO (×1e6). */
  game_value_micro: number
  /** The Loyal Traitor's exploitability, non-negative integer MICRO. */
  exploitability_micro: number
  /** Whether the Loyal Traitor blocked convergence this iteration. */
  blocks_convergence: boolean
  /** The Oracle's beats_margin, signed integer MICRO — surfaced for the trend. */
  beats_margin_micro: number
  /** Whether the Oracle's counter was novel vs the population. */
  novel: boolean
  /** Whether the Archivist actually appended the counter this iteration. */
  appended: boolean
  /** content-addressed id of the appended strategy, or null if none appended. */
  appended_strategy_id: string | null
  /** The Adjudicator's Brier hook: brierPpm of the "mixture is unexploitable"
   *  forecast (1_000_000 − exploitability_ppm, clamped) against the binary outcome
   *  "did it actually converge below threshold" (1) / "still exploitable" (0). A
   *  WIRED hook — it scores the trend's own prediction, ready for calibration. */
  brier_ppm: number
}

/** Why the loop stopped — the Leader's verdict, recorded so verify.ts and the
 *  operator can see whether it RESTED (converged) or hit the iteration cap. */
export type StopReason = "rest" | "max_iters"

/** The full record of a metabolism run — the analogue of psro_min's RunRecord. */
export interface RunRecord {
  /** The seed that fixed the initial strategy (determinism anchor). */
  seed: number
  /** The iteration cap requested. */
  max_iters: number
  /** The convergence threshold (in the float exploitability domain). */
  threshold: number
  /** Matches per Hand evaluation (passed through to every cell). */
  n_matches: number
  /** The final population as integer-milli vectors (no float serialized). */
  final_population_milli: number[][]
  /** Per-iteration summaries (the Adjudicator's trend). */
  history: IterationRecord[]
  /** Why the loop stopped. */
  stop_reason: StopReason
  /** The iteration index at which it stopped. */
  stopped_at_iter: number
  /** The metabolism ledger path used (custody trail of every matrix cell). */
  metabolism_path: string
  /** The population ledger path used (Archivist trail of every appended strategy). */
  population_path: string
}

/** Options for a metabolism run. */
export interface RunMetabolismOpts {
  /** The Hand (the measurement organ). ToyHand for the deterministic CI loop. */
  hand: Hand
  /** Seed for the initial strategy (the ONLY source of run-to-run variation; same
   *  seed ⇒ identical run because everything downstream is deterministic). */
  seed: number
  /** Iteration cap. */
  maxIters: number
  /** Convergence threshold in the exploitability (float) domain — the Leader rests
   *  when exploitability < threshold. */
  threshold: number
  /** Matches per Hand evaluation. */
  nMatches: number
  /** Override the population (Archivist) ledger path — defaults to the State-zone
   *  POPULATION_LEDGER_PATH. */
  populationPath?: string
  /** Override the metabolism (Custodian) ledger path — defaults to the State-zone
   *  METABOLISM_LEDGER_PATH. */
  metabolismPath?: string
}

/** The seeded initial strategy scalar — psro_min.py:154-155 EXACTLY (a tiny LCG
 *  so the seed fixes the first vec[0] deterministically; no Math.random). */
export function seededInitialScalar(seed: number): number {
  const rng = (seed * 9301 + 49297) % 233280
  return rng / 233280
}

/** Build a Strategy from a float scalar/vec, CANONICALIZED through the integer-milli
 *  round-trip and content-addressing its id from that milli vector.
 *
 *  This is load-bearing for verifiability: the ledger only stores `vec_milli`, so an
 *  independent re-checker can only rehydrate `fromMilli(vec_milli)`. If the loop
 *  MEASURED the un-rounded float vec, the stored win-rate would never re-derive (the
 *  ToyHand kernel is sensitive at the 4th decimal). So the CANONICAL strategy IS the
 *  milli-rounded one — the loop measures exactly what the ledger will store, and the
 *  verifier reproduces it bit-for-bit. (Integer-domain discipline, applied to the
 *  measurement input, not just the receipt output.) */
export function strategyFromVec(vec: number[]): Strategy {
  const vecMilli = toMilli(vec)
  return { id: strategyIdFor(vecMilli), vec: fromMilli(vecMilli) }
}

/** The proven PSRO double-oracle loop, re-derived against our substrate.
 *
 *  Port of psro_min.py:152-201 — but every faked organ is swapped for the real
 *  Segment A+B substrate: the Hand measures (custody-stamped), the Cartographer
 *  solves, the Loyal Traitor measures exploitability, the Oracle forges a counter,
 *  the Archivist appends it (content-addressed, hash-chained), the Custodian stamps
 *  every matrix cell, and the Leader rests on the deterministic stopping rule.
 *
 *  DETERMINISTIC: the seed fixes the initial strategy; ToyHand + grid Oracle are
 *  deterministic ⇒ same seed ⇒ identical population + history. NO LLM in the loop.
 *  NOTE the determinism boundary (see the module header): history + population are
 *  bit-identical for a fixed seed, but the LEDGER FILES embed wall-clock receipt
 *  timestamps and are intentionally NOT byte-reproducible — custody, not artifact. */
export async function runMetabolism(opts: RunMetabolismOpts): Promise<RunRecord> {
  const { hand, seed, maxIters, threshold, nMatches } = opts
  const populationPath = opts.populationPath ?? POPULATION_LEDGER_PATH
  const metabolismPath = opts.metabolismPath ?? METABOLISM_LEDGER_PATH

  if (!Number.isInteger(maxIters) || maxIters <= 0) {
    throw new Error(`runMetabolism: maxIters must be a positive integer, got ${maxIters}`)
  }

  const archivist = new PopulationLedgerWriter(populationPath)
  const custodian = new MetabolismLedgerWriter(metabolismPath)

  // --- Seed → initial strategy (psro_min.py:153-156). The ONLY variation source. ---
  const first = strategyFromVec([seededInitialScalar(seed)])
  const population: Strategy[] = [first]
  // The Archivist records the genesis strategy (iteration 0 entrant).
  await archivist.append(makePopulationRecord(first, hand.kind, 0))

  const history: IterationRecord[] = []
  let stopReason: StopReason = "max_iters"
  let stoppedAt = maxIters - 1

  for (let t = 0; t < maxIters; t++) {
    const pop = population
    const popSize = pop.length

    // --- (a) Hand: build the matchup matrix; the Custodian stamps EVERY cell. ---
    // winrate_ppm[i][j] is the custody-stamped measurement A_i vs A_j. The matrix
    // the Cartographer solves is the centered payoff (winrate_ppm/1e6 − 0.5).
    const payoff: number[][] = []
    for (let i = 0; i < popSize; i++) {
      const row: number[] = []
      for (let j = 0; j < popSize; j++) {
        const { winrate_ppm, receipt } = await hand.evaluate(pop[i], pop[j], nMatches)
        // Custodian: stamp the cell (integer-domain, custody-chained). The
        // Adjudicator below scores ONLY these stamped matches, never a loose float.
        await custodian.append(receipt)
        row.push(winrate_ppm / PPM_SCALE - 0.5)
      }
      payoff.push(row)
    }

    // --- (b) Cartographer: solve the centered payoff matrix → mixture + value. ---
    const sol = solveZeroSum(payoff)
    // A 1×1 (lone strategy) is INSUFFICIENT for the solver — the lone pure strategy
    // is forced, so the mixture is [1.0] (the loop's honest behavior at pop size 1,
    // mirrored in solver.test.ts). For ≥2 strategies the solver returns a mixture.
    const mixture: number[] =
      "insufficient" in sol && sol.insufficient ? pop.map((_, i) => (i === 0 ? 1 : 0)) : sol.mixture
    const gameValue: number = "insufficient" in sol && sol.insufficient ? 0 : sol.game_value

    // --- (c) Loyal Traitor: how exploitable is this mixture? (the active anti-fox) ---
    const traitor = await exploitability(pop, mixture, hand, threshold)

    // --- (d) Oracle: forge a best-response to the current mixture. ---
    const oracle = await bestResponse(pop, mixture, hand, { gameValue })

    // The Archivist appends iff the counter beats the mix by margin AND is novel —
    // the Oracle GENERATES, the loop (reading two MEASURED quantities) decides. We
    // also content-address-dedup: a counter whose milli-vec already exists in the
    // population is not appended (mirrors psro_min.py:193's near-duplicate guard,
    // hardened to exact content identity via the Archivist's id).
    const candidate = strategyFromVec(oracle.strategy.vec)
    const alreadyPresent = pop.some((s) => s.id === candidate.id)
    const appended = oracle.beats_margin > threshold && oracle.novel && !alreadyPresent
    let appendedId: string | null = null
    if (appended) {
      population.push(candidate)
      await archivist.append(makePopulationRecord(candidate, hand.kind, t + 1))
      appendedId = candidate.id
    }

    // --- (e/f) Custodian summary + Adjudicator trend (integer-domain). ---
    const exploitMicro = toMicro(traitor.exploitability)
    // The Brier hook: the trend's prediction is "this mixture is unexploitable" =
    // 1_000_000 − exploitability_ppm (clamped to [0, 1e6]); the binary outcome is
    // "did it converge below threshold this iter" (1) else 0. A WIRED calibration
    // hook (brierPpm), not a decision — the Adjudicator scores its own forecast.
    const exploitPpm = Math.min(PPM_SCALE, Math.max(0, exploitMicro))
    const unexploitablePrediction = PPM_SCALE - exploitPpm
    const converged01: 0 | 1 = traitor.exploitability < threshold ? 1 : 0
    const rec: IterationRecord = {
      iter: t,
      pop_size: popSize,
      mixture_ppm: mixtureToPpm(mixture),
      game_value_micro: toMicro(gameValue),
      exploitability_micro: exploitMicro,
      blocks_convergence: traitor.blocks_convergence,
      beats_margin_micro: toMicro(oracle.beats_margin),
      novel: oracle.novel,
      appended,
      appended_strategy_id: appendedId,
      brier_ppm: brierForTrend(unexploitablePrediction, converged01),
    }
    history.push(rec)

    // --- (g) Leader (stopping rule): REST when the Traitor can't find an exploit
    //     AND it does not block convergence AND we are past the warm-up iteration
    //     (psro_min.py:196-198 exactly). The Leader reads exploitability from the
    //     Loyal Traitor (separate organ) — it does NOT recompute it itself. ---
    if (traitor.exploitability < threshold && !traitor.blocks_convergence && t > 1) {
      stopReason = "rest"
      stoppedAt = t
      break
    }
    stoppedAt = t
  }

  return {
    seed,
    max_iters: maxIters,
    threshold,
    n_matches: nMatches,
    final_population_milli: population.map((s) => toMilli(s.vec)),
    history,
    stop_reason: stopReason,
    stopped_at_iter: stoppedAt,
    metabolism_path: metabolismPath,
    population_path: populationPath,
  }
}

/** Build a PopulationRecord (integer-milli vec, content-addressed id) for the
 *  Archivist append. The id MUST be the content hash of the milli vec (the
 *  Archivist re-checks this at write time). */
function makePopulationRecord(s: Strategy, handKind: Hand["kind"], iteration: number): PopulationRecord {
  const vecMilli = toMilli(s.vec)
  return {
    strategy_id: strategyIdFor(vecMilli),
    vec_milli: vecMilli,
    hand_kind: handKind,
    iteration,
    ts: Date.now(),
  }
}

/** brierPpm hook for the trend prediction. Inlined integer-ppm Brier (identical
 *  formula to decision-forecast.ts:193 brierPpm) so the loop carries no float and
 *  does not import a forecast module's graph. prediction is the "unexploitable"
 *  ppm forecast; outcome01 is whether the iteration actually converged. */
function brierForTrend(prediction_ppm: number, outcome01: 0 | 1): number {
  const diff = prediction_ppm - outcome01 * PPM_SCALE
  return Math.round((diff * diff) / PPM_SCALE)
}
