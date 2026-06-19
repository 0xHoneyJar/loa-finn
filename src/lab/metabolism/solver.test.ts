// src/lab/metabolism/solver.test.ts — the SEGMENT B solver organs' contract.
//
// The three math organs are tested against psro_min's known behavior with the
// deterministic ToyHand from Segment A:
//   · Cartographer (solveZeroSum): RPS → ~uniform mixture, game_value ≈ 0,
//     worst-case self-check passes; dominant-row matrix → ~pure mixture;
//     domination_check holds; empty / 1×1 / ragged / out-of-range → explicit
//     INSUFFICIENT (no fabrication). CRUCIALLY: a deliberately UNDER-ITERATED solve
//     trips both self-checks (matches_game_value:false, any_pure_strategy_beats:true)
//     — proving the check has discriminating power and is NOT a tautology.
//   · Oracle (bestResponse): finds a beating + novel counter vs a single-strategy
//     population on ToyHand; the beats_margin and novel flag are MEASURED.
//   · Loyal Traitor (exploitability): a lone pure strategy is HIGHLY exploitable,
//     and exploitability SHRINKS once the Oracle's counter is added — the
//     mini-convergence signal (the active anti-fox).
//
// ANTI-FOX checked structurally AND empirically: the Oracle's payoff comes from
// ToyHand (external), the Cartographer's worst-case check is an INDEPENDENT
// recomputation that can fail (the negative test proves it), and the Loyal Traitor
// is a distinct organ measuring exploitability.

import { describe, expect, it } from "vitest"
import { solveZeroSum, CONVERGENCE_TOL } from "./cartographer.js"
import { bestResponse } from "./oracle.js"
import { exploitability, EXPLOITABILITY_THRESHOLD } from "./loyal-traitor.js"
import { ToyHand, toyWinratePpm } from "./hand.js"
import type { Strategy } from "./types.js"

function strat(id: string, vec: number[]): Strategy {
  return { id, vec }
}

/** Build a ToyHand payoff matrix over a population: centered win-rate
 *  (winrate_ppm/1e6 − 0.5) for every (i, j) pair. This is what the loop feeds the
 *  Cartographer. Deterministic — built straight from toyWinratePpm. */
function toyPayoffMatrix(pop: Strategy[]): number[][] {
  return pop.map((a) =>
    pop.map((b) => toyWinratePpm(a.vec[0] ?? 0, b.vec[0] ?? 0) / 1_000_000 - 0.5),
  )
}

describe("Cartographer — solveZeroSum (psro_min regret-matching + worst-case self-check)", () => {
  it("rock-paper-scissors payoff → ~uniform mixture, game_value ≈ 0, self-check passes", () => {
    // Canonical SYMMETRIC RPS: antisymmetric with equal-magnitude off-diagonals, so
    // the unique equilibrium is exactly uniform [1/3, 1/3, 1/3] with game value 0.
    // (cartographer.claude.md's worked example is RPS-*flavored* but asymmetric; the
    // spec's sanity case is the symmetric one where the equilibrium IS uniform.)
    const A = [
      [0.0, -1.0, 1.0],
      [1.0, 0.0, -1.0],
      [-1.0, 1.0, 0.0],
    ]
    const res = solveZeroSum(A, 8000)
    expect("insufficient" in res && res.insufficient).toBeFalsy()
    if ("insufficient" in res && res.insufficient) throw new Error("unexpected INSUFFICIENT")

    // mixture is a valid probability vector.
    const sum = res.mixture.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 6)
    for (const p of res.mixture) expect(p).toBeGreaterThanOrEqual(0)

    // ~uniform: every weight near 1/3.
    for (const p of res.mixture) expect(p).toBeCloseTo(1 / 3, 1)

    // game value ≈ 0 for this symmetric-ish RPS.
    expect(Math.abs(res.game_value)).toBeLessThan(0.05)

    // The independent worst-case self-check holds on a converged solve: the
    // iteration's value witness (game_value) agrees with the recomputed worst-case
    // of the mixture (min_column_payoff) within the convergence band.
    expect(res.worst_case_check.matches_game_value).toBe(true)
    expect(res.worst_case_check.tol).toBe(CONVERGENCE_TOL)
    expect(Math.abs(res.worst_case_check.min_column_payoff - res.game_value)).toBeLessThanOrEqual(
      CONVERGENCE_TOL,
    )

    // No pure column beats the mixture (invariant 5).
    expect(res.domination_check.any_pure_strategy_beats_mixture).toBe(false)
    expect(res.domination_check.best_response_value).toBeGreaterThanOrEqual(
      res.game_value - CONVERGENCE_TOL,
    )
  })

  it("dominant-row matrix → ~pure mixture on the dominant row; domination_check holds", () => {
    // Row 0 dominates: it pays more than the others against every column.
    const A = [
      [0.9, 0.8, 0.95],
      [-0.5, -0.4, -0.6],
      [-0.7, -0.8, -0.5],
    ]
    const res = solveZeroSum(A, 8000)
    if ("insufficient" in res && res.insufficient) throw new Error("unexpected INSUFFICIENT")

    // Mixture collapses onto row 0.
    expect(res.mixture[0]).toBeGreaterThan(0.95)
    expect(res.support).toEqual([0])

    // game value ≈ worst column payoff under the (near-)pure row-0 mixture =
    // min(0.9,0.8,0.95)=0.8 (the iteration witness converges to this).
    expect(res.game_value).toBeCloseTo(0.8, 2)
    expect(res.worst_case_check.matches_game_value).toBe(true)
    expect(res.domination_check.any_pure_strategy_beats_mixture).toBe(false)
  })

  it("NEGATIVE: an UNDER-ITERATED solve trips both self-checks (the check can FAIL)", () => {
    // The discriminating-power test that binds the anti-fox claim: feed the dominant
    // matrix but allow only ONE regret-matching iteration. The iterate mixture is
    // uniform (no regret accumulated yet), so the iteration's value witness
    // (game_value, the time-average over iterates) OVERSTATES what that bad mixture
    // actually guarantees (min_column_payoff, recomputed). The two diverge beyond the
    // convergence band, so BOTH self-checks must fire — proving they are independent
    // witnesses, not tautologies. (A tautological check would report green here.)
    const A = [
      [0.9, 0.8, 0.95],
      [-0.5, -0.4, -0.6],
      [-0.7, -0.8, -0.5],
    ]
    const res = solveZeroSum(A, 1)
    if ("insufficient" in res && res.insufficient) throw new Error("unexpected INSUFFICIENT")

    // The witness and the recomputed worst-case genuinely DISAGREE.
    expect(Math.abs(res.worst_case_check.min_column_payoff - res.game_value)).toBeGreaterThan(
      CONVERGENCE_TOL,
    )
    expect(res.worst_case_check.matches_game_value).toBe(false)
    // A pure column beats the value the solve claimed → the mixture is not maximin.
    expect(res.domination_check.any_pure_strategy_beats_mixture).toBe(true)
    expect(res.domination_check.best_response_value).toBeLessThan(res.game_value - CONVERGENCE_TOL)
  })

  it("INSUFFICIENT on an empty matrix (abstain over force, no fabricated mixture)", () => {
    const res = solveZeroSum([], 8000)
    expect("insufficient" in res && res.insufficient).toBe(true)
    if (!("insufficient" in res) || !res.insufficient) throw new Error("expected INSUFFICIENT")
    expect(res.reason).toMatch(/empty/)
  })

  it("INSUFFICIENT on a 1×1 matrix (degenerate, no mixture to solve)", () => {
    const res = solveZeroSum([[0.0]], 8000)
    expect("insufficient" in res && res.insufficient).toBe(true)
    if (!("insufficient" in res) || !res.insufficient) throw new Error("expected INSUFFICIENT")
    expect(res.reason).toMatch(/degenerate|1x1/)
  })

  it("INSUFFICIENT on a ragged matrix (refuse, never guess)", () => {
    const res = solveZeroSum(
      [
        [0.1, 0.2, 0.3],
        [0.4, 0.5],
      ],
      8000,
    )
    expect("insufficient" in res && res.insufficient).toBe(true)
    if (!("insufficient" in res) || !res.insufficient) throw new Error("expected INSUFFICIENT")
    expect(res.reason).toMatch(/ragged/)
  })

  it("INSUFFICIENT on an out-of-range entry (payoff_out_of_range refusal)", () => {
    // cartographer.claude.md REFUSALS: entries must lie in the declared payoff scale.
    // An entry of 5.0 is a malformed payoff, not a sparse one — refuse, never solve
    // into an undeclared scale.
    const res = solveZeroSum(
      [
        [0.0, 5.0],
        [-0.3, 0.0],
      ],
      8000,
    )
    expect("insufficient" in res && res.insufficient).toBe(true)
    if (!("insufficient" in res) || !res.insufficient) throw new Error("expected INSUFFICIENT")
    expect(res.reason).toMatch(/payoff_out_of_range/)
  })

  it("is deterministic — same matrix in, same mixture out", () => {
    const A = [
      [0.0, 0.3, -0.4],
      [-0.3, 0.0, 0.5],
      [0.4, -0.5, 0.0],
    ]
    const a = solveZeroSum(A, 4000)
    const b = solveZeroSum(A, 4000)
    if (("insufficient" in a && a.insufficient) || ("insufficient" in b && b.insufficient)) {
      throw new Error("unexpected INSUFFICIENT")
    }
    expect(a.mixture).toEqual(b.mixture)
    expect(a.game_value).toEqual(b.game_value)
  })
})

describe("Oracle — bestResponse (parametric search, external Hand measurement)", () => {
  it("finds a beating + novel response vs a single-strategy population on ToyHand", async () => {
    const hand = new ToyHand()
    // A lone pure strategy at 0.5. Its self-mixture has game_value 0 (draws itself).
    const pop = [strat("p0", [0.5])]
    const mixture = [1.0]

    const br = await bestResponse(pop, mixture, hand, { grid: 401, gameValue: 0 })

    // The counter beats the lone strategy by a positive margin (the toy kernel has
    // an interior optimum just above 0.5 — sin(2.5d)·exp(-1.5d²) peaks near d≈0.5).
    expect(br.br_value).toBeGreaterThan(0.05)
    expect(br.beats_margin).toBeGreaterThan(0.05)
    // It is novel — distinct from the lone pop vector.
    expect(br.novel).toBe(true)
    // The forged vec lives in [0,1].
    expect(br.strategy.vec[0]).toBeGreaterThanOrEqual(0)
    expect(br.strategy.vec[0]).toBeLessThanOrEqual(1)
  })

  it("is deterministic — same population + mixture → same counter", async () => {
    const hand = new ToyHand()
    const pop = [strat("p0", [0.3])]
    const a = await bestResponse(pop, [1.0], hand, { grid: 201 })
    const b = await bestResponse(pop, [1.0], hand, { grid: 201 })
    expect(a.strategy.vec).toEqual(b.strategy.vec)
    expect(a.br_value).toEqual(b.br_value)
  })

  it("abstains on an empty population (INSUFFICIENT, never a fabricated counter)", async () => {
    const hand = new ToyHand()
    await expect(bestResponse([], [], hand)).rejects.toThrow(/INSUFFICIENT/)
  })
})

describe("Loyal Traitor — exploitability (the active anti-fox)", () => {
  it("a lone pure strategy is HIGHLY exploitable and blocks convergence", async () => {
    const hand = new ToyHand()
    const pop = [strat("p0", [0.5])]
    const mixture = [1.0]

    const expl = await exploitability(pop, mixture, hand, EXPLOITABILITY_THRESHOLD, { grid: 401 })

    expect(expl.exploitability).toBeGreaterThan(EXPLOITABILITY_THRESHOLD)
    expect(expl.blocks_convergence).toBe(true)
    // The exploiter is a concrete strategy in [0,1].
    expect(expl.exploiter.vec[0]).toBeGreaterThanOrEqual(0)
    expect(expl.exploiter.vec[0]).toBeLessThanOrEqual(1)
  })

  it("exploitability SHRINKS after the Oracle's counter is added (mini-convergence)", async () => {
    const hand = new ToyHand()

    // Iteration 0: a lone pure strategy. A 1×1 matrix is INSUFFICIENT (the loop forces
    // a pure mixture for the lone strategy), so we measure exploitability against the
    // forced [1.0] mixture directly — the loop's actual behavior at population size 1.
    const pop0 = [strat("p0", [0.5])]
    const res0 = solveZeroSum(toyPayoffMatrix(pop0), 4000)
    const mix0 =
      "insufficient" in res0 && res0.insufficient ? [1.0] : (res0 as { mixture: number[] }).mixture
    const expl0 = await exploitability(pop0, mix0, hand, EXPLOITABILITY_THRESHOLD, { grid: 401 })
    expect(expl0.blocks_convergence).toBe(true)

    // The Oracle forges a counter and the Archivist adds it (now 2 strategies).
    const br = await bestResponse(pop0, mix0, hand, { grid: 401, gameValue: 0 })
    const pop1 = [...pop0, br.strategy]

    // Iteration 1: re-solve over the grown population, re-measure exploitability.
    const res1 = solveZeroSum(toyPayoffMatrix(pop1), 4000)
    if ("insufficient" in res1 && res1.insufficient) throw new Error("unexpected INSUFFICIENT")
    const expl1 = await exploitability(pop1, res1.mixture, hand, EXPLOITABILITY_THRESHOLD, {
      grid: 401,
    })

    // The mini-convergence signal: adding the counter SHRINKS exploitability.
    expect(expl1.exploitability).toBeLessThan(expl0.exploitability)
  })

  it("abstains on an empty population (INSUFFICIENT)", async () => {
    const hand = new ToyHand()
    await expect(exploitability([], [], hand)).rejects.toThrow(/INSUFFICIENT/)
  })
})
