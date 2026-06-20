"""FunSearch fitness: the LLM-authored heuristic pilot vs our PIMC search engine, and vs greedy.
Same sample deck both sides (tests the PILOT, not the deck), both seats (cancels first-player edge).
N matches each, heuristic win-rate + Wilson 95% CI. linux/amd64."""
import math
import os
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
os.environ["CABT_AUGURY"] = "prize_only"
os.environ["CABT_ROLLOUT"] = "0"

from cg import game
from cabt import policy, heuristic
from cabt.policy import greedy_baseline

deck = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]


def heuristic_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    out = heuristic.choose(obs, deck)
    return out if out else greedy_baseline(sel)


def pimc_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    return policy.pimc_select(obs, deck, n_worlds=8) or greedy_baseline(sel)


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


def h2h(name, hero, villain, N):
    w0 = sum(1 for _ in range(N) if play(hero, villain) == 0)
    w1 = sum(1 for _ in range(N) if play(villain, hero) == 1)
    tot, wins = 2 * N, w0 + w1
    lo, hi = wilson(wins, tot)
    print("RESULT heuristic vs %-9s %d/%d winrate=%.2f CI95=[%.2f,%.2f] (seat0 %d/%d, seat1 %d/%d)" % (
        name, wins, tot, wins / tot, lo, hi, w0, N, w1, N), flush=True)


N = 15
print("FunSearch v1: LLM-authored heuristic pilot, N=%d per matchup" % N, flush=True)
h2h("greedy", heuristic_agent, greedy_agent, N)
h2h("PIMC(n8)", heuristic_agent, pimc_agent, N)
print("FUNSEARCH_V1_DONE", flush=True)
