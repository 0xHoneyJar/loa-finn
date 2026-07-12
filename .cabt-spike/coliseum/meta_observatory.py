#!/usr/bin/env python3
"""meta_observatory.py — the cabt META WEATHER STATION + adaptation instrument (2026-06-22).

The competition meta is HIDDEN — opponents' decks aren't visible (the realness-ladder wall). But two signals
ARE observable cheaply, and this instrument turns them into metacognition about meta-shifts + our adaptation:

  1. DRIFT (free, no slot) — every agent we've EVER submitted is a PERMANENT meta-probe. Kaggle re-scores it
     continuously as the ladder field evolves, so a FROZEN agent's score DRIFT *is* the meta shifting under us
     (e.g. v4-Dwebble 807→754.9 in 2 days = the meta hardened ~52pts). We log a snapshot each run → a time
     series → per-probe drift + meta-shift flags beyond the noise band. We never spend a slot to SENSE.

  2. LOCAL MODEL (cheap, dense) — our coliseum match-corpus, farmed into a global matchup matrix (pilot×pilot,
     deck×deck) with Wilson-CI reliability, is the fast pre-screen for adaptations before a scarce ladder slot.

Output: meta-state (drift + shifts) + the farmed local model + an explore/exploit slot proposal. It SENSES +
PROPOSES; it NEVER submits (slots stay operator-gated via the SAATY rubric). Re-runnable as a daily loop.

Usage:  python3 meta_observatory.py [--subs-csv PATH] [--no-poll] [--log PATH]
  --no-poll : skip the live `kaggle` call; read --subs-csv only (offline / test).
"""
from __future__ import annotations

import argparse, csv, glob, json, math, os, re, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("COLISEUM_ROOT", os.path.abspath(os.path.join(HERE, "..", "..")))
DRIFT_LEDGER = os.path.join(ROOT, "grimoires/loa/lab/cabt-meta-drift.jsonl")
COMPETITION = "pokemon-tcg-ai-battle"
NOISE_BAND = 30.0  # ladder pts: a probe move beyond this (between snapshots) is flagged a meta-shift, not noise

# Archetype / pilot tags extracted from an entrant name or submission filename (best-effort keyword match).
_DECKS = ["dwebble", "crustle", "abomasnow", "sylveon", "lucario", "dragapult", "monofighting", "rebuilt"]
_PILOTS = ["v4", "v5", "v6", "v7", "v8", "greedy", "pimc", "clone"]


def _tag(name: str, keys: list[str]) -> str:
    n = (name or "").lower()
    for k in keys:
        if k in n:
            return k
    return "?"


def wilson_lo(w: int, n: int, z: float = 1.96) -> float:
    if n == 0:
        return 0.0
    p = w / n
    d = 1 + z * z / n
    return ((p + z * z / (2 * n)) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d


# ---------------------------------------------------------------- DRIFT lens

def load_submissions(subs_csv: str | None, poll: bool) -> list[dict]:
    if poll and not subs_csv:
        try:
            out = subprocess.run(["kaggle", "competitions", "submissions", "-c", COMPETITION, "--csv"],
                                 capture_output=True, text=True, timeout=60).stdout
            rows = list(csv.DictReader(out.splitlines()))
            if rows:
                return rows
        except Exception as e:
            print(f"  (live poll failed: {e}; falling back to --subs-csv)")
    if subs_csv and os.path.exists(subs_csv):
        return list(csv.DictReader(open(subs_csv)))
    return []


def append_snapshot(subs: list[dict], ts: float) -> None:
    probes = []
    for r in subs:
        sc = (r.get("publicScore") or "").strip()
        if not sc:
            continue
        fn, desc = r.get("fileName", ""), r.get("description", "")
        pilot = _tag(fn, _PILOTS) if _tag(fn, _PILOTS) != "?" else _tag(desc, _PILOTS)  # filename first (clean)
        deck = _tag(fn, _DECKS) if _tag(fn, _DECKS) != "?" else _tag(desc, _DECKS)
        try:
            probes.append({"ref": r.get("ref", ""), "file": fn[:40], "deck": deck, "pilot": pilot,
                           "score": float(sc)})
        except ValueError:
            pass
    os.makedirs(os.path.dirname(DRIFT_LEDGER), exist_ok=True)
    with open(DRIFT_LEDGER, "a") as f:
        f.write(json.dumps({"ts": int(ts), "n_probes": len(probes), "probes": probes}) + "\n")


def read_drift() -> list[dict]:
    if not os.path.exists(DRIFT_LEDGER):
        return []
    return [json.loads(line) for line in open(DRIFT_LEDGER) if line.strip()]


def drift_report(snapshots: list[dict]) -> None:
    print("\n=== 🌡  META DRIFT (frozen probes; score move = the meta shifting under us) ===")
    if len(snapshots) < 2:
        s = snapshots[-1] if snapshots else {"probes": [], "ts": 0}
        print(f"   {len(snapshots)} snapshot(s) logged — drift needs ≥2. Today's planted probes ({s.get('n_probes',0)}):")
        for p in sorted(s.get("probes", []), key=lambda x: -x["score"])[:12]:
            print(f"     {p['score']:>7.1f}  {p['pilot']:>6}/{p['deck']:<10} {p['ref']}")
        print("   → re-run daily (it's free) to accumulate the time series; drift + shift-flags appear at snapshot 2.")
        return
    first, last = snapshots[0], snapshots[-1]
    days = max(1e-9, (last["ts"] - first["ts"]) / 86400.0)
    f_by = {p["ref"]: p for p in first.get("probes", [])}
    print(f"   span: {days:.1f} days, {len(snapshots)} snapshots")
    shifts = 0
    for p in sorted(last.get("probes", []), key=lambda x: -x["score"]):
        fp = f_by.get(p["ref"])
        if not fp:
            continue
        d = p["score"] - fp["score"]
        flag = ""
        if abs(d) >= NOISE_BAND:
            flag = "  ⚠ META-SHIFT" + (" (eroding — being countered)" if d < 0 else " (rising)")
            shifts += 1
        print(f"     {p['score']:>7.1f}  Δ{d:>+7.1f}  {p['pilot']:>6}/{p['deck']:<10} {p['ref']}{flag}")
    print(f"   → {shifts} probe(s) moved beyond ±{NOISE_BAND:.0f}pt noise. Eroding archetypes are being countered — adapt off them.")


# ---------------------------------------------------------------- COLISEUM-FARM lens

def farm_coliseum() -> None:
    files = sorted(set(glob.glob(os.path.join(HERE, "*results*.json")) + glob.glob(os.path.join(HERE, "*-results.json"))))
    pair_w: dict = {}   # (winner_pilot, loser_pilot) -> [wins, games]
    games_seen = 0
    for fp in files:
        try:
            r = json.load(open(fp))
        except Exception:
            continue
        ents = {e["name"]: e for e in r.get("entrants", [])}
        wins, games = r.get("wins", {}), r.get("games", {})
        for i in wins:
            for j, w in wins[i].items():
                g = games.get(i, {}).get(j, 0)
                if g <= 0:
                    continue
                pi = _tag(ents.get(i, {}).get("pilot", "") + " " + i, _PILOTS)
                pj = _tag(ents.get(j, {}).get("pilot", "") + " " + j, _PILOTS)
                if pi == "?" or pj == "?" or pi == pj:
                    continue
                key = (pi, pj)
                acc = pair_w.setdefault(key, [0, 0])
                acc[0] += w; acc[1] += g
                games_seen += w
    print(f"\n=== ⚔  COLISEUM-FARMED MATCHUP MODEL ({len(files)} runs, {games_seen} games, by pilot) ===")
    rows = []
    for (a, b), (w, g) in pair_w.items():
        lo = wilson_lo(w, g)
        rows.append((a, b, w, g, w / g, lo))
    for a, b, w, g, wp, lo in sorted(rows, key=lambda x: -x[4]):
        robust = "✓ robust" if lo > 0.5 else "  within-noise"
        print(f"     {a:>6} beats {b:<6}  {wp:>5.2f}  ({w}/{g}, CI≥{lo:.2f})  {robust}")
    print("   → robust edges transfer; 'within-noise' ones are ladder-only-resolvable (the §5b band-pass).")


# ---------------------------------------------------------------- PROPOSE lens

def propose(snapshots: list[dict]) -> None:
    print("\n=== 🎯 ADAPTATION PROPOSAL (5-slot explore/exploit; SENSE-free, slots operator-gated) ===")
    last = snapshots[-1] if snapshots else {"probes": []}
    ranked = sorted(last.get("probes", []), key=lambda x: -x["score"])
    best = ranked[0] if ranked else None
    if best:
        print(f"   current best planted: {best['score']:.1f} ({best['pilot']}/{best['deck']}, {best['ref']})")
    print("   the 5 daily slots as a BANDIT over a meta we sense for FREE:")
    print("     • EXPLOIT (2 slots): our best current candidate + 1 variant — climb.")
    print("     • EXPLORE (2 slots): NEW deck archetypes off the eroding ones — find un-countered space.")
    print("     • PROBE (1 slot): a fresh reference deck to widen the free drift-sensor panel.")
    print("   the existing submissions keep re-scoring for free → tomorrow's drift tells us if we adapted right.")
    print("   NEXT BUILD: generate deck variants → CI-gated coliseum pre-screen → SAATY rubric → this proposal fills in.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--subs-csv", default=None, help="submission CSV (else live `kaggle` poll)")
    ap.add_argument("--no-poll", action="store_true", help="don't call kaggle; read --subs-csv only")
    args = ap.parse_args()
    ts = time.time()

    subs = load_submissions(args.subs_csv, poll=not args.no_poll)
    if subs:
        append_snapshot(subs, ts)
        print(f"📡 logged drift snapshot: {len([r for r in subs if (r.get('publicScore') or '').strip()])} scored probes → {os.path.relpath(DRIFT_LEDGER, ROOT)}")
    else:
        print("📡 no submissions loaded (offline + no --subs-csv) — drift lens uses existing ledger only")

    snaps = read_drift()
    drift_report(snaps)
    farm_coliseum()
    propose(snaps)


if __name__ == "__main__":
    main()
