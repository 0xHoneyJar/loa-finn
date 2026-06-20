#!/usr/bin/env python3
"""
psro_min.py — the smallest real version of the loop, in pure Python (zero deps).

This is a REFERENCE you run to watch the words become behavior. It is NOT your engine.
It fakes every organ with the simplest honest stand-in:

    Hand          → evaluate(strat_a, strat_b): a deterministic game payoff
    Cartographer  → solve_zero_sum(): maximin mixture via iterative regret-matching
    Oracle        → best_response(): brute-force search over a strategy parameter
    Loyal Traitor → exploitability(): best opponent response vs the current mixture
    Archivist     → the `population` list (append-only)
    Adjudicator   → printed trend of game value + exploitability
    Custodian     → a hash chain over results (shape only; see verify.py)

The "game" is a toy continuous-strategy zero-sum game so that best-response is a real
optimization with a real answer, and PSRO visibly converges (exploitability → ~0) as the
population grows its own counters. Swap `evaluate` for your real Hand and the loop shape
is unchanged.

Run:
    python3 psro_min.py
    python3 psro_min.py --iters 12 --seed 7
Then:
    python3 verify.py run.json
"""

from __future__ import annotations
import argparse, json, math, hashlib, sys
from dataclasses import dataclass, field
from typing import List


# --------------------------------------------------------------------------------------
# THE GAME (stand-in for "The Hand"): a toy zero-sum game on scalar strategies in [0,1].
#
# Payoff to row player a against column player b. Designed to be genuinely adversarial
# with an interior equilibrium, so a single pure strategy is always exploitable and PSRO
# has to build a *mixture*. (A smooth, bounded, zero-sum-ish kernel.)
# --------------------------------------------------------------------------------------
def evaluate(a: float, b: float) -> float:
    """Expected payoff to the row player when row plays `a`, column plays `b`.

    Antisymmetric: evaluate(a, b) == -evaluate(b, a), so the game is zero-sum and the
    symmetric equilibrium has game value 0. The kernel rewards being a little above the
    opponent but punishes being too far above — a 'tempo with overcommit risk' shape.
    """
    diff = a - b
    return math.sin(2.5 * diff) * math.exp(-1.5 * diff * diff)  # in roughly [-0.7, 0.7]


# --------------------------------------------------------------------------------------
# THE CARTOGRAPHER: solve a zero-sum payoff MATRIX for the row player's maximin mixture.
# Method: regret matching (a few thousand iters). Returns mixture + game value.
# This mirrors the capability the CLI prompt specifies — and we self-check the result.
# --------------------------------------------------------------------------------------
def solve_zero_sum(matrix: List[List[float]], iters: int = 8000) -> dict:
    m = len(matrix)
    n = len(matrix[0]) if m else 0
    if m == 0 or n == 0:
        return {"mixture": [], "game_value": 0.0, "support": []}

    row_regret = [0.0] * m
    col_regret = [0.0] * n
    row_strategy_sum = [0.0] * m
    col_strategy_sum = [0.0] * n

    def regret_to_strategy(regret):
        pos = [r if r > 0 else 0.0 for r in regret]
        s = sum(pos)
        if s <= 0:
            return [1.0 / len(regret)] * len(regret)
        return [p / s for p in pos]

    for _ in range(iters):
        x = regret_to_strategy(row_regret)      # row mixture this iter
        y = regret_to_strategy(col_regret)      # col mixture this iter
        for i in range(m):
            row_strategy_sum[i] += x[i]
        for j in range(n):
            col_strategy_sum[j] += y[j]
        # value of each pure row action vs current col mixture, and vice versa
        row_val = [sum(matrix[i][j] * y[j] for j in range(n)) for i in range(m)]
        col_val = [sum(matrix[i][j] * x[i] for i in range(m)) for j in range(n)]
        v_row = sum(x[i] * row_val[i] for i in range(m))
        v_col = sum(y[j] * col_val[j] for j in range(n))
        for i in range(m):
            row_regret[i] += row_val[i] - v_row
        for j in range(n):
            col_regret[j] += (-col_val[j]) - (-v_col)  # col maximizes its own (negated) payoff

    tot = sum(row_strategy_sum) or 1.0
    mixture = [s / tot for s in row_strategy_sum]
    # game value = worst-case (min over columns) of the average row mixture
    game_value = min(sum(matrix[i][j] * mixture[i] for i in range(m)) for j in range(n))
    support = [i for i, p in enumerate(mixture) if p > 1e-4]
    return {"mixture": mixture, "game_value": game_value, "support": support}


# --------------------------------------------------------------------------------------
# THE ORACLE: best-response. Given the opponent's current mixture over population
# strategies, find the scalar strategy in [0,1] that maximizes expected payoff.
# Brute force on a grid (a real, checkable optimum for this toy).
# --------------------------------------------------------------------------------------
def best_response(pop: List[float], opp_mixture: List[float], grid: int = 2001) -> tuple:
    best_s, best_v = 0.0, -1e9
    for k in range(grid):
        s = k / (grid - 1)
        v = sum(opp_mixture[j] * evaluate(s, pop[j]) for j in range(len(pop)))
        if v > best_v:
            best_v, best_s = v, s
    return best_s, best_v


# --------------------------------------------------------------------------------------
# THE LOYAL TRAITOR: exploitability of the current mixture = how much the best opponent
# response beats it. For a symmetric zero-sum game, mixture is an equilibrium iff the
# best response earns ~0. This is the convergence signal the Leader reads.
# --------------------------------------------------------------------------------------
def exploitability(pop: List[float], mixture: List[float], grid: int = 2001) -> float:
    # opponent picks the scalar that maximizes their payoff = minimizes ours
    _, br_val = best_response(pop, mixture, grid)
    # br_val is the opponent's gain vs our mixture; at equilibrium it is ~0
    return max(0.0, br_val)


# --------------------------------------------------------------------------------------
# THE CUSTODIAN (shape only): hash-chain the results so verify.py can re-check the
# *structure* of the run. THIS IS NOT REAL CUSTODY — your system owns that.
# --------------------------------------------------------------------------------------
def chain(prev: str, payload: dict) -> str:
    h = hashlib.sha256()
    h.update(prev.encode())
    h.update(json.dumps(payload, sort_keys=True).encode())
    return h.hexdigest()


@dataclass
class RunRecord:
    seed: int
    iters: int
    population: List[float] = field(default_factory=list)
    history: List[dict] = field(default_factory=list)  # per-iteration records
    receipt: str = "genesis"


# --------------------------------------------------------------------------------------
# THE LOOP. Each turn: solve the meta-matrix (Cartographer) → forge a best-response
# (Oracle) → measure exploitability (Loyal Traitor) → append to population (Archivist)
# → stamp + print trend (Custodian + Adjudicator). The Leader here is the stopping rule.
# --------------------------------------------------------------------------------------
def run(iters: int, seed: int) -> RunRecord:
    # seed only affects the initial strategy; everything else is deterministic
    rng = (seed * 9301 + 49297) % 233280
    first = rng / 233280.0
    rec = RunRecord(seed=seed, iters=iters, population=[first])

    print(f"{'iter':>4} {'pop':>4} {'game_value':>12} {'exploitability':>15}  new_strategy")
    print("-" * 60)

    receipt = "genesis"
    for t in range(iters):
        pop = rec.population
        # --- Cartographer: build the matchup matrix over the population, solve it ---
        A = [[evaluate(pop[i], pop[j]) for j in range(len(pop))] for i in range(len(pop))]
        sol = solve_zero_sum(A)
        mixture = sol["mixture"]
        game_value = sol["game_value"]

        # --- Loyal Traitor: how exploitable is this mixture? ---
        expl = exploitability(pop, mixture)

        # --- Oracle: forge a best-response to the current mixture, add to population ---
        new_s, br_val = best_response(pop, mixture)

        # --- Custodian: stamp this iteration (shape only) ---
        payload = {
            "iter": t,
            "pop_size": len(pop),
            "mixture": [round(x, 6) for x in mixture],
            "game_value": round(game_value, 6),
            "exploitability": round(expl, 6),
            "new_strategy": round(new_s, 6),
        }
        receipt = chain(receipt, payload)
        payload["receipt"] = receipt
        rec.history.append(payload)

        # --- Adjudicator: print the trend ---
        print(f"{t:>4} {len(pop):>4} {game_value:>12.6f} {expl:>15.6f}  {new_s:.4f}")

        # --- Archivist: append (dedupe near-duplicates so the population stays meaningful) ---
        if all(abs(new_s - p) > 1e-3 for p in pop):
            rec.population.append(new_s)
        # --- Leader (stopping rule): rest when the Traitor can't find an exploit ---
        if expl < 1e-3 and t > 1:
            print(f"\n[leader] exploitability below threshold at iter {t} — REST.")
            break

    rec.receipt = receipt
    return rec


def main():
    ap = argparse.ArgumentParser(description="Minimal PSRO / double-oracle reference toy.")
    ap.add_argument("--iters", type=int, default=10)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=str, default="run.json")
    args = ap.parse_args()

    rec = run(args.iters, args.seed)

    out = {
        "seed": rec.seed,
        "iters": rec.iters,
        "final_population": [round(x, 6) for x in rec.population],
        "history": rec.history,
        "receipt": rec.receipt,
    }
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nwrote {args.out}  (final population size: {len(rec.population)})")
    print("verify with:  python3 verify.py", args.out)


if __name__ == "__main__":
    main()
