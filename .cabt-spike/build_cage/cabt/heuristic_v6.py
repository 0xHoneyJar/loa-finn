"""heuristic_v6 — v4 + ONLY energy_economy_term (the one-term minimal pilot · gygax-picked).

Bot-friendly principle (GAMES-006/008): v5 bundled all SIX structural terms and LOST (563 < v4's 719) —
complexity hurts our crude pilot. So add the MINIMUM. gygax picked energy_economy_term: v4 scores every
ATTACH option flat (_BASE[ATTACH]=50) and breaks ties by LIST INDEX, so it fuels Pokemon arbitrarily; this
term de-randomizes the deck's single most frequent decision toward the attacker closest to affording an
attack (and nudges toward the active wall). It touches ONLY ATTACH options (the term early-returns on every
other type), so v4's proven lethal rule + develop-first ordering + attack-damage shaping are UNCHANGED — the
lowest-blast-radius of v5's six terms.

p ~= 0.30 (gygax): the dominant risk is a WASH — the 35-energy deck has abundant energy (over_attach silences
the term mid-game) and the active is often already v4's index-0 pick. A behavioral A/B (does v6's ATTACH pick
differ from v4's on a meaningful fraction of turns?) gates whether this is even worth a ladder slot.

Drop-in: choose(obs, deck) — identical signature + legality contract to heuristic.choose (heuristic.py:47-62).
Reuses v5's term (no duplication); needs heuristic_v5.py + cards_v5.py + cards.py present in the package.
"""
from __future__ import annotations

from . import cards as _cards
from .heuristic_v5 import energy_economy_term, W_NRG, _safe, _you

# cg.api OptionType values (heuristic.py:15)
PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END = 7, 8, 9, 10, 11, 12, 13, 14

# v4's committed type priors, UNCHANGED (heuristic.py:20).
_BASE = {ATTACH: 50.0, EVOLVE: 48.0, PLAY: 45.0, ABILITY: 42.0, ATTACK: 25.0, RETREAT: 10.0, DISCARD: 6.0, END: 2.0}


def _opp_active_hp(cur):
    # identical to heuristic.py:23-32
    if not cur:
        return None
    players = cur.get("players") or []
    you = cur.get("yourIndex", 0)
    if len(players) < 2:
        return None
    active = players[1 - you].get("active") or []
    a = active[0] if active and active[0] else None
    return a.get("hp") if a else None


def _score(opt, cur) -> float:
    """v4's EXACT _score (heuristic.py:35-44) + the ONE added energy_economy_term (ATTACH-only)."""
    t = opt.get("type")
    s = _BASE.get(t, 20.0)
    # UNCHANGED from v4: attack-damage nudge + lethal rule.
    if t == ATTACK and opt.get("attackId") is not None:
        dmg = _cards.attack_damage(opt["attackId"])
        s += 0.1 * dmg
        ohp = _opp_active_hp(cur)
        if ohp is not None and dmg > 0 and dmg >= ohp:
            s += 1000.0  # lethal
    # THE ONE ADDED TERM (gygax pick): board-aware energy targeting, ATTACH-only. state == cur (the State
    # dict IS obs["current"], heuristic_v5.choose:415). _safe degrades to 0.0 on ANY error, so on a bad obs
    # shape v6 is never worse than v4. For every non-ATTACH option the term returns 0.0 -> identical to v4.
    if cur is not None:
        s += W_NRG * _safe(energy_economy_term, cur, cur, _you(cur), opt)
    return s


def choose(obs, deck):
    """Return option indices (drop-in with heuristic.choose — heuristic.py:47-62)."""
    sel = obs.get("select")
    if sel is None:
        return None
    opts = sel.get("option") or []
    if not opts:
        return []
    cur = obs.get("current")
    n = len(opts)
    minc = int(sel.get("minCount", 0) or 0)
    maxc = int(sel.get("maxCount", 1) or 1)
    k = min(max(maxc, 1), n)
    k = max(k, min(max(minc, 1), n))
    ranked = sorted(range(n), key=lambda i: (-_score(opts[i], cur), i))
    return sorted(ranked[:k])
