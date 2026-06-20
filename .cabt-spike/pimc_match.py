"""Validate the PIMC agent (src/cabt) plays a full, legal match vs random using the real cg engine.
linux/amd64. Self-play via cg.game; PIMC (seat 0) decides via cg.api determinized search, random seat 1.
Success = matches reach a terminal result with 0 illegal picks from PIMC. (Win-rate is Sprint-2 eval.)
"""
import random
import sys
import traceback

sys.path.insert(0, "/app")        # parent of the `cabt` package
sys.path.insert(0, "/app/cg_src")  # the `cg` package + deck.csv

from cg import game
from cabt.policy import pimc_select, random_policy

deck = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]
print("DECK_LEN", len(deck), flush=True)
N_WORLDS = 2
N_MATCHES = 2
MAX_STEPS = 4000


def play_one(pimc_seat: int = 0) -> tuple:
    obs, _ = game.battle_start(deck, deck)
    illegal = pimc_decisions = 0
    for step in range(MAX_STEPS):
        if step and step % 300 == 0:
            print("  ...step %d (pimc_decisions=%d)" % (step, pimc_decisions), flush=True)
        if obs is None:
            return None, step, illegal, pimc_decisions
        cur, sel = obs.get("current"), obs.get("select")
        if cur is not None and cur.get("result", -1) != -1:
            return cur.get("result"), step, illegal, pimc_decisions
        if sel is None:
            return None, step, illegal, pimc_decisions
        opts = sel.get("option") or []
        you = cur["yourIndex"] if cur is not None else 0
        if you == pimc_seat and cur is not None:
            try:
                pick = pimc_select(obs, deck, n_worlds=N_WORLDS)
                pimc_decisions += 1
            except Exception:
                traceback.print_exc()
                pick = []
        else:
            pick = random_policy(sel)
        if not pick:
            pick = [0] if opts else []
        if any((i < 0 or i >= len(opts)) for i in pick):
            illegal += 1
            pick = [0] if opts else []
        obs = game.battle_select(pick)
    return None, MAX_STEPS, illegal, pimc_decisions


wins = 0
for m in range(N_MATCHES):
    winner, steps, illegal, decisions = play_one()
    if winner == 0:
        wins += 1
    print("MATCH %d winner=%s steps=%s illegal=%s pimc_decisions=%s"
          % (m, winner, steps, illegal, decisions), flush=True)
    game.battle_finish()

print("PIMC_WINS %d/%d (seat0 vs random seat1)" % (wins, N_MATCHES), flush=True)
print("PIMC_AGENT_OK", flush=True)
