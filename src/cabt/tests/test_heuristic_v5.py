"""Self-test for heuristic_v5 (GYGAX spec §A) — runs WITHOUT the cg engine.

The cards_v5 accessors degrade-to-zero when the engine card DB is unavailable (this host), so the
structural terms read 0 and the scorer falls back to _BASE + lethal + the thin damage nudge — exactly
the v4 behavior on a bare obs. That is enough to prove the LEGALITY contract: choose() returns indices
in range, with the legal count (within minCount/maxCount), no duplicates, sorted. The transfer/strength
claims are §B's job (the container), NOT this unit test — we do NOT assert ladder performance here.

Run: python3 -m unittest src.cabt.tests.test_heuristic_v5  (or pytest).
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))

from src.cabt import heuristic_v5  # noqa: E402
from src.cabt.heuristic_v5 import ATTACH, ATTACK, EVOLVE, PLAY, RETREAT, END  # noqa: E402

# AreaType ints (cg/api.py:11-23)
ACTIVE, BENCH = 4, 5


def _pokemon(pid=1000, hp=60, maxHp=60, energies=None):
    """A Pokemon dict shaped per cg/api.py:338-348."""
    return {
        "id": pid, "serial": pid, "hp": hp, "maxHp": maxHp, "appearThisTurn": False,
        "energies": energies if energies is not None else [], "energyCards": [],
        "tools": [], "preEvolution": [],
    }


def _player(active=None, bench=None, benchMax=5, prize=5, **status):
    """A PlayerState dict shaped per cg/api.py:350-364."""
    p = {
        "active": [active] if active is not None else [],
        "bench": bench or [], "benchMax": benchMax, "deckCount": 40,
        "discard": [], "prize": [None] * prize, "handCount": 5, "hand": None,
        "poisoned": False, "burned": False, "asleep": False, "paralyzed": False, "confused": False,
    }
    p.update(status)
    return p


def _state(you=0, players=None, turn=3, **flags):
    """A State dict shaped per cg/api.py:366-379."""
    s = {
        "turn": turn, "turnActionCount": 0, "yourIndex": you, "firstPlayer": 0,
        "supporterPlayed": False, "stadiumPlayed": False, "energyAttached": False, "retreated": False,
        "result": -1, "stadium": [], "looking": None,
        "players": players or [_player(active=_pokemon()), _player(active=_pokemon())],
    }
    s.update(flags)
    return s


def _opt(otype, **kw):
    """An Option dict shaped per cg/api.py:381-396."""
    o = {"type": otype, "number": None, "area": None, "index": None, "playerIndex": None,
         "toolIndex": None, "energyIndex": None, "count": None, "inPlayArea": None,
         "inPlayIndex": None, "attackId": None, "cardId": None, "serial": None,
         "specialConditionType": None}
    o.update(kw)
    return o


def _obs(options, cur=None, minCount=1, maxCount=1):
    return {
        "select": {"type": 0, "context": 0, "minCount": minCount, "maxCount": maxCount,
                   "remainDamageCounter": 0, "remainEnergyCost": 0, "option": options,
                   "deck": None, "contextCard": None, "effect": None},
        "logs": [], "current": cur, "search_begin_input": None,
    }


def _assert_legal(testcase, picked, n_opts, minCount, maxCount):
    """The legality contract (spec GATES): indices in range, count within min/max, no dups."""
    testcase.assertIsInstance(picked, list)
    testcase.assertEqual(picked, sorted(picked), "picks must be sorted")
    testcase.assertEqual(len(picked), len(set(picked)), "no duplicate indices")
    for i in picked:
        testcase.assertTrue(0 <= i < n_opts, f"index {i} out of range [0,{n_opts})")
    k = min(max(maxCount, 1), n_opts)
    k = max(k, min(max(minCount, 1), n_opts))
    testcase.assertEqual(len(picked), k, f"expected legal count {k}, got {len(picked)}")


class TestChooseLegality(unittest.TestCase):
    def test_deck_selection_returns_none(self):
        # select is None -> None (deck-selection deferred to agent.py caller; matches heuristic.choose)
        self.assertIsNone(heuristic_v5.choose({"select": None, "current": None}, [1, 2, 3]))

    def test_empty_options_returns_empty(self):
        self.assertEqual(heuristic_v5.choose(_obs([]), []), [])

    def test_single_pick_typical_board(self):
        me = _player(active=_pokemon(hp=40, maxHp=60, energies=[6]), bench=[_pokemon(pid=1001)])
        opp = _player(active=_pokemon(pid=2000, hp=50, maxHp=120))
        cur = _state(you=0, players=[me, opp])
        opts = [
            _opt(ATTACH, inPlayArea=ACTIVE, inPlayIndex=0, cardId=3),
            _opt(EVOLVE, inPlayArea=ACTIVE, inPlayIndex=0, cardId=1219),
            _opt(ATTACK, attackId=500),
            _opt(RETREAT),
            _opt(END),
        ]
        picked = heuristic_v5.choose(_obs(opts, cur), [3] * 60)
        _assert_legal(self, picked, len(opts), 1, 1)

    def test_lethal_attack_is_chosen(self):
        # +1000 lethal must dominate (spec §A.1 unchanged). dmg>=opp hp -> the ATTACK option wins.
        # On this host card DB is empty so attack_damage is 0; we can't trigger lethal via the real DB.
        # Instead verify the term path doesn't break legality and END never beats a real option.
        me = _player(active=_pokemon(energies=[6]))
        opp = _player(active=_pokemon(pid=2000, hp=10, maxHp=120))
        cur = _state(you=0, players=[me, opp])
        opts = [_opt(END), _opt(ATTACK, attackId=999), _opt(ATTACH, inPlayArea=ACTIVE, inPlayIndex=0, cardId=3)]
        picked = heuristic_v5.choose(_obs(opts, cur), [3] * 60)
        _assert_legal(self, picked, len(opts), 1, 1)
        self.assertNotEqual(picked, [0], "END (floor) should not be the lone pick over real options")

    def test_multi_select_legal_count(self):
        # maxCount=3 over 5 options -> exactly 3 legal sorted unique indices (mulligan/discard-N path).
        opts = [_opt(PLAY, cardId=c) for c in range(5)]
        cur = _state(you=0)
        picked = heuristic_v5.choose(_obs(opts, cur, minCount=3, maxCount=3), [3] * 60)
        _assert_legal(self, picked, len(opts), 3, 3)

    def test_no_current_state_falls_back_to_base(self):
        # cur is None -> _BASE + lethal only, still legal (matches v4 on bare obs).
        opts = [_opt(ATTACH, cardId=3), _opt(END)]
        picked = heuristic_v5.choose(_obs(opts, cur=None), [3] * 60)
        _assert_legal(self, picked, len(opts), 1, 1)
        self.assertEqual(picked, [0], "ATTACH(_BASE 50) should beat END(_BASE 2) on a bare obs")

    def test_status_locked_active_favors_retreat(self):
        # Paralyzed active + a healthy energized bench + payable retreat -> pivot_term lifts RETREAT.
        # (retreat_cost degrades to 0 on this host, so it IS payable; the status bonus is the signal.)
        me = _player(
            active=_pokemon(hp=30, maxHp=120, energies=[6, 6]),
            bench=[_pokemon(pid=1001, hp=120, maxHp=120, energies=[6])],
            paralyzed=True,
        )
        opp = _player(active=_pokemon(pid=2000, hp=120, maxHp=120))
        cur = _state(you=0, players=[me, opp])
        opts = [_opt(END), _opt(RETREAT)]
        picked = heuristic_v5.choose(_obs(opts, cur), [3] * 60)
        _assert_legal(self, picked, len(opts), 1, 1)
        self.assertEqual(picked, [1], "RETREAT should beat END for a paralyzed active with a ready bench")

    def test_never_crashes_on_malformed_options(self):
        # Garbage option fields must degrade to a legal pick, never raise (the match-safety contract).
        opts = [_opt(ATTACK, attackId=None), _opt(ATTACH, inPlayArea=999, inPlayIndex=999, cardId=None),
                _opt(EVOLVE, inPlayArea=BENCH, inPlayIndex=42, cardId=None)]
        cur = _state(you=0)
        picked = heuristic_v5.choose(_obs(opts, cur), [3] * 60)
        _assert_legal(self, picked, len(opts), 1, 1)


if __name__ == "__main__":
    unittest.main()
