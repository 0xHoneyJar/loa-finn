"""field_eval — the committed multi-deck field-evaluation instrument (GYGAX spec §B).

WHY THIS EXISTS (spec §B.0): single-deck self-play-vs-greedy is a BROKEN instrument. It is flat on the
sample deck (every policy ~0.5, `arena_results.json`), greedy is too weak to discriminate strong policies
(it INVERTED the ladder's n4>n16 truth, `eval_calibration.py`), and the ladder is deck-vs-deck not
same-deck. A 0.76-vs-greedy-on-one-deck score tells us NOTHING. This harness makes a high score MEAN
something.

THE INSTRUMENT (spec §B.1) — a win-rate over a basket of (opponent_policy × deck-matchup) cells, each
seat-swapped with a Wilson CI, then aggregated. Three orthogonal axes:
  - opponent policy: greedy (TRIPWIRE only), champion-heuristic, pimc(16), mirror (bug check).
  - deck matchup: same-deck + cross-deck cells (the ladder IS deck-vs-deck).
  - our piloted deck: graded while WE pilot each candidate deck.

ANTI-OVERFIT (spec §B.4 — THE WHOLE GAME, enforced here structurally):
  1. greedy is a TRIPWIRE, never the headline (defeats the greedy lie / calibration inversion).
  2. HELD-OUT deck split: tune weights on TRAIN decks, report the gate ONLY on HELD-OUT decks. A weight
     set that only wins on its train decks is exposed by the held-out gap. (defeats deck overfit).
  3. the lever is FEATURES not weights (enforced in heuristic_v5 — game-theoretic terms transfer).
  4. seat-swap every cell + mirror≈0.5 check (defeats seat/first-player artifacts).
  5. PRE-REGISTRATION: a winner here is a PRE-REGISTERED LADDER CANDIDATE, never a confirmed improvement.
     The arena PROPOSES; the ladder DISPOSES.

STRUCTURE: the PURE functions (wilson, seat_avg, assemble_matrix, partition_train_holdout,
field_score) import with NO engine — they are unit-tested without cg (test_field_eval.py). The engine-bound
runner (`run_field_eval`) does the `/app` sys.path insert + `cg` import lazily, mirroring
`.cabt-spike/container_decks.py` (battle_start(d0,d1), seat-swap, the same `play` loop). It targets the
linux/amd64 container — do NOT run natively on the dev host (libcg.so is Linux x86-64 only).
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field as _dc_field

# ====================================================================================================
# PURE functions — NO engine import. Unit-testable in CI without cg (the whole point of the split).
# ====================================================================================================


def wilson(wins: int, n: int) -> tuple[float, float]:
    """Wilson 95% CI for a binomial proportion (identical math to container_decks.py:65-71)."""
    if not n:
        return (0.0, 0.0)
    p = wins / n
    z = 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - m), min(1.0, c + m))


def seat_avg(seat0_wins: int, seat0_n: int, seat1_wins: int, seat1_n: int) -> dict:
    """Fold two seat-halves into one seat-averaged cell (spec §B.1: seat-swap every cell, first-player
    advantage is real and must be averaged out — container_decks.py:76-79).

    seat0_wins = hero's wins when hero goes FIRST (was seat 0).
    seat1_wins = hero's wins when hero goes SECOND (was seat 1).
    Returns the pooled record + win-rate + Wilson CI. Pure accounting — no engine."""
    tot = int(seat0_n) + int(seat1_n)
    wins = int(seat0_wins) + int(seat1_wins)
    if tot <= 0:
        return {"wins": 0, "total": 0, "winrate": 0.0, "ci95": [0.0, 0.0],
                "seat0": [int(seat0_wins), int(seat0_n)], "seat1": [int(seat1_wins), int(seat1_n)]}
    lo, hi = wilson(wins, tot)
    return {
        "wins": wins, "total": tot, "winrate": round(wins / tot, 4),
        "ci95": [round(lo, 4), round(hi, 4)],
        "seat0": [int(seat0_wins), int(seat0_n)], "seat1": [int(seat1_wins), int(seat1_n)],
    }


# --- deck-matchup grid assembly -------------------------------------------------------------------

GREEDY = "greedy"
CHAMPION = "champion"
PIMC = "pimc"
MIRROR = "mirror"

# Opponent policies graded. greedy = tripwire (must clear, never headline). mirror = bug check (~0.5).
# champion + pimc = the GATE opponents (headline CI must clear 0.5 on BOTH — conjunctive, spec §B.1).
GATE_OPPONENTS = (CHAMPION, PIMC)
TRIPWIRE_OPPONENTS = (GREEDY,)
SANITY_OPPONENTS = (MIRROR,)


def deck_matchups(hero_decks, opp_decks):
    """The deck axis: every (hero_deck, opp_deck) pair (spec §B.1 — same-deck AND cross-deck cells).
    Seat-swap is folded into each cell's evaluation, not enumerated here. Pure: just the cross-product."""
    pairs = []
    for hd in hero_decks:
        for od in opp_decks:
            pairs.append((hd, od))
    return pairs


def partition_train_holdout(all_decks, train_decks):
    """THE held-out split (spec §B.4 defense #1 — the core anti-overfit defense).

    train  = decks the weight-tuner is allowed to see.
    holdout = all_decks - train (the gate is reported ONLY on these).

    Raises if the split is not REAL (train and holdout must be disjoint AND holdout non-empty) — a fake
    split (train == holdout, or empty holdout) is the overfit hole this defense closes. Pure logic."""
    train = list(dict.fromkeys(train_decks))  # de-dup, preserve order
    all_set = list(dict.fromkeys(all_decks))
    train_set = set(train)
    missing = [d for d in train if d not in set(all_set)]
    if missing:
        raise ValueError(f"train decks not in deck universe: {missing}")
    holdout = [d for d in all_set if d not in train_set]
    if not holdout:
        raise ValueError("held-out split is empty — train must be a STRICT subset of all decks (spec §B.4)")
    if set(holdout) & train_set:
        raise ValueError("train and held-out decks overlap — the split is not real (spec §B.4)")
    return {"train": train, "holdout": holdout}


def assemble_matrix(cells):
    """Assemble graded cells into the report matrix + headline FieldScore + gate verdict (spec §B.1).

    `cells`: list of dicts, each:
      {"opponent": <policy>, "hero_deck": <str>, "opp_deck": <str>, "split": "train"|"holdout",
       "result": <seat_avg dict>}

    Pure aggregation — takes already-graded cells (the engine produced the win counts) and computes:
      - FieldScore = mean win-rate over the NON-greedy, NON-mirror cells (gate opponents only),
        weighted equally, restricted to HELD-OUT decks for the headline (spec §B.1 + §B.4).
      - per-gate-opponent pooled CI on held-out cells.
      - tripwire check (greedy winrate > 0.5) and mirror check (~0.5).
      - the conjunctive GATE verdict.
    """
    def _is_gate(c):
        return c["opponent"] in GATE_OPPONENTS

    holdout_gate = [c for c in cells if _is_gate(c) and c.get("split") == "holdout"]
    # Headline FieldScore: equal-weight mean of held-out gate-cell win-rates.
    if holdout_gate:
        field_score = sum(c["result"]["winrate"] for c in holdout_gate) / len(holdout_gate)
    else:
        field_score = 0.0

    # Per-gate-opponent pooled Wilson CI over held-out cells (the headline CI per gate).
    per_opponent = {}
    for opp in GATE_OPPONENTS:
        rows = [c for c in holdout_gate if c["opponent"] == opp]
        wins = sum(c["result"]["wins"] for c in rows)
        tot = sum(c["result"]["total"] for c in rows)
        lo, hi = wilson(wins, tot) if tot else (0.0, 0.0)
        per_opponent[opp] = {
            "winrate": round(wins / tot, 4) if tot else 0.0,
            "ci95": [round(lo, 4), round(hi, 4)], "record": f"{wins}/{tot}", "cells": len(rows),
        }

    # Tripwire (greedy, ALL cells — must clear; not a headline signal, spec §B.1).
    greedy_rows = [c for c in cells if c["opponent"] == GREEDY]
    g_wins = sum(c["result"]["wins"] for c in greedy_rows)
    g_tot = sum(c["result"]["total"] for c in greedy_rows)
    tripwire_wr = round(g_wins / g_tot, 4) if g_tot else None

    # Mirror sanity (should be ~0.5 seat-adjusted; large deviation flags a seat bug, spec §B.1).
    mirror_rows = [c for c in cells if c["opponent"] == MIRROR]
    m_wins = sum(c["result"]["wins"] for c in mirror_rows)
    m_tot = sum(c["result"]["total"] for c in mirror_rows)
    mirror_wr = round(m_wins / m_tot, 4) if m_tot else None

    # GATE verdict (spec §B.1): conjunctive — champion AND pimc held-out CI lower bound > 0.5,
    # AND greedy tripwire > 0.5, AND mirror within 0.5±0.1.
    gate_pass = bool(holdout_gate)
    reasons = []
    for opp in GATE_OPPONENTS:
        lo = per_opponent[opp]["ci95"][0]
        if lo <= 0.5:
            gate_pass = False
            reasons.append(f"{opp} held-out CI lower bound {lo} <= 0.5")
    if tripwire_wr is not None and tripwire_wr <= 0.5:
        gate_pass = False
        reasons.append(f"greedy tripwire winrate {tripwire_wr} <= 0.5 (failed the floor)")
    if mirror_wr is not None and abs(mirror_wr - 0.5) > 0.1:
        gate_pass = False
        reasons.append(f"mirror winrate {mirror_wr} deviates from 0.5 (seat/first-player bug?)")

    return {
        "field_score": round(field_score, 4),
        "gate_pass": gate_pass,
        "gate_reasons": reasons or (["all gates cleared"] if gate_pass else ["no held-out gate cells graded"]),
        "per_gate_opponent_holdout": per_opponent,
        "greedy_tripwire": {"winrate": tripwire_wr, "record": f"{g_wins}/{g_tot}"},
        "mirror_sanity": {"winrate": mirror_wr, "record": f"{m_wins}/{m_tot}"},
        "n_cells": len(cells),
        "n_holdout_gate_cells": len(holdout_gate),
        "pre_registration_note": (
            "PRE-REGISTERED LADDER CANDIDATE — arena PROPOSES, ladder DISPOSES (spec §B.4). "
            "A gate_pass here is NOT a confirmed ladder improvement; pimc shares augury lineage "
            "(strong+somewhat-correlated, not independent) until B.3.2 replay-opponents land, and "
            "held-out decks are only sampled from local homebrew until B.3.1 mines the real field meta."
        ),
    }


def field_score(cells) -> float:
    """Convenience: just the headline FieldScore number (spec §B.1)."""
    return assemble_matrix(cells)["field_score"]


# ====================================================================================================
# CONFIG — what to grade. Pure dataclass; carries the held-out split so it's auditable + testable.
# ====================================================================================================


@dataclass
class FieldEvalConfig:
    # Decks: filenames (relative to deck_dir) WITHOUT extension are keys; values are paths.
    # Default mirrors container_decks.py: sample (engine bundle) + lucario + monofighting.
    hero_decks: list[str] = _dc_field(default_factory=lambda: ["sample", "lucario", "monofighting"])
    opp_decks: list[str] = _dc_field(default_factory=lambda: ["sample", "lucario", "monofighting"])
    # TRAIN vs HELD-OUT (spec §B.4): tune weights on train; gate on held-out. Default: train on the
    # decks that REWARD policy (finding #2: lucario+monofighting), hold out the flat sample (finding #1)
    # plus any V2-mined archetypes. Sample-as-held-out is thin (spec §B.4 residual risk) — widen via B.3.1.
    train_decks: list[str] = _dc_field(default_factory=lambda: ["lucario", "monofighting"])
    # Where decks live (configurable; default the spike's decks dir + the engine bundle dir).
    deck_dir: str = ".cabt-spike/decks"
    bundled_decks: dict = _dc_field(default_factory=lambda: {
        "sample": "/app/cg_src/deck.csv",
        "lucario": "/app/decks/lucario.csv",
        "monofighting": "/app/decks/monofighting.csv",
    })
    # Tiered N (spec §B.2): screen cheap, confirm only survivors on gate cells.
    screen_n_per_seat: int = 30      # ~60/cell — kills obviously-dead candidates fast
    confirm_n_per_seat: int = 150    # ~300/cell — the headline CI on gate cells
    pimc_n_worlds: int = 16          # the strong, structurally-different opponent (spec §B.1)
    out_path: str = "/app/out/field_eval_results.json"

    def validate_split(self) -> dict:
        """Run the held-out partition over the deck universe (raises if the split isn't real)."""
        universe = list(dict.fromkeys(list(self.hero_decks) + list(self.opp_decks)))
        return partition_train_holdout(universe, self.train_decks)


def deck_split_of(deck_key: str, split: dict) -> str:
    """Tag a cell's split by its HERO deck (the deck WE pilot determines train/held-out exposure —
    the tuner saw the hero deck's reward signal). Spec §B.4."""
    return "train" if deck_key in set(split["train"]) else "holdout"


# ====================================================================================================
# ENGINE-BOUND runner — mirrors container_decks.py EXACTLY. Lazy cg import; container-only.
# ====================================================================================================


def _engine():
    """Lazy-load the cg engine the way container_decks.py:10-15 does. Raises on the dev host (no
    libcg.so) — that is correct: this runner is container-only (spec SCOPE)."""
    import sys
    sys.path.insert(0, "/app")
    sys.path.insert(0, "/app/cg_src")
    os.environ.setdefault("CABT_AUGURY", "prize_only")
    os.environ.setdefault("CABT_ROLLOUT", "0")
    from cg import game  # noqa: PLC0415 — lazy engine load (Linux x86-64 only)
    return game


def _load_deck(path: str) -> list[int]:
    return [int(l) for l in open(path) if l.strip()]


def _resolve_decks(cfg: FieldEvalConfig) -> dict:
    """Resolve deck keys -> card-id lists. Prefer cfg.deck_dir/<key>.csv, fall back to bundled paths."""
    decks = {}
    keys = set(cfg.hero_decks) | set(cfg.opp_decks)
    for key in keys:
        local = os.path.join(cfg.deck_dir, f"{key}.csv")
        if os.path.exists(local):
            decks[key] = _load_deck(local)
        elif key in cfg.bundled_decks and os.path.exists(cfg.bundled_decks[key]):
            decks[key] = _load_deck(cfg.bundled_decks[key])
        else:
            raise FileNotFoundError(f"deck '{key}' not found at {local} or {cfg.bundled_decks.get(key)}")
    return decks


def _make_policy_agent(name: str, deck_ids: list[int], cfg: FieldEvalConfig):
    """Build an obs->indices agent for an opponent policy name. Mirrors container_arena.py:29-45 +
    container_decks.py:30-41 (heuristic._BASE set before the call, greedy fallback)."""
    from cabt import heuristic, heuristic_v5  # noqa: PLC0415
    from cabt.policy import greedy_baseline, pimc_select  # noqa: PLC0415

    CHAMP_PRIORS = {7: 45.0, 8: 50.0, 9: 48.0, 10: 42.0, 11: 6.0, 12: 10.0, 13: 25.0, 14: 2.0}

    if name == GREEDY:
        def agent(obs):
            sel = obs.get("select")
            return greedy_baseline(sel) if sel else []
        return agent
    if name == CHAMPION:
        def agent(obs):
            sel = obs.get("select")
            if not sel:
                return []
            heuristic._BASE = CHAMP_PRIORS
            out = heuristic.choose(obs, deck_ids)
            return out if out else greedy_baseline(sel)
        return agent
    if name == PIMC:
        def agent(obs):
            sel = obs.get("select")
            if not sel:
                return []
            return pimc_select(obs, deck_ids, n_worlds=cfg.pimc_n_worlds) or greedy_baseline(sel)
        return agent
    if name in (MIRROR, "hero", "v5"):
        # the candidate under test (heuristic_v5) — also serves as the mirror opponent
        def agent(obs):
            sel = obs.get("select")
            if not sel:
                return []
            out = heuristic_v5.choose(obs, deck_ids)
            return out if out else greedy_baseline(sel)
        return agent
    raise ValueError(f"unknown opponent policy: {name}")


def _make_hero_agent(deck_ids: list[int]):
    """The candidate we are grading: heuristic_v5 piloting `deck_ids`."""
    from cabt import heuristic_v5  # noqa: PLC0415
    from cabt.policy import greedy_baseline  # noqa: PLC0415

    def agent(obs):
        sel = obs.get("select")
        if not sel:
            return []
        out = heuristic_v5.choose(obs, deck_ids)
        return out if out else greedy_baseline(sel)
    return agent


def _play(game, a0, a1, d0, d1):
    """One match, deck d0 (seat 0) vs deck d1 (seat 1). EXACT copy of container_decks.py:44-62."""
    obs, _ = game.battle_start(d0, d1)
    try:
        for _ in range(4000):
            if obs is None:
                return None
            cur, sel = obs.get("current"), obs.get("select")
            if cur is not None and cur.get("result", -1) != -1:
                return cur.get("result")
            if sel is None:
                return None
            you = cur["yourIndex"] if cur is not None else 0
            pick = (a0 if you == 0 else a1)(obs)
            if not pick:
                pick = [0] if (sel.get("option")) else []
            obs = game.battle_select(pick)
        return None
    finally:
        game.battle_finish()


def _grade_cell(game, hero_deck_ids, opp_agent, opp_deck_ids, n_per_seat) -> dict:
    """Grade ONE (opponent × deck-matchup) cell, seat-swapped (spec §B.1). hero pilots hero_deck_ids,
    opponent pilots opp_deck_ids. Returns a seat_avg dict (pure accounting via seat_avg)."""
    hero = _make_hero_agent(hero_deck_ids)
    # seat 0: hero first. winrate counts result==0.
    s0 = sum(1 for _ in range(n_per_seat) if _play(game, hero, opp_agent, hero_deck_ids, opp_deck_ids) == 0)
    # seat 1: hero second. winrate counts result==1.
    s1 = sum(1 for _ in range(n_per_seat) if _play(game, opp_agent, hero, opp_deck_ids, hero_deck_ids) == 1)
    return seat_avg(s0, n_per_seat, s1, n_per_seat)


def run_field_eval(cfg: FieldEvalConfig | None = None, tier: str = "screen") -> dict:
    """Run the full field-eval grid in the container (spec §B.1+§B.2). `tier` = 'screen' (cheap, all
    cells) or 'confirm' (gate cells, large N). Writes a JSON matchup report. CONTAINER-ONLY (raises
    on the dev host — by design, per SCOPE)."""
    cfg = cfg or FieldEvalConfig()
    split = cfg.validate_split()  # raises if the held-out split is not real (anti-overfit gate)
    game = _engine()
    decks = _resolve_decks(cfg)

    n_per_seat = cfg.screen_n_per_seat if tier == "screen" else cfg.confirm_n_per_seat
    if tier == "confirm":
        opponents = list(GATE_OPPONENTS)  # confirm only the gate opponents (spec §B.2 tiered budget)
    else:
        opponents = [GREEDY, CHAMPION, PIMC, MIRROR]

    cells = []
    for opp in opponents:
        for hero_deck, opp_deck in deck_matchups(cfg.hero_decks, cfg.opp_decks):
            opp_agent = _make_policy_agent(opp, decks[opp_deck], cfg)
            result = _grade_cell(game, decks[hero_deck], opp_agent, decks[opp_deck], n_per_seat)
            cells.append({
                "opponent": opp, "hero_deck": hero_deck, "opp_deck": opp_deck,
                "split": deck_split_of(hero_deck, split), "result": result,
            })
            print(f"  [{tier}] {opp:9s} hero={hero_deck:13s} vs {opp_deck:13s} "
                  f"wr={result['winrate']:.3f} CI={result['ci95']} ({deck_split_of(hero_deck, split)})",
                  flush=True)

    report = assemble_matrix(cells)
    report["config"] = {
        "tier": tier, "n_per_seat": n_per_seat, "split": split,
        "hero_decks": cfg.hero_decks, "opp_decks": cfg.opp_decks, "pimc_n_worlds": cfg.pimc_n_worlds,
    }
    report["cells"] = cells
    try:
        os.makedirs(os.path.dirname(cfg.out_path), exist_ok=True)
        with open(cfg.out_path, "w") as f:
            json.dump(report, f, indent=2)
    except Exception as e:  # noqa: BLE001 — container path may differ; don't crash the run on I/O
        print(f"  (could not write {cfg.out_path}: {e})", flush=True)
    print(f"FIELD_EVAL_DONE field_score={report['field_score']} gate_pass={report['gate_pass']}", flush=True)
    return report


if __name__ == "__main__":
    import sys
    _tier = sys.argv[1] if len(sys.argv) > 1 else "screen"
    run_field_eval(tier=_tier)
