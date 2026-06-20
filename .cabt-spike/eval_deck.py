"""Deck A/B: Mega Lucario ex deck vs the stock sample deck, SAME PIMC engine, both seats (cancels
first-player advantage). N matches per seat, Lucario overall win-rate + Wilson 95% CI. linux/amd64."""
import math
import os
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
os.environ["CABT_AUGURY"] = "prize_only"
os.environ["CABT_ROLLOUT"] = "0"

from cg import game
from cabt import policy
from cabt.policy import greedy_baseline

_CAND = os.environ.get("CABT_TEST_DECK", "/app/decks/lucario.csv")
_NAME = os.environ.get("CABT_DECK_NAME", "candidate")
lucario = [int(l) for l in open(_CAND) if l.strip()]
sample = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]
print("decks: %s=%d sample=%d" % (_NAME, len(lucario), len(sample)), flush=True)


def make_pimc(deck):
    def a(obs):
        sel = obs.get("select")
        if not sel:
            return []
        return policy.pimc_select(obs, deck, n_worlds=8) or greedy_baseline(sel)
    return a


def play(deck0, deck1, a0, a1):
    obs, _ = game.battle_start(deck0, deck1)
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


N = 15
luc, smp = make_pimc(lucario), make_pimc(sample)
w0 = w1 = 0
for i in range(N):  # Lucario = seat 0
    if play(lucario, sample, luc, smp) == 0:
        w0 += 1
print("  seat0 (Lucario) %d/%d" % (w0, N), flush=True)
for i in range(N):  # Lucario = seat 1
    if play(sample, lucario, smp, luc) == 1:
        w1 += 1
print("  seat1 (Lucario) %d/%d" % (w1, N), flush=True)
total, wins = 2 * N, w0 + w1
lo, hi = wilson(wins, total)
print("RESULT Lucario-vs-sample (both PIMC n_worlds=8): overall %d/%d winrate=%.2f CI95=[%.2f,%.2f]" % (
    wins, total, wins / total, lo, hi), flush=True)
print("DECK_AB_DONE", flush=True)
