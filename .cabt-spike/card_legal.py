"""card_legal.py — probe the ENGINE's constructible card set AND each card's MAX COPY CAP.

EN_Card_Data.csv ⊋ the engine's legal set, AND a card legal at 1 copy can be illegal at 4 (ACE-SPEC / 1-per-deck
limits — e.g. Hero's Cape [1159] is legal at 1 but rejected at 4). So "is it legal" is not enough; we need the CAP.

Method: take the known-legal base deck (Dwebble PB), set the candidate to exactly K copies (balancing with Basic
{G} Energy to keep 60), and call battle_start for K = 4,3,2,1 descending — the first K accepted is the cap. obs
!= None ⟹ constructible at K. Output: legal-cards.json {caps:{id:maxcopies}, illegal:[ids cap 0], names:{}}.

Caveat: evolution cards (need their pre-evolution) may false-fail as a lone swap — sound for the trainer/energy
swap pool. Usage (Docker/Linux):
  python3 .cabt-spike/card_legal.py --ids 1159,1158,1123,1096,1182,1199   # caps for specific cards
  python3 .cabt-spike/card_legal.py --csv-trainers                         # cap-sweep the Trainer/Energy pool
"""
import argparse, csv, json, os, sys
from collections import Counter

sys.path.insert(0, ".cabt-spike/dl")
os.environ.setdefault("CABT_AUGURY", "prize_only")
from cg import game

CARD_CSV = ".cabt-spike/dl/EN_Card_Data.csv"
BASE = ".cabt-spike/sub_dwebble_v4/deck.csv"
BASIC_G = 1  # Basic {G} Energy — unlimited; the balancing filler (base has 19)


def load(p):
    return [int(x) for x in open(p).read().split() if x.strip()][:60]


def card_rows():
    rows = {}
    with open(CARD_CSV) as f:
        for r in csv.DictReader(f):
            try:
                rows[int(r["Card ID"])] = r
            except (ValueError, KeyError):
                pass
    return rows


def make_test_deck(base_cnt, cid, k):
    """base with `cid` set to exactly k copies, Basic {G} adjusted to keep 60. None if it can't balance."""
    cnt = Counter(base_cnt)
    e = cnt.get(cid, 0)
    if k <= 0:
        cnt.pop(cid, None)
    else:
        cnt[cid] = k
    delta = sum(cnt.values()) - 60          # +ve ⟹ too many ⟹ remove that many Basic {G}
    cnt[BASIC_G] = cnt.get(BASIC_G, 0) - delta
    if cnt[BASIC_G] < 0:
        return None
    if cnt[BASIC_G] == 0:
        cnt.pop(BASIC_G, None)
    deck = []
    for c, n in cnt.items():
        deck.extend([c] * n)
    return deck if len(deck) == 60 else None


def starts(deck, base):
    try:
        obs, _ = game.battle_start(deck, base)
        ok = obs is not None
        game.battle_finish()
        return ok
    except Exception:
        try:
            game.battle_finish()
        except Exception:
            pass
        return False


def max_copies(cid, base, base_cnt):
    if cid == BASIC_G:
        return 4  # basic energy effectively unlimited
    for k in (4, 3, 2, 1):
        d = make_test_deck(base_cnt, cid, k)
        if d is not None and starts(d, base):
            return k  # descending → first hit is the cap
    return 0          # illegal even at 1 copy


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids")
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--csv-trainers", action="store_true")
    args = ap.parse_args()

    base = load(BASE)
    base_cnt = Counter(base)
    rows = card_rows()

    if args.ids:
        ids = [int(x) for x in args.ids.split(",")]
    elif args.csv_trainers:
        ids = [cid for cid, r in rows.items()
               if any(k in (r.get("Category", "") + r.get("Stage (Pokémon)/Type (Energy and Trainer)", "")).lower()
                      for k in ("trainer", "energy", "supporter", "item", "tool", "stadium"))]
    elif args.sweep:
        ids = list(rows.keys())
    else:
        ap.error("pass --ids, --sweep, or --csv-trainers")

    caps, illegal, capped = {}, [], []
    for cid in ids:
        cap = max_copies(cid, base, base_cnt)
        nm = rows.get(cid, {}).get("Card Name", "?")
        if cap == 0:
            illegal.append(cid)
        else:
            caps[cid] = cap
            if cap < 4:
                capped.append((cid, cap, nm))
        if args.ids:
            print(f"  [{cid}] {nm:<28} max copies = {cap}" + ("  ⛔ ILLEGAL" if cap == 0 else (f"  ⚠ CAPPED at {cap}" if cap < 4 else "")))

    print(f"\n{len(caps)} legal ({len(capped)} CAPPED below 4), {len(illegal)} illegal, of {len(ids)} tested")
    if capped:
        print("  capped-below-4 (ACE-SPEC / restricted — gygax must respect these):")
        for cid, cap, nm in sorted(capped):
            print(f"    [{cid}] {nm} → max {cap}")
    if args.sweep or args.csv_trainers:
        out = ".cabt-spike/coliseum/legal-cards.json"
        json.dump({"caps": {str(c): caps[c] for c in sorted(caps)},
                   "illegal": sorted(illegal),
                   "capped_below_4": {str(c): caps[c] for c, cap, _ in sorted(capped)},
                   "names": {str(c): rows.get(c, {}).get("Card Name", "?") for c in sorted(list(caps) + illegal)}},
                  open(out, "w"), indent=1)
        print(f"  → {out}")


if __name__ == "__main__":
    main()
