// src/lab/metabolism/verify.ts — the independent re-checker (SEGMENT C).
//
// verifyRun() is the verify.py-equivalent (reference/verify.py): an INDEPENDENT,
// FAIL-CLOSED check that re-derives a run's claims WITHOUT trusting the values the
// producer wrote. The whole design rests on one rule — believe the receipt, not the
// story. A loop that SAYS it converged and one that DID are different things.
//
// THE DESIGN LAW (anti-fox): verifyRun is a NON-GENERATOR. It owns no ledger writer,
// forges no strategy, solves no matrix — it only RE-DERIVES and COMPARES. It re-runs
// the SAME Hand the loop used (the Hand is a pure measurement organ — re-running it
// on the same strategies must reproduce the stored win-rate). A FAILURE is a
// REFUSAL, never an average (verify.py's "[custodian] refusing this run").
//
// It checks FIVE things, the binding checks the architecture marks:
//   1. CHAIN INTEGRITY — re-walk BOTH ledger chains (population + metabolism) via the
//      REUSED verifyChain (tamper / reorder / delete detectable). We do NOT
//      reimplement the chain walk — we delegate to the Segment A verifiers.
//   2. RE-DERIVED WIN-RATES — re-run hand.evaluate for every stored matchup and
//      compare to the stored winrate_ppm within tolerance. A stored cell that the
//      Hand will not reproduce is a fabricated measurement.
//   3. MIXTURE VALIDITY — every stored mixture sums to 1_000_000 ppm (±tol) and all
//      weights ≥ 0 (a real probability vector in the integer domain).
//   4. SOLVER CONSISTENCY — the central anti-fox check. The mixture / game_value /
//      exploitability are the run's MOST important claims and they live in the
//      un-chained `history` object, so shape alone (check 3) is not enough: a
//      forged-but-well-shaped mixture (all weight on one index) sums to 1e6 with
//      non-negative weights yet does NOT solve the matrix. So we RE-DERIVE the
//      solver's claims from the CHAINED matrix (the custody-stamped win-rate cells,
//      grouped by iteration) and refuse if they diverge. We recompute
//      min_j (Aᵀx)_j (what the stored mixture actually guarantees) and the
//      best-response gain (the residual exploit) using the Cartographer's
//      worst_case_check ARITHMETIC — NOT solveZeroSum's regret iteration — so verify
//      stays a non-generator (it re-derives + compares, it never re-solves).
//   5. CONVERGENCE — exploitability is non-increasing in trend AND the final value
//      is ≤ threshold (the population actually grew counters that worked), AND a
//      claimed REST is STRUCTURALLY sound: the loop only rests past its warm-up
//      (iter > 1) and breaks immediately, so a REST must sit at the natural history
//      tail. This structural gate closes the EARLY false-REST that the check-4(b)
//      population-floor witness cannot see (an out-of-population exploit) — without
//      re-running the Oracle (which would make verify a generator). The residual
//      out-of-population corridor at the converged tail is a documented limit
//      (see VerifyResult), benign because the run did converge there.
//
// DETERMINISTIC: no LLM, no Math.random — verify re-runs the deterministic Hand and
// recomputes integer comparisons. Same record + same Hand ⇒ same verdict.

import type { Hand } from "./hand.js"
import {
  readMetabolism,
  verifyMetabolismChain,
} from "./metabolism-ledger.js"
import {
  readPopulation,
  verifyPopulationChain,
} from "./population-ledger.js"
import { fromMilli, PPM_SCALE, type MatchReceipt } from "./types.js"
import { MICRO_SCALE, type RunRecord } from "./loop.js"

/** The verdict — fail-closed. `valid` is false if ANY check fails; `failures`
 *  enumerates them (a refusal lists its reasons, it does not average them).
 *
 *  KNOWN LIMIT of the convergence binding (do NOT over-trust verify here):
 *  check 4(b)'s exploitability witness is a POPULATION-FLOOR LOWER BOUND — it can
 *  only see exploits that already live IN the current population. An exploit that
 *  lives OUTSIDE the population is invisible to verify without RE-RUNNING the
 *  Oracle, which is forbidden — that would make verify a generator and collapse
 *  the anti-fox separation. Three layers DEFEND the convergence claim despite this:
 *    (1) check 5's REST guards — REST is only legal past the loop's warm-up
 *        (`t > 1`) and only at the natural history tail (the loop breaks
 *        immediately on REST), so a REST claimed before the warm-up or off the tail
 *        did not come from the loop and is refused;
 *    (2) check 4b's custody-vs-history guard — TRUNCATING the history to a still-
 *        exploitable iteration strands the later iterations' match cells in the
 *        ledger, and that surplus is refused (the custody trail records more
 *        iterations than the history claims).
 *  What survives BOTH is a forge that keeps the FULL history and the FULL ledger but
 *  flips one tail iteration's exploitability downward using an out-of-population
 *  exploit. That residual is BENIGN: such a run actually grew the population through
 *  the natural tail and DID converge there. So `valid:true` is a strong, structural
 *  binding of "this loop ran to its honest end and rested correctly" — but a caller
 *  MUST NOT read it as a cryptographic proof that the final mixture is GLOBALLY
 *  unexploitable against strategies the Oracle never searched. */
export interface VerifyResult {
  valid: boolean
  failures: string[]
}

export interface VerifyOpts {
  /** Win-rate re-derivation tolerance, in ppm. The Hand is deterministic so an
   *  exact match is expected; a small band absorbs nothing for ToyHand but lets a
   *  noisier real Hand (CabtHand, seat-swap rounding) pass. Default 0 (exact). */
  winratePpmTol?: number
  /** Mixture-sum tolerance, in ppm. Largest-remainder reconciliation makes the sum
   *  EXACTLY 1_000_000, so default is 0 (exact). */
  mixturePpmTol?: number
  /** Solver-consistency tolerance, in MICRO. The stored game_value_micro /
   *  exploitability_micro are re-derived from the chained matrix + the stored mixture
   *  and must agree with what the mixture ACTUALLY guarantees within this band. The
   *  band absorbs (a) the loop's mixture→ppm largest-remainder quantization (±1 ppm
   *  per weight ⇒ the re-derived value drifts by at most ~½ a payoff unit × that),
   *  (b) the Cartographer's regret-matching convergence slack (CONVERGENCE_TOL = 1e-2
   *  ⇒ 10_000 micro). Default 20_000 micro (=2e-2) — wide enough that an honestly
   *  converged run passes, tight enough that a FORGED mixture (whose true worst-case
   *  is far from the stored claim) is refused. */
  solverConsistencyMicroTol?: number
  /** Convergence trend tolerance, in micro. Allows iteration-to-iteration noise in
   *  the non-increasing check (matches verify.py's `tol`). Default 1000 micro
   *  (=1e-3, verify.py's 1e-4 scaled — generous so a converging-but-jittery run is
   *  not refused, while a run that gets MORE exploitable is). */
  trendMicroTol?: number
  /** Final-exploitability ceiling, in micro. verify.py refuses if final > 0.05; we
   *  default to that (50_000 micro) so a run that "stopped" while still exploitable
   *  is refused even if its trend was technically non-increasing. */
  finalCeilingMicro?: number
}

const DEFAULTS: Required<VerifyOpts> = {
  winratePpmTol: 0,
  mixturePpmTol: 0,
  solverConsistencyMicroTol: 20_000,
  trendMicroTol: 1000,
  finalCeilingMicro: 50_000,
}

/** Independently verify a metabolism run — fail-closed. Re-derives every stored
 *  claim from the ledgers + a fresh Hand replay; a failing check is a refusal.
 *
 *  @param record the RunRecord the loop produced (paths point at its ledgers).
 *  @param hand   the SAME Hand kind the loop used (re-run to re-derive win-rates).
 *  @param opts   tolerances (all default to the strict/verify.py values). */
export async function verifyRun(
  record: RunRecord,
  hand: Hand,
  opts: VerifyOpts = {},
): Promise<VerifyResult> {
  const cfg = { ...DEFAULTS, ...opts }
  const failures: string[] = []

  // ---- 1. CHAIN INTEGRITY (REUSED verifyChain via the Segment A verifiers) -------
  // Both ledgers are re-walked from genesis; any tamper / reorder / delete surfaces
  // as a broken index. We never reimplement the walk — we delegate.
  let populationRecords: Awaited<ReturnType<typeof readPopulation>>["records"] = []
  let matchReceipts: MatchReceipt[] = []
  try {
    const pop = await readPopulation(record.population_path)
    populationRecords = pop.records
    const pv = verifyPopulationChain(pop.envelopes)
    if (!pv.valid) {
      failures.push(`population chain broken at index ${pv.brokenAt}: ${pv.reason}`)
    }
  } catch (err) {
    failures.push(`population ledger unreadable: ${(err as Error).message}`)
  }
  try {
    const meta = await readMetabolism(record.metabolism_path)
    matchReceipts = meta.receipts
    const mv = verifyMetabolismChain(meta.envelopes)
    if (!mv.valid) {
      failures.push(`metabolism chain broken at index ${mv.brokenAt}: ${mv.reason}`)
    }
  } catch (err) {
    failures.push(`metabolism ledger unreadable: ${(err as Error).message}`)
  }

  // ---- 2. RE-DERIVED WIN-RATES (re-run the Hand; do not trust the stored cell) ----
  // Every custody-stamped match receipt names (strategy_a, strategy_b, winrate_ppm).
  // We rehydrate the two strategies from the population ledger (by content id) and
  // re-run hand.evaluate — the Hand is a pure measurement organ, so a stored cell
  // that the Hand will not reproduce is a fabricated measurement → refusal.
  const vecById = new Map<string, number[]>()
  for (const pr of populationRecords) {
    vecById.set(pr.strategy_id, fromMilli(pr.vec_milli))
  }
  for (let k = 0; k < matchReceipts.length; k++) {
    const r = matchReceipts[k]
    const vecA = vecById.get(r.strategy_a)
    const vecB = vecById.get(r.strategy_b)
    if (vecA === undefined || vecB === undefined) {
      failures.push(
        `match ${k}: strategy id not in population ledger (a=${r.strategy_a.slice(0, 8)}…, b=${r.strategy_b.slice(0, 8)}…) — cannot re-derive`,
      )
      continue
    }
    const { winrate_ppm } = await hand.evaluate(
      { id: r.strategy_a, vec: vecA },
      { id: r.strategy_b, vec: vecB },
      r.n_matches,
    )
    if (Math.abs(winrate_ppm - r.winrate_ppm) > cfg.winratePpmTol) {
      failures.push(
        `match ${k}: stored winrate_ppm ${r.winrate_ppm} ≠ re-derived ${winrate_ppm} (tol ${cfg.winratePpmTol}) — fabricated measurement`,
      )
    }
  }

  // ---- 3. MIXTURE VALIDITY (a real probability vector in the integer domain) ------
  for (const it of record.history) {
    let sum = 0
    let negative = false
    for (const w of it.mixture_ppm) {
      sum += w
      if (w < 0) negative = true
    }
    if (Math.abs(sum - PPM_SCALE) > cfg.mixturePpmTol) {
      failures.push(`iter ${it.iter}: mixture_ppm sums to ${sum}, not ${PPM_SCALE} (tol ${cfg.mixturePpmTol})`)
    }
    if (negative) {
      failures.push(`iter ${it.iter}: mixture_ppm has a negative weight`)
    }
    // Every stored field must be integer-domain (no float leaked into history).
    if (!Number.isInteger(it.game_value_micro) || !Number.isInteger(it.exploitability_micro)) {
      failures.push(`iter ${it.iter}: game_value/exploitability not integer micro (float leaked)`)
    }
    if (it.exploitability_micro < 0) {
      failures.push(`iter ${it.iter}: exploitability_micro ${it.exploitability_micro} is negative`)
    }
  }

  // ---- 4. SOLVER CONSISTENCY (re-derive the central claims from the CHAINED matrix) -
  // The mixture / game_value / exploitability live in the un-chained `history`, so we
  // must not trust them on shape alone (check 3). We rebuild each iteration's payoff
  // matrix from the CUSTODY-STAMPED win-rate cells (re-derived, in chain order), then
  // recompute — using the Cartographer's worst_case ARITHMETIC, NOT its solver — what
  // the STORED mixture actually guarantees and how exploitable it really is. A stored
  // claim that diverges from the re-derived truth is a forged solver output → refusal.
  //
  // The metabolism ledger holds, per iteration t, exactly pop_size_t² match cells in
  // the loop's row-major (i, then j) order (loop.ts (a)). We consume the receipts in
  // chain order, slicing pop_size_t² off the front for each history row, so a dropped,
  // extra, or reordered cell ALSO surfaces here (the matrix won't reconstruct).
  let cellCursor = 0
  for (const it of record.history) {
    const n = it.pop_size
    const cellsNeeded = n * n
    const slice = matchReceipts.slice(cellCursor, cellCursor + cellsNeeded)
    if (slice.length !== cellsNeeded) {
      failures.push(
        `iter ${it.iter}: metabolism ledger has ${slice.length} cells for a ${n}×${n} matrix, expected ${cellsNeeded} — cannot re-derive the solver claims`,
      )
      cellCursor += slice.length
      continue
    }
    cellCursor += cellsNeeded

    // Re-derive the CENTERED payoff matrix from the stored (re-derived) win-rate cells:
    // payoff = winrate_ppm/1e6 − 0.5, exactly the loop's centering (loop.ts (a)). We use
    // the STORED winrate_ppm here; check 2 has already proven each one re-derives from
    // the Hand, so this matrix is the Hand's measured truth, not the producer's story.
    const payoff: number[][] = []
    for (let i = 0; i < n; i++) {
      const row: number[] = []
      for (let j = 0; j < n; j++) {
        const cell = slice[i * n + j]
        row.push(cell.winrate_ppm / PPM_SCALE - 0.5)
      }
      payoff.push(row)
    }

    // The stored mixture as floats (ppm → probability). Its SHAPE is already checked
    // (check 3); here we test whether it actually SOLVES the matrix.
    const mixture = it.mixture_ppm.map((w) => w / PPM_SCALE)
    if (mixture.length !== n) {
      failures.push(
        `iter ${it.iter}: mixture has ${mixture.length} weights for a ${n}-strategy population — shape mismatch`,
      )
      continue
    }

    // (a) GAME VALUE WITNESS — min_j (Aᵀx)_j: what the stored mixture actually
    //     guarantees against the best pure column. This is the Cartographer's
    //     worst_case_check.min_column_payoff arithmetic (cartographer.ts:235-253),
    //     re-derived here independently. The solve claimed game_value = this; a forged
    //     mixture's true worst-case is far below its claimed value.
    let minColumnPayoff = Infinity
    for (let j = 0; j < n; j++) {
      let v = 0
      for (let i = 0; i < n; i++) v += payoff[i][j] * mixture[i]
      if (v < minColumnPayoff) minColumnPayoff = v
    }
    const reGameValueMicro = Math.round(minColumnPayoff * MICRO_SCALE)
    if (Math.abs(reGameValueMicro - it.game_value_micro) > cfg.solverConsistencyMicroTol) {
      failures.push(
        `iter ${it.iter}: stored game_value ${it.game_value_micro} micro ≠ re-derived worst-case ${reGameValueMicro} micro (tol ${cfg.solverConsistencyMicroTol}) — the mixture does not solve the matrix (forged solver output)`,
      )
    }

    // (b) EXPLOITABILITY WITNESS — the best PURE-population response's gain against the
    //     stored mixture, floored at 0. The Loyal Traitor measures exploitability via
    //     the Oracle's search over the WHOLE vec space; here verify re-derives a LOWER
    //     BOUND from the population's own strategies (a pure column k earns
    //     −(Aᵀx)_k = the row player's loss to column k). If the population already
    //     contains a strategy that beats the stored mixture by more than the stored
    //     exploitability + tol, the stored exploitability is understated (a forged-low
    //     convergence claim). max_k(−(Aᵀx)_k) = −min_k(Aᵀx)_k = −minColumnPayoff.
    //
    //     KNOWN LIMIT (the non-generator price, also stated on VerifyResult): this
    //     witness is a POPULATION-FLOOR LOWER BOUND. It catches a forged-low
    //     exploitability ONLY when a CURRENT population member already beats the
    //     stored mixture. An out-of-population exploit collapses popExploitFloor to
    //     ~0 and slips past THIS check, because finding it would require RE-RUNNING
    //     the Oracle (forbidden: it would make verify a generator). The dangerous
    //     false-REST cases that exploit this gap are closed elsewhere, structurally:
    //     the EARLY one by check 5's REST warm-up guard, the TRUNCATED one by check
    //     4b's custody-vs-history (stranded-cell) guard. Only a forge that preserves
    //     the full history+ledger and flips a NATURAL-TAIL iteration survives — and
    //     that run did converge, so it is benign.
    const popExploitFloor = Math.max(0, -minColumnPayoff)
    const reExploitFloorMicro = Math.round(popExploitFloor * MICRO_SCALE)
    if (it.exploitability_micro < reExploitFloorMicro - cfg.solverConsistencyMicroTol) {
      failures.push(
        `iter ${it.iter}: stored exploitability ${it.exploitability_micro} micro < population best-response gain ${reExploitFloorMicro} micro (tol ${cfg.solverConsistencyMicroTol}) — exploitability understated (forged-low convergence)`,
      )
    }
  }

  // ---- 4b. CUSTODY-vs-HISTORY: the ledger must not record MORE iterations than history -
  // After consuming pop_size² cells per history row, the cursor must land on the END of
  // the metabolism ledger. TRAILING unconsumed cells mean the custody trail stamped more
  // iterations than the history claims — i.e. the run was TRUNCATED (history sliced short)
  // or re-stamped. This is a SOUND, non-generator guard (it compares two stored artifacts;
  // it re-runs no Oracle), and it closes the residual past-warm-up false-REST corridor the
  // check-4(b) population-floor witness cannot see: a forge that truncates the history to a
  // still-exploitable iter leaves the LATER iterations' cells stranded in the ledger, and
  // that surplus is refused here. (The chain checks in check 1 do NOT catch this — a
  // truncated HISTORY is fully consistent with an intact, longer LEDGER chain.)
  if (cellCursor < matchReceipts.length) {
    failures.push(
      `metabolism ledger holds ${matchReceipts.length} match cells but the history accounts for only ${cellCursor} — ${matchReceipts.length - cellCursor} cells stranded (the custody trail records more iterations than the history; truncated or re-stamped run)`,
    )
  }

  // ---- 5. CONVERGENCE (non-increasing trend AND final ≤ threshold + REST structure) -
  // The population must have grown counters that actually shrink exploitability, AND a
  // claimed REST must be STRUCTURALLY consistent with how the loop actually rests. The
  // loop RESTs (loop.ts:340-349) ONLY when exploitability < threshold && !blocks_
  // convergence && t > 1, and it breaks IMMEDIATELY — so in any honest run a REST is
  // (i) past the warm-up (stopped_at_iter > 1, psro_min.py:196 `t > 1`) and (ii) at the
  // NATURAL TAIL (stopped_at_iter === the last history iter === history.length-1). These
  // are SOUND, non-generator guards: they close the dangerous EARLY false-REST (forge a
  // sub-threshold exploitability at an early, still-exploitable iter and truncate the
  // run) without re-running the Oracle. The population-floor witness (check 4b) cannot
  // see an out-of-population exploit, so this structural gate — not the witness — is what
  // refuses the early-false-convergence attack. (The benign converged-tail residual is
  // documented on VerifyResult; it is not closable without making verify a generator.)
  const expls = record.history.map((h) => h.exploitability_micro)
  if (record.stop_reason === "rest") {
    // (i) WARM-UP: the loop never rests at iter ≤ 1 (the `t > 1` gate). A REST claimed
    //     at the warm-up iterations did not come from the loop's stopping rule.
    if (record.stopped_at_iter <= 1) {
      failures.push(
        `loop reported REST at iter ${record.stopped_at_iter} but the stopping rule requires iter > 1 (warm-up) — a REST this early did not come from the loop (forged early convergence)`,
      )
    }
    // (ii) NATURAL TAIL: the loop breaks immediately on REST, so the REST iteration is
    //      always the last history entry. A REST whose stopped_at_iter is not the final,
    //      contiguous history index means the run was truncated or re-stamped.
    if (expls.length > 0) {
      const lastIter = record.history[record.history.length - 1].iter
      if (record.stopped_at_iter !== lastIter || record.stopped_at_iter !== expls.length - 1) {
        failures.push(
          `loop reported REST at iter ${record.stopped_at_iter} but the history tail is iter ${lastIter} (length ${expls.length}) — REST must be the final, contiguous iteration (truncated or re-stamped run)`,
        )
      }
    }
  }
  if (expls.length > 0) {
    // Non-increasing in trend: the final must beat the first by a clear margin (a run
    // that got MORE exploitable did not converge). verify.py allows ≥3 points before
    // judging the trend; we mirror that (a 1-2 iter run has no trend to refuse).
    const first = expls[0]
    const final = expls[expls.length - 1]
    if (expls.length >= 3 && final > first + cfg.trendMicroTol) {
      failures.push(
        `exploitability did not improve: first ${first} micro → final ${final} micro (population failed to grow useful counters)`,
      )
    }
    // The final value must be small — at/below the run's own threshold, capped by the
    // hard verify.py ceiling. A run that "rested" while still exploitable is refused.
    const thresholdMicro = Math.round(record.threshold * MICRO_SCALE)
    const ceiling = Math.min(cfg.finalCeilingMicro, Math.max(thresholdMicro, 0))
    // If the loop RESTED, the final must honor the threshold; if it hit the cap, the
    // ceiling still applies (a non-converged run is refused either way).
    if (record.stop_reason === "rest" && final > thresholdMicro) {
      failures.push(
        `final exploitability ${final} micro > threshold ${thresholdMicro} micro but loop reported REST — false convergence`,
      )
    }
    if (final > ceiling) {
      failures.push(
        `final exploitability ${final} micro > ceiling ${ceiling} micro — not converged (run more iters, or the game/oracle is mismatched)`,
      )
    }
  } else {
    failures.push("empty history — nothing to verify (the loop produced no iterations)")
  }

  return { valid: failures.length === 0, failures }
}
