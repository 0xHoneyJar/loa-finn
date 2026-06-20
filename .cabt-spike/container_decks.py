# container_decks.py — does DECK VARIETY create the signal same-deck self-play lacked?
# Same-deck play is luck-bound (proven: every reasonable policy ~0.5 vs greedy). But the
# ladder is DECK-vs-DECK. battle_start(d0, d1) takes a deck per side. Two questions:
#   (1) DECK STRENGTH: greedy both sides, vary decks — does one deck just beat another?
#       (isolates deck contribution; directly tests the pre-registered deck-Lucario decision)
#   (2) POLICY-UNDER-DECK: heuristic vs greedy ON each deck — does policy edge appear on a
#       stronger deck even though it's flat on the sample deck?
import math, os, sys, time

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game
from cabt import heuristic
from cabt.policy import greedy_baseline
from cabt.heuristic import PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END

CHAMPION = {ATTACH: 50.0, EVOLVE: 48.0, PLAY: 45.0, ABILITY: 42.0, ATTACK: 25.0, RETREAT: 10.0, DISCARD: 6.0, END: 2.0}


def load(path):
    return [int(l) for l in open(path) if l.strip()]


DECKS = {"sample": load("/app/cg_src/deck.csv"), "lucario": load("/app/decks/lucario.csv"), "monofighting": load("/app/decks/monofighting.csv")}


def heuristic_agent(obs):
    sel = obs.get("select")
    if not sel:
        return []
    heuristic._BASE = CHAMPION
    out = heuristic.choose(obs, DECKS["sample"])  # deck arg is vestigial for in-game scoring
    return out if out else greedy_baseline(sel)


def greedy_agent(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


def play(a0, a1, d0, d1):
    obs, _ = game.battle_start(d0, d1)
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
    p = w / n
    z = 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - m), min(1.0, c + m))


def deck_h2h(label, agent, dA, dB, N):
    """deck dA vs deck dB (same agent both sides), seat-swapped. winrate = dA's."""
    w0 = sum(1 for _ in range(N) if play(agent, agent, DECKS[dA], DECKS[dB]) == 0)
    w1 = sum(1 for _ in range(N) if play(agent, agent, DECKS[dB], DECKS[dA]) == 1)
    tot, wins = 2 * N, w0 + w1
    lo, hi = wilson(wins, tot)
    sig = "DECK EDGE" if lo > 0.5 else ("DECK DEFICIT" if hi < 0.5 else "~0.5 (no deck edge)")
    print(f"  {label:34s} {wins}/{tot}  wr={wins/tot:.3f}  CI95=[{lo:.3f},{hi:.3f}]  {sig}", flush=True)


def policy_h2h(label, deck, N):
    """heuristic vs greedy, BOTH on the same deck. winrate = heuristic's."""
    w0 = sum(1 for _ in range(N) if play(heuristic_agent, greedy_agent, DECKS[deck], DECKS[deck]) == 0)
    w1 = sum(1 for _ in range(N) if play(greedy_agent, heuristic_agent, DECKS[deck], DECKS[deck]) == 1)
    tot, wins = 2 * N, w0 + w1
    lo, hi = wilson(wins, tot)
    sig = "POLICY EDGE" if lo > 0.5 else ("POLICY DEFICIT" if hi < 0.5 else "~0.5 (flat)")
    print(f"  {label:34s} {wins}/{tot}  wr={wins/tot:.3f}  CI95=[{lo:.3f},{hi:.3f}]  {sig}", flush=True)


N = int(os.environ.get("N", "60"))
print(f"DECK-VARIETY PROBE  N={N}/matchup", flush=True)
print("-- (1) DECK STRENGTH: greedy both sides, vary decks (isolate deck) --", flush=True)
deck_h2h("lucario vs sample [greedy]", greedy_agent, "lucario", "sample", N)
deck_h2h("monofighting vs sample [greedy]", greedy_agent, "monofighting", "sample", N)
deck_h2h("lucario vs monofighting [greedy]", greedy_agent, "lucario", "monofighting", N)
print("-- (2) POLICY edge per deck: heuristic vs greedy, same deck both --", flush=True)
policy_h2h("heuristic>greedy on sample", "sample", N)
policy_h2h("heuristic>greedy on lucario", "lucario", N)
policy_h2h("heuristic>greedy on monofighting", "monofighting", N)
print("DECKS_DONE", flush=True)
