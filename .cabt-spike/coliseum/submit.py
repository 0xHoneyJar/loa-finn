#!/usr/bin/env python3
# submit.py — the INTAKE: a teammate submits EXACTLY what they submit to Kaggle
# (a submission.tar.gz, or its unpacked dir) and it becomes a coliseum entrant.
#
# A Kaggle bundle ships its OWN `cabt/` package + a bundled `cg/`. If we imported it in our
# process it would COLLIDE with our cabt/our engine. So validation runs the bundle's agent in
# an ISOLATED SUBPROCESS — its own cabt resolves cleanly, OUR Linux engine wins on the path,
# and the opponent is an inline trivial-legal floor (no cabt dependency). This is the same
# isolation Kaggle itself uses (one submission = one process), and it's the seed of the rails:
# a real round-robin over FOREIGN agents needs one subprocess per agent + a match coordinator.
#
# Usage (in the amd64 container, where the cg engine lives):
#   python .cabt-spike/coliseum/submit.py <submission.tar.gz | bundle_dir> --name alice --owner alice
import argparse, json, os, shutil, subprocess, sys, tarfile, tempfile

ROOT = os.environ.get("COLISEUM_ROOT", os.getcwd())
OUR_CG = os.path.join(ROOT, ".cabt-spike/dl")                      # our Linux engine (libcg.so)
BUNDLES = os.path.join(ROOT, ".cabt-spike/coliseum/bundles")
ROSTER = os.path.join(ROOT, ".cabt-spike/coliseum/roster.json")

# The isolated smoke: imports ONLY the bundle (cwd) + our engine. Plays the bundle agent vs a
# trivial-legal floor, seat-swapped, and reports legality + a smoke win-rate. No cabt import here
# but the bundle's own — so a foreign cabt/ never collides with ours.
SMOKE = r'''
import sys, os, json, traceback
sys.path.insert(0, os.environ["OUR_CG"])     # our engine wins over the bundle's bundled cg/
os.environ.setdefault("CABT_AUGURY", "prize_only"); os.environ.setdefault("CABT_ROLLOUT", "0")
N = int(os.environ.get("SMOKE_N", "3"))
out = {"legal": False, "decisive": 0, "wins": 0, "crashes": 0, "error": None}
try:
    from cg import game
    from main import agent as bundle_agent       # the Kaggle contract: agent(obs) -> list[int]
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
            try:
                p = a(obs)
            except Exception:
                out["crashes"] += 1; p = None
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


def unpack(src, name):
    dest = os.path.join(BUNDLES, name)
    if os.path.isdir(src):
        if os.path.abspath(src) != os.path.abspath(dest):
            shutil.rmtree(dest, ignore_errors=True); shutil.copytree(src, dest)
        return dest
    shutil.rmtree(dest, ignore_errors=True); os.makedirs(dest, exist_ok=True)
    with tarfile.open(src, "r:gz") as t:
        t.extractall(dest)
    # tars often wrap a single top dir or use ./ — flatten to where main.py lives
    if not os.path.exists(os.path.join(dest, "main.py")):
        for r, _, fs in os.walk(dest):
            if "main.py" in fs and "deck.csv" in os.listdir(r):
                return r
    return dest


def validate(bundle_dir, n):
    for need in ("main.py", "deck.csv"):
        if not os.path.exists(os.path.join(bundle_dir, need)):
            return {"legal": False, "error": f"missing {need} (a Kaggle bundle needs main.py exposing agent(obs) + deck.csv)"}
    smoke_path = os.path.join(bundle_dir, "_coliseum_smoke.py")
    open(smoke_path, "w").write(SMOKE)
    env = {**os.environ, "OUR_CG": OUR_CG, "SMOKE_N": str(n)}
    try:
        p = subprocess.run([sys.executable, "_coliseum_smoke.py"], cwd=bundle_dir, env=env,
                           capture_output=True, text=True, timeout=300)
    finally:
        os.remove(smoke_path)
    line = next((l for l in p.stdout.splitlines() if l.startswith("SMOKE_JSON:")), None)
    if not line:
        return {"legal": False, "error": (p.stderr.strip().splitlines() or ["no SMOKE_JSON emitted"])[-1]}
    return json.loads(line[len("SMOKE_JSON:"):])


def upsert_roster(name, owner, bundle_dir):
    spec = json.load(open(ROSTER))
    rel = os.path.relpath(bundle_dir, ROOT)
    entry = {"name": name, "owner": owner, "pilot": f"bundle:{rel}", "deck": os.path.join(rel, "deck.csv"),
             "note": f"teammate submission ({owner}) — validated isolated smoke"}
    ents = spec["entrants"]
    ents[:] = [e for e in ents if e["name"] != name] + [entry]
    json.dump(spec, open(ROSTER, "w"), indent=2)
    return entry


def main():
    ap = argparse.ArgumentParser(description="Submit a Kaggle bundle to the coliseum (isolated validation + register).")
    ap.add_argument("submission", help="path to submission.tar.gz or an unpacked bundle dir")
    ap.add_argument("--name", required=True, help="entrant name (roster key)")
    ap.add_argument("--owner", required=True, help="who submitted it (owner != lab/internal = a REAL entrant)")
    ap.add_argument("--n", type=int, default=3, help="smoke matches per seat")
    args = ap.parse_args()

    print(f"📥 submit: {args.submission}  →  entrant '{args.name}' (owner {args.owner})")
    bundle = unpack(args.submission, args.name)
    print(f"   unpacked → {os.path.relpath(bundle, ROOT)}")
    print(f"   validating in an ISOLATED subprocess (bundle's own cabt/, our engine)…")
    res = validate(bundle, args.n)
    if not res.get("legal"):
        print(f"   ❌ REJECTED — {res.get('error') or 'agent produced no decisive match'}")
        sys.exit(1)
    wr = res["wins"] / res["decisive"] if res["decisive"] else 0.0
    print(f"   ✅ LEGAL — {res['decisive']} decisive smoke matches vs floor, win% {wr:.2f}, {res['crashes']} caught crashes")
    entry = upsert_roster(args.name, args.owner, bundle)
    print(f"   📋 roster updated: {entry['name']}  pilot={entry['pilot']}")
    print(f"\n   Next: run the coliseum to rank the field. (Foreign bundles need the subprocess")
    print(f"   match-coordinator — the rails follow-up — for the FULL round-robin; smoke is in-isolation now.)")


if __name__ == "__main__":
    main()
