"""Kaggle PTCG Simulation submission entry point.

The Kaggle harness imports this file and calls `agent(obs_dict) -> list[int]`. The submission bundle
ships this `main.py` at the root alongside `cg/` (the competition engine) + `deck.csv` + the `cabt/`
package (our determinized-PIMC engine). We re-export `agent` from `cabt.agent`.
"""
import os
import sys

# Make the bundle root importable so `cabt` (our package) and `cg` (the engine) resolve regardless of cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cabt.agent import agent  # noqa: E402  — Kaggle calls this symbol

__all__ = ["agent"]
