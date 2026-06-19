// src/lab/metabolism/hand.test.ts — the Hand surface's contract.
//
// The Hand only MEASURES; its CHECK ships with it. For ToyHand the check is the
// ZERO-SUM invariant the solver relies on: winrate(a,b) + winrate(b,a) ===
// 1_000_000, integer-exact, across a grid of vecs. For CabtHand the check is the
// vec→8-priors mapping (grounded against src/cabt/heuristic.py:20) and that the
// injected subprocess receives the mandatory SEAT-SWAP calls.

import { describe, expect, it, vi } from "vitest"
import {
  CabtHand,
  HEURISTIC_PRIOR_KEYS,
  ToyHand,
  toyPayoff,
  toyWinratePpm,
  vecToPriors,
  type CabtMatchRequest,
  type SeatRunResult,
} from "./hand.js"
import type { Strategy } from "./types.js"

function strat(id: string, vec: number[]): Strategy {
  return { id, vec }
}

describe("ToyHand — psro_min's antisymmetric kernel in win-rate space", () => {
  it("payoff kernel is odd: payoff(-d) === -payoff(d)", () => {
    for (const d of [0.1, 0.37, 0.8, 1.4, 2.0]) {
      expect(toyPayoff(-d)).toBeCloseTo(-toyPayoff(d), 12)
    }
  })

  it("self-play is exactly a draw: winrate(a,a) === 500_000", () => {
    expect(toyWinratePpm(0.5, 0.5)).toBe(500_000)
    expect(toyWinratePpm(0, 0)).toBe(500_000)
    expect(toyWinratePpm(0.9, 0.9)).toBe(500_000)
  })

  it("ZERO-SUM invariant: winrate(a,b) + winrate(b,a) === 1_000_000 across a grid", () => {
    const grid = [0, 0.05, 0.1, 0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 1.0]
    for (const a of grid) {
      for (const b of grid) {
        const ab = toyWinratePpm(a, b)
        const ba = toyWinratePpm(b, a)
        expect(ab + ba).toBe(1_000_000)
        // and every value is a valid integer ppm
        expect(Number.isInteger(ab)).toBe(true)
        expect(ab).toBeGreaterThanOrEqual(0)
        expect(ab).toBeLessThanOrEqual(1_000_000)
      }
    }
  })

  it("evaluate emits an integer-domain toy receipt with the zero-sum property", async () => {
    const h = new ToyHand()
    const a = strat("a", [0.7])
    const b = strat("b", [0.2])
    const ab = await h.evaluate(a, b, 30)
    const ba = await h.evaluate(b, a, 30)
    expect(ab.winrate_ppm + ba.winrate_ppm).toBe(1_000_000)
    expect(ab.receipt.hand_kind).toBe("toy")
    expect(ab.receipt.n_matches).toBe(30)
    expect(ab.receipt.strategy_a).toBe("a")
    expect(ab.receipt.strategy_b).toBe("b")
    expect(Number.isInteger(ab.receipt.winrate_ppm)).toBe(true)
    expect(Number.isInteger(ab.receipt.ts)).toBe(true)
  })

  it("rejects a non-integer nMatches", async () => {
    const h = new ToyHand()
    await expect(h.evaluate(strat("a", [0.5]), strat("b", [0.5]), 1.5)).rejects.toThrow(/integer/)
  })
})

describe("CabtHand — cg-engine adapter (subprocess injected)", () => {
  it("maps vec[0..7] to the 8 _BASE heuristic priors in heuristic.py:20 order", () => {
    const priors = vecToPriors([50, 48, 45, 42, 25, 10, 6, 2])
    expect(HEURISTIC_PRIOR_KEYS).toEqual([
      "ATTACH",
      "EVOLVE",
      "PLAY",
      "ABILITY",
      "ATTACK",
      "RETREAT",
      "DISCARD",
      "END",
    ])
    expect(priors).toEqual({
      ATTACH: 50,
      EVOLVE: 48,
      PLAY: 45,
      ABILITY: 42,
      ATTACK: 25,
      RETREAT: 10,
      DISCARD: 6,
      END: 2,
    })
  })

  it("a short vec fills missing priors with 0 (degenerate, not an error)", () => {
    const priors = vecToPriors([1, 2])
    expect(priors.ATTACH).toBe(1)
    expect(priors.EVOLVE).toBe(2)
    expect(priors.PLAY).toBe(0)
    expect(priors.END).toBe(0)
  })

  it("shells the subprocess with the MANDATORY seat-swap (a-seat0 then a-seat1)", async () => {
    const calls: CabtMatchRequest[] = []
    const runner = vi.fn(async (req: CabtMatchRequest): Promise<SeatRunResult> => {
      calls.push(req)
      // A wins 20/30 as seat 0, 16/30 as seat 1 → (20+16)/(60) = 0.6 → 600_000 ppm.
      return { wins: req.seat === "a-seat0" ? 20 : 16, n: 30 }
    })
    const h = new CabtHand(runner)
    const a = strat("a", [50, 48, 45, 42, 25, 10, 6, 2])
    const b = strat("b", [10, 10, 10, 10, 10, 10, 10, 10])

    const out = await h.evaluate(a, b, 30)

    // Seat-swap: exactly two subprocess calls, one per seat orientation.
    expect(runner).toHaveBeenCalledTimes(2)
    expect(calls.map((c) => c.seat)).toEqual(["a-seat0", "a-seat1"])
    // Both calls carry A's priors mapped from the vec.
    expect(calls[0].priorsA.ATTACH).toBe(50)
    expect(calls[0].priorsB.ATTACK).toBe(10)
    expect(calls[0].nMatches).toBe(30)

    // winrate = (20 + 16) / (30 + 30) = 0.6 → 600_000 ppm.
    expect(out.winrate_ppm).toBe(600_000)
    expect(out.receipt.hand_kind).toBe("cabt")
    expect(out.receipt.n_matches).toBe(60) // seat-swap-doubled
    expect(out.receipt.strategy_a).toBe("a")
    expect(out.receipt.strategy_b).toBe("b")
  })

  it("abstains (throws INSUFFICIENT) when 0 matches resolve across both seats", async () => {
    const runner = vi.fn(async (): Promise<SeatRunResult> => ({ wins: 0, n: 0 }))
    const h = new CabtHand(runner)
    await expect(
      h.evaluate(strat("a", [1, 2, 3, 4, 5, 6, 7, 8]), strat("b", [8, 7, 6, 5, 4, 3, 2, 1]), 30),
    ).rejects.toThrow(/INSUFFICIENT/)
  })

  it("rejects a non-positive nMatches", async () => {
    const runner = vi.fn(async (): Promise<SeatRunResult> => ({ wins: 0, n: 0 }))
    const h = new CabtHand(runner)
    await expect(h.evaluate(strat("a", [1]), strat("b", [2]), 0)).rejects.toThrow(/positive integer/)
  })
})
