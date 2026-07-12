#!/usr/bin/env python3
"""adapt_loop.py — the cabt META-ADAPTATION LOOP orchestrator (2026-06-22).

Ties the instrument together:
  SENSE  (daily, free, no engine) — run meta_observatory: poll drift, farm the coliseum corpus, flag meta-shifts.
  ADAPT  (episodic, engine-needed) — forge gygax's deck variants (deck_forge), CI-gated coliseum pre-screen, then
         the SAATY-framed 5-slot proposal. Triggered when SENSE flags a shift, or on demand.

Design: the DAILY cron runs `--sense` (light — drift time-series compounds, meta weather report, shift alert).
The ADAPT pass (`--adapt SPEC.json`) is heavier (gygax variants must be designed by the gygax CONSTRUCT first —
not scriptable — then forged + pre-screened here). It NEVER submits; the 5 ladder slots stay operator-gated.

Usage:
  python3 adapt_loop.py --sense                         # daily cron: sense + farm + shift-alert
  python3 adapt_loop.py --adapt variants.json [--n 30]  # adaptation pass: forge → pre-screen → propose
"""
from __future__ import annotations

import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("COLISEUM_ROOT", os.path.abspath(os.path.join(HERE, "..", "..")))
PY = sys.executable
NOISE_BAND = 30.0


def sense() -> dict:
    """Run the meta_observatory (drift + farm + propose). Returns a small summary + shift count."""
    print("════ SENSE ════")
    r = subprocess.run([PY, os.path.join(HERE, "meta_observatory.py")], cwd=ROOT, capture_output=True, text=True)
    print(r.stdout)
    if r.returncode != 0:
        print(r.stderr[:500])
    shifts = r.stdout.count("⚠ META-SHIFT")
    return {"shifts": shifts}


def engine_available() -> bool:
    """The cg engine is native on Linux x86-64; on the Mac it needs Docker (pre-screen prints the cmd instead)."""
    sys.path.insert(0, os.path.join(ROOT, ".cabt-spike/dl"))
    try:
        from cg import game  # noqa: F401 — actually loads libcg.so (fails on non-Linux, unlike a bare `import cg`)
        return True
    except Exception:
        return False


def build_roster(forged: list[dict]) -> str:
    """v7 (our best pilot) on each forged variant + the baselines (v4-dwebble PB, gumi-v8, greedy)."""
    entrants = [{"name": f["name"], "owner": "soju", "pilot": "v7", "deck": f["deck"]} for f in forged]
    entrants += [
        {"name": "v4-dwebble-PB", "owner": "lab", "pilot": "v4", "deck": ".cabt-spike/sub_dwebble_v4/deck.csv"},
        {"name": "gumi-v8", "owner": "gumi", "pilot": "bundle:.cabt-spike/build_v8dw", "deck": ".cabt-spike/build_v8dw/deck.csv"},
        {"name": "greedy", "owner": "lab", "pilot": "greedy", "deck": ".cabt-spike/sub_v6_validate/deck.csv"},
    ]
    path = os.path.join(HERE, "adapt-roster.json")
    json.dump({"_comment": "auto-built by adapt_loop from forged variants", "entrants": entrants}, open(path, "w"), indent=2)
    return path


def adapt(spec_path: str, n: int) -> None:
    print("════ ADAPT ════")
    # 1. FORGE
    fr = subprocess.run([PY, os.path.join(HERE, "deck_forge.py"), "--spec", spec_path], cwd=ROOT, capture_output=True, text=True)
    print(fr.stdout)
    forged_index = os.path.join(ROOT, ".cabt-spike/variants/forged.json")
    if not os.path.exists(forged_index):
        print("  no variants forged — nothing to pre-screen."); return
    forged = json.load(open(forged_index)).get("forged", [])
    if not forged:
        print("  0 legal variants — gygax specs all rejected by the forge."); return
    # 2. PRE-SCREEN (CI-gated coliseum)
    roster = build_roster(forged)
    rel = os.path.relpath(roster, ROOT)
    cmd = [PY, ".cabt-spike/coliseum/coliseum.py", "--roster", rel, "--n", str(n), "--seed", "42",
           "--out", ".cabt-spike/coliseum/adapt-results.json"]
    if engine_available():
        print(f"  pre-screening {len(forged)} variant(s) vs the field, N={n} (CI-gated)…")
        subprocess.run(cmd, cwd=ROOT)
    else:
        docker = ("docker run --rm --platform linux/amd64 -e COLISEUM_ROOT=/app -v \"$PWD:/app\" -w /app "
                  f"python:3.12 bash -c '{' '.join(cmd)}'")
        print("  cg engine not native here (Mac) — run the pre-screen in Docker:\n   " + docker)
    # 3. PROPOSE (reliability-aware)
    res_path = os.path.join(ROOT, ".cabt-spike/coliseum/adapt-results.json")
    print("\n════ PROPOSE (SAATY-framed; slots operator-gated) ════")
    if os.path.exists(res_path):
        res = json.load(open(res_path))
        order, elo, ci, games = res.get("order", []), res.get("elo", {}), res.get("win_ci", {}), res.get("games", {})
        forged_names = {f["name"] for f in forged}
        # ENGINE-LEGALITY: EN_Card_Data.csv ⊋ the engine's constructible set, so the forge's legality check is
        # necessary-but-not-sufficient — a deck with a non-constructible card is rejected at battle_start (0 games).
        # The pre-screen is the authoritative legality gate; flag any forged variant that played ~nothing.
        rejected = [nm for nm in forged_names if sum((games.get(nm, {}) or {}).values()) < 2]
        if rejected:
            print(f"  ⛔ ENGINE-REJECTED (non-constructible card → battle_start None; NOT submittable): {rejected}")
        print("  variant ranking (legal + played; vs v4-dwebble PB baseline):")
        for nm in order:
            if nm in rejected:
                continue
            tag = " ← OUR VARIANT" if nm in forged_names else ""
            c = ci.get(nm, [0, 1])
            print(f"    {elo.get(nm,0):>7.0f}  win%CI[{c[0]:.2f},{c[1]:.2f}]  {nm}{tag}")
        robust_beats_pb = [f["name"] for f in forged
                           if any(rr["hi"] == f["name"] and "v4-dwebble" in rr["lo"] and rr.get("verdict") == "robust"
                                  for rr in res.get("reliability", []))]
        print("\n  SAATY gate: submit a variant only if it ROBUSTLY clears the v4-dwebble PB (C1 floor) OR resolves")
        print("  a ladder-only question (C4). Within-noise variants = ladder-only-resolvable (don't burn a slot blind).")
        if robust_beats_pb:
            print(f"  → robustly-better variants worth a slot: {robust_beats_pb}")
        else:
            print("  → no variant ROBUSTLY beats the PB locally — any submission is a C4 info-gain bet (humble p).")
    else:
        print("  (run the pre-screen, then re-run --adapt to read results)")
    for f in forged:
        print(f"    • {f['name']}: {f.get('rationale','')[:100]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sense", action="store_true", help="daily light pass: drift + farm + shift-alert")
    ap.add_argument("--adapt", metavar="SPEC", help="adaptation pass: forge variants spec → pre-screen → propose")
    ap.add_argument("--n", type=int, default=30, help="coliseum matches/seat for the pre-screen")
    args = ap.parse_args()
    if args.adapt:
        adapt(args.adapt, args.n)
    else:
        s = sense()
        if s["shifts"]:
            print(f"\n🔔 {s['shifts']} META-SHIFT(S) FLAGGED → time for an ADAPT pass: design variants with gygax, "
                  f"then `python3 adapt_loop.py --adapt <spec.json>`.")
        else:
            print("\n✓ no meta-shift beyond noise — hold; the drift sensor keeps watching (free).")


if __name__ == "__main__":
    main()
