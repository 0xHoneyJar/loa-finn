"""Move-selection policies.

`pimc_select` is the Sprint-1 floor engine: determinized 1-ply PIMC over the `cg.api` search API.
Rev 2 (flatline fold 2026-06-17): a per-decision DEADLINE (chess-clock safety), a top-K option cap,
per-child `try/finally` release with null-guards (no leaks / no decision-abort on a bad leaf), and a
terminal-result short-circuit. Multi-select (maxCount>1) and `minCount==0` "decline" remain greedy-
deferred — doing them right needs card-aware augury (Sprint 2); see flatline findings #6/#8.
"""
from __future__ import annotations

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


def pimc_select(obs: dict[str, Any], deck: list[int], n_worlds: int = 4,
                rng: random.Random | None = None, deadline: float | None = None,
                top_k: int = 12) -> list[int]:
    """Determinized 1-ply PIMC for single-pick (maxCount==1) decisions, bounded by `deadline`
    (`time.monotonic` seconds). Searches at most `top_k` options. Returns the best option index,
    or `greedy_baseline` if no search world completed."""
    rng = rng or _RNG
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
    cand = list(range(min(n, top_k)))  # cap the breadth searched (deeper ranking = Sprint 2)
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
                    obs_c = getattr(child, "observation", None)
                    if obs_c is not None:
                        q[i] += position_value(getattr(obs_c, "current", None), you)
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
