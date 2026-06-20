"""Echelon — CLONE-ROSTER serve (PURE PYTHON, no numpy).

make_clone(archetype) -> agent(obs) -> option indices. The agent is the imitation_spike's linear
softmax-over-candidates ranker, frozen at the train weights for ONE archetype. It must run INSIDE the
amd64 python:3.12 arena container, where numpy is NOT guaranteed at match time — so everything here is
plain-python: a CSV-backed CardDB and a hand-ported featurize that is BIT-IDENTICAL to the spike's
numpy featurize (same FEAT_NAMES order, same branch logic, same scalars), then a plain dot product.

Train/serve parity contract:
  * features  — this file's featurize() mirrors imitation_spike.featurize() line-for-line.
  * z-score   — the saved (mu, sd) ARE the train standardization; serve applies the same z-score.
  * weights   — w·standardize(f) ; argmax over legal options.

Agent contract (mirrors src/cabt heuristic.choose):
  * sel is None            -> return None (deck-selection; the arena caller falls back to greedy)
  * no options             -> return []
  * minCount/maxCount      -> honor (return sorted top-k indices)

Load gate: weights/CSV missing -> RAISE (FAGAN-F1 package-closure lesson). NEVER silently fall back to
greedy without surfacing — a clone that can't load is a configuration bug the arena must see.
"""
from __future__ import annotations
import os, json, csv, re

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPIKE_DIR = os.path.dirname(_HERE)              # .cabt-spike
_CSV_PATH = os.path.join(_SPIKE_DIR, "dl", "EN_Card_Data.csv")

# OptionType ints + areas — MUST equal imitation_spike's (heuristic.py:15).
PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END = 7, 8, 9, 10, 11, 12, 13, 14
TYPES = [PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END]
ACTIVE_AREA, BENCH_AREA = 4, 5

# Feature order — MUST equal imitation_spike.FEAT_NAMES exactly. Asserted against the saved
# feat_names at load (the train==serve tripwire).
FEAT_NAMES = [f"type_{t}" for t in TYPES] + [
    "play_basic_room", "play_supporter", "play_item", "play_tool", "play_stadium",
    "attach_progress", "attach_active",
    "evolve_ready",
    "atk_lethal", "atk_dmgfrac", "atk_weak"]
N_FEAT = len(FEAT_NAMES)  # 19


# ------------------------------------------------------------------ CSV CardDB (pure-python port of spike.CardDB)
class CardDB:
    def __init__(self, path=_CSV_PATH):
        if not os.path.exists(path):
            raise FileNotFoundError(f"clone CardDB: card-data CSV missing at {path}")
        self.info = {}
        with open(path) as f:
            r = csv.reader(f)
            next(r)
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
        try:
            return int(str(s).strip())
        except Exception:
            return 0

    @staticmethod
    def _dmg(s):
        m = re.match(r"\s*(\d+)", str(s or ""))
        return int(m.group(1)) if m else 0

    @staticmethod
    def _stage(s):
        if "stage 2" in s:
            return 2
        if "stage 1" in s:
            return 1
        if "basic" in s:
            return 0
        return None

    @staticmethod
    def _cat(s):
        s = (s or "").lower()
        if "supporter" in s:
            return "supporter"
        if "item" in s:
            return "item"
        if "tool" in s:
            return "tool"
        if "stadium" in s:
            return "stadium"
        if "energy" in s:
            return "energy"
        if "stage 2" in s:
            return "stage2_pkmn"
        if "stage 1" in s:
            return "stage1_pkmn"
        if "basic" in s:
            return "basic_pkmn"
        return "other"

    @staticmethod
    def _cost_count(cost):
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
        if not d:
            return 0
        dmg_costs = [c for c, dm in d["moves"] if dm > 0 and c > 0]
        return min(dmg_costs) if dmg_costs else 0


# ------------------------------------------------------------------ per-option helpers (port of spike)
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
    hand = cur["players"][you].get("hand") or []
    idx = o.get("index")
    if idx is not None and 0 <= idx < len(hand):
        c = hand[idx]
        return c.get("id") if isinstance(c, dict) else c
    return None


def featurize(o, cur, you, db):
    """PURE-PYTHON, BIT-IDENTICAL port of imitation_spike.featurize (returns a list of N_FEAT floats
    in FEAT_NAMES order). Every branch/scalar mirrors the spike — do NOT diverge; train uses the spike's
    numpy featurize, serve uses this, and the arena demands they agree to the bit."""
    f = [0.0] * N_FEAT
    t = o.get("type")
    if t in TYPES:
        f[TYPES.index(t)] = 1.0
    me = cur["players"][you]
    opp = cur["players"][1 - you]
    my_act, opp_act = _active(me), _active(opp)
    b = 8  # board-feature base offset

    if t == PLAY:
        d = db.get(_hand_id(cur, you, o))
        cat = d["cat"] if d else None
        if cat == "basic_pkmn":
            bench = me.get("bench") or []
            bmax = me.get("benchMax") or 5
            f[b + 0] = max(0.0, 1.0 - len(bench) / float(bmax)) if bmax else 0.0
        elif cat == "supporter":
            f[b + 1] = 1.0
        elif cat == "item":
            f[b + 2] = 1.0
        elif cat == "tool":
            f[b + 3] = 1.0
        elif cat == "stadium":
            f[b + 4] = 1.0

    if t == ATTACH:
        tg = _target(cur, you, o)
        if tg:
            have = len(tg.get("energies") or [])
            cost = db.min_atk_cost(tg.get("id"))
            if cost > 0 and have < cost:
                f[b + 5] = min(1.0, (have + 1) / cost)
            f[b + 6] = 1.0 if (my_act and tg is my_act) else 0.0

    if t == EVOLVE:
        tg = _target(cur, you, o)
        d = db.get(_hand_id(cur, you, o))
        sw = 1.0 if (d and d["stage"] == 2) else (0.6 if (d and d["stage"] == 1) else 0.4)
        ready = 1.0 if (tg and tg.get("energies")) else 0.4
        f[b + 7] = sw * ready

    if t == ATTACK:
        dmg = db.max_damage(my_act.get("id")) if my_act else 0
        ohp = (opp_act.get("hp") or 0) if opp_act else 0
        f[b + 8] = 1.0 if (dmg > 0 and ohp > 0 and dmg >= ohp) else 0.0
        f[b + 9] = min(1.0, dmg / ohp) if ohp > 0 else 0.0
        if my_act and opp_act:
            mt = (db.get(my_act.get("id")) or {}).get("type")
            ow = (db.get(opp_act.get("id")) or {}).get("weak")
            f[b + 10] = 1.0 if (mt and ow and mt == ow) else 0.0
    return f


# ------------------------------------------------------------------ clone factory
_DB = None  # CardDB shared across clones (loaded once)


def _db():
    global _DB
    if _DB is None:
        _DB = CardDB()
    return _DB


def _load_weights(archetype):
    path = os.path.join(_HERE, f"clone_weights_{archetype}.json")
    if not os.path.exists(path):
        # EXPLICIT load gate — surface, never silently greedy (FAGAN-F1 package-closure).
        raise FileNotFoundError(
            f"clone weights missing for archetype '{archetype}' at {path}. "
            f"Run: python .cabt-spike/echelon/train_clones.py")
    with open(path) as f:
        m = json.load(f)
    saved = m.get("feat_names")
    if saved != FEAT_NAMES:
        raise ValueError(
            f"clone '{archetype}': saved feat_names != serve FEAT_NAMES (train/serve feature drift). "
            f"saved n={len(saved or [])}, serve n={len(FEAT_NAMES)}")
    w, mu, sd = m["weights"], m["mu"], m["sd"]
    if not (len(w) == len(mu) == len(sd) == N_FEAT):
        raise ValueError(f"clone '{archetype}': weight/mu/sd length != N_FEAT ({N_FEAT})")
    return w, mu, sd


def _score(f, w, mu, sd):
    """w · standardize(f) — plain dot product, no numpy. standardize == (f-mu)/sd, the SAME mu/sd the
    trainer used (sd already floored at 1e-6 -> 1.0 in train_clones, so no /0)."""
    s = 0.0
    for i in range(N_FEAT):
        s += w[i] * ((f[i] - mu[i]) / sd[i])
    return s


def make_clone(archetype):
    """Return agent(obs) -> option indices for `archetype`. Loads weights + CSV CardDB eagerly so a
    missing/ corrupt clone fails LOUD at construction (not silently mid-match)."""
    w, mu, sd = _load_weights(archetype)   # raises if missing/ drifted
    db = _db()                              # raises if card CSV missing

    def agent(obs):
        sel = obs.get("select")
        if sel is None:
            return None                     # deck-selection — caller handles (greedy fallback)
        opts = sel.get("option") or []
        if not opts:
            return []
        cur = obs.get("current")
        n = len(opts)
        minc = int(sel.get("minCount", 0) or 0)
        maxc = int(sel.get("maxCount", 1) or 1)
        k = min(max(maxc, 1), n)
        k = max(k, min(max(minc, 1), n))    # honor minCount/maxCount, same shape as heuristic.choose
        you = cur.get("yourIndex", 0) if cur else 0
        if not (cur and cur.get("players") and len(cur["players"]) == 2):
            # board context unavailable — feature space needs both players; defer to caller fallback.
            return None
        scores = []
        for o in opts:
            try:
                fe = featurize(o, cur, you, db)
                sc = _score(fe, w, mu, sd)
            except Exception:
                sc = float("-inf")          # a featurization failure must NOT win argmax
            scores.append(sc)
        ranked = sorted(range(n), key=lambda i: (-scores[i], i))
        return sorted(ranked[:k])

    agent.archetype = archetype
    return agent


if __name__ == "__main__":
    # smoke: every clone constructs + scores a tiny synthetic decision (no engine needed).
    for arch in ("lucario", "dwebble_crustle", "alakazam"):
        a = make_clone(arch)
        assert callable(a), f"{arch}: make_clone did not return a callable"
        obs = {
            "select": {"option": [{"type": END}, {"type": ATTACK, "attackId": 1}], "maxCount": 1},
            "current": {"yourIndex": 0, "players": [
                {"active": [{"id": 673, "hp": 100, "energies": [1, 1]}], "bench": [], "hand": []},
                {"active": [{"id": 1, "hp": 60}], "bench": [], "hand": []}]},
        }
        pick = a(obs)
        assert isinstance(pick, list) and len(pick) == 1, f"{arch}: bad pick {pick}"
        # deck-selection -> None ; empty -> []
        assert a({"select": None}) is None, f"{arch}: deck-select must be None"
        assert a({"select": {"option": []}}) == [], f"{arch}: empty options must be []"
        print(f"  {arch:18s} OK -> pick={pick}")
    print("clone_agent smoke OK")
