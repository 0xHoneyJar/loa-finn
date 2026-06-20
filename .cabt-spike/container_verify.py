# container_verify.py — tighten the surprising claim (verify-to-bind on our OWN finding).
# The arena said champion ~= coin-flip vs greedy at N=50. Before asserting that, nail it
# with high N + a control (greedy-vs-greedy null) + a skill-vs-luck test (does SEARCH beat
# greedy?). If even PIMC can't beat greedy, the game is variance-dominated and self-play-vs-
# greedy is a near-useless instrument -> the ladder (vs the field) is the only real signal.
import math, os, sys, time

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game
from cabt import heuristic, policy
from cabt.policy import greedy_baseline
from cabt.heuristic import PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END

deck = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]
CHAMPION = {ATTACH: 50.0, EVOLVE: 48.0, PLAY: 45.0, ABILITY: 42.0, ATTACK: 25.0, RETREAT: 10.0, DISCARD: 6.0, END: 2.0}
DEVELOP_MAX = {**CHAMPION, ATTACH: 60.0, EVOLVE: 58.0, ATTACK: 15.0}
MORE_AGGR = {**CHAMPION, ATTACK: 45.0}


def make_agent(priors):
    def agent(obs):
        sel = obs.get("select")
        if not sel:
            return []
        heuristic._BASE = priors
        out = heuristic.choose(obs, deck)
        return out if out else greedy_baseline(sel)
    return agent


def greedy_agent(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


def pimc_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    return policy.pimc_select(obs, deck, n_worlds=4) or greedy_baseline(sel)


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


def h2h(label, a0fac, a1fac, N):
    t = time.time()
    w0 = sum(1 for _ in range(N) if play(a0fac(), a1fac()) == 0)
    w1 = sum(1 for _ in range(N) if play(a1fac(), a0fac()) == 1)
    tot, wins = 2 * N, w0 + w1
    lo, hi = wilson(wins, tot)
    sig = "REAL EDGE" if lo > 0.5 else ("REAL DEFICIT" if hi < 0.5 else "indistinguishable from 0.5")
    print(f"  {label:28s} {wins}/{tot}  wr={wins/tot:.3f}  CI95=[{lo:.3f},{hi:.3f}]  {sig}  ({(time.time()-t)/tot:.2f}s/match)", flush=True)
    return wins / tot, lo, hi


N = int(os.environ.get("VN", "150"))
NP = int(os.environ.get("VN_PIMC", "8"))
ch = lambda: make_agent(CHAMPION)
gd = lambda: greedy_agent
dm = lambda: make_agent(DEVELOP_MAX)
ag = lambda: make_agent(MORE_AGGR)
pi = lambda: pimc_agent

print(f"VERIFY high-N (heuristic N={N}, pimc N={NP})", flush=True)
print("-- control: greedy vs greedy (must be ~0.5 — confirms seat-swap + the noise floor) --", flush=True)
h2h("greedy vs greedy [null]", gd, gd, N)
print("-- the headline claim: is the heuristic actually better than greedy? --", flush=True)
h2h("champion vs greedy", ch, gd, N)
print("-- the best arena candidate, re-measured at high N --", flush=True)
h2h("develop-max vs greedy", dm, gd, N)
h2h("develop-max vs champion", dm, ch, N)
print("-- confirm aggression is reliably worse --", flush=True)
h2h("more-aggressive vs champion", ag, ch, N)
print("-- skill-vs-luck: does SEARCH (PIMC n4) have a real edge over greedy? --", flush=True)
h2h("PIMC(n4) vs greedy", pi, gd, NP)
print("VERIFY_DONE", flush=True)
