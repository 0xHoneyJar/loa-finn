# container_smoke.py — the FIRST real cabt match this lab has ever run end-to-end.
# Reuses the exact eval harness shape (eval_funsearch.py) but small + timed, so we
# learn (a) does the real engine run in an amd64 container, (b) the per-match cost
# under qemu emulation (decides if a real metabolism run is feasible locally).
import math, os, sys, time

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game
from cabt import policy, heuristic
from cabt.policy import greedy_baseline

deck = [int(l) for l in open("/app/cg_src/deck.csv") if l.strip()]
print("DECK_LEN", len(deck), flush=True)


def heuristic_agent(obs):
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


N = int(os.environ.get("SMOKE_N", "3"))
print(f"SMOKE: heuristic vs greedy, N={N} per seat (seat-swapped)", flush=True)
t0 = time.time()
w0 = 0
for i in range(N):
    ts = time.time()
    r = play(heuristic_agent, greedy_agent)
    print(f"  seat0 #{i}: result={r} ({time.time()-ts:.1f}s)", flush=True)
    if r == 0:
        w0 += 1
w1 = 0
for i in range(N):
    ts = time.time()
    r = play(greedy_agent, heuristic_agent)
    print(f"  seat1 #{i}: result={r} ({time.time()-ts:.1f}s)", flush=True)
    if r == 1:
        w1 += 1
tot, wins = 2 * N, w0 + w1
lo, hi = wilson(wins, tot)
avg = (time.time() - t0) / tot
print(
    f"FIRST_REAL_RESULT heuristic vs greedy {wins}/{tot} winrate={wins/tot:.2f} "
    f"CI95=[{lo:.2f},{hi:.2f}] (seat0 {w0}/{N}, seat1 {w1}/{N}) "
    f"| {avg:.1f}s/match avg under emulation",
    flush=True,
)
print("SMOKE_DONE", flush=True)
