"""FunSearch candidate v1 — an LLM-authored heuristic pilot (NO search).

The leaderboard winners hand-code a pilot like this; here the LLM (main-loop) authors it, and the eval
gate decides if it's kept. Strategy: act PROACTIVELY — prefer attacking (especially for a knockout),
developing the board (evolve/play/attach), and end the turn only as a last resort. This is the iteration
target of the FunSearch loop: measure it, then the LLM mutates the priorities/bonuses toward what wins.

obs option `type` is a `cg.api` OptionType; ATTACK options carry an `attackId` we can look up for lethal.
"""
from __future__ import annotations

from . import cards as _cards

# cg.api OptionType values
PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END = 7, 8, 9, 10, 11, 12, 13, 14

# v2 (grounded 2026-06-18): ATTACK ENDS THE TURN, so don't attack first — DEVELOP first (attach energy,
# evolve, build board), and attack only for a knockout (the +1000 lethal bonus below) or as a last
# pre-END resort. v1 made ATTACK top priority -> attacked every turn before setup -> lost even to greedy.
_BASE = {ATTACH: 50.0, EVOLVE: 48.0, PLAY: 45.0, ABILITY: 42.0, ATTACK: 25.0, RETREAT: 10.0, DISCARD: 6.0, END: 2.0}


def _opp_active_hp(cur):
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
    t = opt.get("type")
    s = _BASE.get(t, 20.0)
    if t == ATTACK and opt.get("attackId") is not None:
        dmg = _cards.attack_damage(opt["attackId"])
        s += 0.1 * dmg
        ohp = _opp_active_hp(cur)
        if ohp is not None and dmg > 0 and dmg >= ohp:
            s += 1000.0  # lethal — always take the knockout (dominates develop)
    return s


def choose(obs, deck):
    """Return option indices for the current decision (or None at deck-selection, handled by the caller)."""
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
