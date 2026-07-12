#!/usr/bin/env python3
# coliseum.py — the LIVE COLISEUM: a round-robin tournament over Kaggle-shaped agents,
# fought in the real `cg` engine. Every entrant plays every other, seat-swapped, N matches.
# Output: a Bradley-Terry Elo leaderboard + win-matrix + a field-trust meter + results JSON.
#
# An ENTRANT = (pilot, deck). The pilot is either a built-in heuristic, the greedy floor, an
# imitation clone (SPARRING), or an external `bundle:` — a teammate's directory exposing the
# Kaggle contract `agent(obs) -> list[int]` + a deck.csv. That is the intake: a teammate drops
# their agent in, adds a roster line, and they're in the coliseum.
#
# ── HONEST CAVEAT (load-bearing — do not delete) ───────────────────────────────────────────
# A coliseum is a LOCAL PROXY for the ladder, never the ladder. GAMES-014 PROVED that a field of
# our OWN variants + imitation clones CANNOT reproduce the ladder (0.08-0.10 spread, mis-ranks
# v4>v5>v6). The coliseum is trustworthy IN PROPORTION to how REAL and DIVERSE its entrants are.
# Clones are flagged SPARRING. The field-trust meter below makes the synthetic-field warning
# impossible to miss. The instrument earns trust only when REAL teammate agents fill the roster.
#
# ── RELIABILITY (the 2026-06-22 seed fix) ───────────────────────────────────────────────────
# The cg engine (native libcg.so/.dll) auto-seeds its own RNG and exposes NO Seed() symbol — so
# per-match outcomes are NOT reproducible from Python (a single N=6 run flipped v6-Dwebble 1277→876).
# `--seed` therefore controls only HARNESS-level randomness (clone sampling, ordering) — it CANNOT
# make the engine deterministic. The real defense against the noise is built in below: a higher N
# default + a Wilson 95% CI on every win% + an ADJACENT-RANK reliability check that flags when the
# order between two entrants is within-noise (their head-to-head CI straddles 0.50). That flag is
# what would have caught the v6 fluke: trust a rank gap only when it's marked ✓ robust.
# ────────────────────────────────────────────────────────────────────────────────────────────
import argparse, importlib.util, json, math, os, random, sys, time

ROOT = os.environ.get("COLISEUM_ROOT", os.getcwd())
sys.path.insert(0, os.path.join(ROOT, ".cabt-spike/dl"))       # cg engine (Linux-only .so)
sys.path.insert(0, os.path.join(ROOT, "src"))                  # cabt pilots (heuristic v4/v5/v6)
sys.path.insert(0, os.path.join(ROOT, ".cabt-spike/echelon"))  # clone_agent (sparring)
os.environ.setdefault("CABT_AUGURY", "prize_only")
os.environ.setdefault("CABT_ROLLOUT", "0")

from cg import game                                            # noqa: E402
from cabt import heuristic, heuristic_v5, heuristic_v6, heuristic_v7  # noqa: E402
from cabt.policy import greedy_baseline                        # noqa: E402

_BUILTIN = {"v4": heuristic.choose, "v5": heuristic_v5.choose, "v6": heuristic_v6.choose, "v7": heuristic_v7.choose}


def resolve(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def load_deck(path):
    return [int(l) for l in open(resolve(path)) if l.strip()]


def _greedy(obs):
    sel = obs.get("select")
    return greedy_baseline(sel) if sel else []


def make_pilot(spec, deck):
    """Build an agent obs->list[int] from a roster `pilot` spec. greedy is the universal
    fallback at deck-select / decline / error — the same never-crash contract the ladder needs."""
    if spec == "greedy":
        return _greedy
    if spec.startswith("clone:"):
        from clone_agent import make_clone
        cl = make_clone(spec.split(":", 1)[1])                 # raises LOUD on missing weights

        def a(obs):
            sel = obs.get("select")
            if not sel:
                return []
            try:
                out = cl(obs)
            except Exception:
                out = None
            return out if out else greedy_baseline(sel)
        return a
    if spec.startswith("bundle:"):
        # external teammate agent: a dir exposing agent(obs)->list[int] (the Kaggle contract).
        d = resolve(spec.split(":", 1)[1])
        modpath = next((os.path.join(d, f) for f in ("main.py", "agent.py") if os.path.exists(os.path.join(d, f))), None)
        if not modpath:
            raise FileNotFoundError(f"bundle {d}: no main.py or agent.py exposing agent(obs)")
        sys.path.insert(0, d)
        sp = importlib.util.spec_from_file_location(f"bundle_{abs(hash(d))}", modpath)
        mod = importlib.util.module_from_spec(sp)
        sp.loader.exec_module(mod)
        fn = getattr(mod, "agent", None)
        if not callable(fn):
            raise AttributeError(f"bundle {d}: {os.path.basename(modpath)} has no callable agent(obs)")

        def a(obs):
            sel = obs.get("select")
            if not sel:
                return []
            try:
                out = fn(obs)
            except Exception:
                out = None
            return out if out else greedy_baseline(sel)
        return a
    choose = _BUILTIN.get(spec)
    if choose is None:
        raise ValueError(f"unknown pilot spec '{spec}' (want v4|v5|v6|greedy|clone:<arch>|bundle:<dir>)")

    def a(obs):
        sel = obs.get("select")
        if not sel:
            return []
        try:
            out = choose(obs, deck)
        except Exception:
            out = None
        return out if out else greedy_baseline(sel)
    return a


def play(deck0, deck1, a0, a1, trace=None):
    """One match. Returns the winning seat (0/1) or None on a non-terminating / errored game.
    If `trace` is a list, append a one-line descriptor per decision (the simstim ride-along)."""
    obs, _ = game.battle_start(deck0, deck1)
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
            if trace is not None and len(trace) < 200:
                nopt = len(sel.get("option") or [])
                trace.append(f"  seat{you}  opts={nopt:<3} min={sel.get('minCount',0)} max={sel.get('maxCount',1)}  -> pick {pick}")
            obs = game.battle_select(pick)
        return None
    finally:
        game.battle_finish()


def run_match(e0, e1, n):
    """e0 vs e1, seat-swapped over n*2 games. Returns (w0, w1, drawn) — drawn = non-terminating."""
    w0 = w1 = drawn = 0
    for i in range(n * 2):
        # alternate who sits in seat 0 so neither benefits from any first-move asymmetry
        if i % 2 == 0:
            r = play(e0["deck"], e1["deck"], e0["agent"], e1["agent"]); win0_seat = 0
        else:
            r = play(e1["deck"], e0["deck"], e1["agent"], e0["agent"]); win0_seat = 1
        if r is None:
            drawn += 1
            continue
        if r == win0_seat:
            w0 += 1
        else:
            w1 += 1
    return w0, w1, drawn


def bradley_terry_elo(names, wins, games, iters=400):
    """MM-fit Bradley-Terry strengths from the pairwise win matrix, then map to an Elo scale
    (mean anchored at 1000). Laplace +1 phantom game/pair (0.5 each way) keeps 0%/100% finite."""
    gamma = {x: 1.0 for x in names}
    for _ in range(iters):
        new = {}
        for i in names:
            Wi = sum(wins[i][j] + 0.5 for j in names if j != i and games[i][j] > 0)
            denom = sum((games[i][j] + 1.0) / (gamma[i] + gamma[j]) for j in names if j != i and games[i][j] > 0)
            new[i] = Wi / denom if denom > 0 else gamma[i]
        logmean = sum(math.log(v) for v in new.values()) / len(names)
        g = math.exp(logmean)
        gamma = {k: v / g for k, v in new.items()}
    elo = {k: 400 * math.log10(gamma[k]) + 1000 for k in names}
    return elo


def wilson_ci(w, n, z=1.96):
    """Wilson score 95% CI for a win proportion w/n. Honest small-N bounds (unlike normal-approx)."""
    if n == 0:
        return (0.0, 1.0)
    p = w / n
    d = 1 + z * z / n
    center = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((center - half) / d, (center + half) / d)


def _entrant_kind(pilot, owner, known, operator):
    """Classify an entrant by KIND (GAMES-014 honesty rule). Keyed on the `pilot` prefix + an
    operator-owner EXCLUSION — NOT on the owner string being in an allowlist alone. Relabelling our
    own entrants 'lab'->'soju' therefore CANNOT flip the meter: only a bundle from a DIVERSE EXTERNAL
    teammate (allowlisted AND not one of our operator handles/placeholders) counts as 'real'.

    Must stay byte-identical to service/app.py:_entrant_kind (the two twins kept in sync)."""
    if pilot.startswith("clone"):
        return "sparring"
    if pilot.startswith("bundle") and owner in known and owner not in operator:
        return "real"
    return "internal"


def field_trust(roster):
    """The strategic conscience, baked in. Counts entrant provenance by KIND and emits a verdict on
    whether THIS field is trustworthy as a ladder-proxy — per GAMES-014, synthetic ≠ trustworthy.
    A field of our OWN variants/clones/bundles (even relabelled to a real-looking owner) reads
    SYNTHETIC: only DIVERSE EXTERNAL teammate agents count as real."""
    known = {o.strip().lower() for o in os.environ.get("KNOWN_OWNERS", "soju,gumi").split(",") if o.strip()}
    operator = {o.strip().lower() for o in os.environ.get("OPERATOR_OWNERS", "soju,lab,internal").split(",") if o.strip()}
    kinds = {"real": [], "internal": [], "sparring": []}
    real_owners = set()
    for e in roster:
        pilot = str(e.get("pilot") or "").lower()
        owner = str(e.get("owner") or "").lower()
        k = _entrant_kind(pilot, owner, known, operator)
        kinds[k].append(e["name"])
        if k == "real":
            real_owners.add(owner)
    real, internal, sparring = len(kinds["real"]), len(kinds["internal"]), len(kinds["sparring"])
    distinct_real_owners = len(real_owners)
    if real >= 3 and distinct_real_owners >= 3:
        verdict, trust = "TRUSTWORTHY — ≥3 diverse external teammate agents in the field", "high"
    elif real >= 1:
        verdict, trust = f"BOOTSTRAP — {real} diverse external teammate agent(s); add more diverse real entrants to trust the ranking", "low"
    else:
        verdict, trust = "SYNTHETIC — field is our own variants + clones only; GAMES-014 says this CANNOT reproduce the ladder. Do NOT trust this ranking. Recruit diverse external teammate agents.", "none"
    return {"real": real, "internal": internal, "sparring": sparring, "distinct_real_owners": distinct_real_owners, "trust": trust, "verdict": verdict}


def build_roster(roster_path):
    spec = json.load(open(resolve(roster_path)))
    entrants = spec["entrants"] if isinstance(spec, dict) else spec
    out = []
    for e in entrants:
        deck = load_deck(e["deck"])
        out.append({"name": e["name"], "owner": e.get("owner", "internal"), "pilot": e["pilot"],
                    "deck": deck, "agent": make_pilot(e["pilot"], deck)})
    return out


def main():
    ap = argparse.ArgumentParser(description="The live coliseum — round-robin tournament in the cg engine.")
    ap.add_argument("--roster", default=".cabt-spike/coliseum/roster.json")
    ap.add_argument("--n", type=int, default=20, help="matches per matchup PER SEAT (total = 2n/matchup). Default 20: low N is NOISE (the engine is unseeded) — keep the CI band tight.")
    ap.add_argument("--seed", type=int, default=None, help="seed HARNESS randomness only (clone sampling/order). The cg engine auto-seeds natively and stays non-reproducible — rely on N + the CI band.")
    ap.add_argument("--replay", nargs=2, metavar=("A", "B"), help="ride-along: play ONE A-vs-B match with a per-decision trace")
    ap.add_argument("--out", default=None, help="results JSON path (default: .cabt-spike/coliseum/results-<ts>.json)")
    args = ap.parse_args()
    if args.seed is not None:
        random.seed(args.seed)  # harness-level only — the native engine is not reproducible

    roster = build_roster(args.roster)
    by_name = {e["name"]: e for e in roster}

    if args.replay:
        a, b = args.replay
        if a not in by_name or b not in by_name:
            sys.exit(f"replay: unknown entrant(s); roster = {list(by_name)}")
        ea, eb = by_name[a], by_name[b]
        print(f"⚔  RIDE-ALONG (simstim): {a} (seat0) vs {b} (seat1) — one match\n")
        tr = []
        r = play(ea["deck"], eb["deck"], ea["agent"], eb["agent"], trace=tr)
        print("\n".join(tr))
        if len(tr) >= 200:
            print("  … (trace capped at 200 decisions)")
        winner = a if r == 0 else (b if r == 1 else "DRAW/non-terminating")
        print(f"\n🏁 result: seat {r} → WINNER: {winner}  ({len(tr)} decisions)")
        return

    names = [e["name"] for e in roster]
    wins = {i: {j: 0 for j in names} for i in names}
    games = {i: {j: 0 for j in names} for i in names}
    drawn_total = 0
    t0 = time.time()
    ft = field_trust(roster)
    print(f"🏟  COLISEUM · {len(names)} entrants · N={args.n}/seat ({2*args.n}/matchup) · field={ft['trust'].upper()}")
    ent_str = ", ".join(f"{e['name']}[{e['pilot'].split(':')[0]}]" for e in roster)
    print(f"   entrants: {ent_str}\n")
    for ix in range(len(names)):
        for jx in range(ix + 1, len(names)):
            i, j = names[ix], names[jx]
            w0, w1, dr = run_match(by_name[i], by_name[j], args.n)
            wins[i][j] += w0; wins[j][i] += w1
            games[i][j] += w0 + w1; games[j][i] += w0 + w1
            drawn_total += dr
            print(f"   {i:>16s} {w0:>2d} – {w1:<2d} {j:<16s}  ({time.time()-t0:.0f}s)")

    elo = bradley_terry_elo(names, wins, games)
    tot_w = {i: sum(wins[i].values()) for i in names}
    tot_g = {i: sum(games[i].values()) for i in names}
    order = sorted(names, key=lambda n: -elo[n])

    win_ci = {n: wilson_ci(tot_w[n], tot_g[n]) for n in names}
    print("\n=== 🏆 LEADERBOARD (Bradley-Terry Elo, mean=1000) ===")
    print(f"   {'rank':<5}{'entrant':<18}{'owner':<10}{'pilot':<18}{'Elo':>6}{'  W-L':>9}{'  win%':>7}{'  win% 95%CI':>14}")
    for r, n in enumerate(order, 1):
        e = by_name[n]
        wl = f"{tot_w[n]}-{tot_g[n]-tot_w[n]}"
        wp = tot_w[n] / tot_g[n] if tot_g[n] else 0.0
        ci = f"[{win_ci[n][0]:.2f},{win_ci[n][1]:.2f}]"
        tag = " ⚠spar" if e["pilot"].startswith("clone:") else ""
        print(f"   {r:<5}{n:<18}{e['owner']:<10}{e['pilot']:<18}{elo[n]:>6.0f}{wl:>9}{wp:>7.2f}{ci:>14}{tag}")

    print("\n=== WIN MATRIX (row beats col, win%) ===")
    print("        " + "".join(f"{n[:6]:>7}" for n in order))
    for i in order:
        row = "".join((f"{wins[i][j]/games[i][j]:>7.2f}" if games[i][j] else f"{'·':>7}") for j in order)
        print(f"   {i[:6]:>6} {row}")

    print("\n=== 🎯 RELIABILITY (adjacent-rank checks — trust a gap only when ✓ robust) ===")
    reliability = []
    any_noise = False
    for r in range(len(order) - 1):
        hi_n, lo_n = order[r], order[r + 1]          # hi_n ranked directly above lo_n
        g, w = games[hi_n][lo_n], wins[hi_n][lo_n]   # hi_n's head-to-head record vs lo_n
        if g == 0:
            print(f"   #{r+1} {hi_n[:14]:<14} / #{r+2} {lo_n[:14]:<14}  — no head-to-head games")
            reliability.append({"hi": hi_n, "lo": lo_n, "verdict": "no_h2h"})
            continue
        lo, hi = wilson_ci(w, g)
        wp = w / g
        if lo > 0.5:
            print(f"   #{r+1} {hi_n[:14]:<14} ≻ #{r+2} {lo_n[:14]:<14}  ✓ robust       (h2h {wp:.2f} [{lo:.2f},{hi:.2f}] clears 0.50)")
            reliability.append({"hi": hi_n, "lo": lo_n, "verdict": "robust", "h2h": round(wp, 3), "ci": [round(lo, 3), round(hi, 3)]})
        else:
            any_noise = True
            print(f"   #{r+1} {hi_n[:14]:<14} ? #{r+2} {lo_n[:14]:<14}  ⚠ WITHIN-NOISE (h2h {wp:.2f} [{lo:.2f},{hi:.2f}] straddles 0.50 — order unresolved at N={args.n})")
            reliability.append({"hi": hi_n, "lo": lo_n, "verdict": "within_noise", "h2h": round(wp, 3), "ci": [round(lo, 3), round(hi, 3)]})
    if any_noise:
        print(f"   → ≥1 adjacent rank is within-noise. Raise --n or settle on the LADDER before trusting that gap (this is the v6-1277 fluke guard).")

    print(f"\n=== 🔎 FIELD-TRUST METER ===\n   real={ft['real']}  internal={ft['internal']}  sparring={ft['sparring']}  distinct_real_owners={ft['distinct_real_owners']}")
    print(f"   >>> {ft['verdict']}")
    total_matches = sum(games[i][j] for i in names for j in names) // 2
    print(f"\n   {total_matches} decisive matches ({drawn_total} non-terminating) in {time.time()-t0:.0f}s")

    out_path = resolve(args.out) if args.out else os.path.join(ROOT, ".cabt-spike/coliseum", f"results-{int(t0)}.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump({
        "n_per_seat": args.n, "seed": args.seed, "entrants": [{k: e[k] for k in ("name", "owner", "pilot")} for e in roster],
        "elo": {n: round(elo[n], 1) for n in names}, "order": order,
        "win_ci": {n: [round(win_ci[n][0], 3), round(win_ci[n][1], 3)] for n in names},
        "reliability": reliability,
        "wins": wins, "games": games, "drawn": drawn_total,
        "field_trust": ft, "total_matches": total_matches, "elapsed_s": round(time.time() - t0, 1),
    }, open(out_path, "w"), indent=2)
    print(f"   results → {out_path}")


if __name__ == "__main__":
    main()
