# fair_pimc.py — close the confound I introduced. Earlier PIMC ran with CABT_ROLLOUT=0
# (no lookahead) and lost to greedy. Give search a FAIR shot: n_worlds=8, real rollout
# depth, a per-move deadline so it doesn't blow up. Question: does ANY skill beat greedy
# in same-deck self-play, or is it conclusively luck-bound (=> the field is the only lever)?
import math, os, sys, time

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ["CABT_ROLLOUT"] = os.environ.get("CABT_ROLLOUT", "3")  # fair lookahead

from cg import game
from cabt import heuristic, policy
from cabt.policy import greedy_baseline
from cabt.heuristic import PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END

deck = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]
CHAMPION = {ATTACH: 50.0, EVOLVE: 48.0, PLAY: 45.0, ABILITY: 42.0, ATTACK: 25.0, RETREAT: 10.0, DISCARD: 6.0, END: 2.0}
NW = int(os.environ.get("NW", "8"))
BUDGET = float(os.environ.get("MOVE_BUDGET", "0.5"))


def champion_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    heuristic._BASE = CHAMPION
    out = heuristic.choose(obs, deck)
    return out if out else greedy_baseline(sel)


def greedy_agent(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


def pimc_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    return policy.pimc_select(obs, deck, n_worlds=NW, deadline=time.monotonic() + BUDGET) or greedy_baseline(sel)


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
    p = w / n
    z = 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - m), min(1.0, c + m))


def h2h(label, a0, a1, N):
    t = time.time()
    w0 = sum(1 for _ in range(N) if play(a0, a1) == 0)
    w1 = sum(1 for _ in range(N) if play(a1, a0) == 1)
    tot, wins = 2 * N, w0 + w1
    lo, hi = wilson(wins, tot)
    sig = "REAL EDGE" if lo > 0.5 else ("REAL DEFICIT" if hi < 0.5 else "indistinguishable from 0.5")
    print(f"  {label:26s} {wins}/{tot}  wr={wins/tot:.3f}  CI95=[{lo:.3f},{hi:.3f}]  {sig}  ({(time.time()-t)/tot:.2f}s/match)", flush=True)


N = int(os.environ.get("N", "15"))
print(f"FAIR PIMC: n_worlds={NW}, CABT_ROLLOUT={os.environ['CABT_ROLLOUT']}, move_budget={BUDGET}s, N={N}", flush=True)
h2h("PIMC vs greedy", pimc_agent, greedy_agent, N)
h2h("PIMC vs champion", pimc_agent, champion_agent, N)
print("FAIR_PIMC_DONE", flush=True)
