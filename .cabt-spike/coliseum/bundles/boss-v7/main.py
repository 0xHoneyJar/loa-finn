"""Kaggle PTCG Simulation submission entry point — BIG SWING 1 ("Mirror Apex").

The Kaggle harness loads this file via `exec(code, namespace)` — which runs it WITHOUT `__file__`
defined (kaggle_environments/agent.py:get_last_callable). So we resolve the agent directory
defensively (no bare `__file__`) and make `cabt/` + `cg/` importable, then re-export `agent`.

DECK: the cleanse PB deck (Crustle wall + Switch + Lumiose Galette status-clear) with -2 Basic {G}
energy +2 Boss's Orders [1182] (deck.csv). The Boss gusts a benched Dwebble (70HP) so Crustle (120)
KOs it BEFORE it evolves = setup-denial + prize tempo in the EV-dominant 65% Crustle mirror.

PILOT: v7 — our own threat-aware pilot. Boss's Orders is the ONE card that activates v7's
Boss-target-best-KO feature (dead in the no-Boss cleanse deck). agent.py default is v6, so force v7.
Pre-registered forecast: cleanse-boss-orders-v7-mirror, p=0.40 (logged before eval).
"""
import os
import sys

_candidates = []
try:
    _candidates.append(os.path.dirname(os.path.abspath(__file__)))
except NameError:
    # Kaggle exec() path: no __file__. The bundle is unpacked to /kaggle_simulations/agent.
    _candidates.append("/kaggle_simulations/agent")
_candidates.append(os.getcwd())
for _p in _candidates:
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

os.environ["CABT_POLICY"] = "v7"

from cabt.agent import agent  # noqa: E402  — Kaggle calls this symbol

__all__ = ["agent"]
