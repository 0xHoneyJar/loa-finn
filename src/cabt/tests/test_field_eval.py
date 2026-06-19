"""Pure-logic tests for field_eval (GYGAX spec §B) — NO engine required.

These exercise the functions §B.4 hangs its anti-overfit defense on, with NO cg import:
  - wilson CI math (matches container_decks.py:65-71)
  - seat_avg seat-swap accounting (spec §B.1 — first-player advantage averaged out)
  - partition_train_holdout — the HELD-OUT split MUST be real (spec §B.4 defense #1)
  - assemble_matrix — FieldScore on held-out gate cells, greedy-as-tripwire-only, conjunctive gate
  - field_score convenience

If these import cg, the test environment is wrong — the whole point of the pure/engine split is that
the instrument's LOGIC is verifiable in CI without the linux/amd64 container.

Run: python3 -m unittest src.cabt.tests.test_field_eval  (or pytest).
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))

from src.cabt import field_eval as fe  # noqa: E402


class TestWilson(unittest.TestCase):
    def test_zero_n(self):
        self.assertEqual(fe.wilson(0, 0), (0.0, 0.0))

    def test_symmetric_at_half(self):
        lo, hi = fe.wilson(50, 100)
        self.assertLess(lo, 0.5)
        self.assertGreater(hi, 0.5)
        self.assertAlmostEqual((lo + hi) / 2, 0.5, places=1)

    def test_bounds_clamped(self):
        lo, hi = fe.wilson(100, 100)
        self.assertGreaterEqual(lo, 0.0)
        self.assertLessEqual(hi, 1.0)

    def test_tighter_with_more_n(self):
        _, hi_small = fe.wilson(15, 30)
        lo_small, _ = fe.wilson(15, 30)
        lo_big, hi_big = fe.wilson(150, 300)
        self.assertLess(hi_big - lo_big, hi_small - lo_small, "more games -> tighter CI")


class TestSeatAvg(unittest.TestCase):
    def test_pools_both_seats(self):
        r = fe.seat_avg(20, 30, 10, 30)
        self.assertEqual(r["wins"], 30)
        self.assertEqual(r["total"], 60)
        self.assertEqual(r["winrate"], 0.5)
        self.assertEqual(r["seat0"], [20, 30])
        self.assertEqual(r["seat1"], [10, 30])

    def test_zero_total(self):
        r = fe.seat_avg(0, 0, 0, 0)
        self.assertEqual(r["total"], 0)
        self.assertEqual(r["winrate"], 0.0)

    def test_seat_imbalance_preserved(self):
        # first-player advantage shows in the per-seat split even after pooling (spec §B.1 bug check).
        r = fe.seat_avg(30, 30, 0, 30)  # crush as P1, lose as P2 -> seat artifact
        self.assertEqual(r["winrate"], 0.5)
        self.assertEqual(r["seat0"], [30, 30])
        self.assertEqual(r["seat1"], [0, 30])

    def test_ci_present(self):
        r = fe.seat_avg(45, 50, 45, 50)
        self.assertEqual(len(r["ci95"]), 2)
        self.assertGreater(r["ci95"][0], 0.5, "0.9 winrate -> CI lower bound above 0.5")


class TestPartitionHeldOut(unittest.TestCase):
    def test_real_split(self):
        s = fe.partition_train_holdout(["sample", "lucario", "monofighting"], ["lucario", "monofighting"])
        self.assertEqual(set(s["train"]), {"lucario", "monofighting"})
        self.assertEqual(s["holdout"], ["sample"])

    def test_disjoint_enforced(self):
        # train and holdout must NOT overlap — the defense (spec §B.4) is meaningless otherwise.
        s = fe.partition_train_holdout(["a", "b", "c"], ["a"])
        self.assertFalse(set(s["train"]) & set(s["holdout"]))

    def test_empty_holdout_raises(self):
        # train == all decks -> NO held-out set -> the overfit hole this defense closes. Must raise.
        with self.assertRaises(ValueError):
            fe.partition_train_holdout(["a", "b"], ["a", "b"])

    def test_train_not_in_universe_raises(self):
        with self.assertRaises(ValueError):
            fe.partition_train_holdout(["a", "b"], ["z"])

    def test_dedup_train(self):
        s = fe.partition_train_holdout(["a", "b", "c"], ["a", "a", "b"])
        self.assertEqual(s["train"], ["a", "b"])
        self.assertEqual(set(s["holdout"]), {"c"})


class TestDeckMatchups(unittest.TestCase):
    def test_cross_product(self):
        pairs = fe.deck_matchups(["x", "y"], ["x", "z"])
        self.assertIn(("x", "x"), pairs)  # same-deck cell
        self.assertIn(("x", "z"), pairs)  # cross-deck cell
        self.assertEqual(len(pairs), 4)


def _cell(opponent, hero_deck, opp_deck, split, wins, total, seat0=None, seat1=None):
    """Build a graded cell with a precomputed seat_avg-shaped result (no engine)."""
    half = total // 2
    s0 = seat0 if seat0 is not None else wins // 2
    s1 = seat1 if seat1 is not None else wins - (wins // 2)
    res = fe.seat_avg(s0, half, s1, total - half)
    # Force exact wins/total for the matrix-assembly math under test.
    res["wins"], res["total"] = wins, total
    res["winrate"] = round(wins / total, 4) if total else 0.0
    return {"opponent": opponent, "hero_deck": hero_deck, "opp_deck": opp_deck,
            "split": split, "result": res}


class TestAssembleMatrix(unittest.TestCase):
    def test_field_score_only_holdout_gate_cells(self):
        # FieldScore is the mean of HELD-OUT gate (champion/pimc) cells ONLY — train cells excluded,
        # greedy + mirror excluded (spec §B.1 + §B.4).
        cells = [
            _cell(fe.CHAMPION, "sample", "sample", "holdout", 70, 100),   # counts
            _cell(fe.PIMC, "sample", "lucario", "holdout", 60, 100),      # counts
            _cell(fe.CHAMPION, "lucario", "lucario", "train", 99, 100),   # excluded (train)
            _cell(fe.GREEDY, "sample", "sample", "holdout", 99, 100),     # excluded (tripwire)
            _cell(fe.MIRROR, "sample", "sample", "holdout", 50, 100),     # excluded (mirror)
        ]
        report = fe.assemble_matrix(cells)
        self.assertAlmostEqual(report["field_score"], (0.70 + 0.60) / 2, places=3)
        self.assertEqual(report["n_holdout_gate_cells"], 2)

    def test_greedy_is_tripwire_not_headline(self):
        # A candidate that crushes greedy but loses to the gate opponents must NOT pass (the greedy lie).
        cells = [
            _cell(fe.GREEDY, "sample", "sample", "holdout", 99, 100),     # crushes greedy
            _cell(fe.CHAMPION, "sample", "sample", "holdout", 40, 100),   # LOSES to champion
            _cell(fe.PIMC, "sample", "sample", "holdout", 40, 100),       # LOSES to pimc
        ]
        report = fe.assemble_matrix(cells)
        self.assertFalse(report["gate_pass"], "beating only greedy must NOT pass the gate")
        self.assertEqual(report["greedy_tripwire"]["winrate"], 0.99)

    def test_conjunctive_gate_requires_both_opponents(self):
        # Beating champion but NOT pimc must fail (conjunctive gate, spec §B.1).
        cells = [
            _cell(fe.CHAMPION, "sample", "sample", "holdout", 90, 100),   # clears champion
            _cell(fe.PIMC, "sample", "sample", "holdout", 48, 100),       # fails pimc
            _cell(fe.GREEDY, "sample", "sample", "holdout", 80, 100),     # tripwire ok
        ]
        report = fe.assemble_matrix(cells)
        self.assertFalse(report["gate_pass"])
        self.assertTrue(any("pimc" in r for r in report["gate_reasons"]))

    def test_full_pass(self):
        cells = [
            _cell(fe.CHAMPION, "sample", "sample", "holdout", 90, 100),   # clears champion (CI lo > 0.5)
            _cell(fe.PIMC, "sample", "sample", "holdout", 88, 100),       # clears pimc
            _cell(fe.GREEDY, "sample", "sample", "holdout", 95, 100),     # tripwire ok
            _cell(fe.MIRROR, "sample", "sample", "holdout", 50, 100),     # mirror ~0.5 ok
        ]
        report = fe.assemble_matrix(cells)
        self.assertTrue(report["gate_pass"], f"should pass: {report['gate_reasons']}")

    def test_mirror_seat_bug_flagged(self):
        # mirror far from 0.5 flags a seat/first-player bug and fails the gate (spec §B.1 #4).
        cells = [
            _cell(fe.CHAMPION, "sample", "sample", "holdout", 90, 100),
            _cell(fe.PIMC, "sample", "sample", "holdout", 88, 100),
            _cell(fe.GREEDY, "sample", "sample", "holdout", 95, 100),
            _cell(fe.MIRROR, "sample", "sample", "holdout", 80, 100),     # 0.80 -> seat bug
        ]
        report = fe.assemble_matrix(cells)
        self.assertFalse(report["gate_pass"])
        self.assertTrue(any("mirror" in r for r in report["gate_reasons"]))

    def test_field_score_convenience(self):
        cells = [_cell(fe.CHAMPION, "s", "s", "holdout", 60, 100),
                 _cell(fe.PIMC, "s", "s", "holdout", 80, 100)]
        self.assertAlmostEqual(fe.field_score(cells), 0.70, places=3)

    def test_pre_registration_note_present(self):
        # The arena PROPOSES, the ladder DISPOSES — the note MUST ride on every report (spec §B.4).
        report = fe.assemble_matrix([_cell(fe.CHAMPION, "s", "s", "holdout", 60, 100)])
        self.assertIn("PRE-REGISTERED LADDER CANDIDATE", report["pre_registration_note"])


class TestConfigSplit(unittest.TestCase):
    def test_default_config_split_is_real(self):
        cfg = fe.FieldEvalConfig()
        split = cfg.validate_split()
        # default: train on lucario+monofighting, hold out sample (finding #1 flat deck as held-out).
        self.assertEqual(set(split["train"]), {"lucario", "monofighting"})
        self.assertIn("sample", split["holdout"])
        self.assertFalse(set(split["train"]) & set(split["holdout"]))

    def test_deck_split_of(self):
        split = {"train": ["lucario"], "holdout": ["sample"]}
        self.assertEqual(fe.deck_split_of("lucario", split), "train")
        self.assertEqual(fe.deck_split_of("sample", split), "holdout")


if __name__ == "__main__":
    unittest.main()
