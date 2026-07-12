import os, sys
sys.path.insert(0, ".cabt-spike/dl"); sys.path.insert(0, "src")
os.environ.setdefault("CABT_AUGURY", "prize_only")
from cg import game
from cabt import heuristic, heuristic_v6, heuristic_v7
import cabt.cards as C
C._ensure()
print("card DB:", len(C._CARDS or {}), "cards,", len(C._ATTACKS or {}), "attacks")

deck = [int(x) for x in open(".cabt-spike/sub_dwebble_v4/deck.csv").read().split() if x.strip()][:60]
obs, _ = game.battle_start(deck, deck)
total = v4d = v6d = err = 0
for step in range(500):
    if obs is None:
        break
    cur, sel = obs.get("current"), obs.get("select")
    if cur and cur.get("result", -1) != -1:
        break
    if sel is None:
        break
    try:
        p4 = heuristic.choose(obs, deck); p6 = heuristic_v6.choose(obs, deck); p7 = heuristic_v7.choose(obs, deck)
    except Exception as e:
        err += 1; p7 = None; print("v7 ERROR:", repr(e)[:120])
    if sel.get("type") == 0 and int(sel.get("maxCount", 1) or 1) == 1:
        total += 1
        if p4 != p7: v4d += 1
        if p6 != p7: v6d += 1
    obs = game.battle_select(p7 if p7 else ([0] if sel.get("option") else []))
game.battle_finish()
print(f"MAIN single-pick decisions: {total} | v7 differs from v4: {v4d} | from v6: {v6d} | v7 errors: {err}")
print("VERDICT:", "✓ v7 logic FIRES (differs from v4)" if v4d > 0 else "✗ v7 == v4 always — logic NOT firing (floor trap)")
