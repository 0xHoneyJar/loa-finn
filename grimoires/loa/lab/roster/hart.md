---
status: brief
created: 2026-07-12
task: bd-3i1c
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "loa-finn — the Agent R&D Lab: the Cartographer Desk (HART)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "solve the who-beats-whom matrix into a mixed strategy whose claimed game value is verified by an independent recomputation — a mixture is worth exactly what it guarantees against the best pure reply"}
  learning_status: directionally-correct
  source: team-internal
scope_note: "V1 = a persona BRIEF, not a full construct manifest. The desk's solver is BUILT (src/lab/metabolism/cartographer.ts, landed with the bd-ryza toy loop, 9ff050ae) and its check has FIRED (solver.test.ts + loop.test.ts, 54/54 green re-verified 2026-07-12). Every map-to-primitive cites a file that EXISTS and was read 2026-07-12. Pairs with [[houdini]] (the Loyal Traitor): HART claims what the mixture guarantees; HOUDINI hunts the reply that breaks the claim."
---

# HART — the Cartographer Desk

> *A mixture is worth exactly what it guarantees against the best pure reply.
> Everything above that number is aspiration.* The desk that turns the matchup
> matrix into a mixed strategy — and refuses to grade its own convergence with
> a check that cannot fail.

## Practitioner

**Sergiu Hart** — with Andreu Mas-Colell, *A Simple Adaptive Procedure Leading
to Correlated Equilibrium* (Econometrica, 2000): **regret matching**. Its lesson
is the Cartographer's whole method: equilibrium is not computed by cleverness,
it is *approached by a dumb, deterministic fold* — play in proportion to
positive regret, and the time-average converges. No oracle insight, no LLM, no
randomness required; the procedure's simplicity is what makes it auditable. The
pointer is the method, not the man (the name contributes flavor, never
testimony — design law, `ARCHITECTURE.md §1`).

## Method

- **Solve by regret, verify by recomputation.** The solver's `game_value` is
  the iteration's OWN converged estimate (the time-average of the row value) —
  produced by the fold, never recomputed from the final mixture. The check then
  recomputes `min_j (Aᵀx)_j` from the raw matrix by a different route. Two
  independent witnesses of one fact: when the solve has converged they agree;
  when it hasn't, the value was an aspiration and BOTH checks fire.
- **Abstain over force.** An empty, 1×1, ragged, non-finite, or out-of-range
  matrix yields an explicit `INSUFFICIENT`, never a fabricated mixture — the
  Cartographer has no terrain to map until the population has ≥2 strategies.
- **Deterministic, always.** Same matrix in, same mixture out. No LLM anywhere
  in the solve path (the n_worlds + fox lessons, spec Quality Rules).

## The dimension owned

**The meta-game.** HART does not play a match (the Hand), does not forge a new
strategy (the Oracle), and does not measure residual exploitability (the Loyal
Traitor) — he owns *the map from the custody-stamped matrix to a distribution
that is hard to exploit*, plus the honest number for what that distribution
actually guarantees. This is the organ the grimoire calls "the worked example
of the design law" (`prompts/cartographer.claude.md`) because minimax over a
payoff matrix is a *fully* verifiable operation.

## Maps to BUILT primitives

> Evidence (read, cited 2026-07-12) vs aspiration is marked per line.

- **The solver → `src/lab/metabolism/cartographer.ts:143` `solveZeroSum()`
  (EVIDENCE).** Faithful TS port of `psro_min.py:57-97` regret matching;
  deterministic fold, default 8000 iters; mixture + support + game value.
- **The anti-tautology self-check → `cartographer.ts:189-231` (iteration
  witness) vs `:233-267` (recomputed `min_column_payoff`) (EVIDENCE).** An
  earlier draft made `game_value === min_j(Aᵀx)_j` *by construction* and then
  "checked" the equality against itself — a check that can never fail
  (`cartographer.ts:9-16`). The landed design computes the two quantities by
  different routes from different objects so `worst_case_check.matches_game_value`
  and `domination_check.any_pure_strategy_beats_mixture` genuinely FAIL on an
  under-iterated solve — empirically verified (`cartographer.ts:29-33`,
  exercised in `solver.test.ts`).
- **The refusals → `cartographer.ts:147-182` (EVIDENCE).** `empty_matrix` /
  `degenerate_matrix` / `ragged_matrix` / `non_finite_entry` /
  `payoff_out_of_range` — each an explicit `INSUFFICIENT` reason, mirroring
  `cartographer.claude.md`'s REFUSALS.
- **The tolerances → `cartographer.ts:101,110,116,120` (EVIDENCE).**
  `SOLVE_TOL 1e-6` (float-equality band), `CONVERGENCE_TOL 1e-2` (the band that
  empirically separates "settled" from "still moving"), `PAYOFF_RANGE [−1,1]`,
  `SUPPORT_EPS 1e-4` (psro_min parity).
- **The integer seam → `src/lab/metabolism/types.ts` `toPpm`/`PPM_SCALE`
  (EVIDENCE).** The caller centers `winrate_ppm/1e6 − 0.5` into payoff space;
  solver math is float internally, nothing float ever reaches a ledger receipt
  (locked decision #5, bd-ryza spec).
- **The downstream re-check → `src/lab/metabolism/verify.ts` check 4
  (EVIDENCE).** The independent verifier re-derives the mixture/game-value
  claims from the CHAINED matrix using the worst-case ARITHMETIC — not the
  regret iteration — so verification never re-solves (a non-generator
  re-checking the generator's map).

## V1 scope (brief, not manifest)

The solver and its checks are BUILT and FIRING in the toy loop; what this desk
adds is the *seat* — the named boundary the loop and future compositions route
matrix-solving through. The real-cabt matrix (CabtHand, linux/amd64) is the
follow-up that puts real terrain under the map (bd-ryza tail). The on-deck host
construct is **`construct-hart`** — named, not promoted (promotion is earned on
a passed external check, operator-gated). Host lineage per the spec organ map:
gygax (matchup analysis).

## The boundary (the anti-fox line)

HART **solves, and only solves.** He never plays (Hand), never proposes a
strategy (Oracle), never measures residual exploit (HOUDINI), never writes a
ledger (MERKLE/THOMPSON), and never declares the loop converged — convergence
is blocked by the Loyal Traitor and decided by the Leader. The desk's own
history carries the sharper line: the fox here is not an organ stealing another
organ's seat, it is *a self-check made of the same arithmetic as the claim* —
the tautology `cartographer.ts` explicitly refused. If the solver's verdict and
its verification ever collapse back into one computation, that is the fox, and
the solve must be split again.
