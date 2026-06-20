"""Echelon — CLONE-FIELD VALIDATION GATE (runs inside the amd64 container).

Sibling of validate_arena.py. GAMES-013: the v4-piloted field was too WEAK — it separated the
ladder (v4 719 > v5 569 > v6 540) by only 0.08, within noise. Field QUALITY is the whole ballgame.
So swap the v4-piloted FIELD for the CLONE field: each archetype opponent is piloted by ITS OWN
imitation clone (lucario-clone on deck_lucario, dwebble-clone on deck_dwebble_crustle, alakazam-clone
on deck_alakazam) — a stronger, reality-mirroring field.

The test (UNCHANGED from validate_arena.py): each pilot v4/v5/v6 (same Abomasnow deck — pure-pilot
compare) plays the field. Does the STRONGER clone-field SEPARATE v4 > v5 > v6 BETTER than the
v4-piloted field's 0.08 spread? Separation is a LEARNABILITY/field-strength signal — NOT a strength
claim about the clones themselves.

Usage (host): docker run --rm --platform linux/amd64 -v "$PWD:/app" -w /app python:3.12 \
                 bash -c "python .cabt-spike/echelon/validate_arena_clones.py [N]"
  (no numpy install needed — clone serve is pure-python.)
"""
import sys, os, time
sys.path.insert(0, ".cabt-spike/dl")        # cg engine
sys.path.insert(0, "src")                    # cabt pilots
sys.path.insert(0, ".cabt-spike/echelon")    # clone_agent
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game
from cabt import heuristic, heuristic_v5, heuristic_v6
from cabt.policy import greedy_baseline
from clone_agent import make_clone


def load(p):
    return [int(l) for l in open(p) if l.strip()]


ABO = load(".cabt-spike/sub_v6_validate/deck.csv")  # the deck v4/v5/v6 all ship (pure-pilot compare)
FIELD = {
    "dwebble": (".cabt-spike/echelon/deck_dwebble_crustle.csv", "dwebble_crustle"),
    "lucario": (".cabt-spike/echelon/deck_lucario.csv", "lucario"),
    "alakazam": (".cabt-spike/echelon/deck_alakazam.csv", "alakazam"),
}
FIELD_DECKS = {k: load(v[0]) for k, v in FIELD.items()}

# One clone agent per archetype. make_clone RAISES on missing weights (no silent greedy) — so a
# misconfigured field fails LOUD here, before any match runs.
CLONES = {k: make_clone(v[1]) for k, v in FIELD.items()}


def pilot(choose):
    """Pilot the Abomasnow deck with a cabt heuristic; greedy fallback only at deck-select / errors."""
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


def clone_field(archetype):
    """FIELD agent: the archetype's imitation clone. Falls back to greedy ONLY when the clone declines
    (deck-select -> None, or board context unavailable) — the same fallback shape as v4field/pilot, and
    distinct from the LOAD gate (which already raised at make_clone if weights were missing)."""
    cl = CLONES[archetype]

    def a(obs):
        sel = obs.get("select")
        if not sel:
            return []
        try:
            out = cl(obs)
        except Exception:
            out = None
        return out if out else greedy_baseline(sel)
    return a


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


def greedy(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


PILOTS = {"v4": pilot(heuristic.choose), "v5": pilot(heuristic_v5.choose), "v6": pilot(heuristic_v6.choose)}
# FIELD agents: each archetype piloted by ITS OWN clone, on ITS OWN deck.
FIELD_AGENTS = {fn: clone_field(fn) for fn in FIELD}  # CLONES is keyed by the FIELD key (fn), not arch_slug

N = int(sys.argv[1]) if len(sys.argv) > 1 else 16
t0 = time.time()
print(f"CLONE-FIELD GATE · each pilot (Abomasnow) vs greedy + CLONE meta-field · N={N}/matchup, seat-swapped")
print(f"  field = {', '.join(f'{fn}-clone' for fn in FIELD)}")
results = {}
for name, pa in PILOTS.items():
    row = {"greedy": match(pa, greedy, ABO, N)}
    for fn, fd in FIELD_DECKS.items():
        row[fn] = match(pa, FIELD_AGENTS[fn], fd, N)
    results[name] = row
    print(f"  {name} done ({time.time()-t0:.0f}s)")

cols = ["greedy"] + list(FIELD)
print("\n=== ARENA SCORES (pilot win-rate vs CLONE field) ===")
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
V4FIELD_SPREAD = 0.08  # the v4-piloted field's spread (GAMES-013 baseline to beat)

print("\n=== VERDICT ===")
print(f"  arena field-rank   : {' > '.join(order)}   (ladder: v4 > v5 > v6 = 719/569/540)")
print(f"  reproduces ladder  : {order == ladder}")
print(f"  greedy-field spread: {greedy_spread:.2f}")
print(f"  CLONE-field spread : {field_spread:.2f}   (v4-piloted field gave {V4FIELD_SPREAD:.2f})")
print(f"  separates better?  : {field_spread > V4FIELD_SPREAD}  "
      f"(clone-field {field_spread:.2f} vs v4-field {V4FIELD_SPREAD:.2f})")
if order == ladder and field_spread > greedy_spread + 0.05 and field_spread > V4FIELD_SPREAD:
    verdict = "STRONGER FIELD WINS (reproduces ladder + separates better than v4-field)"
elif field_spread > V4FIELD_SPREAD:
    verdict = "PARTIAL (clone-field separates wider than v4-field, but ladder mis-ranked)"
else:
    verdict = "NO GAIN (clone-field did not out-separate the v4-piloted field)"
print(f"  >>> {verdict}")
print(f"  ({sum(results[n][c][1] for n in PILOTS for c in cols)} matches in {time.time()-t0:.0f}s)")
