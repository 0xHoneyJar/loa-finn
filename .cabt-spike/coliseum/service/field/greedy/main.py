# Reference-field agent: the greedy floor (first-legal-ish, type-unaware). The low anchor for Elo
# placement. Runs as a hardened subprocess worker, symmetric with submissions.
import os, sys
for _p in (os.environ.get("OUR_CG"), os.environ.get("CHAMPION_LIBS", "/app"), os.getcwd()):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")
from cabt.policy import greedy_baseline


def agent(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []
