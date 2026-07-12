"""Kaggle PTCG Simulation submission entry point — MIRROR SWING (alt): "Enhanced Hammer".

The Kaggle harness loads this file via `exec(code, namespace)` — which runs it WITHOUT `__file__`
defined (kaggle_environments/agent.py:get_last_callable). So we resolve the agent directory
defensively (no bare `__file__`) and make `cabt/` + `cg/` importable, then re-export `agent`.

DECK: the cleanse PB deck with -2 Basic {G} +2 Enhanced Hammer[1081] (deck.csv). Asymmetric mirror
disruption: the 65%-of-field Crustle mirror runs 12 special energies (Mist/Spiky/Grow Grass) — we run the
hate, they don't, stripping their Crustle's fuel. gygax's #2 read: lowest misplay risk (a simple item, no
pilot dependence) → the cleaner mirror lever than Boss+v7. The diversity-pair partner to Boss+v7.

PILOT: v4 — the proven bot-friendly type-only pilot (no hand-dumping liability). agent.py default is v6.
Pre-registered forecast: cleanse-enhanced-hammer-v4-mirror, p=0.40 (logged before eval).
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

os.environ["CABT_POLICY"] = "v4"

from cabt.agent import agent  # noqa: E402  — Kaggle calls this symbol

__all__ = ["agent"]
