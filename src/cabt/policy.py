"""Move-selection policies.

`pimc_select` is the determinized search engine over `cg.api`. Per-option evaluation:
  - `rollout_depth == 0`: 1-ply — value the state immediately after the option (fast, but optimistic:
    it scores before the opponent responds).
  - `rollout_depth > 0`: roll the search forward `rollout_depth` more plies (random rollout, through the
    opponent's reply and beyond) and value the leaf — a less-optimistic estimate. Depth is read from
    `CABT_ROLLOUT` when not passed, so the A/B harness can sweep it.

Bounded by a per-decision `deadline` (chess-clock safety), a top-K option cap, and per-handle `try/finally`
release with null-guards. Multi-select (maxCount>1) / `minCount==0` defer to greedy (card-aware = Sprint 2).
"""
from __future__ import annotations

import os
import random
import time
from typing import Any

from . import search as _search
from .augury import position_value

_RNG = random.Random(0)


def _legal_count(sel: dict[str, Any], n: int) -> int:
    minc = int(sel.get("minCount", 0) or 0)
    maxc = int(sel.get("maxCount", 1) or 1)
    k = min(max(maxc, 1), n)
    return max(k, min(max(minc, 1), n))


def random_policy(sel: dict[str, Any], rng: random.Random | None = None) -> list[int]:
    opts = sel.get("option") or []
    if not opts:
        return []
    return sorted((rng or _RNG).sample(range(len(opts)), _legal_count(sel, len(opts))))


def greedy_baseline(sel: dict[str, Any]) -> list[int]:
    """Deterministic legal pick (lowest indices). A reproducible, non-random floor."""
    opts = sel.get("option") or []
    if not opts:
        return []
    return sorted(range(len(opts)))[: _legal_count(sel, len(opts))]


def _rollout_value(api, child_state, you: int, depth: int, rng: random.Random) -> float:
    """Random-rollout `depth` plies forward from `child_state` (which the CALLER owns/releases),
    releasing only the intermediate states this function creates, then value the leaf."""
    state = child_state
    created: list = []
    try:
        for _ in range(depth):
            obs = getattr(state, "observation", None)
            sel = getattr(obs, "select", None) if obs is not None else None
            opts = getattr(sel, "option", None) or [] if sel is not None else []
            if not opts:
                break  # terminal / no decision -> stop early
            minc = int(getattr(sel, "minCount", 0) or 0)
            maxc = int(getattr(sel, "maxCount", 1) or 1)
            k = min(max(maxc, 1), len(opts))
            k = max(k, min(max(minc, 1), len(opts)))
            pick = rng.sample(range(len(opts)), k)
            try:
                nxt = api["step"](state.searchId, pick)
            except Exception:
                break
            if nxt is None or getattr(nxt, "searchId", None) is None:
                break
            created.append(nxt.searchId)
            state = nxt
        obs = getattr(state, "observation", None)
        return position_value(getattr(obs, "current", None) if obs is not None else None, you)
    finally:
        for sid in created:
            try:
                api["release"](sid)
            except Exception:
                pass


def pimc_select(obs: dict[str, Any], deck: list[int], n_worlds: int = 16,
                rng: random.Random | None = None, deadline: float | None = None,
                top_k: int = 12, rollout_depth: int | None = None) -> list[int]:
    # n_worlds is a CAP; the deadline governs how many worlds actually run (A/B 2026-06-18: more worlds
    # = stronger — 8 beat 2 at 0.65 vs 0.30 vs greedy). On fast hardware the deadline fits more worlds.
    """Determinized PIMC for single-pick (maxCount==1) decisions, bounded by `deadline` (monotonic secs)."""
    rng = rng or _RNG
    if rollout_depth is None:
        rollout_depth = int(os.environ.get("CABT_ROLLOUT", "0"))
    sel = obs.get("select")
    cur = obs.get("current")
    if not sel or not sel.get("option"):
        return []
    n = len(sel["option"])
    if cur is None or int(sel.get("maxCount", 1) or 1) != 1:
        return greedy_baseline(sel)

    api = _search.load_search()
    you = cur["yourIndex"]
    agent_obs = api["to_obs"](obs)
    cand = list(range(min(n, top_k)))
    q = {i: 0.0 for i in cand}
    cnt = {i: 0 for i in cand}

    for _ in range(n_worlds):
        if deadline is not None and time.monotonic() > deadline:
            break
        pred = _search.predict_opponent(cur, deck, rng)
        try:
            root = api["begin"](agent_obs, **pred)
        except Exception:
            continue
        try:
            for i in cand:
                if deadline is not None and time.monotonic() > deadline:
                    break
                child = None
                try:
                    child = api["step"](root.searchId, [i])
                    if child is not None and getattr(child, "observation", None) is not None:
                        if rollout_depth > 0:
                            q[i] += _rollout_value(api, child, you, rollout_depth, rng)
                        else:
                            q[i] += position_value(getattr(child.observation, "current", None), you)
                        cnt[i] += 1
                except Exception:
                    pass
                finally:
                    cid = getattr(child, "searchId", None)
                    if cid is not None and cid != root.searchId:
                        try:
                            api["release"](cid)
                        except Exception:
                            pass
        finally:
            try:
                api["release"](root.searchId)
            except Exception:
                pass

    if not any(cnt.values()):
        return greedy_baseline(sel)
    best = max(cand, key=lambda i: (q[i] / cnt[i]) if cnt[i] else float("-inf"))
    return [best]
