"""Calibration experiment: the ladder says PIMC n_worlds=4 (585.7) > n_worlds=16 (539.4). Our greedy-based
local A/B ranked them BACKWARDS. Hypothesis: greedy is too weak a sparring bot to resolve the difference.
Run the SAME n4-vs-n16 question three ways and see which agrees with the ladder (n4 > n16):
  (A) head-to-head n4 vs n16
  (B) each vs greedy   (reproduce the miscalibrated method)
  (C) each vs the strong develop-first heuristic
Same sample deck both sides, both seats, Wilson 95% CI. linux/amd64."""
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


def pimc(nw):
    def a(obs):
        sel = obs.get("select")
        if not sel:
            return []
        return policy.pimc_select(obs, deck, n_worlds=nw) or greedy_baseline(sel)
    return a


def heur(obs):
    sel = obs.get("select")
    if not sel:
        return []
    return heuristic.choose(obs, deck) or greedy_baseline(sel)


def greedy(obs):
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
    rate = wins / tot
    print("  %-18s %2d/%d  rate=%.2f  CI95=[%.2f,%.2f]" % (name, wins, tot, rate, lo, hi), flush=True)
    return rate


N = 15
n4, n16 = pimc(4), pimc(16)
print("CALIBRATION: ladder truth = n4 (585.7) > n16 (539.4). Does the local eval agree? N=%d/seat" % N, flush=True)

print("(A) head-to-head:", flush=True)
a_n4_vs_n16 = h2h("n4 vs n16", n4, n16, N)

print("(B) vs greedy (the miscalibrated method):", flush=True)
b_n4 = h2h("n4 vs greedy", n4, greedy, N)
b_n16 = h2h("n16 vs greedy", n16, greedy, N)

print("(C) vs strong heuristic:", flush=True)
c_n4 = h2h("n4 vs heur", n4, heur, N)
c_n16 = h2h("n16 vs heur", n16, heur, N)

print("--- VERDICT (does each method rank n4 > n16, matching the ladder?) ---", flush=True)
print("  (A) head-to-head: n4 beats n16? %s (n4 win-rate %.2f)" % ("YES" if a_n4_vs_n16 > 0.5 else "NO", a_n4_vs_n16), flush=True)
print("  (B) vs greedy:    n4>n16? %s (n4 %.2f vs n16 %.2f)" % ("YES" if b_n4 > b_n16 else "NO", b_n4, b_n16), flush=True)
print("  (C) vs heuristic: n4>n16? %s (n4 %.2f vs n16 %.2f)" % ("YES" if c_n4 > c_n16 else "NO", c_n4, c_n16), flush=True)
print("CALIBRATION_DONE", flush=True)
