import os, sys
sys.path.insert(0, ".cabt-spike/dl"); sys.path.insert(0, "src")
os.environ.setdefault("CABT_AUGURY", "prize_only")
from cg import game
from cabt.policy import greedy_baseline

def load(p):
    return [int(x) for x in open(p).read().split() if x.strip()][:60]

base = load(".cabt-spike/sub_dwebble_v4/deck.csv")
variants = {
    "exbelt": ".cabt-spike/variants/crustle-exbelt/deck.csv",
    "boss": ".cabt-spike/variants/crustle-boss/deck.csv",
    "pivotheal": ".cabt-spike/variants/crustle-pivotheal/deck.csv",
    "lean": ".cabt-spike/variants/crustle-lean/deck.csv",
}
for name, p in variants.items():
    d = load(p)
    print(f"{name:<10} ({len(d)} cards)", end="  ")
    try:
        obs, sd = game.battle_start(d, base)
        if obs is None:
            print(f"→ battle_start RETURNED NONE — deck REJECTED (errorPlayer={sd.errorPlayer}, errorType={sd.errorType})")
            continue
        steps, res = 0, None
        for _ in range(4000):
            cur, sel = obs.get("current"), obs.get("select")
            if cur and cur.get("result", -1) != -1:
                res = cur.get("result"); break
            if sel is None:
                break
            pick = greedy_baseline(sel) or ([0] if sel.get("option") else [])
            obs = game.battle_select(pick); steps += 1
        game.battle_finish()
        print(f"→ started OK, ran {steps} steps, result={res}" + ("  ⚠ NON-TERMINATING (hit cap)" if res is None and steps >= 3999 else ""))
    except Exception as e:
        print(f"→ EXCEPTION: {repr(e)[:120]}")
        try:
            game.battle_finish()
        except Exception:
            pass
