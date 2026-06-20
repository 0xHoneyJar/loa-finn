"""Echelon — THE VALIDATION GATE (runs inside the amd64 container).

The coliseum's entire value-prop: a fast local signal that can REPLACE the 5-bets/day ladder.
We already proved a greedy-field arena CANNOT (GAMES-008: pilots clustered at 0.5). The test:
does a DIVERSE META-FIELD arena reproduce the known ladder ranking v4 > v5 > v6 (719/569/540)?

Each pilot (v4/v5/v6 — same Abomasnow deck, pure-pilot difference) plays:
  - greedy (the OLD weak field — expected to cluster), and
  - the diverse meta-field: Dwebble/Crustle, Lucario, Alakazam (the RPS triangle), each piloted by v4.
If the diverse-field ranking == v4>v5>v6 AND it separates them where greedy can't -> the arena is a
trustworthy fast signal -> the coliseum premise holds. If not -> it's self-play cosplay (a real result).
"""
import sys, os, time
sys.path.insert(0, ".cabt-spike/dl")   # cg engine
sys.path.insert(0, "src")               # cabt
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game
from cabt import heuristic, heuristic_v5, heuristic_v6
from cabt.policy import greedy_baseline


def load(p):
    return [int(l) for l in open(p) if l.strip()]


ABO = load(".cabt-spike/sub_v6_validate/deck.csv")  # the deck v4/v5/v6 all ship (pure-pilot compare)
FIELD = {
    "dwebble": load(".cabt-spike/echelon/deck_dwebble_crustle.csv"),
    "lucario": load(".cabt-spike/echelon/deck_lucario.csv"),
    "alakazam": load(".cabt-spike/echelon/deck_alakazam.csv"),
}


def pilot(choose):
    def a(obs):
        sel = obs.get("select")
        if not sel:
            return []
        try:
            out = choose(obs, ABO)
        except Exception:
            out = None
        return out if out else greedy_baseline(sel)
    return a


def v4field(obs):
    sel = obs.get("select")
    if not sel:
        return []
    try:
        out = heuristic.choose(obs, None)
    except Exception:
        out = None
    return out if out else greedy_baseline(sel)


def greedy(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


PILOTS = {"v4": pilot(heuristic.choose), "v5": pilot(heuristic_v5.choose), "v6": pilot(heuristic_v6.choose)}


def play(deck0, deck1, a0, a1):
    obs, _ = game.battle_start(deck0, deck1)
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
                pick = [0] if sel.get("option") else []
            obs = game.battle_select(pick)
        return None
    finally:
        game.battle_finish()


def match(pilot_agent, opp_agent, opp_deck, N):
    w = n = 0
    for i in range(N):
        if i % 2 == 0:
            r = play(ABO, opp_deck, pilot_agent, opp_agent); pilot_seat = 0
        else:
            r = play(opp_deck, ABO, opp_agent, pilot_agent); pilot_seat = 1
        if r is None:
            continue
        n += 1; w += 1 if r == pilot_seat else 0
    return w, n


def wr(t):
    return t[0] / t[1] if t[1] else 0.0


N = int(sys.argv[1]) if len(sys.argv) > 1 else 16
t0 = time.time()
print(f"VALIDATION GATE · each pilot (Abomasnow) vs greedy + diverse meta-field · N={N}/matchup, seat-swapped")
results = {}
for name, pa in PILOTS.items():
    row = {"greedy": match(pa, greedy, ABO, N)}
    for fn, fd in FIELD.items():
        row[fn] = match(pa, v4field, fd, N)
    results[name] = row
    print(f"  {name} done ({time.time()-t0:.0f}s)")

cols = ["greedy"] + list(FIELD)
print("\n=== ARENA SCORES (pilot win-rate) ===")
print("  pilot  " + "  ".join(f"{c:>9s}" for c in cols) + "   FIELD_avg")
favg = {}
for name in ["v4", "v5", "v6"]:
    row = results[name]
    favg[name] = sum(wr(row[f]) for f in FIELD) / len(FIELD)
    print(f"  {name:5s} " + "  ".join(f"{wr(row[c]):9.2f}" for c in cols) + f"   {favg[name]:.3f}")

order = sorted(favg, key=lambda n: -favg[n])
ladder = ["v4", "v5", "v6"]
g = {n: wr(results[n]["greedy"]) for n in PILOTS}
greedy_spread = max(g.values()) - min(g.values())
field_spread = max(favg.values()) - min(favg.values())
print("\n=== VERDICT ===")
print(f"  arena field-rank : {' > '.join(order)}   (ladder: v4 > v5 > v6 = 719/569/540)")
print(f"  reproduces ladder: {order == ladder}")
print(f"  separation       : greedy-field spread={greedy_spread:.2f}  diverse-field spread={field_spread:.2f}")
verdict = "TRUSTWORTHY (reproduces ladder + separates)" if (order == ladder and field_spread > greedy_spread + 0.05) \
    else ("PARTIAL (separates but mis-ranks)" if field_spread > greedy_spread + 0.05 else "SELF-PLAY COSPLAY (cannot separate)")
print(f"  >>> {verdict}")
print(f"  ({sum(results[n][c][1] for n in PILOTS for c in cols)} matches in {time.time()-t0:.0f}s)")
