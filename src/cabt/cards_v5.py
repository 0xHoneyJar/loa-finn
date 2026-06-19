"""cards_v5 — the A.8 thin card accessors required by heuristic_v5 (GYGAX spec §A.8).

Every accessor is a *read* over the same in-engine card DB that `cards.py` already loads
(`cg.api.all_card_data()` / `all_attack()` cached in `cards._CARDS` / `cards._ATTACKS`). We reuse
that cache via `cards._ensure()` so there is ONE engine load, not two.

Hard contract (GYGAX §A.8, mirrors `cards.py:13-23`): **degrade-to-zero / degrade-to-None on missing
data.** A card the DB doesn't know about makes its feature term 0, never crashes a match
(`agent.py:89-90` is the last-resort net; these accessors are the first).

Grounding — every field below cites `.cabt-spike/dl/cg/api.py`:
  - `CardData.basic / stage1 / stage2`   api.py:473-475   (is_basic / is_stage1 / is_stage2)
  - `CardData.ex / megaEx`               api.py:476-477   (is_ex / is_megaEx — prize liability)
  - `CardData.retreatCost`               api.py:467       (retreat_cost)
  - `CardData.weakness / resistance`     api.py:470-471   (weakness_type / resistance_type)
  - `CardData.energyType`                api.py:472       (card_energy_type)
  - `Attack.energies`                    api.py:490       (attack_costs / attack_cost_count)
  - `Attack.damage`                      api.py:489       (re-exported attack_damage, see cards.py:45)
"""
from __future__ import annotations

from . import cards as _cards

# EnergyType ints (cg/api.py:25-37) — RAINBOW matches every type; COLORLESS is filler in attack costs.
COLORLESS = 0
RAINBOW = 10
TEAM_ROCKET = 11  # PSYCHIC(5) and DARKNESS(7) (cg/api.py:37)


def _card(card_id):
    """The CardData object for a cardId, or None. Reuses cards.py's single engine cache."""
    if card_id is None:
        return None
    _cards._ensure()
    cmap = _cards._CARDS or {}
    return cmap.get(card_id)


def _attack(attack_id):
    """The Attack object for an attackId, or None. Reuses cards.py's single engine cache."""
    if attack_id is None:
        return None
    _cards._ensure()
    amap = _cards._ATTACKS or {}
    return amap.get(attack_id)


# --- stage flags (A.3 development) — CardData.basic/stage1/stage2 (api.py:473-475) ---

def is_basic(card_id) -> bool:
    c = _card(card_id)
    return bool(c and getattr(c, "basic", False))


def is_stage1(card_id) -> bool:
    c = _card(card_id)
    return bool(c and getattr(c, "stage1", False))


def is_stage2(card_id) -> bool:
    c = _card(card_id)
    return bool(c and getattr(c, "stage2", False))


# --- prize liability (A.2) — CardData.ex/megaEx (api.py:476-477) ---

def is_ex(card_id) -> bool:
    c = _card(card_id)
    return bool(c and getattr(c, "ex", False))


def is_megaEx(card_id) -> bool:
    c = _card(card_id)
    return bool(c and getattr(c, "megaEx", False))


def prize_value(card_id) -> int:
    """Prizes the OPPONENT takes when this Pokémon is KO'd (api.py:476-478, documented payouts):
    megaEx -> 3, ex -> 2, otherwise -> 1. Degrades to 1 (a normal KO) on missing data — a safe,
    non-crashing default that never invents extra prize liability."""
    c = _card(card_id)
    if c is None:
        return 1
    if getattr(c, "megaEx", False):
        return 3
    if getattr(c, "ex", False):
        return 2
    return 1


# --- retreat (A.5) — CardData.retreatCost (api.py:467) ---

def retreat_cost(card_id) -> int:
    c = _card(card_id)
    if c is None:
        return 0
    rc = getattr(c, "retreatCost", 0)
    try:
        return int(rc or 0)
    except (TypeError, ValueError):
        return 0


# --- weakness / resistance (A.6) — CardData.weakness/resistance (api.py:470-471) ---

def weakness_type(card_id):
    """The opponent's weakness EnergyType (int), or None. None = no weakness term applies (A.6)."""
    c = _card(card_id)
    if c is None:
        return None
    return getattr(c, "weakness", None)


def resistance_type(card_id):
    """The opponent's resistance EnergyType (int), or None."""
    c = _card(card_id)
    if c is None:
        return None
    return getattr(c, "resistance", None)


def card_energy_type(card_id):
    """A Pokémon's printed type (CardData.energyType, api.py:472), or None. Used as the
    attack's type proxy for weakness/resistance matching (A.6) when an attack carries no
    distinct color (most attacks are typed by their Pokémon)."""
    c = _card(card_id)
    if c is None:
        return None
    return getattr(c, "energyType", None)


# --- attack affordability / cost (A.4, A.6) — Attack.energies (api.py:490) ---

def attack_costs(attack_id) -> list[int]:
    """The energy cost list for an attack (Attack.energies, api.py:490) — a list of EnergyType ints,
    one entry per required energy unit (COLORLESS=0 is a wildcard slot). Empty list on missing data."""
    a = _attack(attack_id)
    if a is None:
        return []
    energies = getattr(a, "energies", None) or []
    try:
        return [int(e) for e in energies]
    except (TypeError, ValueError):
        return []


def attack_cost_count(attack_id) -> int:
    """Total number of energy units an attack needs (len of Attack.energies). 0 on missing data —
    an attack we can't price reads as 'free', which only ever *reduces* an affordability bonus,
    never invents one (degrade-to-zero contract)."""
    return len(attack_costs(attack_id))


def attack_damage(attack_id) -> int:
    """Re-export of cards.attack_damage (cards.py:45) for a single import surface in heuristic_v5."""
    return _cards.attack_damage(attack_id)


# --- type matching helpers (A.4 cost-matching, A.6 weakness) ---

def energy_satisfies(have_type: int, need_type: int) -> bool:
    """Does an energy of type `have_type` satisfy a cost slot requiring `need_type`?

    Rules grounded in EnergyType (api.py:25-37):
      - COLORLESS cost slot (need=0): any energy satisfies it (filler).
      - RAINBOW energy (have=10): satisfies any color (api.py:36 'Every Types').
      - TEAM_ROCKET energy (have=11): satisfies PSYCHIC(5) or DARKNESS(7) (api.py:37).
      - otherwise: exact type match.
    """
    if need_type is None or have_type is None:
        return False
    if need_type == COLORLESS:
        return True
    if have_type == RAINBOW:
        return True
    if have_type == TEAM_ROCKET:
        return need_type in (5, 7)
    return have_type == need_type


def energy_progress(have_energies: list[int], attack_id) -> float:
    """Fraction in [0,1] of an attack's cost already covered by `have_energies` (A.4 cost-matching
    gradient). Greedily matches each have-energy to an unfilled cost slot (colored slots first, then
    colorless). 1.0 means the attack is affordable now; 0.0 means no progress / unknown cost.

    Degrade-to-zero: unknown attack (empty cost) -> returns 1.0 (a 0-cost attack is 'affordable'),
    but callers gate on `attack_cost_count > 0` before treating that as a real ramp signal."""
    costs = attack_costs(attack_id)
    if not costs:
        return 1.0  # nothing required -> trivially satisfied (caller decides if that's meaningful)
    have = list(have_energies or [])
    # Colored slots are harder to fill than colorless wildcards — fill them first.
    colored = [c for c in costs if c != COLORLESS]
    colorless = [c for c in costs if c == COLORLESS]
    filled = 0
    remaining = list(have)
    for slot in colored:
        for i, e in enumerate(remaining):
            if energy_satisfies(e, slot):
                filled += 1
                remaining.pop(i)
                break
    # Any leftover energy fills colorless wildcard slots.
    for _ in colorless:
        if remaining:
            remaining.pop(0)
            filled += 1
    return filled / len(costs)
