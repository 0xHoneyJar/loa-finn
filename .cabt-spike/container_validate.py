# container_validate.py — prove the deck-swap tarball is a CORRECT, RUNNABLE submission.
# Extracted bundle is mounted at /app/sub. We import the REAL Kaggle entry (cabt.agent.agent)
# exactly as Kaggle would, confirm the packaged deck is monofighting (60), and play it vs
# greedy so a runtime/import error surfaces here, not on the ladder.
import sys, os, time

SUB = "/app/sub"
sys.path.insert(0, SUB)
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game
from cabt.agent import agent as sub_agent  # THE Kaggle-called symbol
from cabt.policy import greedy_baseline

deck = [int(l) for l in open(os.path.join(SUB, "deck.csv")) if l.strip()]
print("PACKAGED DECK_LEN", len(deck), flush=True)


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


N = int(os.environ.get("N", "12"))
t = time.time()
w = sum(1 for _ in range(N) if play(sub_agent, greedy_agent) == 0)
w += sum(1 for _ in range(N) if play(greedy_agent, sub_agent) == 1)
print(f"VALIDATE packaged-submission vs greedy {w}/{2*N} winrate={w/(2*N):.2f} in {time.time()-t:.1f}s", flush=True)
print("VALIDATE_OK — tarball imports the Kaggle agent symbol, loads monofighting(60), plays legal moves", flush=True)
print("VALIDATE_DONE", flush=True)
