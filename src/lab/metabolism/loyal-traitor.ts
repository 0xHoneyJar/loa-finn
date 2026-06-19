// src/lab/metabolism/loyal-traitor.ts — the Loyal Traitor organ (SEGMENT B).
//
// exploitability() measures how much the BEST opponent response beats the current
// mixture. Port of psro_min.py:120-124: the opponent picks the strategy that
// maximizes their payoff (= minimizes ours); exploitability = max(0, that gain).
// For a symmetric zero-sum game the mixture is an equilibrium iff the best response
// earns ≈ 0 — so exploitability is the convergence signal the Leader reads.
//
// THE DESIGN LAW (anti-fox): the Loyal Traitor is a SEPARATE organ from the Oracle
// that forges the population's counters. It is the loyal opposition — its job is to
// find the hole, not to defend the mixture. It is the ACTIVE anti-fox of the loop:
//   blocks_convergence = exploitability > threshold
// While blocks_convergence is true the loop MAY NOT declare converged. The organ
// that generates the population (Oracle) does NOT get to also pronounce it solved;
// a distinct organ measures the residual exploit. The measurement runs through the
// EXTERNAL Hand (via the same best-response search), never a self-score.
//
// DETERMINISTIC: delegates to the Oracle's deterministic search (grid / Halton);
// no LLM, no Math.random.

import type { Hand } from "./hand.js"
import type { Strategy } from "./types.js"
import { bestResponse, type BestResponseOpts } from "./oracle.js"

/** Default convergence threshold — mirrors psro_min.py:196 `expl < 1e-3`. */
export const EXPLOITABILITY_THRESHOLD = 1e-3

/** The Loyal Traitor's verdict on the current mixture. */
export interface ExploitabilityResult {
  /** max(0, best-response payoff vs the mixture). ≈ 0 at equilibrium; the larger
   *  it is, the more a single opponent strategy beats the mixture. */
  exploitability: number
  /** The exploiting strategy the Traitor found — the concrete hole, surfaced so
   *  the Oracle can be pointed at it / the auditor can re-measure it. */
  exploiter: Strategy
  /** exploitability > threshold. While true the loop MAY NOT declare converged
   *  (the active anti-fox). Read by the Leader stopping rule. */
  blocks_convergence: boolean
}

/** Measure the exploitability of a mixture over a population.
 *
 *  Finds the best opponent response (via the EXTERNAL Hand, same search as the
 *  Oracle) and returns its gain against the mixture, floored at 0. The opponent
 *  best-responds against the mixture EXACTLY as the Oracle does (the mixture is
 *  the "opponent mixture" the candidate plays into); br_value is already that gain
 *  because payoff is antisymmetric/centered, so exploitability = max(0, br_value).
 *
 *  @param pop       the current population.
 *  @param mixture   the mixture to test for exploitability.
 *  @param hand      the EXTERNAL measurement organ.
 *  @param threshold convergence threshold (default 1e-3, psro_min).
 *  @param opts      search resolution forwarded to the Oracle's best-response. */
export async function exploitability(
  pop: Strategy[],
  mixture: number[],
  hand: Hand,
  threshold: number = EXPLOITABILITY_THRESHOLD,
  opts: BestResponseOpts = {},
): Promise<ExploitabilityResult> {
  if (pop.length === 0) {
    throw new Error("exploitability: INSUFFICIENT — empty population, nothing to exploit")
  }
  // best-response payoff vs the mixture (gameValue=0: we want the raw gain, not a
  // margin — psro_min returns br_val directly and floors it).
  const br = await bestResponse(pop, mixture, hand, { ...opts, gameValue: 0 })
  const expl = Math.max(0, br.br_value)
  return {
    exploitability: expl,
    exploiter: br.strategy,
    blocks_convergence: expl > threshold,
  }
}
