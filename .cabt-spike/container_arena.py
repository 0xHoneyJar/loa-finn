# container_arena.py — the metabolism's first REAL matchup matrix.
#
# The Oracle proposes heuristic-priors variants; REAL cabt grades them. Each candidate
# plays the current champion (_BASE) and the greedy floor, seat-swapped, N matches, with
# a Wilson CI. This is the metabolism's logic (population -> matchup -> who wins) on GROUND
# TRUTH instead of the ToyHand.
#
# HONEST CAVEAT (anti-reward-hack, the n_worlds lesson): beating _BASE in self-play is a
# LOCAL PROXY. The ladder is ground truth. A winner here is a PRE-REGISTERED LADDER
# CANDIDATE, never a confirmed improvement. Self-play overfits to our own opponent pool.
import json, math, os, sys, time

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game
from cabt import heuristic
from cabt.policy import greedy_baseline
from cabt.heuristic import PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END

deck = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]

# The current champion — the committed _BASE (heuristic.py:20).
CHAMPION = {ATTACH: 50.0, EVOLVE: 48.0, PLAY: 45.0, ABILITY: 42.0, ATTACK: 25.0, RETREAT: 10.0, DISCARD: 6.0, END: 2.0}


def make_agent(priors):
    """An agent that plays heuristic.choose under ITS OWN priors. play() is sequential
    (one agent computes a move at a time), so setting the module global right before the
    scan gives each side its own priors within a single match — no cross-contamination."""
    def agent(obs):
        sel = obs.get("select")
        if not sel:
            return []
        heuristic._BASE = priors          # activate MY priors for this decision
        out = heuristic.choose(obs, deck)
        return out if out else greedy_baseline(sel)
    return agent


def greedy_agent(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


def play(a0, a1):
    obs, _ = game.battle_start(deck, deck)
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


def wilson(w, n):
    if not n:
        return (0.0, 0.0)
    p = w / n
    z = 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - m), min(1.0, c + m))


def h2h(hero_priors, villain_agent, N):
    """hero (priors) vs a villain agent, seat-swapped. Returns (winrate, lo, hi, wins, tot)."""
    hero = make_agent(hero_priors)
    w0 = sum(1 for _ in range(N) if play(hero, villain_agent) == 0)
    w1 = sum(1 for _ in range(N) if play(villain_agent, hero) == 1)
    tot, wins = 2 * N, w0 + w1
    lo, hi = wilson(wins, tot)
    return wins / tot, lo, hi, wins, tot


def perturb(base, seed):
    """A deterministic LCG-perturbed priors vector — the Oracle's exploration. ±35% jitter
    on each prior, clamped >= 0. Seeded so the whole experiment reproduces."""
    s = (seed * 1103515245 + 12345) & 0x7FFFFFFF
    out = {}
    for k in base:
        s = (s * 1103515245 + 12345) & 0x7FFFFFFF
        frac = (s / 0x7FFFFFFF) * 0.70 - 0.35     # in [-0.35, +0.35]
        out[k] = round(max(0.0, base[k] * (1.0 + frac)), 1)
    return out


# --- the population: the champion + hand-designed hypotheses + Oracle random explorations ---
def named(d):
    return {"ATTACH": d[ATTACH], "EVOLVE": d[EVOLVE], "PLAY": d[PLAY], "ABILITY": d[ABILITY],
            "ATTACK": d[ATTACK], "RETREAT": d[RETREAT], "DISCARD": d[DISCARD], "END": d[END]}


CANDIDATES = [
    ("champion", dict(CHAMPION)),
    # hand-designed hypotheses
    ("energy-focus(v5)", {**CHAMPION, ATTACH: 70.0}),               # the pre-registered v5 energy hypothesis
    ("more-aggressive", {**CHAMPION, ATTACK: 45.0}),
    ("less-aggressive", {**CHAMPION, ATTACK: 12.0}),
    ("evolve-priority", {**CHAMPION, EVOLVE: 60.0}),
    ("ability-priority", {**CHAMPION, ABILITY: 55.0}),
    ("develop-max", {**CHAMPION, ATTACH: 60.0, EVOLVE: 58.0, ATTACK: 15.0}),
]
# Oracle explorations — deterministic random perturbations of the champion.
for i in range(6):
    CANDIDATES.append((f"oracle-rand-{i}", perturb(CHAMPION, i + 1)))

N_VS_CHAMP = int(os.environ.get("N_VS_CHAMP", "40"))
N_VS_GREEDY = int(os.environ.get("N_VS_GREEDY", "25"))

print(f"ARENA: {len(CANDIDATES)} candidates · N_vs_champ={N_VS_CHAMP} N_vs_greedy={N_VS_GREEDY} "
      f"(~{len(CANDIDATES)*(N_VS_CHAMP+N_VS_GREEDY)*2} matches)", flush=True)
greedy = greedy_agent
champ_agent = make_agent(CHAMPION)
t0 = time.time()
results = []
for name, priors in CANDIDATES:
    vs_g = h2h(priors, greedy, N_VS_GREEDY)
    vs_c = (None if name == "champion" else h2h(priors, champ_agent, N_VS_CHAMP))
    row = {"name": name, "priors": named(priors),
           "vs_greedy": {"winrate": round(vs_g[0], 3), "ci95": [round(vs_g[1], 3), round(vs_g[2], 3)], "record": f"{vs_g[3]}/{vs_g[4]}"},
           "vs_champion": (None if vs_c is None else {"winrate": round(vs_c[0], 3), "ci95": [round(vs_c[1], 3), round(vs_c[2], 3)], "record": f"{vs_c[3]}/{vs_c[4]}"})}
    results.append(row)
    vc = "    —    " if vs_c is None else f"{vs_c[0]:.2f} [{vs_c[1]:.2f},{vs_c[2]:.2f}]"
    print(f"  {name:18s}  vs_greedy={vs_g[0]:.2f} [{vs_g[1]:.2f},{vs_g[2]:.2f}]   vs_champ={vc}", flush=True)

elapsed = time.time() - t0
# A candidate "beats the champion" only if its vs_champion CI LOWER bound > 0.5 (honest bar).
beats = [r for r in results if r["vs_champion"] and r["vs_champion"]["ci95"][0] > 0.5]
out = {"champion_priors": named(CHAMPION), "n_vs_champ": N_VS_CHAMP, "n_vs_greedy": N_VS_GREEDY,
       "elapsed_s": round(elapsed, 1), "results": results,
       "beats_champion_ci_lower_gt_0.5": [b["name"] for b in beats]}
json.dump(out, open("/app/out/arena_results.json", "w"), indent=2)
print(f"\nELAPSED {elapsed:.1f}s · beats_champion(CI>0.5): {[b['name'] for b in beats] or 'NONE'}", flush=True)
print("ARENA_DONE", flush=True)
