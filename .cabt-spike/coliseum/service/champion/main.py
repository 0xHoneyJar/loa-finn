# The CHAMPION as a Kaggle-shaped bundle (so it runs in a subprocess, SYMMETRIC with the foreign
# agent — see match_runner / SDD R1). Running the champion in-process advantaged it (shared live cg
# state) and made the foreign side lose ~always; symmetric workers fix that. Champion = the v4
# FunSearch type-only heuristic (the 719/807-class pilot) on the Dwebble deck.
import os, sys
for _p in (os.environ.get("OUR_CG"), os.environ.get("CHAMPION_LIBS", "/app"), os.getcwd()):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")
from cabt import heuristic
from cabt.policy import greedy_baseline

_HERE = os.path.dirname(os.path.abspath(__file__))
_DECK = [int(l) for l in open(os.path.join(_HERE, "deck.csv")) if l.strip()]


def agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    try:
        out = heuristic.choose(obs, _DECK)   # v4 — the champion pilot
    except Exception:
        out = None
    return out if out else greedy_baseline(sel)
