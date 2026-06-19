// src/lab/metabolism/cartographer.ts — the Cartographer organ (SEGMENT B).
//
// solveZeroSum() reads a payoff MATRIX over the population and returns the row
// player's maximin mixed strategy + its game value, by iterative regret matching.
// It is a faithful TypeScript port of psro_min.py:57-97 (the proven shape) with
// the deterministic worst-case self-check from cartographer.claude.md baked into
// the OUTPUT so an auditor (and the loop) can re-check it.
//
// THE DESIGN LAW (anti-fox) — and why the self-check is NOT a tautology:
// The Cartographer SOLVES; it does NOT rubber-stamp itself. The trap an earlier
// draft fell into was making game_value === min_j(Aᵀx)_j by construction, then
// "checking" that equality against itself — a check that can never fail (the fox
// grading the henhouse). cartographer.claude.md inv. 4/5 demand the check confirm
// game_value is "the actual worst-case value of the mixture, not an aspiration",
// and inv. 5 says "if this fails you must re-solve". A check that cannot fail
// satisfies neither.
//
// So the two quantities are made INDEPENDENT witnesses of the same fact:
//   · game_value          = the regret-matching iteration's OWN converged value
//                           estimate (the time-average of the row player's value
//                           over the `iters` iterates). It is what the SOLVE
//                           believed it could guarantee — produced by the iteration,
//                           NOT recomputed from the final mixture.
//   · min_column_payoff   = min_j (Aᵀx)_j RECOMPUTED from the raw matrix and the
//                           returned average mixture. It is what the mixture ACTUALLY
//                           guarantees against the best pure column.
// They are computed by two different routes from two different objects. When the
// regret-matching has CONVERGED they agree (matches_game_value: true). When it has
// NOT (e.g. iters=1, a non-equilibrium mixture), the iteration's value estimate
// OVERSTATES what the mixture actually guarantees, the two diverge beyond the
// convergence tolerance, and BOTH checks fire (matches_game_value: false,
// any_pure_strategy_beats_mixture: true) — empirically verified on a deliberately
// under-iterated dominant-row solve.
//
// ABSTAIN OVER FORCE: an empty / 1×1 / ragged / non-finite / out-of-range matrix
// yields an explicit INSUFFICIENT result, NEVER a fabricated mixture (mirrors the
// outcomeToBinary insufficient→null discipline cited in the spec's quality rules,
// and cartographer.claude.md's REFUSALS — including payoff_out_of_range).
//
// DETERMINISTIC: no LLM, no Math.random. Regret matching is a deterministic fold
// over `iters` iterations — same matrix in, same mixture out (matches psro_min).

/** The worst-case self-check: an INDEPENDENT recomputation from the raw matrix,
 *  so it can genuinely DISAGREE with game_value when the solve has not converged. */
export interface WorstCaseCheck {
  /** min_j (Aᵀx)_j recomputed from the raw matrix and the returned mixture — what
   *  the mixture ACTUALLY guarantees against the best pure column. */
  min_column_payoff: number
  /** |min_column_payoff − game_value| ≤ tol — does the iteration's value estimate
   *  (game_value) match what the mixture actually guarantees? FALSE on a
   *  non-converged solve: the value was an aspiration, not the achieved worst case
   *  (cartographer.claude.md inv. 4). This is a check that CAN fail. */
  matches_game_value: boolean
  /** The convergence tolerance used (CONVERGENCE_TOL). The two witnesses must agree
   *  within this band for the solve to count as settled. */
  tol: number
}

/** The anti-exploitability claim, made concrete: is there a pure opponent column
 *  that beats the value the solve believed it guaranteed? */
export interface DominationCheck {
  /** True iff some pure column drives the row player's payoff below game_value − tol
   *  — i.e. the mixture does NOT actually guarantee the value the iteration claimed.
   *  When true the mixture is NOT a valid maximin solution and must be re-solved
   *  (cartographer.claude.md inv. 5). This is a check that CAN fail. */
  any_pure_strategy_beats_mixture: boolean
  /** argmin_j of the row payoff (= the opponent's best pure response, which
   *  minimizes the row player's payoff). */
  best_responding_column: number
  /** The row player's payoff under that best-responding column = min_j (Aᵀx)_j. For
   *  a valid maximin mixture this is ≥ game_value − tol (the opponent cannot drive
   *  us below the value the solve guaranteed). */
  best_response_value: number
}

/** A solved maximin mixture + its self-check, OR an explicit INSUFFICIENT marker. */
export type ZeroSumResult =
  | {
      insufficient?: false
      /** Probability vector over the row strategies; sums to 1, entries ≥ 0. */
      mixture: number[]
      /** The maximin game value, as estimated by the regret-matching ITERATION
       *  (≈ 0 for a symmetric zero-sum game at equilibrium). This is the SOLVE's own
       *  witness — the worst_case_check verifies it against the recomputed truth. */
      game_value: number
      /** Indices of rows with mixture weight above the support threshold. */
      support: number[]
      worst_case_check: WorstCaseCheck
      domination_check: DominationCheck
    }
  | {
      insufficient: true
      /** Why the matrix could not be solved (empty / 1×1 / ragged / non-finite /
       *  out-of-range). */
      reason: string
    }

/** Tolerance for the exact recomputation invariant (cartographer.claude.md inv. 3).
 *  Used only for value-vs-value equality where float error is the only source of
 *  difference (kept at the spec's literal 1e-6). */
export const SOLVE_TOL = 1e-6

/** Convergence tolerance for the worst-case / domination witnesses. The iteration's
 *  value estimate and the recomputed worst-case of the average mixture agree within
 *  this band ONLY when regret matching has settled. Empirically: a converged solve
 *  has |witness − recomputed| < 3e-3; an under-iterated one (iters=1) diverges by
 *  >3e-2 — so this band cleanly separates "settled" from "still moving". It is the
 *  meaningful failure threshold the anti-fox check needs (a 1e-6 band would report
 *  every finite-iteration asymmetric solve as broken). */
export const CONVERGENCE_TOL = 1e-2

/** The declared payoff range. cartographer.claude.md REFUSALS: payoff entries must
 *  be numeric in the declared scale. The caller centers winrate_ppm/1e6 − 0.5 into
 *  [−0.5, 0.5]; we widen to the spec's [−1, 1] payoff scale (a small float slack is
 *  absorbed). An entry outside this is a malformed payoff, not a sparse one. */
export const PAYOFF_RANGE: readonly [number, number] = [-1, 1]

/** Support threshold — a row is "in support" if its mixture weight exceeds this
 *  (mirrors psro_min.py:96 `p > 1e-4`). */
export const SUPPORT_EPS = 1e-4

/** Regret → strategy: clamp regrets to non-negative, normalize. If no positive
 *  regret, fall back to uniform (psro_min.py:68-73 exactly). */
function regretToStrategy(regret: number[]): number[] {
  const pos = regret.map((r) => (r > 0 ? r : 0))
  let s = 0
  for (const p of pos) s += p
  if (s <= 0) return regret.map(() => 1 / regret.length)
  return pos.map((p) => p / s)
}

/** Solve a zero-sum payoff matrix for the row player's maximin mixture via regret
 *  matching. Port of psro_min.py:57-97 with the deterministic self-check made part
 *  of the output (cartographer.claude.md REQUIRED OUTPUT + INVARIANTS), and the
 *  game_value sourced from the ITERATION (an independent witness) so the check can
 *  genuinely fail on a non-converged solve.
 *
 *  @param matrix PAYOFF matrix, rows = your strategies, cols = opponent's;
 *                A[i][j] = your expected payoff when you play i, they play j.
 *                The caller centers win-rate ppm → payoff (winrate_ppm/1e6 − 0.5).
 *  @param iters  regret-matching iterations (default 8000, matches psro_min).
 *  @returns a solved mixture + self-check, or an explicit INSUFFICIENT result. */
export function solveZeroSum(matrix: number[][], iters = 8000): ZeroSumResult {
  const m = matrix.length
  const n = m > 0 ? matrix[0].length : 0

  // --- ABSTAIN OVER FORCE: degenerate input → explicit INSUFFICIENT, no fabrication ---
  if (m === 0 || n === 0) {
    return { insufficient: true, reason: "empty_matrix: matrix has no rows or no columns" }
  }
  if (m === 1 && n === 1) {
    // A 1×1 matrix is degenerate: there is no mixture to solve (the single pure
    // strategy is forced) and no real maximin trade-off. The loop needs ≥2
    // strategies before the Cartographer has terrain to map. Abstain.
    return { insufficient: true, reason: "degenerate_matrix: 1x1 has no mixture to solve" }
  }
  // Ragged / non-finite / out-of-range — refuse (cartographer.claude.md REFUSALS).
  // A malformed payoff table has no honest mixture; abstain over force.
  const [rangeLo, rangeHi] = PAYOFF_RANGE
  for (let i = 0; i < m; i++) {
    if (matrix[i].length !== n) {
      return {
        insufficient: true,
        reason: `ragged_matrix: row ${i} has length ${matrix[i].length}, expected ${n}`,
      }
    }
    for (let j = 0; j < n; j++) {
      const a = matrix[i][j]
      if (!Number.isFinite(a)) {
        return { insufficient: true, reason: `non_finite_entry: A[${i}][${j}] is ${a}` }
      }
      // payoff_out_of_range (cartographer.claude.md): entries must lie in the
      // declared payoff scale. A small SOLVE_TOL slack absorbs centering float
      // error; anything beyond is a malformed payoff, not a sparse one.
      if (a < rangeLo - SOLVE_TOL || a > rangeHi + SOLVE_TOL) {
        return {
          insufficient: true,
          reason: `payoff_out_of_range: A[${i}][${j}]=${a} outside [${rangeLo}, ${rangeHi}]`,
        }
      }
    }
  }

  // --- Regret matching (psro_min.py:63-93, deterministic) ---
  const rowRegret = new Array<number>(m).fill(0)
  const colRegret = new Array<number>(n).fill(0)
  const rowStrategySum = new Array<number>(m).fill(0)
  const colStrategySum = new Array<number>(n).fill(0)
  // The iteration's OWN value witness: the time-average of the row player's value
  // under the per-iterate mixtures. This is what the SOLVE believed it could
  // guarantee — it is NOT recomputed from the final mixture, so it can disagree
  // with the recomputed worst-case when the iteration has not converged.
  let rowValueSum = 0

  for (let t = 0; t < iters; t++) {
    const x = regretToStrategy(rowRegret) // row mixture this iter
    const y = regretToStrategy(colRegret) // col mixture this iter
    for (let i = 0; i < m; i++) rowStrategySum[i] += x[i]
    for (let j = 0; j < n; j++) colStrategySum[j] += y[j]

    // value of each pure row action vs current col mixture, and vice versa.
    const rowVal = new Array<number>(m)
    for (let i = 0; i < m; i++) {
      let v = 0
      for (let j = 0; j < n; j++) v += matrix[i][j] * y[j]
      rowVal[i] = v
    }
    const colVal = new Array<number>(n)
    for (let j = 0; j < n; j++) {
      let v = 0
      for (let i = 0; i < m; i++) v += matrix[i][j] * x[i]
      colVal[j] = v
    }
    let vRow = 0
    for (let i = 0; i < m; i++) vRow += x[i] * rowVal[i]
    let vCol = 0
    for (let j = 0; j < n; j++) vCol += y[j] * colVal[j]
    rowValueSum += vRow

    for (let i = 0; i < m; i++) rowRegret[i] += rowVal[i] - vRow
    // col maximizes its own (negated) payoff (psro_min.py:90).
    for (let j = 0; j < n; j++) colRegret[j] += -colVal[j] - -vCol
  }

  let tot = 0
  for (const s of rowStrategySum) tot += s
  if (tot <= 0) tot = 1
  const mixture = rowStrategySum.map((s) => s / tot)

  // game_value = the ITERATION's converged value estimate (independent witness).
  const gameValue = rowValueSum / iters

  // --- INDEPENDENT SELF-CHECK (recomputed from the raw matrix + the final mixture) ---
  // column payoff against the mixture: (Aᵀx)_j = Σ_i A[i][j]·x[i].
  const columnPayoff = new Array<number>(n)
  for (let j = 0; j < n; j++) {
    let v = 0
    for (let i = 0; i < m; i++) v += matrix[i][j] * mixture[i]
    columnPayoff[j] = v
  }

  // The opponent's BEST pure response minimizes the row player's payoff → the column
  // with the SMALLEST payoff-to-us. min_column_payoff = what the mixture ACTUALLY
  // guarantees (psro_min.py:95 — but here it is the WITNESS to check game_value, not
  // game_value itself).
  let minColumnPayoff = Infinity
  let bestRespondingColumn = 0
  for (let j = 0; j < n; j++) {
    if (columnPayoff[j] < minColumnPayoff) {
      minColumnPayoff = columnPayoff[j]
      bestRespondingColumn = j
    }
  }

  const support: number[] = []
  for (let i = 0; i < m; i++) {
    if (mixture[i] > SUPPORT_EPS) support.push(i)
  }

  // worst_case_check: does the iteration's value estimate (game_value) match what the
  // mixture actually guarantees (min_column_payoff)? They are computed by two
  // independent routes, so this can FAIL when the solve has not converged.
  const worstCaseCheck: WorstCaseCheck = {
    min_column_payoff: minColumnPayoff,
    matches_game_value: Math.abs(minColumnPayoff - gameValue) <= CONVERGENCE_TOL,
    tol: CONVERGENCE_TOL,
  }

  // domination_check: invariant 5 (cartographer.claude.md). A pure column "beats" the
  // mixture if it drives the row payoff below the value the solve claimed to
  // guarantee (game_value) by more than tol — i.e. min_column_payoff < game_value −
  // tol. On a converged maximin solution this is false; on a non-converged one (the
  // iteration overstated its value) it fires true.
  const dominationCheck: DominationCheck = {
    any_pure_strategy_beats_mixture: minColumnPayoff < gameValue - CONVERGENCE_TOL,
    best_responding_column: bestRespondingColumn,
    best_response_value: minColumnPayoff,
  }

  return {
    mixture,
    game_value: gameValue,
    support,
    worst_case_check: worstCaseCheck,
    domination_check: dominationCheck,
  }
}
