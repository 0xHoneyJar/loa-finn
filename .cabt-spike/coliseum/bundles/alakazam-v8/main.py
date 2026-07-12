"""Kaggle PTCG Simulation submission entry point — BIG SWING 2 ("Powerful Hand").

The Kaggle harness loads this file via `exec(code, namespace)` — which runs it WITHOUT `__file__`
defined (kaggle_environments/agent.py:get_last_callable). So we resolve the agent directory
defensively (no bare `__file__`) and make `cabt/` + `cg/` importable, then re-export `agent`.

DECK: the converged top-tier Alakazam deck (deck.csv, extracted from real winning ladder games) — the
field's empirical apex (60.3% WR, beats our 65%-share Crustle 80%). The COUNTER-META structural swing.

PILOT: v8 — our NEW hand-size-aware "Powerful Hand" pilot. The Alakazam win-con scales with hand size,
so v8 hoards cards then swings with a full hand (fixing the anti-synergy that collapses a flat pilot).
agent.py default is v6, so force v8. Pre-registered forecast: deck-alakazam-v8-powerful-hand, p=0.20
(logged before eval), with a hard pre-screen KILL-GATE.
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

os.environ["CABT_POLICY"] = "v8"

from cabt.agent import agent  # noqa: E402  — Kaggle calls this symbol

__all__ = ["agent"]
