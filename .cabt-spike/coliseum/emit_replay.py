#!/usr/bin/env python3
# emit_replay.py — the KEYSTONE SEAM: play one coliseum match and emit it as a cabt-viewer
# replay JSON ({ok, cards, attacks, steps, visualize}) — the exact format charlielockyer-rice's
# Svelte viewer loads via ?view=replay&replayUrl=…  So: submit an agent → watch it fight on the site.
#
# cards/attacks come from OUR cg engine (cg.api.all_card_data/all_attack — the same source the
# viewer's own bridge uses), so this is native, not a reused-fixture hack.
#
# Usage (amd64 container):
#   python .cabt-spike/coliseum/emit_replay.py champion-dwebble greedy-floor --out <path>.json
import argparse, json, os, sys
import coliseum  # noqa: E402 — sets sys.path (cg engine, pilots), imports cg; exposes build_roster
from cg import game                       # noqa: E402
from cg.api import all_card_data, all_attack  # noqa: E402


def to_jsonable(v):
    """Recurse dataclasses → dicts (the cg obs/cards are dataclasses), same shape the viewer expects."""
    if hasattr(v, "__dataclass_fields__"):
        return {f: to_jsonable(getattr(v, f)) for f in v.__dataclass_fields__}
    if isinstance(v, dict):
        return {k: to_jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [to_jsonable(x) for x in v]
    return v


def record_match(ea, eb):
    """Play one match, recording {index, observation, action} per decision (the replay trajectory)."""
    steps = []
    obs, _ = game.battle_start(ea["deck"], eb["deck"])
    try:
        for _ in range(4000):
            if obs is None:
                break
            cur, sel = obs.get("current"), obs.get("select")
            if cur is not None and cur.get("result", -1) != -1:
                steps.append({"index": len(steps), "observation": to_jsonable(obs), "action": []})
                return steps, cur.get("result")
            if sel is None:
                break
            you = cur["yourIndex"] if cur is not None else 0
            pick = (ea["agent"] if you == 0 else eb["agent"])(obs)
            if not pick:
                pick = [0] if sel.get("option") else []
            steps.append({"index": len(steps), "observation": to_jsonable(obs), "action": pick})
            obs = game.battle_select(pick)
        return steps, None
    finally:
        game.battle_finish()


def main():
    ap = argparse.ArgumentParser(description="Emit a coliseum match as a cabt-viewer replay JSON.")
    ap.add_argument("a", help="seat-0 entrant name")
    ap.add_argument("b", help="seat-1 entrant name")
    ap.add_argument("--roster", default=".cabt-spike/coliseum/roster.json")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    roster = {e["name"]: e for e in coliseum.build_roster(args.roster)}
    for nm in (args.a, args.b):
        if nm not in roster:
            sys.exit(f"unknown entrant '{nm}'; roster = {list(roster)}")
    ea, eb = roster[args.a], roster[args.b]

    print(f"🎬 recording {args.a} (seat0) vs {args.b} (seat1) …")
    steps, result = record_match(ea, eb)
    visualize = [{"select": s["observation"].get("select"), "logs": s["observation"].get("logs"),
                  "current": s["observation"].get("current"), "selected": s["action"]} for s in steps]
    replay = {
        "ok": True,
        "cards": [to_jsonable(c) for c in all_card_data()],
        "attacks": [to_jsonable(a) for a in all_attack()],
        "steps": steps,
        "visualize": visualize,
        # provenance — NOT part of the viewer schema, ignored by it; the coliseum's audit trail
        "_coliseum": {"seat0": args.a, "seat1": args.b, "result_seat": result,
                      "winner": (args.a if result == 0 else args.b if result == 1 else None)},
    }
    out = args.out or os.path.join(coliseum.ROOT, ".cabt-spike/coliseum/replays", f"{args.a}__vs__{args.b}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(replay, open(out, "w"), ensure_ascii=False)
    winner = replay["_coliseum"]["winner"]
    print(f"   {len(steps)} steps · winner: {winner or 'DRAW'} · cards {len(replay['cards'])} attacks {len(replay['attacks'])}")
    print(f"   replay → {out}  ({round(os.path.getsize(out)/1024)} KB)")
    print(f"   view: cabt-viewer  http://localhost:5173/?view=replay&replayUrl=<served-url-of-this-file>")


if __name__ == "__main__":
    main()
