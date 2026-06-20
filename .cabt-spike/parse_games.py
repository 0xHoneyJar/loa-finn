# parse_games.py — extract analysis intel from our ladder replays.
# Per game: our seat, outcome, opponent, both decks -> archetype. Strips the huge visualize field.
import json, csv, os, glob, collections

REPLAY_DIR = ".cabt-spike/games/replays"

# --- card map: id -> (name, is_pokemon, type) ---
CARD = {}
with open(".cabt-spike/dl/EN_Card_Data.csv") as f:
    r = csv.reader(f)
    hdr = next(r)
    for row in r:
        try:
            cid = int(row[0])
        except (ValueError, IndexError):
            continue
        name, hp, typ = row[1], row[8], row[9]
        CARD[cid] = (name, hp not in ("n/a", "", None), typ)


def deck_archetype(deck_ids):
    """Top Pokémon (by count) = the archetype signature; + energy types present."""
    pk = collections.Counter()
    energies = collections.Counter()
    for cid in deck_ids:
        name, is_pk, typ = CARD.get(cid, (f"#{cid}", False, "?"))
        if is_pk:
            pk[name] += 1
        elif "Energy" in name:
            energies[typ] += 1
    top = ", ".join(f"{n}x{c}" for n, c in pk.most_common(4))
    en = ",".join(f"{t}x{c}" for t, c in energies.most_common(3))
    return top or "(no pokemon parsed)", en


def label_of(ep_id):
    return EP_LABEL.get(ep_id, "?")


# map episode id -> which agent (mono / v4)
EP_LABEL = {}
for lbl, csvf in (("mono", ".cabt-spike/games/mono_eps.csv"), ("v4", ".cabt-spike/games/v4_eps.csv")):
    if os.path.exists(csvf):
        for line in open(csvf):
            p = line.split(",")
            if p and p[0].isdigit():
                EP_LABEL[int(p[0])] = lbl

games = []
for fp in sorted(glob.glob(f"{REPLAY_DIR}/episode-*-replay.json")):
    ep = int(fp.split("episode-")[1].split("-replay")[0])
    try:
        d = json.load(open(fp))
    except Exception as e:
        print("skip", ep, e); continue
    teams = d["info"]["TeamNames"]
    rewards = d["rewards"]
    our_seat = teams.index("soju") if "soju" in teams else 1
    opp_seat = 1 - our_seat
    opp = teams[opp_seat]
    we_won = rewards[our_seat] == 1
    steps = d["steps"]
    our_deck = steps[1][our_seat].get("action") or []
    opp_deck = steps[1][opp_seat].get("action") or []
    our_arch, our_en = deck_archetype(our_deck) if len(our_deck) >= 30 else ("?", "?")
    opp_arch, opp_en = deck_archetype(opp_deck) if len(opp_deck) >= 30 else ("?", "?")
    games.append(dict(ep=ep, label=label_of(ep), we_won=we_won, opp=opp,
                      our_arch=our_arch, opp_arch=opp_arch, opp_en=opp_en, nsteps=len(steps)))

# --- report ---
for lbl in ("mono", "v4"):
    gs = [g for g in games if g["label"] == lbl]
    if not gs:
        continue
    w = sum(1 for g in gs if g["we_won"])
    print(f"\n===== {lbl.upper()}  record {w}-{len(gs)-w}  ({len(gs)} games) =====")
    if gs:
        print(f"  our deck: {gs[0]['our_arch']}  [{gs[0].get('our_en','')}]" if False else "")
    for g in sorted(gs, key=lambda x: x["we_won"]):
        res = "WON " if g["we_won"] else "LOST"
        print(f"  {res} vs {g['opp'][:22]:22s} | their deck: {g['opp_arch'][:60]} [{g['opp_en']}] ({g['nsteps']}st)")

# field meta: who beats us, what they run
print("\n===== FIELD (opponents faced) =====")
opp_rec = collections.defaultdict(lambda: [0, 0, ""])  # opp -> [wins_vs, games, archetype]
for g in games:
    opp_rec[g["opp"]][1] += 1
    if g["we_won"]:
        opp_rec[g["opp"]][0] += 1
    opp_rec[g["opp"]][2] = g["opp_arch"]
for opp, (w, n, arch) in sorted(opp_rec.items(), key=lambda x: x[1][0] / x[1][1]):
    print(f"  vs {opp[:24]:24s} we go {w}-{n-w} | they run: {arch[:55]}")

# our decks sanity
print("\n===== our decks (sanity) =====")
for lbl in ("mono", "v4"):
    gs = [g for g in games if g["label"] == lbl]
    if gs:
        print(f"  {lbl}: {gs[0]['our_arch']}")
