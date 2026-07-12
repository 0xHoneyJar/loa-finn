"""Augury — position value for search-leaf evaluation.

Prize differential ALWAYS dominates (you win when YOUR prize count reaches 0). On top of that, a bounded
board term — selectable via `CABT_AUGURY`:
  - `prize_only` (DEFAULT): bounded raw-HP tie-break. The current floor.
  - `card_aware`: HP-fraction + KO-threat (can I KO their active? can they KO mine?) from card data.

**A/B result (2026-06-18, N=20 PIMC-vs-greedy): `card_aware` REGRESSED — 0.30 win-rate vs `prize_only`'s
0.70 (worse than greedy itself).** The KO heuristic misleads: `best_attack_damage` ignores energy cost
(credits unaffordable attacks), the weakness ×2 is a crude proxy, and a 1-ply "KO threat" is illusory
before the opponent responds; the ±0.9 board term then dominates early-game move choice. So `card_aware`
is NOT promoted — it needs energy-aware damage + correct weakness + deeper search (Sprint 2). Both board
terms are capped below one prize, so neither reorders a prize-taking option.

Operates on the `cg.api` State dataclass returned by the search.
"""
from __future__ import annotations

import os

from . import cards as _cards

WIN = 1000.0
_HP_SCALE = 2000.0   # prize_only mode
_HP_CAP = 0.5
_BOARD_CAP = 0.9     # card_aware board term, still < 1 prize


def _active(player):
    a = getattr(player, "active", None) or []
    return a[0] if a and a[0] is not None else None


def _prize_only_term(me, opp) -> float:
    my_hp = sum((p.hp or 0) for p in (me.active or []) if p is not None)
    opp_hp = sum((p.hp or 0) for p in (opp.active or []) if p is not None)
    return max(-_HP_CAP, min(_HP_CAP, (my_hp - opp_hp) / _HP_SCALE))


def _card_aware_term(me, opp) -> float:
    ma, oa = _active(me), _active(opp)
    if ma is None or oa is None:
        return 0.0
    board = 0.0
    my_frac = (ma.hp or 0) / max(1, (ma.maxHp or 1))
    opp_frac = (oa.hp or 0) / max(1, (oa.maxHp or 1))
    board += 0.3 * (my_frac - opp_frac)

    my_dmg = _cards.best_attack_damage(ma.id)
    if _cards.has_weakness(oa.id):
        my_dmg *= 2  # weakness proxy (engine specifics vary; ×2 is a floor approximation)
    opp_dmg = _cards.best_attack_damage(oa.id)
    if _cards.has_weakness(ma.id):
        opp_dmg *= 2

    if my_dmg > 0 and my_dmg >= (oa.hp or 0):
        board += 0.45   # I threaten a KO next turn
    if opp_dmg > 0 and opp_dmg >= (ma.hp or 0):
        board -= 0.45   # they threaten a KO of my active

    return max(-_BOARD_CAP, min(_BOARD_CAP, board))


def position_value(state, you: int, mode: str | None = None) -> float:
    """Value from player `you`'s perspective; higher is better. `state` is a `cg.api` State (or None)."""
    if state is None:
        return 0.0
    result = getattr(state, "result", -1)
    if result is not None and result != -1:
        return WIN if result == you else -WIN

    players = state.players
    me, opp = players[you], players[1 - you]
    value = float(len(opp.prize or []) - len(me.prize or []))  # dominant signal

    mode = mode or os.environ.get("CABT_AUGURY", "prize_only")  # prize_only won the A/B (see module docstring)
    value += _prize_only_term(me, opp) if mode == "prize_only" else _card_aware_term(me, opp)
    return value
