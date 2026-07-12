import os, sys, json
os.environ.setdefault("CABT_AUGURY", "prize_only")
sys.path.insert(0, ".cabt-spike/dl"); sys.path.insert(0, "src")
from cg import game

deck = [int(x) for x in open(".cabt-spike/sub_dwebble_v4/deck.csv").read().split() if x.strip()][:60]
obs, _ = game.battle_start(deck, deck)
for step in range(60):
    if obs is None:
        break
    cur, sel = obs.get("current"), obs.get("select")
    if cur and cur.get("result", -1) != -1:
        break
    if sel is None:
        break
    st = sel.get("type")
    if st == 0 and cur and cur.get("players"):           # MAIN with a board
        print("SELECT keys:", list(sel.keys()))
        print("OPTION sample:", json.dumps(sel["option"][0]) if sel.get("option") else None)
        print("OPTION types:", sorted({o.get("type") for o in sel.get("option", [])}))
        print("CUR keys:", list(cur.keys()))
        p = cur["players"][cur["yourIndex"]]
        print("PLAYER keys:", list(p.keys()))
        act = (p.get("active") or [None])[0]
        print("ACTIVE pk:", json.dumps(act)[:700] if act else None)
        # also dump an opponent active + a bench card + a card option if present
        op = cur["players"][1 - cur["yourIndex"]]
        oact = (op.get("active") or [None])[0]
        print("OPP ACTIVE pk:", json.dumps(oact)[:500] if oact else None)
        break
    pick = [0] if sel.get("option") else []
    obs = game.battle_select(pick)
game.battle_finish()
