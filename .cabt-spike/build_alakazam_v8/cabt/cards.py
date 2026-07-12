"""Card metadata, loaded once from the engine (`cg.api.all_card_data()` / `all_attack()`).

The card DB is queryable in-engine, so augury needs no offline CSV at match time (the bundled
`EN_Card_Data.csv` is an offline cross-check only). Lazy engine import (Linux-only); degrades to empty
maps if unavailable so card-aware terms simply become 0 rather than crashing.
"""
from __future__ import annotations

_CARDS: dict | None = None   # {cardId: CardData}
_ATTACKS: dict | None = None  # {attackId: Attack}


def _ensure() -> None:
    global _CARDS, _ATTACKS
    if _CARDS is not None:
        return
    try:
        from cg.api import all_card_data, all_attack  # noqa: PLC0415 — lazy (loads engine)
        _CARDS = {c.cardId: c for c in all_card_data()}
        _ATTACKS = {a.attackId: a for a in all_attack()}
    except Exception:
        _CARDS, _ATTACKS = {}, {}


def best_attack_damage(card_id: int) -> int:
    """Max raw printed damage among a card's attacks (energy cost ignored — a floor heuristic)."""
    _ensure()
    c = _CARDS.get(card_id)
    if not c or not getattr(c, "attacks", None):
        return 0
    best = 0
    for aid in c.attacks:
        a = _ATTACKS.get(aid)
        if a is not None:
            best = max(best, int(a.damage or 0))
    return best


def has_weakness(card_id: int) -> bool:
    _ensure()
    c = _CARDS.get(card_id)
    return bool(c and getattr(c, "weakness", None) is not None)


def attack_damage(attack_id: int) -> int:
    """Printed damage of a specific attack (by attackId, e.g. from an ATTACK option). 0 if unknown."""
    _ensure()
    a = _ATTACKS.get(attack_id)
    return int(a.damage or 0) if a is not None else 0


# --- v7 (threat-aware) accessors: typed reads the card_aware term lacked. Additive — v4/v6/augury untouched.

def weakness_type(card_id: int):
    """The card's Weakness energy-type (an int matching another card's energyType), or None."""
    _ensure()
    c = _CARDS.get(card_id)
    return getattr(c, "weakness", None) if c is not None else None


def energy_type(card_id: int):
    """The card's own energy type (matched against a defender's weakness_type for ×2). None if unknown."""
    _ensure()
    c = _CARDS.get(card_id)
    return getattr(c, "energyType", None) if c is not None else None


def prize_value(card_id: int) -> int:
    """Prizes the opponent takes for KO'ing this card: Mega-ex 3, ex 2, else 1."""
    _ensure()
    c = _CARDS.get(card_id)
    if c is None:
        return 1
    if getattr(c, "megaEx", False):
        return 3
    if getattr(c, "ex", False):
        return 2
    return 1


def attack_ids(card_id: int) -> list:
    """The attackIds printed on a card (to read an opponent's threat from its own attacks)."""
    _ensure()
    c = _CARDS.get(card_id)
    return list(getattr(c, "attacks", None) or []) if c is not None else []


def attack_cost(attack_id: int) -> int:
    """Energy units an attack costs (len of its energy list) — for energy-aware affordability."""
    _ensure()
    a = _ATTACKS.get(attack_id)
    return len(getattr(a, "energies", None) or []) if a is not None else 0


def attack_text(attack_id: int) -> str:
    """An attack's effect text (lowercased), for recoil/self-damage detection. '' if unknown."""
    _ensure()
    a = _ATTACKS.get(attack_id)
    return (getattr(a, "text", "") or "").lower() if a is not None else ""
