"""Kaggle PTCG Simulation submission entry point.

The Kaggle harness loads this file via `exec(code, namespace)` — which runs it WITHOUT `__file__`
defined (kaggle_environments/agent.py:get_last_callable). So we resolve the agent directory
defensively (no bare `__file__`) and make `cabt/` + `cg/` importable, then re-export `agent`.
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

from cabt.agent import agent  # noqa: E402  — Kaggle calls this symbol

__all__ = ["agent"]
