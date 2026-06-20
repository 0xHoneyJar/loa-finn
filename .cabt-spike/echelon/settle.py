"""Echelon v0 — the GHOST ARENA.

The metacog move (operator, 2026-06-19): stop optimizing inside a bad signal regime (5 slow ladder
bets/day, everything cheaper is anti-signal). Instead settle the signal we ALREADY hold: 256+ real
top-tier matches between real players. Those matches already happened — this settles them against
ground truth into calibration residue (echelon's discipline), with no engine and no Docker.

Outputs the REAL META we are actually fighting:
  - a per-player Elo leaderboard (who is strong in the 1300-tier field),
  - the archetype x archetype matchup matrix (the rock-paper-scissors of the meta),
  - per-archetype standing (share, win-rate, avg Elo of its pilots).

This is the data spine of the live coliseum (v1 = clone roster + Docker matches). It is also the
field whose QUALITY is the whole ballgame: a coliseum seeded with greedy clustered our pilots at 0.5
(GAMES-008). A coliseum seeded with THIS field is a miniature of the ladder.
"""
from __future__ import annotations
import json, csv, glob, collections, math

EPISODE_DIR = ".cabt-spike/top"
CSV_PATH = ".cabt-spike/dl/EN_Card_Data.csv"
OUT = ".cabt-spike/echelon/meta.json"

# --- card -> (name, is_pokemon) ---
CARD = {}
with open(CSV_PATH) as f:
    r = csv.reader(f); next(r)
    for row in r:
        if row and row[0].isdigit():
            CARD[int(row[0])] = (row[1], row[8] not in ("n/a", "", None))

# Archetype rules (from parse_matchups.py — the field instrument's taxonomy, extended).
ARCH_RULES = [
    ("Lucario (Fighting)", ["mega lucario", "lucario"]),
    ("Dwebble/Crustle (Grass)", ["crustle", "dwebble"]),
    ("Alakazam (Psychic)", ["alakazam", "kadabra", "abra"]),
    ("Abomasnow (Water)", ["abomasnow", "snover"]),
    ("Dragapult", ["dragapult", "drakloak"]),
    ("Grimmsnarl (Dark)", ["grimmsnarl", "impidimp"]),
    ("Sinistcha (Grass)", ["sinistcha", "poltchageist"]),
    ("Mismagius (Psychic)", ["mismagius", "misdreavus"]),
    ("Ogerpon/RagingBolt", ["ogerpon", "raging bolt"]),
    ("Gholdengo", ["gholdengo", "gimmighoul"]),
    ("Charizard", ["charizard", "charmander"]),
    ("Team Rocket", ["team rocket"]),
    ("Kangaskhan", ["kangaskhan"]),
]


def top_pokemon(deck):
    pk = collections.Counter()
    for cid in deck:
        n, isp = CARD.get(cid, (f"#{cid}", False))
        if isp:
            pk[n] += 1
    return pk


def classify(pk):
    keys = " ".join(pk).lower()
    for label, needles in ARCH_RULES:
        if any(n in keys for n in needles):
            return label
    lead = pk.most_common(1)
    return f"other: {lead[0][0]}" if lead else "unknown"


def load_games():
    games = []  # (player_a, player_b, winner_seat or None for tie, arch_a, arch_b)
    for fp in sorted(glob.glob(f"{EPISODE_DIR}/*.json")):
        try:
            d = json.load(open(fp))
        except Exception:
            continue
        rew = d.get("rewards")
        info = d.get("info", {})
        teams = info.get("TeamNames") or ["?", "?"]
        if not rew or len(rew) < 2 or any(r is None for r in rew) or len(teams) < 2:
            continue
        try:
            decks = [d["steps"][1][s].get("action") or [] for s in range(2)]
        except Exception:
            decks = [[], []]
        arch = [classify(top_pokemon(dk)) if len(dk) >= 30 else "unknown" for dk in decks]
        if rew[0] == rew[1]:
            win = None
        else:
            win = 0 if rew[0] > rew[1] else 1
        games.append((teams[0], teams[1], win, arch[0], arch[1], info.get("EpisodeId")))
    return games


def elo(games, k=24, passes=12):
    """Iterative Elo over the settled games (multi-pass for stability; ties = 0.5)."""
    R = collections.defaultdict(lambda: 1500.0)
    n = collections.Counter()
    for g in games:
        n[g[0]] += 1; n[g[1]] += 1
    order = sorted(games, key=lambda g: (g[5] is None, g[5]))  # chronological by episode id
    for _ in range(passes):
        for a, b, win, _aa, _ab, _ep in order:
            ra, rb = R[a], R[b]
            ea = 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))
            sa = 0.5 if win is None else (1.0 if win == 0 else 0.0)
            R[a] += k * (sa - ea)
            R[b] += k * ((1 - sa) - (1 - ea))
    return R, n


def wilson(w, n):
    if n == 0:
        return 0.0, 0.0, 0.0
    p = w / n; z = 1.96; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, max(0.0, c - m), min(1.0, c + m)


def main():
    games = load_games()
    print(f"settled {len(games)} real top-tier matches ({len(glob.glob(EPISODE_DIR + '/*.json'))} episodes)\n")

    R, n = elo(games)
    # --- player leaderboard (min 3 games for a reliable rating) ---
    rated = [(p, R[p], n[p]) for p in R if n[p] >= 3]
    rated.sort(key=lambda x: -x[1])
    print("=== ECHELON LEADERBOARD — top players (>=3 games) ===")
    for p, r, g in rated[:15]:
        print(f"  {r:7.0f}  {p[:28]:28s}  ({g} games)")

    # --- archetype standing ---
    arch_games = collections.Counter()
    arch_wins = collections.Counter()
    arch_elos = collections.defaultdict(list)
    matchup = collections.defaultdict(lambda: [0, 0])  # (atk,def)->[wins,games]
    for a, b, win, aa, ab, _ep in games:
        for seat, (me_arch, opp_arch, player) in enumerate([(aa, ab, a), (ab, aa, b)]):
            if me_arch in ("unknown",) or me_arch.startswith("other"):
                continue
            arch_games[me_arch] += 1
            won = (win == seat)
            if won:
                arch_wins[me_arch] += 1
            if n[player] >= 3:
                arch_elos[me_arch].append(R[player])
            if not opp_arch.startswith("other") and opp_arch != "unknown":
                matchup[(me_arch, opp_arch)][1] += 1
                if won:
                    matchup[(me_arch, opp_arch)][0] += 1

    print("\n=== THE REAL META — archetype standing (>=10 appearances) ===")
    rows = []
    for arch in arch_games:
        g = arch_games[arch]
        if g < 10:
            continue
        wr, lo, hi = wilson(arch_wins[arch], g)
        avg_elo = sum(arch_elos[arch]) / len(arch_elos[arch]) if arch_elos[arch] else 1500
        rows.append((avg_elo, arch, g, wr, lo, hi))
    rows.sort(key=lambda x: -x[0])
    for avg_elo, arch, g, wr, lo, hi in rows:
        bar = "#" * round(wr * 20)
        print(f"  {arch:26s} share={g:4d}  wr={wr:.2f} [{lo:.2f},{hi:.2f}]  pilotElo~{avg_elo:4.0f}  {bar}")

    print("\n=== MATCHUP MATRIX — row beats column (win-rate, >=6 games) ===")
    archs = [r[1] for r in rows]
    short = {a: a.split(" (")[0].split("/")[0][:10] for a in archs}
    hdr = "  " + " " * 12 + "".join(f"{short[a]:>11s}" for a in archs)
    print(hdr)
    for ra in archs:
        line = f"  {short[ra]:12s}"
        for rb in archs:
            if ra == rb:
                line += f"{'  --  ':>11s}"; continue
            w, gg = matchup[(ra, rb)]
            line += f"{(f'{w/gg:.2f}({gg})' if gg >= 6 else '  ·  '):>11s}"
        print(line)

    # --- settlement artifact (calibration residue) ---
    artifact = {
        "settled_matches": len(games),
        "leaderboard": [{"player": p, "elo": round(r, 1), "games": g} for p, r, g in rated[:40]],
        "archetypes": [{"archetype": a, "appearances": g, "winrate": round(wr, 3),
                        "wr_ci95": [round(lo, 3), round(hi, 3)], "pilot_elo": round(e, 1)}
                       for e, a, g, wr, lo, hi in rows],
        "matchups": [{"attacker": a, "defender": b, "wins": v[0], "games": v[1],
                      "winrate": round(v[0] / v[1], 3)} for (a, b), v in matchup.items() if v[1] >= 6],
    }
    json.dump(artifact, open(OUT, "w"), indent=1)
    print(f"\nsettled -> {OUT}  ({len(artifact['leaderboard'])} players, "
          f"{len(artifact['archetypes'])} archetypes, {len(artifact['matchups'])} matchups)")


if __name__ == "__main__":
    main()
