// src/lab/metabolism/oracle.ts — the Oracle organ (SEGMENT B).
//
// bestResponse() searches the parameter-vector space for the strategy that best
// responds to the opponent's current mixture over the population. It is a faithful
// TypeScript port of psro_min.py:105-112 (the grid brute-force) for the 1-dim
// ToyHand, generalized to a deterministic coarse SAMPLED search for higher-dim
// vectors (e.g. CabtHand's 8-vec) without ever touching Math.random.
//
// THE DESIGN LAW (anti-fox): the Oracle GENERATES a counter; it MUST NOT also
// ratify it. Two things make this concrete:
//   1. The payoff it maximizes comes from `hand.evaluate` — an EXTERNAL measurement
//      organ. The Oracle never scores a candidate itself; it asks the Hand.
//   2. "good" is reported, not asserted: `beats_margin = br_value − game_value`
//      and `novel = (min distance to any pop vector) > epsilon` are both MEASURED
//      quantities the caller (the loop) reads. The Oracle does not decide whether
//      the counter is "good enough" — it surfaces the two numbers and lets the
//      Loyal Traitor + Leader gate convergence.
//
// DETERMINISTIC: the grid is a fixed lattice; the higher-dim sampler is a seeded
// low-discrepancy (van der Corput / Halton) sequence — same inputs, same candidate
// set, every run. No LLM, no Math.random (matches psro_min's determinism).

import type { Hand } from "./hand.js"
import type { Strategy } from "./types.js"

/** The Oracle's verdict on one best-response search. Every field is a measured
 *  quantity the loop reads — the Oracle reports, it does not decide. */
export interface OracleResult {
  /** The forged counter-strategy (its id is content-addressed by the caller; here
   *  it carries a search-local id derived from the winning vec). */
  strategy: Strategy
  /** The best-response payoff: Σ_j mixture[j] · payoff(candidate, pop[j]), where
   *  payoff is centered win-rate from `hand.evaluate` (external measurement). */
  br_value: number
  /** br_value − game_value. How much the counter beats the current mixture. The
   *  loop reads this; the Oracle does not gate on it. */
  beats_margin: number
  /** Min L2 distance from the counter's vec to any existing pop vec > epsilon.
   *  A non-novel "best response" is a near-duplicate of something already in the
   *  population — the loop should not grow on it. Measured, not asserted. */
  novel: boolean
}

export interface BestResponseOpts {
  /** 1-dim grid resolution (psro_min default 2001 → step 1/2000). */
  grid?: number
  /** Per-axis samples for the higher-dim coarse search (deterministic lattice). */
  samplesPerAxis?: number
  /** Novelty threshold: min L2 distance to any pop vec to count as novel. */
  epsilon?: number
  /** Search range per axis [lo, hi] (ToyHand strategies live in [0,1]). */
  range?: [number, number]
}

const DEFAULTS = {
  grid: 2001,
  samplesPerAxis: 11,
  epsilon: 1e-3,
  range: [0, 1] as [number, number],
}

/** Van der Corput sequence in a given base — a deterministic low-discrepancy
 *  generator (no RNG state, no Math.random). Index n → a point in [0,1). Used to
 *  spread higher-dim candidate samples evenly without randomness, so the search is
 *  reproducible (matches psro_min determinism). */
function vanDerCorput(n: number, base: number): number {
  let q = 0
  let bk = 1 / base
  let i = n
  while (i > 0) {
    q += (i % base) * bk
    i = Math.floor(i / base)
    bk /= base
  }
  return q
}

const HALTON_BASES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]

/** L2 distance between two equal-padded vectors (shorter padded with 0). */
function l2(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  let s = 0
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    s += d * d
  }
  return Math.sqrt(s)
}

/** Centered payoff against one opponent: winrate_ppm/1e6 − 0.5 ∈ [−0.5, 0.5].
 *  The Hand measures the win-rate (EXTERNAL); the Oracle only centers it — it does
 *  not compute the game outcome itself. */
async function payoffAgainst(hand: Hand, candidate: Strategy, opp: Strategy): Promise<number> {
  const { winrate_ppm } = await hand.evaluate(candidate, opp, 1)
  return winrate_ppm / 1_000_000 - 0.5
}

/** Expected centered payoff of a candidate against the opponent mixture over the
 *  population: Σ_j mixture[j] · payoff(candidate, pop[j]). All payoffs measured by
 *  the Hand (external). */
async function expectedPayoff(
  hand: Hand,
  candidate: Strategy,
  pop: Strategy[],
  mixture: number[],
): Promise<number> {
  let v = 0
  for (let j = 0; j < pop.length; j++) {
    const w = mixture[j] ?? 0
    if (w === 0) continue
    v += w * (await payoffAgainst(hand, candidate, pop[j]))
  }
  return v
}

/** Forge the best response to the opponent's current mixture over the population.
 *
 *  For a 1-dim search space (ToyHand: only vec[0] is read) this is psro_min.py's
 *  exact grid brute-force (105-112). For higher dims it is a deterministic Halton
 *  coarse sample over the per-axis range — reproducible, no Math.random.
 *
 *  @param pop      the current population.
 *  @param mixture  opponent's mixture over `pop` (game_value below is min column).
 *  @param hand     the EXTERNAL measurement organ; the Oracle never scores itself.
 *  @param opts     search resolution + novelty epsilon + per-axis range.
 *  @param gameValue the Cartographer's game value for the current mixture, so the
 *                   loop can read beats_margin = br_value − game_value. Defaults to
 *                   0 (symmetric zero-sum equilibrium value) if omitted.
 *  @returns the forged counter + its MEASURED beats_margin and novel flag. */
export async function bestResponse(
  pop: Strategy[],
  mixture: number[],
  hand: Hand,
  opts: BestResponseOpts & { gameValue?: number } = {},
): Promise<OracleResult> {
  const grid = opts.grid ?? DEFAULTS.grid
  const samplesPerAxis = opts.samplesPerAxis ?? DEFAULTS.samplesPerAxis
  const epsilon = opts.epsilon ?? DEFAULTS.epsilon
  const [lo, hi] = opts.range ?? DEFAULTS.range
  const gameValue = opts.gameValue ?? 0

  if (pop.length === 0) {
    throw new Error("bestResponse: INSUFFICIENT — empty population, nothing to respond to")
  }

  // Dimensionality = the widest vec in the population (the candidate must live in
  // the same space the Hand interprets). ToyHand reads only vec[0] → dim 1.
  const dim = Math.max(1, ...pop.map((s) => s.vec.length))

  let bestVec: number[] = []
  let bestVal = -Infinity

  if (dim === 1) {
    // psro_min.py:105-112 — exact grid brute-force over the scalar in [lo, hi].
    for (let k = 0; k < grid; k++) {
      const s = lo + ((hi - lo) * k) / (grid - 1)
      const candidate: Strategy = { id: `br:${s}`, vec: [s] }
      const v = await expectedPayoff(hand, candidate, pop, mixture)
      if (v > bestVal) {
        bestVal = v
        bestVec = [s]
      }
    }
  } else {
    // Higher-dim coarse search: a deterministic Halton lattice of candidates. The
    // total sample count is samplesPerAxis^? capped — we walk a single Halton
    // sequence so cost stays linear, not exponential, in dim (anti-blowout).
    const total = Math.max(samplesPerAxis * dim, samplesPerAxis)
    for (let idx = 1; idx <= total; idx++) {
      const vec: number[] = []
      for (let d = 0; d < dim; d++) {
        const base = HALTON_BASES[d % HALTON_BASES.length]
        const u = vanDerCorput(idx, base)
        vec.push(lo + (hi - lo) * u)
      }
      const candidate: Strategy = { id: `br:${idx}`, vec }
      const v = await expectedPayoff(hand, candidate, pop, mixture)
      if (v > bestVal) {
        bestVal = v
        bestVec = vec
      }
    }
  }

  // MEASURED novelty: min L2 distance from the winner to any pop vec.
  let minDist = Infinity
  for (const s of pop) {
    const d = l2(bestVec, s.vec)
    if (d < minDist) minDist = d
  }

  const strategy: Strategy = { id: `br:${bestVec.map((x) => x.toFixed(6)).join(",")}`, vec: bestVec }
  return {
    strategy,
    br_value: bestVal,
    beats_margin: bestVal - gameValue,
    novel: minDist > epsilon,
  }
}
