"""Imitation-pilot LEARNABILITY spike (verify-before-spend; NOT shipped code).

Question: can a LINEAR softmax-over-candidates ranker on per-option board features predict
top-tier Dwebble/Crustle experts' moves BETTER than v4's hand-set type priors? If yes -> the
imitation bet clears the local bar and the production build (via /compose) is worth spending. If
no -> clean NO-GO (a calibration win), reported before any build cost.

Offline-feasible on macOS: the cg engine is a Linux-only native lib, so features are CSV-backed
(EN_Card_Data.csv) here. ATTACK damage uses a per-card-max-damage PROXY (the option carries only
attackId, which the CSV can't map without the engine attack table) — adequate for a learnability
read; production gets the exact attackId->damage table.

LTR note: features are PER-OPTION (vary within a decision); board-context scalars constant across a
group's candidates cancel in the softmax and are excluded.
"""
from __future__ import annotations
import json, csv, glob, collections, re, sys
import numpy as np

CSV_PATH = ".cabt-spike/dl/EN_Card_Data.csv"
EPISODE_DIR = ".cabt-spike/top"

# OptionType ints (heuristic.py:15)
PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END = 7, 8, 9, 10, 11, 12, 13, 14
TYPES = [PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END]
ACTIVE_AREA, BENCH_AREA = 4, 5
# v4 _BASE priors (heuristic.py:20) for the incumbent baseline
V4_BASE = {ATTACH: 50.0, EVOLVE: 48.0, PLAY: 45.0, ABILITY: 42.0, ATTACK: 25.0, RETREAT: 10.0, DISCARD: 6.0, END: 2.0}


# ------------------------------------------------------------------ CSV-backed card accessor
class CardDB:
    def __init__(self, path=CSV_PATH):
        self.info = {}  # cid -> dict
        with open(path) as f:
            r = csv.reader(f); next(r)
            for row in r:
                if not row or not row[0].strip().isdigit():
                    continue
                cid = int(row[0])
                stage_s = (row[4] or "").lower()
                hp = self._int(row[8])
                typ = (row[9] or "").strip()
                weak = (row[10] or "").strip()
                retreat = self._int(row[12])
                cost = row[14] or ""
                dmg = self._dmg(row[15])
                d = self.info.setdefault(cid, dict(
                    name=row[1], stage=self._stage(stage_s), cat=self._cat(row[4]), hp=hp, type=typ,
                    weak=weak, retreat=retreat, is_pokemon=hp > 0, moves=[], rule=(row[5] or "")))
                d["moves"].append((self._cost_count(cost), dmg))

    @staticmethod
    def _int(s):
        try: return int(str(s).strip())
        except Exception: return 0

    @staticmethod
    def _dmg(s):
        m = re.match(r"\s*(\d+)", str(s or ""))
        return int(m.group(1)) if m else 0

    @staticmethod
    def _stage(s):
        if "stage 2" in s: return 2
        if "stage 1" in s: return 1
        if "basic" in s: return 0
        return None  # trainer / energy

    @staticmethod
    def _cat(s):
        s = (s or "").lower()
        if "supporter" in s: return "supporter"
        if "item" in s: return "item"
        if "tool" in s: return "tool"
        if "stadium" in s: return "stadium"
        if "energy" in s: return "energy"          # basic/special energy (before 'basic' pokemon)
        if "stage 2" in s: return "stage2_pkmn"
        if "stage 1" in s: return "stage1_pkmn"
        if "basic" in s: return "basic_pkmn"        # 'basic pokémon'
        return "other"

    @staticmethod
    def _cost_count(cost):
        # {G}●● -> 3 ; {W}{W}● -> 3 ; ● -> 1 ; n/a -> 0
        if not cost or "n/a" in cost.lower():
            return 0
        return len(re.findall(r"\{[^}]+\}", cost)) + cost.count("●")

    def get(self, cid):
        return self.info.get(cid) if cid is not None else None

    def max_damage(self, cid):
        d = self.get(cid)
        return max((dmg for _, dmg in d["moves"]), default=0) if d else 0

    def min_atk_cost(self, cid):
        d = self.get(cid)
        if not d: return 0
        dmg_costs = [c for c, dm in d["moves"] if dm > 0 and c > 0]
        return min(dmg_costs) if dmg_costs else 0

    def prize_value(self, cid):
        d = self.get(cid)
        if not d: return 1
        nm, rule = d["name"].lower(), d["rule"].lower()
        if "mega" in nm and "ex" in nm: return 3
        if nm.endswith(" ex") or " ex " in nm or "ex" == rule.strip() or "pokémon ex" in rule: return 2
        return 1


# ------------------------------------------------------------------ archetype of a deck
def deck_arch(deck, db):
    pk = collections.Counter()
    for cid in deck:
        d = db.get(cid)
        if d and d["is_pokemon"]:
            pk[d["name"]] += 1
    keys = " ".join(pk).lower()
    if "crustle" in keys or "dwebble" in keys: return "dwebble_crustle"
    if "lucario" in keys: return "lucario"
    return "other"


# ------------------------------------------------------------------ per-option features (vary within a group)
# Card identity is resolved from the (visible) hand via hand[o["index"]].id — the fix that the first
# cut missed (o.get("cardId") is absent on PLAY/ATTACH/EVOLVE options).
FEAT_NAMES = [f"type_{t}" for t in TYPES] + [
    "play_basic_room", "play_supporter", "play_item", "play_tool", "play_stadium",
    "attach_progress", "attach_active",
    "evolve_ready",
    "atk_lethal", "atk_dmgfrac", "atk_weak"]
N_FEAT = len(FEAT_NAMES)  # 8 + 11 = 19


def _active(p):
    a = (p or {}).get("active") or []
    return a[0] if a and a[0] else None


def _target(cur, you, o):
    me = cur["players"][you]
    area, idx = o.get("inPlayArea"), o.get("inPlayIndex")
    if area == ACTIVE_AREA:
        return _active(me)
    if area == BENCH_AREA and idx is not None:
        bench = me.get("bench") or []
        if 0 <= idx < len(bench):
            return bench[idx]
    return None


def _hand_id(cur, you, o):
    """The cardId the option sources from hand (PLAY/ATTACH/EVOLVE carry only a hand index)."""
    hand = cur["players"][you].get("hand") or []
    idx = o.get("index")
    if idx is not None and 0 <= idx < len(hand):
        c = hand[idx]
        return c.get("id") if isinstance(c, dict) else c
    return None


def featurize(o, cur, you, db):
    f = np.zeros(N_FEAT)
    t = o.get("type")
    if t in TYPES:
        f[TYPES.index(t)] = 1.0
    me = cur["players"][you]; opp = cur["players"][1 - you]
    my_act, opp_act = _active(me), _active(opp)
    b = 8  # board-feature base offset

    if t == PLAY:
        d = db.get(_hand_id(cur, you, o))  # WHICH card is being played (resolved from hand)
        cat = d["cat"] if d else None
        if cat == "basic_pkmn":
            bench = me.get("bench") or []; bmax = me.get("benchMax") or 5
            f[b + 0] = max(0.0, 1.0 - len(bench) / float(bmax)) if bmax else 0.0  # bench-width, diminishing
        elif cat == "supporter": f[b + 1] = 1.0
        elif cat == "item":      f[b + 2] = 1.0
        elif cat == "tool":      f[b + 3] = 1.0
        elif cat == "stadium":   f[b + 4] = 1.0

    if t == ATTACH:
        tg = _target(cur, you, o)
        if tg:
            have = len(tg.get("energies") or []); cost = db.min_atk_cost(tg.get("id"))
            if cost > 0 and have < cost:
                f[b + 5] = min(1.0, (have + 1) / cost)                       # progress toward affording attack
            f[b + 6] = 1.0 if (my_act and tg is my_act) else 0.0            # fuel the active

    if t == EVOLVE:
        tg = _target(cur, you, o)
        d = db.get(_hand_id(cur, you, o))  # the evolution card from hand (its stage)
        sw = 1.0 if (d and d["stage"] == 2) else (0.6 if (d and d["stage"] == 1) else 0.4)
        ready = 1.0 if (tg and tg.get("energies")) else 0.4
        f[b + 7] = sw * ready

    if t == ATTACK:
        dmg = db.max_damage(my_act.get("id")) if my_act else 0
        ohp = (opp_act.get("hp") or 0) if opp_act else 0
        f[b + 8] = 1.0 if (dmg > 0 and ohp > 0 and dmg >= ohp) else 0.0     # lethal (max-dmg proxy)
        f[b + 9] = min(1.0, dmg / ohp) if ohp > 0 else 0.0                  # dmg fraction
        if my_act and opp_act:
            mt = (db.get(my_act.get("id")) or {}).get("type")
            ow = (db.get(opp_act.get("id")) or {}).get("weak")
            f[b + 10] = 1.0 if (mt and ow and mt == ow) else 0.0            # weakness hit
    return f


def v4_score(o, cur, you, db):
    t = o.get("type")
    s = V4_BASE.get(t, 20.0)
    if t == ATTACK:
        my_act = _active(cur["players"][you])
        dmg = db.max_damage(my_act.get("id")) if my_act else 0
        s += 0.1 * dmg
        opp_act = _active(cur["players"][1 - you])
        ohp = (opp_act.get("hp") or 0) if opp_act else 0
        if dmg > 0 and ohp > 0 and dmg >= ohp:
            s += 1000.0
    return s


# ------------------------------------------------------------------ extract decisions from winner replays
def extract(db, arch_filter="dwebble_crustle"):
    groups = []  # (game_id, X[n_opts,N_FEAT], v4scores[n_opts], chosen_idx, types)
    handle_wins = collections.Counter(); handle_games = collections.Counter()
    n_games = collections.Counter()
    for fp in sorted(glob.glob(f"{EPISODE_DIR}/*.json")):
        try:
            d = json.load(open(fp))
        except Exception:
            continue
        gid = d["info"].get("EpisodeId", fp)
        rew = d.get("rewards") or [0, 0]
        if len(rew) < 2 or any(r is None for r in rew):
            continue  # incomplete/errored game — can't determine a winner
        teams = d["info"].get("TeamNames", ["?", "?"])
        for seat in range(min(2, len(rew))):
            won = rew[seat] == max(rew) and rew[seat] != rew[1 - seat]
            handle_games[teams[seat]] += 1
            if won:
                handle_wins[teams[seat]] += 1
            if not won:
                continue
            deck = d["steps"][1][seat].get("action") or []
            if deck_arch(deck, db) != arch_filter:
                continue
            n_games[arch_filter] += 1
            for st in d["steps"]:
                if seat >= len(st):
                    continue
                p = st[seat]
                if p.get("status") != "ACTIVE":
                    continue
                obs = p.get("observation") or {}; sel = obs.get("select")
                if not (sel and isinstance(sel, dict)):
                    continue
                opts = sel.get("option") or []
                act = p.get("action")
                if len(opts) < 2 or int(sel.get("maxCount", 1) or 1) != 1:
                    continue
                if not (act and len(act) == 1 and 0 <= act[0] < len(opts)):
                    continue
                cur = obs.get("current")
                if not (cur and cur.get("players") and len(cur["players"]) == 2):
                    continue
                you = cur.get("yourIndex", seat)
                try:
                    X = np.array([featurize(o, cur, you, db) for o in opts])
                    v4 = np.array([v4_score(o, cur, you, db) for o in opts])
                    keys = [_opt_key(o, cur, you) for o in opts]  # specific resource each option deploys
                except Exception:
                    continue
                groups.append((gid, X, v4, act[0], [o.get("type") for o in opts], keys))
    return groups, n_games, handle_wins, handle_games


def _opt_key(o, cur, you):
    """The specific card/attack an option deploys, for the per-card preference steelman.
    PLAY/ATTACH/EVOLVE -> ('card', hand cardId); ATTACK -> ('atk', attackId); else None."""
    t = o.get("type")
    if t in (PLAY, ATTACH, EVOLVE):
        cid = _hand_id(cur, you, o)
        return ("card", cid) if cid is not None else None
    if t == ATTACK:
        return ("atk", o.get("attackId"))
    return None


# ------------------------------------------------------------------ softmax-over-candidates linear ranker
def train(groups, nfeat, l2=1e-3, lr=0.5, iters=500):
    w = np.zeros(nfeat)
    for _ in range(iters):
        grad = np.zeros(nfeat)
        for g in groups:
            X, ci = g[1], g[3]
            s = X @ w; s -= s.max()
            e = np.exp(s); p = e / e.sum()
            gr = p.copy(); gr[ci] -= 1.0
            grad += X.T @ gr
        grad = grad / len(groups) + l2 * w
        w -= lr * grad
    return w


def top1(groups, scorer):
    return np.mean([1.0 if int(np.argmax(scorer(g[1], g[2]))) == g[3] else 0.0 for g in groups])


def augment(groups, vocab):
    """Append a one-hot block over the per-option card/attack key (the per-card-preference steelman)."""
    K = len(vocab)
    out = []
    for g in groups:
        gid, X, v4, ci, types, keys = g
        block = np.zeros((X.shape[0], K))
        for i, k in enumerate(keys):
            j = vocab.get(k)
            if j is not None:
                block[i, j] = 1.0
        out.append((gid, np.hstack([X, block]), v4, ci, types, keys))
    return out


def standardize(tr, te):
    allrows = np.vstack([g[1] for g in tr])
    mu = allrows.mean(0); sd = allrows.std(0); sd[sd < 1e-6] = 1.0
    def nz(grp): return [(g[0], (g[1] - mu) / sd, g[2], g[3], g[4], g[5]) for g in grp]
    return nz(tr), nz(te)


def main():
    arch = sys.argv[1] if len(sys.argv) > 1 else "dwebble_crustle"
    db = CardDB()
    print(f"cards loaded: {len(db.info)}  | archetype = {arch}")
    groups, n_games, hw, hg = extract(db, arch_filter=arch)
    n_eps = len(glob.glob(f"{EPISODE_DIR}/*.json"))
    print(f"episodes on disk: {n_eps}")
    print(f"{arch} winner-games: {n_games[arch]} | decision groups: {len(groups)}")
    if len(groups) < 50:
        print("TOO FEW groups — let the download finish, then re-run."); return

    gids = sorted({g[0] for g in groups})

    # ---- multi-seed CV: bound the v4 / learned lift across 8 game-level splits (small test sets are noisy)
    def split(seed):
        r = np.random.RandomState(seed); gg = list(gids); r.shuffle(gg)
        cut = max(1, int(0.8 * len(gg))); ti = set(gg[:cut])
        return [g for g in groups if g[0] in ti], [g for g in groups if g[0] not in ti]
    cv_v4, cv_base = [], []
    for seed in range(8):
        trS, teS = split(seed)
        trn, ten = standardize(trS, teS)
        w = train(trn, N_FEAT)
        cv_v4.append(top1(teS, lambda X, v4: v4))
        cv_base.append(top1(ten, lambda X, v4: X @ w))
    cv_v4, cv_base = np.array(cv_v4), np.array(cv_base)
    cv_lift = cv_base - cv_v4
    print(f"\n  CV (8 game-splits): v4 {cv_v4.mean():.3f}±{cv_v4.std():.3f} | "
          f"learned {cv_base.mean():.3f}±{cv_base.std():.3f} | "
          f"lift {cv_lift.mean():+.3f}±{cv_lift.std():.3f} "
          f"(wins {int((cv_lift>0).sum())}/8)")

    # detailed readout on seed 0
    tr, te = split(0)
    rand_exp = np.mean([1.0 / len(g[1]) for g in te])
    avg_opts = np.mean([len(g[1]) for g in te])
    acc_v4 = top1(te, lambda X, v4: v4)
    print(f"games: {len(gids)} (~{int(0.8*len(gids))} train / {len(gids)-int(0.8*len(gids))} test) | groups: {len(tr)} train / {len(te)} test")

    def run(tr_, te_, nfeat, label):
        trn, ten = standardize(tr_, te_)
        w = train(trn, nfeat)
        acc = top1(ten, lambda X, v4: X @ w)
        differ = np.mean([1.0 if np.argmax(ten[i][1] @ w) != np.argmax(te_[i][2]) else 0.0 for i in range(len(te_))])
        print(f"  {label:32s}: {acc:.3f}  (lift vs v4 {acc-acc_v4:+.3f}, differs {differ:.0%})")
        return w, acc

    # vocab of the most frequent option card/attack keys, from TRAIN only
    kc = collections.Counter(k for g in tr for k in g[5] if k is not None)
    TOPN = 60
    vocab = {k: i for i, (k, _) in enumerate(kc.most_common(TOPN))}
    tr_aug, te_aug = augment(tr, vocab), augment(te, vocab)

    print("\n================  LEARNABILITY READOUT  ================")
    print(f"  test decision groups : {len(te)}  (avg {avg_opts:.1f} options/decision)")
    print(f"  random baseline                 : {rand_exp:.3f}  (1/options)")
    print(f"  v4-proxy (incumbent hand priors): {acc_v4:.3f}  (_BASE + lethal, argmax)")
    print("  --- learned softmax-over-candidates rankers (held-out top-1 accuracy) ---")
    wb, _ = run(tr, te, N_FEAT, "type + board-delta + card-cat")
    wa, _ = run(tr_aug, te_aug, N_FEAT + len(vocab), f"+ per-card-id one-hot (top {len(vocab)})")

    print("\n  base-model weights (standardized):")
    for nm, wi in sorted(zip(FEAT_NAMES, wb), key=lambda x: -abs(x[1]))[:12]:
        print(f"    {nm:18s} {wi:+.3f}")
    print("\n  (LOCAL learnability signal only — the LADDER is the strength judge.)")


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()
