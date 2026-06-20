"""A/B: does card-aware augury beat prize-only? Both as PIMC (seat 0) vs a greedy baseline (seat 1),
N matches each, win-rate + Wilson 95% CI (honest about no-seed variance). linux/amd64.
"""
import math
import os
import sys

sys.path.insert(0, "/app")        # cabt package
sys.path.insert(0, "/app/cg_src")  # cg package + deck.csv

from cg import game
from cabt import policy
from cabt.policy import greedy_baseline

deck = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]


def pimc_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    return policy.pimc_select(obs, deck, n_worlds=3) or greedy_baseline(sel)


def greedy_agent(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


def play(a0, a1):
    obs, _ = game.battle_start(deck, deck)
    try:
        for _ in range(4000):
            if obs is None:
                return None
            cur, sel = obs.get("current"), obs.get("select")
            if cur is not None and cur.get("result", -1) != -1:
                return cur.get("result")
            if sel is None:
                return None
            you = cur["yourIndex"] if cur is not None else 0
            pick = (a0 if you == 0 else a1)(obs)
            if not pick:
                pick = [0] if (sel.get("option")) else []
            obs = game.battle_select(pick)
        return None
    finally:
        game.battle_finish()


def wilson(w, n):
    if not n:
        return (0.0, 0.0)
    p = w / n
    z = 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - m), min(1.0, c + m))


N = 20
print("A/B: PIMC(seat0) vs greedy(seat1), N=%d per mode" % N, flush=True)
for mode in ("prize_only", "card_aware"):
    os.environ["CABT_AUGURY"] = mode
    wins = 0
    for i in range(N):
        if play(pimc_agent, greedy_agent) == 0:
            wins += 1
        if (i + 1) % 5 == 0:
            print("  %s %d/%d" % (mode, i + 1, N), flush=True)
    lo, hi = wilson(wins, N)
    print("RESULT mode=%-11s wins=%2d/%d winrate=%.2f CI95=[%.2f,%.2f]" % (mode, wins, N, wins / N, lo, hi), flush=True)
print("AB_DONE", flush=True)
