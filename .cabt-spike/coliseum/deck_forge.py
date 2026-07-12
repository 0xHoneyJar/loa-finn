#!/usr/bin/env python3
"""deck_forge.py — apply principled swap-specs to a base deck → legal 60-card variant deck.csv files.

The ACTING half of the adaptation loop: gygax (deck-building domain) designs swaps as OUT/IN card-count deltas;
this forge applies them mechanically + ENFORCES legality so a bad spec can't ship an illegal deck (60 cards,
≤4 of any non-basic-energy card, Dwebble→Crustle engine intact). Variants then go to the CI-gated coliseum
pre-screen + the SAATY rubric. Random swaps degrade the converged deck (the 205-pt failures) — so the swaps
come from gygax, the forge just validates + materializes them.

CAVEAT (2026-06-22): EN_Card_Data.csv is a SUPERSET of the engine's constructible set — a card can exist in the
data yet be deck-illegal (Maximum Belt 1158 / Switch 1123 / Poke Vital A 1096 were rejected at battle_start,
errorType=4). So this forge's legality check (60 / ≤4 / engine-core) is NECESSARY-BUT-NOT-SUFFICIENT; the
ENGINE is the final authority, enforced at the coliseum pre-screen (a rejected deck plays 0 games → flagged).

Spec JSON: {"base": "<deck.csv>", "variants": [{"name": "...", "out": [{"id":N,"count":k}], "in": [...], ...}]}
Usage: python3 deck_forge.py --spec variants.json --out-dir .cabt-spike/variants [--base <deck.csv>]
"""
from __future__ import annotations

import argparse, collections, csv, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("COLISEUM_ROOT", os.path.abspath(os.path.join(HERE, "..", "..")))
CARD_CSV = os.path.join(ROOT, ".cabt-spike/dl/EN_Card_Data.csv")
ENGINE_CORE = {344, 345}  # Dwebble→Crustle: the variant must keep the attacker line


def load_cards() -> tuple[dict, set]:
    """(id->name, set of basic-energy ids that are exempt from the ≤4 rule)."""
    idname, basic = {}, set()
    try:
        with open(CARD_CSV) as f:
            r = csv.DictReader(f)
            for row in r:
                try:
                    cid = int(row["Card ID"]); nm = row["Card Name"]
                except (ValueError, KeyError):
                    continue
                idname[cid] = nm
                if nm.strip().lower().startswith("basic ") and "energy" in nm.lower():
                    basic.add(cid)
    except Exception:
        pass
    return idname, basic


def load_deck(path: str) -> list[int]:
    return [int(x) for x in open(path).read().split() if x.strip()][:60]


def apply_variant(base: list[int], variant: dict, idname: dict, basic: set) -> tuple[list[int] | None, list[str]]:
    """Return (60-card deck or None if illegal, list of issue strings)."""
    cnt = collections.Counter(base)
    issues = []
    for o in variant.get("out", []):
        cid, k = int(o["id"]), int(o.get("count", 1))
        if cnt[cid] < k:
            issues.append(f"OUT {k}x [{cid}] {idname.get(cid,'?')} but deck has only {cnt[cid]}")
            k = cnt[cid]
        cnt[cid] -= k
        if cnt[cid] <= 0:
            del cnt[cid]
    for i in variant.get("in", []):
        cid, k = int(i["id"]), int(i.get("count", 1))
        cnt[cid] += k
    # legality
    total = sum(cnt.values())
    if total != 60:
        issues.append(f"ILLEGAL: {total} cards (must be 60) — OUT/IN don't net to zero")
    for cid, k in cnt.items():
        if k > 4 and cid not in basic:
            issues.append(f"ILLEGAL: {k}x [{cid}] {idname.get(cid,'?')} exceeds the 4-copy limit")
    for core in ENGINE_CORE:
        if cnt.get(core, 0) < 1:
            issues.append(f"ENGINE BROKEN: lost the [{core}] {idname.get(core,'?')} line")
    if any("ILLEGAL" in s or "ENGINE BROKEN" in s for s in issues):
        return None, issues
    deck = []
    for cid, k in cnt.items():
        deck.extend([cid] * k)
    return deck, issues


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--spec", required=True, help="variants spec JSON")
    ap.add_argument("--out-dir", default=os.path.join(ROOT, ".cabt-spike/variants"))
    ap.add_argument("--base", default=None, help="override the spec's base deck.csv")
    args = ap.parse_args()

    spec = json.load(open(args.spec))
    base_path = args.base or spec.get("base") or os.path.join(ROOT, ".cabt-spike/sub_dwebble_v4/deck.csv")
    base = load_deck(base_path)
    idname, basic = load_cards()
    print(f"🔨 deck_forge — base: {os.path.relpath(base_path, ROOT)} ({len(base)} cards), {len(spec.get('variants',[]))} variants")
    os.makedirs(args.out_dir, exist_ok=True)
    forged = []
    for v in spec.get("variants", []):
        name = v["name"]
        deck, issues = apply_variant(base, v, idname, basic)
        swap = " | ".join(f"-{o['count']}x[{o['id']}]" for o in v.get("out", [])) + "  " + \
               " ".join(f"+{i['count']}x[{i['id']}]" for i in v.get("in", []))
        if deck is None:
            print(f"  ✗ {name:<18} REJECTED: {'; '.join(issues)}")
            continue
        vdir = os.path.join(args.out_dir, name)
        os.makedirs(vdir, exist_ok=True)
        with open(os.path.join(vdir, "deck.csv"), "w") as f:
            f.write("\n".join(str(c) for c in deck) + "\n")
        warn = ("  ⚠ " + "; ".join(issues)) if issues else ""
        print(f"  ✓ {name:<18} {swap}{warn}")
        forged.append({"name": name, "deck": os.path.join(os.path.relpath(vdir, ROOT), "deck.csv"), "rationale": v.get("rationale", "")})
    out_index = os.path.join(args.out_dir, "forged.json")
    json.dump({"base": base_path, "forged": forged}, open(out_index, "w"), indent=2)
    print(f"  → {len(forged)} legal variant(s) forged; index → {os.path.relpath(out_index, ROOT)}")


if __name__ == "__main__":
    main()
