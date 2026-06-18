"""Augury — position value for search-leaf evaluation.

Floor heuristic (Sprint 1): prize differential DOMINATES (you win when YOUR prize count reaches 0);
active-HP is a strictly bounded tie-break. Card-aware augury (attacks/types/weakness from
`all_card_data()` / `EN_Card_Data.csv`) is Sprint 2. Operates on the `cg.api` State dataclass.

Rev 2 (flatline fold 2026-06-17): the HP term is capped to ±0.5 so it can NEVER outrank a single prize
(prior `0.01 * hp_diff` reached ±3, letting the agent refuse a winning prize to preserve HP).
"""
from __future__ import annotations

WIN = 1000.0
_HP_SCALE = 2000.0  # divides hp_diff; with the clamp below, |HP term| < 1 prize always.
_HP_CAP = 0.5


def position_value(state, you: int) -> float:
    """Value from player `you`'s perspective; higher is better. `state` is a `cg.api` State (or None)."""
    if state is None:
        return 0.0
    result = getattr(state, "result", -1)
    if result is not None and result != -1:
        return WIN if result == you else -WIN

    players = state.players
    me, opp = players[you], players[1 - you]
    my_prizes_left = len(me.prize or [])
    opp_prizes_left = len(opp.prize or [])
    value = float(opp_prizes_left - my_prizes_left)  # dominant signal (~ -6..6)

    my_hp = sum((p.hp or 0) for p in (me.active or []) if p is not None)
    opp_hp = sum((p.hp or 0) for p in (opp.active or []) if p is not None)
    hp_term = (my_hp - opp_hp) / _HP_SCALE
    value += max(-_HP_CAP, min(_HP_CAP, hp_term))  # bounded: never reorders a prize-taking option
    return value
