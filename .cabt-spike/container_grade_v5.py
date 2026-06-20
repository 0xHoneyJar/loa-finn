# container_grade_v5.py — the payoff: does gygax's structural heuristic_v5 beat v4?
# v5 vs v4 head-to-head on the SAME deck (isolates POLICY) across real decks — if v5 wins
# on MULTIPLE decks (not just one), the structural features genuinely improve play (not
# deck-overfit). Greedy stays a tripwire only. Honest: this is self-play; the ladder judges.
import math, os, sys, time

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game
from cabt import heuristic, heuristic_v5
from cabt.policy import greedy_baseline


def load(p):
    return [int(l) for l in open(p) if l.strip()]


DECKS = {"sample": load("/app/cg_src/deck.csv"), "lucario": load("/app/decks/lucario.csv"), "monofighting": load("/app/decks/monofighting.csv")}


def v5_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    out = heuristic_v5.choose(obs, DECKS["sample"])
    return out if out else greedy_baseline(sel)


def v4_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    out = heuristic.choose(obs, DECKS["sample"])
    return out if out else greedy_baseline(sel)


def greedy_agent(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


def play(a0, a1, d):
    obs, _ = game.battle_start(d, d)
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


def h2h(label, a0, a1, deck, N):
    t = time.time()
    w0 = sum(1 for _ in range(N) if play(a0, a1, DECKS[deck]) == 0)
    w1 = sum(1 for _ in range(N) if play(a1, a0, DECKS[deck]) == 1)
    tot, wins = 2 * N, w0 + w1
    lo, hi = wilson(wins, tot)
    sig = "v5 WINS" if lo > 0.5 else ("v5 LOSES" if hi < 0.5 else "~tie")
    print(f"  {label:30s} {wins}/{tot}  wr={wins/tot:.3f}  CI95=[{lo:.3f},{hi:.3f}]  {sig}  ({(time.time()-t)/tot:.2f}s/m)", flush=True)
    return wins / tot, lo, hi


N = int(os.environ.get("N", "80"))
NT = int(os.environ.get("NT", "40"))
print(f"GRADE heuristic_v5 vs v4 (N={N}), tripwire vs greedy (N={NT})", flush=True)
print("-- v5 vs v4 head-to-head, SAME deck (isolates policy) — win on MULTIPLE decks = real, not overfit --", flush=True)
h2h("v5 vs v4 [monofighting]", v5_agent, v4_agent, "monofighting", N)
h2h("v5 vs v4 [lucario]", v5_agent, v4_agent, "lucario", N)
h2h("v5 vs v4 [sample]", v5_agent, v4_agent, "sample", N)
print("-- tripwire: both must still beat greedy on a real deck --", flush=True)
h2h("v5 vs greedy [monofighting]", v5_agent, greedy_agent, "monofighting", NT)
h2h("v4 vs greedy [monofighting]", v4_agent, greedy_agent, "monofighting", NT)
print("GRADE_DONE", flush=True)
