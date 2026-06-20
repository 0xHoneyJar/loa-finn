"""Phase-0 / Sprint-1 task-1 probe (SAFE, informational): characterize the search API input.
Runs ONLY in linux/amd64. Drives a real match via the low-level game API (so search_begin_input
survives), reaches a real decision point, and characterizes `search_begin_input` + the select struct
+ the raw SerialData — WITHOUT calling SearchBegin yet (wrong ctypes argtypes would segfault).
Goal: learn the input format so the next iteration can bind SearchBegin/Step/End correctly.
"""
import json
import random
from kaggle_environments.envs.cabt import cabt as cabt_mod
from kaggle_environments.envs.cabt.cg import game
from kaggle_environments.envs.cabt.cg.sim import lib, Battle


def describe_blob(s):
    if s is None:
        return {"present": False}
    out = {"present": True, "type": type(s).__name__, "len": len(s)}
    head = s[:300] if isinstance(s, str) else s[:300]
    out["head"] = head if isinstance(head, str) else repr(head)
    # crude format sniff
    st = s.strip() if isinstance(s, str) else ""
    out["looks_json"] = st[:1] in "[{" if st else False
    out["looks_b64"] = bool(st) and all(c.isalnum() or c in "+/=" for c in st[:64])
    return out


def main():
    deck = cabt_mod.deck
    print("DECK_LEN", len(deck))
    obs, start = game.battle_start(list(deck), list(deck))
    print("BATTLE_START ptr_ok=%s errPlayer=%s errType=%s" % (
        Battle.battle_ptr not in (None, 0), start.errorPlayer, start.errorType))

    # step a few real decisions in
    captured = None
    for step in range(12):
        if obs is None:
            print("OBS_NONE at step", step); break
        sel = obs.get("select")
        if sel is None:
            # deck-select phase already consumed by battle_start; pick nothing-ish
            break
        opts = sel.get("option") or []
        maxc = sel.get("maxCount", 1) or 1
        minc = sel.get("minCount", 0) or 0
        # capture the first decision that has a real option list + a search blob
        if opts and obs.get("search_begin_input") and captured is None and step >= 1:
            captured = {
                "step": step,
                "select": {k: sel.get(k) for k in
                           ["type", "context", "minCount", "maxCount", "remainDamageCounter", "remainEnergyCost"]},
                "n_options": len(opts),
                "option_head": str(opts[:6]),
                "search_begin_input": describe_blob(obs.get("search_begin_input")),
            }
            # also pull raw SerialData
            sd = lib.GetBattleData(Battle.battle_ptr)
            captured["serial"] = {"selectPlayer": sd.selectPlayer, "count": sd.count,
                                  "json_head": (sd.json.decode()[:200] if sd.json else None)}
            break
        # advance with a random legal pick
        k = max(minc, 1)
        k = min(k, maxc, len(opts))
        pick = random.sample(range(len(opts)), k) if opts else []
        try:
            obs = game.battle_select(pick)
        except Exception as e:
            print("SELECT_ERR step=%d pick=%s err=%r" % (step, pick, e)); break

    print("CAPTURED", json.dumps(captured, default=str)[:2500])
    # informational: confirm the search symbols resolve (addresses), do NOT call them
    print("SEARCH_SYMS", json.dumps({s: bool(getattr(lib, s, None)) for s in
          ["SearchBegin", "SearchStep", "SearchEnd", "SearchRelease"]}))
    game.battle_finish()
    print("DONE")


if __name__ == "__main__":
    main()
