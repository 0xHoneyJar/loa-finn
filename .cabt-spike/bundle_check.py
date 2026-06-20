"""Validate the assembled submission bundle plays as Kaggle would.
Imports the bundle's main.py, then runs a full match: main.agent (seat 0) vs random (seat 1),
via the bundle's own cg engine. Success = legal full match (0 illegal). linux/amd64.
"""
import importlib.util
import os
import random
import sys

BUNDLE = "/bundle"
os.chdir(BUNDLE)            # so the agent's deck.csv lookup ("deck.csv") resolves like Kaggle's runtime
sys.path.insert(0, BUNDLE)  # cabt/ + cg/ importable

spec = importlib.util.spec_from_file_location("main", os.path.join(BUNDLE, "main.py"))
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)
print("MAIN_IMPORT_OK agent=%s" % callable(getattr(main, "agent", None)))

from cg import game
from cabt.policy import random_policy

deck = [int(l) for l in open(os.path.join(BUNDLE, "deck.csv")) if l.strip()]
print("DECK_LEN", len(deck), flush=True)

obs, _ = game.battle_start(deck, deck)
illegal = agent_moves = 0
winner = None
for step in range(4000):
    if obs is None:
        break
    cur, sel = obs.get("current"), obs.get("select")
    if cur is not None and cur.get("result", -1) != -1:
        winner = cur.get("result"); break
    if sel is None:
        break
    opts = sel.get("option") or []
    you = cur["yourIndex"] if cur is not None else 0
    if you == 0:
        pick = main.agent(obs)   # the SUBMISSION entry point
        agent_moves += 1
    else:
        pick = random_policy(sel)
    if not pick:
        pick = [0] if opts else []
    if any((i < 0 or i >= len(opts)) for i in pick):
        illegal += 1
        pick = [0] if opts else []
    obs = game.battle_select(pick)

game.battle_finish()
print("BUNDLE_MATCH winner=%s illegal=%s agent_moves=%s" % (winner, illegal, agent_moves))
print("BUNDLE_OK" if illegal == 0 and agent_moves > 0 else "BUNDLE_FAIL")
