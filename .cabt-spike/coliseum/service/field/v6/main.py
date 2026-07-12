# Reference-field agent: v6 (v4 + energy_economy_term) on the Abomasnow deck. Runs as a hardened
# subprocess worker, symmetric with submissions (SDD R1). A mid-strength reference for Elo placement.
import os, sys
for _p in (os.environ.get("OUR_CG"), os.environ.get("CHAMPION_LIBS", "/app"), os.getcwd()):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")
from cabt import heuristic_v6
from cabt.policy import greedy_baseline

_HERE = os.path.dirname(os.path.abspath(__file__))
_DECK = [int(l) for l in open(os.path.join(_HERE, "deck.csv")) if l.strip()]


def agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    try:
        out = heuristic_v6.choose(obs, _DECK)
    except Exception:
        out = None
    return out if out else greedy_baseline(sel)
