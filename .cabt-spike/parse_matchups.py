# parse_matchups.py — the field instrument: per-archetype win-rate table from real ladder games.
import json, csv, os, glob, collections, math

CARD = {}
with open(".cabt-spike/dl/EN_Card_Data.csv") as f:
    r = csv.reader(f); next(r)
    for row in r:
        try: cid = int(row[0])
        except (ValueError, IndexError): continue
        CARD[cid] = (row[1], row[8] not in ("n/a", "", None))  # name, is_pokemon

def top_pokemon(deck):
    pk = collections.Counter()
    for cid in deck:
        n, isp = CARD.get(cid, (f"#{cid}", False))
        if isp: pk[n] += 1
    return ", ".join(f"{n}x{c}" for n, c in pk.most_common(4))

ARCH_RULES = [
    ("Lucario (Fighting)", ["mega lucario"]),
    ("Bellibolt (Lightning)", ["bellibolt"]),
    ("Abomasnow (Water) MIRROR", ["abomasnow"]),
    ("Dragapult", ["dragapult"]),
    ("Grimmsnarl (Dark)", ["grimmsnarl", "marnie"]),
    ("Sinistcha (Grass)", ["sinistcha", "poltchageist"]),
    ("Mismagius (Psychic)", ["mismagius", "misdreavus"]),
    ("Ogerpon/RagingBolt", ["ogerpon", "raging bolt"]),
    ("Team Rocket", ["team rocket"]),
    ("Crustle/Ethan", ["crustle", "dwebble"]),
    ("Kangaskhan", ["kangaskhan"]),
]
def classify(arch):
    a = arch.lower()
    for label, keys in ARCH_RULES:
        if any(k in a for k in keys): return label
    return "other: " + arch.split("x")[0].strip()[:18]

def wilson(w, n):
    if n == 0: return (0.0, 0.0)
    p = w/n; z = 1.96; d = 1+z*z/n
    c = (p+z*z/(2*n))/d; m = z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return (max(0.0, c-m), min(1.0, c+m))

EP_LABEL = {}
for lbl, csvf in (("mono", ".cabt-spike/games/mono_eps.csv"), ("v4", ".cabt-spike/games/v4_eps.csv")):
    for line in open(csvf):
        p = line.split(",")
        if p and p[0].isdigit(): EP_LABEL[int(p[0])] = lbl

games = []
for fp in glob.glob(".cabt-spike/games/replays/episode-*-replay.json"):
    ep = int(fp.split("episode-")[1].split("-replay")[0])
    d = json.load(open(fp))
    teams = d["info"]["TeamNames"]
    seat = teams.index("soju") if "soju" in teams else 1
    won = d["rewards"][seat] == 1
    opp = teams[1-seat]
    opp_deck = d["steps"][1][1-seat].get("action") or []
    arch = classify(top_pokemon(opp_deck)) if len(opp_deck) >= 30 else "?"
    games.append((EP_LABEL.get(ep, "?"), won, arch, opp, len(d["steps"])))

for deck in ("v4", "mono"):
    gs = [g for g in games if g[0] == deck]
    if not gs: continue
    w = sum(1 for g in gs if g[1])
    print(f"\n===== {deck.upper()} matchup table — overall {w}-{len(gs)-w} ({w/len(gs)*100:.0f}%) over {len(gs)} games =====")
    by_arch = collections.defaultdict(lambda: [0, 0, []])
    for _, won, arch, opp, nst in gs:
        by_arch[arch][0] += won; by_arch[arch][1] += 1; by_arch[arch][2].append(nst)
    rows = []
    for arch, (wins, n, steps) in by_arch.items():
        lo, hi = wilson(wins, n)
        rows.append((wins/n, arch, wins, n, lo, hi, sum(steps)//len(steps)))
    for wr, arch, wins, n, lo, hi, avgst in sorted(rows):
        bar = "█" * round(wr*10)
        print(f"  {arch:26s} {wins:2d}-{n-wins:<2d} ({n:2d})  wr={wr:.2f} [{lo:.2f},{hi:.2f}] {bar:<10s} avg {avgst}st")
