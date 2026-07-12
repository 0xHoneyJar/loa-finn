"""Determinized forward-search over the competition `cg.api` (the FR-2 substrate).

`cg.api` loads the Linux engine (`libcg.so`) at import, so it is imported LAZILY here — this module
imports on any OS; only *calling* the search touches the engine (Linux x86-64 only).

Determinization (proven by LB agents: g-kari PIMC, belatijagad ISMCTS): sample the opponent's hidden
zones from a shuffled mirror-deck. Rev 2 (flatline fold 2026-06-17): draw the hidden zones WITHOUT
replacement (disjoint hand/prize/active/deck — no impossible "same card in two zones" worlds) and size
`opponent_deck`/`your_deck` to the *public* `deckCount` (the engine length-checks each list; the prior
full-60 `opponent_deck` could fail mid-game and silently degrade to greedy).
"""
from __future__ import annotations

import random
from typing import Any


def _sample_side(deck: list[int], hand_n: int, prize_n: int, deck_n: int,
                 want_active: bool, rng: random.Random) -> dict[str, list[int]]:
    """Disjoint draw (no replacement) of hidden zones from a shuffled mirror pool, sized to public counts."""
    pool = list(deck)
    rng.shuffle(pool)
    i = 0

    def take(n: int) -> list[int]:
        nonlocal i
        out = pool[i:i + max(0, n)]
        i += max(0, n)
        return out

    hand = take(hand_n)
    prize = take(prize_n)
    active = take(1) if want_active else []
    rest = pool[i:]
    # `deck` must be exactly deck_n; use the disjoint remainder, wrapping only if the pool was too small.
    deck_pred = (rest + pool)[:deck_n] if deck_n else []
    return {"hand": hand, "prize": prize, "active": active, "deck": deck_pred}


def predict_opponent(current: dict[str, Any], deck: list[int], rng: random.Random) -> dict[str, list[int]]:
    """Sample a plausible hidden state -> the hidden-info kwargs for `search_begin`."""
    you = current["yourIndex"]
    me, opp = current["players"][you], current["players"][1 - you]
    opp_active = opp.get("active") or []
    needs_face_down = bool(opp_active) and opp_active[0] is None

    o = _sample_side(deck,
                     int(opp.get("handCount", 0) or 0),
                     len(opp.get("prize") or []),
                     int(opp.get("deckCount", 0) or 0),
                     needs_face_down, rng)
    m = _sample_side(deck,
                     0,  # your hand is public; not predicted
                     len(me.get("prize") or []),
                     int(me.get("deckCount", 0) or 0),
                     False, rng)
    return {
        "your_deck": m["deck"],
        "your_prize": m["prize"],
        "opponent_deck": o["deck"],
        "opponent_prize": o["prize"],
        "opponent_hand": o["hand"],
        "opponent_active": o["active"][:1],  # safe even if pool was empty
    }


def load_search():
    """Lazy-import the competition `cg.api` search functions (loads the Linux engine on first call)."""
    from cg.api import (  # noqa: PLC0415 — intentional lazy import
        search_begin,
        search_step,
        search_end,
        search_release,
        to_observation_class,
    )

    return {
        "begin": search_begin,
        "step": search_step,
        "end": search_end,
        "release": search_release,
        "to_obs": to_observation_class,
    }
