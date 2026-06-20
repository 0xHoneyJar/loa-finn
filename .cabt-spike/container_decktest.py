# container_decktest.py — does the REBUILT deck fix board-establishment + the Lucario matchup?
# Holds the heuristic constant; varies only the DECK. Plays rebuilt-vs-Lucario AND old(35E)-vs-Lucario,
# seat-swapped, tracking win-rate + OUR max bench (the root-cause metric). Real extracted Lucario decklist.
import sys, os, json, csv, math, time
sys.path.insert(0, "/app"); sys.path.insert(0, "/app/cg_src")
os.environ.setdefault("CABT_AUGURY", "prize_only"); os.environ.setdefault("CABT_ROLLOUT", "0")
from cg import game
from cabt import heuristic
from cabt.policy import greedy_baseline

def load(p): return [int(l) for l in open(p) if l.strip()]
REBUILT = load("/app/decks/deck_rebuilt.csv")
OLD     = load("/app/cg_src/deck.csv")          # the 35-energy starter Abomasnow
LUCARIO = load("/app/decks/deck_lucario.csv")

def hero(obs):
    sel = obs.get("select")
    if not sel: return []
    out = heuristic.choose(obs, OLD)            # deck arg is vestigial for in-game scoring
    return out if out else greedy_baseline(sel)

def play(d0, d1, our_seat):
    """seat0 plays d0, seat1 plays d1. Track players[our_seat] max bench. Return (winner, our_max_bench)."""
    obs, _ = game.battle_start(d0, d1); mb = 0
    try:
        for _ in range(4000):
            if obs is None: return None, mb
            cur, sel = obs.get("current"), obs.get("select")
            if isinstance(cur, dict):
                try: mb = max(mb, len((cur['players'][our_seat].get('bench')) or []))
                except Exception: pass
            if cur is not None and cur.get("result", -1) != -1: return cur.get("result"), mb
            if sel is None: return None, mb
            you = cur["yourIndex"] if cur is not None else 0
            pick = (hero)(obs)
            if not pick: pick = [0] if (sel.get("option")) else []
            obs = game.battle_select(pick)
        return None, mb
    finally: game.battle_finish()

def wilson(w, n):
    if not n: return (0.,0.)
    p=w/n; z=1.96; d=1+z*z/n; c=(p+z*z/(2*n))/d; m=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return (max(0.,c-m), min(1.,c+m))

def matchup(label, ourdeck, N):
    w=0; benches=[]; t=time.time()
    for _ in range(N):                          # us = seat0
        r,mb=play(ourdeck, LUCARIO, 0); benches.append(mb)
        if r==0: w+=1
    for _ in range(N):                          # us = seat1 (swap)
        r,mb=play(LUCARIO, ourdeck, 1); benches.append(mb)
        if r==1: w+=1
    tot=2*N; lo,hi=wilson(w,tot)
    print(f"  {label:18s} {w}-{tot-w} ({tot})  wr={w/tot:.3f} [{lo:.2f},{hi:.2f}]  our_avg_max_bench={sum(benches)/len(benches):.1f}  ({(time.time()-t)/tot:.1f}s/m)", flush=True)
    return w/tot

N=int(os.environ.get("N","40"))
print(f"DECK TEST vs real Lucario decklist (heuristic constant), N={N}/seat:", flush=True)
matchup("OLD (35E starter)", OLD, N)
matchup("REBUILT (gygax)", REBUILT, N)
print("DECKTEST_DONE", flush=True)
