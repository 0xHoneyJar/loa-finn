# validate.py — isolated bundle validation (the proven submit.py smoke, service-side).
# Runs the submitted bundle's agent in its OWN subprocess (its own cabt/, our vendored engine,
# an inline trivial-legal floor opponent — no cabt collision). Confirms the agent is LEGAL and
# never-crashes in the real cg engine before it enters the field. Same isolation Kaggle uses.
import json, os, subprocess, sys
import sandbox  # scrubbed env + hardened preexec (fixes the live os.environ leak to untrusted code)

SMOKE = r'''
import sys, os, json, traceback
sys.path.insert(0, os.environ["OUR_CG"])     # vendored engine wins over any bundled cg/
os.environ.setdefault("CABT_AUGURY", "prize_only"); os.environ.setdefault("CABT_ROLLOUT", "0")
N = int(os.environ.get("SMOKE_N", "3"))
out = {"legal": False, "decisive": 0, "wins": 0, "crashes": 0, "error": None}
try:
    from cg import game
    from main import agent as bundle_agent
    deck = [int(l) for l in open("deck.csv") if l.strip()]
    def floor(obs):
        sel = obs.get("select")
        if not sel: return []
        opt = sel.get("option") or []
        if not opt: return []
        k = max(1, int(sel.get("minCount", 0) or 0))
        return sorted(range(min(k, len(opt))))
    def safe(a):
        def f(obs):
            try: p = a(obs)
            except Exception: out["crashes"] += 1; p = None
            return p if p else floor(obs)
        return f
    hero = safe(bundle_agent)
    def play(d0, d1, a0, a1):
        obs, _ = game.battle_start(d0, d1)
        try:
            for _ in range(4000):
                if obs is None: return None
                cur, sel = obs.get("current"), obs.get("select")
                if cur is not None and cur.get("result", -1) != -1: return cur.get("result")
                if sel is None: return None
                you = cur["yourIndex"] if cur is not None else 0
                pick = (a0 if you == 0 else a1)(obs)
                if not pick: pick = [0] if sel.get("option") else []
                obs = game.battle_select(pick)
            return None
        finally:
            game.battle_finish()
    dec = w = 0
    for i in range(N * 2):
        if i % 2 == 0: r = play(deck, deck, hero, floor); hero_seat = 0
        else:          r = play(deck, deck, floor, hero); hero_seat = 1
        if r is None: continue
        dec += 1; w += 1 if r == hero_seat else 0
    out.update(legal=(dec > 0), decisive=dec, wins=w)
except Exception:
    out["error"] = traceback.format_exc().strip().splitlines()[-1]
print("SMOKE_JSON:" + json.dumps(out))
'''


def validate_bundle(bundle_dir: str, engine_dir: str, n: int = 3) -> dict:
    for need in ("main.py", "deck.csv"):
        if not os.path.exists(os.path.join(bundle_dir, need)):
            return {"legal": False, "error": f"missing {need} (a Kaggle bundle needs main.py exposing agent(obs) + deck.csv)"}
    smoke_path = os.path.join(bundle_dir, "_coliseum_smoke.py")
    with open(smoke_path, "w") as f:
        f.write(SMOKE)
    env = sandbox.scrubbed_env({"OUR_CG": engine_dir, "SMOKE_N": str(n)})  # NOT {**os.environ}
    try:
        p = subprocess.run([sys.executable, "_coliseum_smoke.py"], cwd=bundle_dir, env=env,
                           capture_output=True, text=True, timeout=300, preexec_fn=sandbox.harden)
    finally:
        try: os.remove(smoke_path)
        except OSError: pass
    line = next((l for l in p.stdout.splitlines() if l.startswith("SMOKE_JSON:")), None)
    if not line:
        return {"legal": False, "error": (p.stderr.strip().splitlines() or ["no SMOKE_JSON emitted"])[-1]}
    return json.loads(line[len("SMOKE_JSON:"):])


def find_bundle_root(extracted: str) -> str:
    """Tars often wrap a top dir or use ./ — return where main.py + deck.csv live."""
    if os.path.exists(os.path.join(extracted, "main.py")):
        return extracted
    for root, _dirs, files in os.walk(extracted):
        if "main.py" in files and "deck.csv" in files:
            return root
    return extracted
