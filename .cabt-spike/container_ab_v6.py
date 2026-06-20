# gygax's gate: does v6 (v4 + energy_economy_term) actually pick DIFFERENT options than v4?
# This is a BEHAVIORAL-DIVERGENCE check, NOT a strength claim (self-play win-rate is anti-signal).
# If v6's pick == v4's pick on ~every ATTACH-involving decision, the term is a no-op -> a guaranteed wash
# on the ladder -> DON'T spend a submission slot. If it diverges meaningfully, it's a real intervention.
import sys, os, collections
sys.path.insert(0, "/app"); sys.path.insert(0, "/app/cg_src")
os.environ.setdefault("CABT_AUGURY", "prize_only"); os.environ.setdefault("CABT_ROLLOUT", "0")
from cg import game
from cabt import heuristic as v4, heuristic_v6 as v6
from cabt.policy import greedy_baseline

DECK = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]
ATTACH = 8
stats = collections.Counter()

def argmax(scorer, opts, cur):
    return min(range(len(opts)), key=lambda i: (-scorer(opts[i], cur), i))

def pilot(obs):
    sel = obs.get("select"); opts = sel.get("option") or []; cur = obs.get("current")
    if len(opts) > 1 and any(o.get("type") == ATTACH for o in opts):
        stats["attach_decisions"] += 1
        if argmax(v4._score, opts, cur) != argmax(v6._score, opts, cur):
            stats["diverged"] += 1
    out = v6.choose(obs, DECK)
    return out if out else greedy_baseline(sel)

N = int(os.environ.get("N", "30"))
for _ in range(N):
    obs, _ = game.battle_start(DECK, DECK)  # self-play (divergence measure, NOT strength)
    try:
        for _ in range(4000):
            if obs is None: break
            cur, sel = obs.get("current"), obs.get("select")
            if cur is not None and cur.get("result", -1) != -1: break
            if sel is None: break
            pick = pilot(obs)
            if not pick: pick = [0] if sel.get("option") else []
            obs = game.battle_select(pick)
    finally:
        game.battle_finish()

ad = stats["attach_decisions"]; dv = stats["diverged"]
print(f"ATTACH-involving multi-option decisions: {ad}")
print(f"  v6 picked DIFFERENTLY than v4: {dv}  ({100*dv/ad if ad else 0:.1f}%)")
print(f"VERDICT: {'REAL INTERVENTION — worth a ladder slot' if (ad and dv/ad >= 0.05) else 'NO-OP / near-wash — v6 ~= v4, do NOT spend a slot'}")
print("AB_DONE")
