"""Echelon v1 — proof-of-life match driver (runs INSIDE an amd64 container).

The cg engine is x86-64 Linux native (libcg.so), so on an ARM Mac it runs under Docker
--platform linux/amd64 (qemu). This drives ONE match via the direct cg.game API — the same
battle_start -> battle_select loop -> battle_finish the prior container_arena used — to prove the
engine runs locally. Once this lights up, the live coliseum (clone roster, Elo, validation vs the
5 ladder points) is just more of this loop.

Usage (host): docker run --rm --platform linux/amd64 -v "$PWD:/app" -w /app python:3.12 \
                 bash -c "pip install -q numpy && python .cabt-spike/echelon/arena_match.py [N]"
"""
import sys, os
sys.path.insert(0, ".cabt-spike/dl")   # cg package (libcg.so)
sys.path.insert(0, "src")               # cabt package (heuristic v4, policy)
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1
DECK_FILE = os.environ.get("ARENA_DECK", ".cabt-spike/echelon/deck_dwebble_crustle.csv")

try:
    from cg import game
    from cabt import heuristic
    from cabt.policy import greedy_baseline
except Exception as e:
    print(f"ENGINE LOAD FAILED: {type(e).__name__}: {e}")
    raise SystemExit(1)

deck = [int(l) for l in open(DECK_FILE) if l.strip()]
print(f"engine loaded OK · deck={DECK_FILE} ({len(deck)} cards) · running {N} match(es)")


def v4_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    out = heuristic.choose(obs, deck)
    return out if out else greedy_baseline(sel)


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
                pick = [0] if sel.get("option") else []
            obs = game.battle_select(pick)
        return None
    finally:
        game.battle_finish()


import time
t0 = time.time()
wins = {0: 0, 1: 0, None: 0}
for i in range(N):
    # seat-swap each match (v4 on seat 0 even games, seat 1 odd) for fairness
    if i % 2 == 0:
        r = play(v4_agent, greedy_agent); v4_seat = 0
    else:
        r = play(greedy_agent, v4_agent); v4_seat = 1
    v4_won = (r == v4_seat)
    wins[0 if v4_won else (1 if r is not None else None)] += 1
dt = time.time() - t0
print(f"\nPROOF-OF-LIFE: {N} match(es) in {dt:.1f}s ({dt/max(N,1):.2f}s/match)")
print(f"  v4(Dwebble) vs greedy(Dwebble): v4 won {wins[0]}/{N}  (greedy {wins[1]}, draws {wins[None]})")
print("ENGINE RUNS LOCALLY — coliseum v1 unblocked.")
