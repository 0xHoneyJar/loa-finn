// src/lab/metabolism/hand.ts — the Hand surface (the organ that MEASURES).
//
// `Hand.evaluate(a, b, nMatches)` returns A's win-rate over B as integer ppm plus
// a custody MatchReceipt. The loop is Hand-agnostic: it asks the Hand to evaluate
// pairs and never inspects strategy internals (locked decision #2, bd-ryza spec).
//
// ANTI-FOX: the Hand ONLY measures. It does not record (the Custodian ledger
// does), it does not decide novelty or convergence (the Oracle/Loyal Traitor in
// segments B/C do). It is a pure measurement organ — its CHECK (ToyHand's
// zero-sum invariant, CabtHand's seat-swap) ships with it.
//
// Two Hands:
//   · ToyHand — deterministic, CI-able. psro_min's antisymmetric kernel realised
//     IN WIN-RATE SPACE, with the exact zero-sum invariant the solver relies on:
//         winrate(a,b) + winrate(b,a) === 1_000_000  (integer-exact).
//   · CabtHand — shells the real cg engine with mandatory SEAT-SWAP. The
//     subprocess is INJECTED (constructor dependency) so the unit test stubs it;
//     we do NOT execute real cabt here (libcg.so is a linux/amd64 slice, verified
//     non-loadable on this darwin host — see the container note below).

import { toPpm, PPM_SCALE, type HandKind, type MatchReceipt, type Strategy } from "./types.js"

/** The 8 heuristic-prior keys, in the order CabtHand maps `vec[0..7]` onto them.
 *  GROUNDED against src/cabt/heuristic.py:20 (`_BASE` dict order):
 *      ATTACH:50, EVOLVE:48, PLAY:45, ABILITY:42, ATTACK:25, RETREAT:10,
 *      DISCARD:6, END:2
 *  NOTE: this is the `_BASE` insertion order, NOT the OptionType integer order on
 *  heuristic.py:15 (PLAY,ATTACH,EVOLVE,ABILITY,DISCARD,RETREAT,ATTACK,END). The
 *  vec axis is the PRIOR weights, so `_BASE` key order is the correct mapping. */
export const HEURISTIC_PRIOR_KEYS = [
  "ATTACH",
  "EVOLVE",
  "PLAY",
  "ABILITY",
  "ATTACK",
  "RETREAT",
  "DISCARD",
  "END",
] as const

export type HeuristicPriorKey = (typeof HEURISTIC_PRIOR_KEYS)[number]

/** The Hand surface. `evaluate` returns A-vs-B win-rate as integer ppm + a
 *  custody receipt over `nMatches` matches (seat-swap-doubled for CabtHand). */
export interface Hand {
  readonly kind: HandKind
  evaluate(
    a: Strategy,
    b: Strategy,
    nMatches: number,
  ): Promise<{ winrate_ppm: number; receipt: MatchReceipt }>
}

// ---------------------------------------------------------------------------
// ToyHand — psro_min's antisymmetric kernel in win-rate space.
// ---------------------------------------------------------------------------

/** psro_min's payoff kernel: payoff(d) = sin(2.5·d)·exp(-1.5·d²), d = a − b.
 *  It is ODD in d (sin is odd, the gaussian is even), so payoff(b,a) = −payoff(a,b)
 *  — the antisymmetry the zero-sum win-rate is built from. */
export function toyPayoff(d: number): number {
  return Math.sin(2.5 * d) * Math.exp(-1.5 * d * d)
}

/** ToyHand win-rate in integer ppm, for d = a.vec[0] − b.vec[0].
 *
 *  payoff ∈ [-1, 1] → win-rate p = payoff/2 + 0.5 ∈ [0, 1] → ppm.
 *
 *  ZERO-SUM, INTEGER-EXACT: we do NOT round both sides independently (two
 *  independent rounds of p(d) and p(−d) can drift the sum by ±1). Instead we round
 *  ONE side and DERIVE the other as `PPM_SCALE − that`. Concretely: compute ppm for
 *  the canonical orientation (d ≥ 0 keeps its own round; d < 0 is the complement of
 *  +|d|'s round). Then winrate(a,b) + winrate(b,a) === 1_000_000 holds exactly for
 *  every pair, because the two ppm values are literally `x` and `1_000_000 − x`.
 *  At d = 0 (a == b) payoff = 0 → p = 0.5 → 500_000, its own complement: a draw. */
export function toyWinratePpm(da: number, db: number): number {
  const d = da - db
  if (d === 0) return PPM_SCALE / 2 // exactly 500_000 — self-play is a draw.
  // Round the POSITIVE-d orientation, derive the negative-d side as its complement.
  // This makes the pair {ppm(+|d|), ppm(-|d|)} = {x, PPM_SCALE - x} by construction.
  const mag = Math.abs(d)
  const pPos = toyPayoff(mag) / 2 + 0.5 // win-rate of the larger-vec player.
  const ppmPos = toPpm(pPos)
  // d > 0 means A's scalar is larger → A is the "+|d|" player → ppmPos.
  // d < 0 means A is the "-|d|" player → the exact complement.
  return d > 0 ? ppmPos : PPM_SCALE - ppmPos
}

/** ToyHand — deterministic, CI-able. Reads only `vec[0]` of each strategy. */
export class ToyHand implements Hand {
  readonly kind: HandKind = "toy"

  async evaluate(
    a: Strategy,
    b: Strategy,
    nMatches: number,
  ): Promise<{ winrate_ppm: number; receipt: MatchReceipt }> {
    if (!Number.isInteger(nMatches) || nMatches < 0) {
      throw new Error(`ToyHand.evaluate: nMatches must be a non-negative integer, got ${nMatches}`)
    }
    const da = a.vec[0] ?? 0
    const db = b.vec[0] ?? 0
    const winrate_ppm = toyWinratePpm(da, db)
    const receipt: MatchReceipt = {
      winrate_ppm,
      n_matches: nMatches,
      hand_kind: "toy",
      strategy_a: a.id,
      strategy_b: b.id,
      ts: Date.now(),
    }
    return { winrate_ppm, receipt }
  }
}

// ---------------------------------------------------------------------------
// CabtHand — shells the real cg engine, with mandatory seat-swap.
// ---------------------------------------------------------------------------

/** The result of running N matches in ONE seat orientation: the count of wins for
 *  the strategy under test. The injected subprocess returns this for each seat. */
export interface SeatRunResult {
  /** Wins for the strategy-under-test in this seat orientation, integer in [0, N]. */
  wins: number
  /** Matches actually played, integer (== N unless the engine aborted some). */
  n: number
}

/** The seat-swap request handed to the injected subprocess runner. `priorsA` /
 *  `priorsB` are the 8 `_BASE` heuristic priors (float weights — the cg engine's
 *  native domain). `seat` names which orientation is being run. */
export interface CabtMatchRequest {
  priorsA: Record<HeuristicPriorKey, number>
  priorsB: Record<HeuristicPriorKey, number>
  nMatches: number
  /** "a-seat0" = A plays seat 0 (A's wins counted); "a-seat1" = A plays seat 1. */
  seat: "a-seat0" | "a-seat1"
}

/** The injected subprocess boundary. The REAL implementation shells the Python cg
 *  match (see the container note on `runRealCabtMatch` below); the UNIT TEST
 *  injects a stub so no real cabt runs. Dependency injection is the seam that
 *  keeps CabtHand testable on a darwin host where libcg.so cannot load. */
export type CabtSubprocessRunner = (req: CabtMatchRequest) => Promise<SeatRunResult>

/** Map a strategy's `vec[0..7]` to the 8 `_BASE` heuristic priors. The vec is the
 *  PRIOR-weight axis (locked decision #2). Missing entries fall back to 0 (the
 *  Oracle proposes full 8-vecs; a short vec is a degenerate strategy, not an
 *  error). The mapping is positional against HEURISTIC_PRIOR_KEYS, which is the
 *  `_BASE` insertion order from src/cabt/heuristic.py:20. */
export function vecToPriors(vec: number[]): Record<HeuristicPriorKey, number> {
  const priors = {} as Record<HeuristicPriorKey, number>
  for (let i = 0; i < HEURISTIC_PRIOR_KEYS.length; i++) {
    priors[HEURISTIC_PRIOR_KEYS[i]] = vec[i] ?? 0
  }
  return priors
}

/** CabtHand — the cg-engine adapter. Shells the Python match with MANDATORY
 *  SEAT-SWAP (locked decision #4 + the Hand-surface grounding): A is run once as
 *  seat 0 and once as seat 1, and the win-rate is `(w0 + w1) / (2N)` — this cancels
 *  the first-player edge (eval_funsearch.py:61-71). The subprocess is INJECTED so
 *  the test can stub it; the real run happens in a linux/amd64 container.
 *
 *  REAL CONTAINER INVOCATION (documented, not executed this session):
 *    The real `CabtSubprocessRunner` shells the cg engine inside the linux/amd64
 *    image that holds libcg.so (libcg.so is a Linux mach-o slice — dlopen on this
 *    darwin host fails with "slice is not valid mach-o file", verified). The
 *    harness mirrors .cabt-spike/eval_funsearch.py: it builds a heuristic agent
 *    from the injected `_BASE` priors, plays `game.battle_start(deck, deck)` /
 *    `game.battle_select(pick)` loops (eval_funsearch.py:40-58) N times per seat,
 *    and returns the per-seat win count. Concretely:
 *      docker run --rm --platform linux/amd64 cabt-eval \
 *        python -c "<priors-injected eval_funsearch harness>"
 *    Both seats share ONE fixed 60-card deck (decks are NOT parameterized —
 *    locked decision #2 grounded reality), so priors are the only live axis. */
export class CabtHand implements Hand {
  readonly kind: HandKind = "cabt"

  /** @param runner injected subprocess boundary (stubbed in tests, real in the
   *                 container). MUST perform exactly the seat run it is asked for. */
  constructor(private readonly runner: CabtSubprocessRunner) {}

  async evaluate(
    a: Strategy,
    b: Strategy,
    nMatches: number,
  ): Promise<{ winrate_ppm: number; receipt: MatchReceipt }> {
    if (!Number.isInteger(nMatches) || nMatches <= 0) {
      throw new Error(`CabtHand.evaluate: nMatches must be a positive integer, got ${nMatches}`)
    }
    const priorsA = vecToPriors(a.vec)
    const priorsB = vecToPriors(b.vec)

    // Mandatory seat-swap: A as seat 0, then A as seat 1.
    const seat0 = await this.runner({ priorsA, priorsB, nMatches, seat: "a-seat0" })
    const seat1 = await this.runner({ priorsA, priorsB, nMatches, seat: "a-seat1" })

    const wins = seat0.wins + seat1.wins
    const total = seat0.n + seat1.n
    if (total <= 0) {
      // Abstain over force: no matches actually resolved → INSUFFICIENT, never a
      // fabricated number (mirrors outcomeToBinary's insufficient→null discipline).
      throw new Error("CabtHand.evaluate: INSUFFICIENT — 0 matches resolved across both seats")
    }
    // winrate_A = (w0 + w1) / (2N). Float division here, integer ppm at the seam.
    const winrate_ppm = toPpm(wins / total)
    const receipt: MatchReceipt = {
      winrate_ppm,
      n_matches: total,
      hand_kind: "cabt",
      strategy_a: a.id,
      strategy_b: b.id,
      ts: Date.now(),
    }
    return { winrate_ppm, receipt }
  }
}
