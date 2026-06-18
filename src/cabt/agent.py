"""Self-contained cabt agent — the Kaggle Simulation submission entry point.

Contract (certified from the bundled engine + the competition `sample_submission/main.py`):
    agent(obs_dict: dict) -> list[int]
  - `obs_dict["select"] is None`  -> return the 60-card DECK (the deck IS the first action).
  - otherwise                     -> return option indices into `obs_dict["select"]["option"]`.

Move engine: determinized PIMC (`policy.pimc_select`) over `cg.api`, with a per-decision time budget
derived from the obs `remainingOverageTime` (the 10-min per-player chess clock). Match-time
self-contained (no internet/LLM). NEVER crashes a match — any failure -> a legal fallback pick.

Rev 2 (flatline fold 2026-06-17): the deck is loaded+validated ONCE (cached, not per-decision disk I/O,
and a malformed deck.csv can no longer crash deck-selection), and the chess-clock now bounds the search.
"""
from __future__ import annotations

import os
import time
from typing import Any

# A legal 60-card reference deck (the engine's bundled sample — battle_start accepts it). Real
# deck-building (and legality validation against EN_Card_Data.csv) is Sprint 2.
DEFAULT_DECK: list[int] = (
    [721, 721, 722, 722, 722, 722, 723, 723, 723, 723, 1092, 1121, 1121, 1145, 1145,
     1163, 1163, 1219, 1219, 1219, 1219, 1227, 1227, 1227, 1227, 1262, 1262]
    + [3] * 33  # 27 + 33 = 60
)

_DECK_CACHE: list[int] | None = None


def load_deck() -> list[int]:
    """Load+validate the 60-card deck once (cached). Tries $CABT_DECK, deck.csv, the Kaggle agent path;
    never raises — falls back to DEFAULT_DECK on any error."""
    global _DECK_CACHE
    if _DECK_CACHE is not None:
        return _DECK_CACHE
    for candidate in (os.environ.get("CABT_DECK"), "deck.csv", "/kaggle_simulations/agent/deck.csv"):
        if candidate and os.path.exists(candidate):
            try:
                with open(candidate) as f:
                    deck = [int(line.strip()) for line in f if line.strip()][:60]
                if len(deck) == 60:
                    _DECK_CACHE = deck
                    return _DECK_CACHE
            except Exception:
                pass  # malformed file -> fall through to DEFAULT_DECK
    _DECK_CACHE = list(DEFAULT_DECK)
    return _DECK_CACHE


def _legal_fallback(select: dict[str, Any]) -> list[int]:
    opts = select.get("option") or []
    n = len(opts)
    if n == 0:
        return []
    minc = int(select.get("minCount", 0) or 0)
    maxc = int(select.get("maxCount", 1) or 1)
    k = max(1, min(maxc, n))
    k = max(k, min(max(minc, 1), n))
    return list(range(k))


def _decision_deadline(obs_dict: dict[str, Any]) -> float:
    """Per-decision wall-clock budget. The engine enforces ``actTimeout`` (~1s/move) plus a banked
    ``remainingOverageTime`` (~60s) buffer; overrun the bank and you're disqualified (TIMEOUT). So target
    JUST under the per-move actTimeout, and back off hard once the bank is nearly drained."""
    bank = obs_dict.get("remainingOverageTime")
    bank = float(bank) if bank is not None else 60.0
    budget = 0.85 if bank > 5.0 else 0.40  # stay under the ~1s actTimeout; conserve the bank when low
    return time.monotonic() + budget


def agent(obs_dict: dict[str, Any]) -> list[int]:
    select = obs_dict.get("select")
    if select is None:
        return load_deck()  # deck selection: the deck IS the first action
    try:
        from .policy import pimc_select, greedy_baseline  # lazy: engine loads only at match time
        chosen = pimc_select(obs_dict, load_deck(), deadline=_decision_deadline(obs_dict))
        return chosen if chosen else greedy_baseline(select)
    except Exception:
        return _legal_fallback(select)  # never crash a match
