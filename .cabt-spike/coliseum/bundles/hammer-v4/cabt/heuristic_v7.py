"""heuristic_v7 — OUR threat-aware + expert-sequencing pilot (v8-class capability, our own implementation).

The deck⊗pilot farm (2026-06-22) showed gumi's v8 beats our v4/v6 because v4 is damage-blind: it reads only
BASE printed damage (no Weakness ×2), never reads the opponent's THREAT, and sequences flat by type. Our own
augury `card_aware` term tried the KO-threat idea and REGRESSED (0.30 vs 0.70 — augury.py docstring) — but for
fixable reasons it named itself: it used `best_attack_damage` (ignores energy cost → credits unaffordable
attacks), a crude `has_weakness` proxy (not a real type match), and a 1-ply illusion. v7 does the SAME idea
CORRECTLY (the way gumi's v8 does), on OUR raw-obs-dict infrastructure, as our own code — NOT a copy of gumi's:

  1. TRUE-DAMAGE KO — a SPECIFIC attack's printed damage, ×2 ONLY when the defender's Weakness type matches the
     attacker's energy type (a real type match via cards.weakness_type/energy_type, not has_weakness). v4's #1
     gap: it misses every Weakness KO (reads base dmg < hp when the real ×2 dmg ≥ hp).
  2. THREAT-AWARE RETREAT — read the opp Active's OWN attacks, keep only those AFFORDABLE within its attached
     energy (+1 horizon); retreat an UNDEVELOPED multi-prize Active (≤1 energy) when it's KO'd next turn and we
     have no KO of our own. Energy-aware (the affordability filter is exactly what card_aware lacked).
  3. EXPERT SEQUENCING — KO > draw(max info) > search > evolve(win-con online) > develop bench > ability >
     ATTACH energy LAST (irreversible commit, but ABOVE attack so we never skip energy) > attack > end.
  4. RECOIL SAFETY — never take a NON-lethal attack that KOs our own Active (self-damage read from attack text).
  5. SAFE PROMOTION / BOSS TARGET — promote the smallest prize liability (keep ex/Mega benched); when gusting an
     opponent's Pokémon, drag up the best KO-for-prizes target (best-effort; degrades to a safe default).

Defensive throughout: any missing obs field or off-engine card data degrades to v4-style ordering, so v7 is
NEVER worse than v4 on a malformed input. Drop-in: choose(obs, deck) — identical signature + legality contract
to heuristic.choose (heuristic.py:47-62). Validated behaviorally in the seeded coliseum (CI-gated) vs v4/gumi-v8.
"""
from __future__ import annotations

import re

from . import cards as _cards

# cg.api OptionType values (heuristic.py:15)
PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END = 7, 8, 9, 10, 11, 12, 13, 14
# SelectType values (gumi v8 mirror): MAIN=0, CARD=1, ATTACK=6, COUNT=8, YES_NO=9
ST_MAIN, ST_CARD, ST_ATTACK = 0, 1, 6

# Name-based trainer classification (runtime CardData carries name, not effect text).
_DRAW_WORDS = ("research", "determination", "iono", "marnie", "cynthia", "colress", "hop", "judge", "shauna", "sonia", "lillie")
_SEARCH_WORDS = ("ball", "signal", "cyrano", "communication", "nest", "candy", "search", "capturing", "pad")


# --------------------------------------------------------------------------- obs-dict accessors

def _you(cur):
    return cur.get("yourIndex", 0) if cur else 0


def _active(cur, side):
    try:
        a = cur["players"][side].get("active") or []
        return a[0] if a and a[0] else None
    except Exception:
        return None


def _my_active(cur):
    return _active(cur, _you(cur))


def _opp_active(cur):
    return _active(cur, 1 - _you(cur))


def _energy_count(pk):
    return len(pk.get("energyCards") or []) if pk else 0


# --------------------------------------------------------------------------- true damage + KO

def _true_damage(attack_id, attacker_pk, defender_pk) -> int:
    """Base printed damage, ×2 when defender Weakness type == attacker energy type. (Text-scaling left to a
    future v7.1 — Weakness ×2 is the high-value, low-risk fix; base-only was v4's blind spot.)"""
    base = _cards.attack_damage(attack_id)
    if base <= 0 or attacker_pk is None or defender_pk is None:
        return base if base > 0 else 0
    wk = _cards.weakness_type(defender_pk.get("id"))
    atype = _cards.energy_type(attacker_pk.get("id"))
    if wk is not None and atype is not None and wk == atype:
        return base * 2
    return base


def _attack_kos(cur, attack_id):
    """(kos, true_damage) for an ATTACK option vs the opponent's Active."""
    oa, ma = _opp_active(cur), _my_active(cur)
    if oa is None:
        return (False, 0)
    dmg = _true_damage(attack_id, ma, oa)
    hp = int(oa.get("hp") or 0)
    return (hp > 0 and dmg >= hp, dmg)


def _i_have_ko(cur, opts) -> bool:
    return any(o.get("type") == ATTACK and o.get("attackId") is not None
               and _attack_kos(cur, o["attackId"])[0] for o in opts)


def _self_damage(attack_id) -> int:
    """Recoil — damage an attack deals to its own user (0 if none), from attack text."""
    m = re.search(r"(\d+)\s*damage to (?:itself|this pok)", _cards.attack_text(attack_id))
    return int(m.group(1)) if m else 0


# --------------------------------------------------------------------------- threat awareness

def _opp_max_dmg(cur, horizon=1):
    """(max_dmg, my_hp): most damage the opp Active can deal to ours within its energy + `horizon` attaches,
    ×2 on our Weakness. Energy-aware affordability filter — the fix card_aware lacked."""
    ma, oa = _my_active(cur), _opp_active(cur)
    if ma is None or oa is None:
        return (0, 0)
    my_hp = int(ma.get("hp") or 0)
    avail = _energy_count(oa) + horizon
    best = 0
    for aid in _cards.attack_ids(oa.get("id")):
        if _cards.attack_cost(aid) > avail:
            continue
        best = max(best, _true_damage(aid, oa, ma))   # attacker = opp Active, defender = our Active
    return (best, my_hp)


def _should_retreat(cur, opts) -> bool:
    """Retreat our multi-prize Active ONLY when undeveloped (≤1 energy), KO'd next turn, and we have no KO of
    our own — keep the ex/Mega liability safe, let a 1-prize body take the hit. (gumi v7's ~638 sweet spot.)"""
    ma = _my_active(cur)
    if ma is None or _cards.prize_value(ma.get("id")) < 2:
        return False
    if _i_have_ko(cur, opts):
        return False
    if _energy_count(ma) > 1:        # a developed multi-prizer is our win-con — stand and trade, don't flee
        return False
    dmg, hp = _opp_max_dmg(cur, 1)
    return hp > 0 and dmg >= hp


# --------------------------------------------------------------------------- expert sequencing

def _hand_card_name(cur, opt):
    try:
        hand = cur["players"][_you(cur)].get("hand") or []
        idx = opt.get("index")
        if idx is None or not (0 <= idx < len(hand)):
            return ""
        c = _cards.card(hand[idx].get("id"))
        return (getattr(c, "name", "") or "").lower() if c is not None else ""
    except Exception:
        return ""


def _main_score(cur, opt, bench_n) -> float:
    """Priority for one MAIN-phase option. KO first; ATTACH last but above attack (never skip energy)."""
    t = opt.get("type")
    if t == ATTACK and opt.get("attackId") is not None:
        kos, dmg = _attack_kos(cur, opt["attackId"])
        if kos:
            return 90000 + dmg                                  # take the prize
        ma = _my_active(cur)                                    # recoil safety: don't suicide for no prize
        if ma is not None and _self_damage(opt["attackId"]) >= int(ma.get("hp") or 0) > 0:
            return 30
        return 350 + min(dmg, 99)                               # else attack is near-last
    if t == PLAY:
        if bench_n == 0:
            return 800                                          # never sit on an empty bench (instant-loss guard)
        nm = _hand_card_name(cur, opt)
        if any(w in nm for w in _DRAW_WORDS):
            return 790                                          # draw FIRST — act on max info
        if any(w in nm for w in _SEARCH_WORDS):
            return 770                                          # search after draw
        return 760 if bench_n < 4 else (700 if bench_n < 5 else 100)
    if t == EVOLVE:
        return 765                                              # bring the win-con online (bricking is a top loss cause)
    if t == ABILITY:
        return 600
    if t == ATTACH:
        return 500                                              # COMMIT LAST — after develop, but above any attack
    if t == RETREAT:
        return 150
    if t == DISCARD:
        return 120
    if t == END:
        return 1
    return 100


# --------------------------------------------------------------------------- card-select helpers

def _opt_inplay_pk(cur, opt):
    """The in-play Pokémon an option references (best-effort across the engine's option shapes)."""
    try:
        pi = opt.get("playerIndex")
        area = opt.get("area") if opt.get("inPlayArea") is None else opt.get("inPlayArea")
        idx = int((opt.get("inPlayIndex") if opt.get("inPlayIndex") is not None else opt.get("index", 0)) or 0)
        if pi is None:
            return None
        pl = cur["players"][pi]
        if area == 4:                                          # ACTIVE
            a = pl.get("active") or []
            return a[0] if a else None
        if area == 5:                                          # BENCH
            b = pl.get("bench") or []
            return b[idx] if 0 <= idx < len(b) else None
    except Exception:
        pass
    return None


def _our_best_dmg_vs(cur, target):
    ma = _my_active(cur)
    if ma is None or target is None:
        return 0
    best = 0
    for aid in _cards.attack_ids(ma.get("id")):
        best = max(best, _true_damage(aid, ma, target))
    return best


# --------------------------------------------------------------------------- policy

def choose(obs, deck):
    """Return option indices (drop-in with heuristic.choose). Defensive: unknown shapes → lowest-index legal."""
    sel = obs.get("select")
    if sel is None:
        return None
    opts = sel.get("option") or []
    if not opts:
        return []
    cur = obs.get("current")
    n = len(opts)
    minc = int(sel.get("minCount", 0) or 0)
    maxc = int(sel.get("maxCount", 1) or 1)
    k = min(max(maxc, 1), n)
    k = max(k, min(max(minc, 1), n))
    st = sel.get("type")

    try:
        # MAIN: defend a threatened multi-prizer first, else the highest-priority single action.
        if st == ST_MAIN and maxc == 1 and cur is not None:
            if _should_retreat(cur, opts):
                ridx = next((i for i, o in enumerate(opts) if o.get("type") == RETREAT), None)
                if ridx is not None:
                    return [ridx]
            bench_n = len((cur["players"][_you(cur)].get("bench")) or [])
            return [max(range(n), key=lambda i: _main_score(cur, opts[i], bench_n))]

        # ATTACK: KO first, demote self-KO recoil, then biggest true hit.
        if st == ST_ATTACK and cur is not None:
            ma = _my_active(cur)
            mhp = int(ma.get("hp") or 0) if ma else 0
            def akey(i):
                aid = opts[i].get("attackId")
                if aid is None:
                    return (0, 1, 0)
                kos, dmg = _attack_kos(cur, aid)
                safe = 0 if (mhp and _self_damage(aid) >= mhp) else 1
                return (1 if kos else 0, safe, dmg)
            return [max(range(n), key=akey)]

        # CARD select: gust the best KO target if choosing among the OPPONENT's Pokémon; else promote the
        # smallest prize liability into our Active. Both best-effort; fall through to lowest-index otherwise.
        if st == ST_CARD and cur is not None and maxc == 1:
            oppi = 1 - _you(cur)
            if any(o.get("playerIndex") == oppi for o in opts):    # Boss's Orders / gust
                def bkey(i):
                    pk = _opt_inplay_pk(cur, opts[i])
                    if pk is None:
                        return (-1, -1, 0)
                    hp = int(pk.get("hp") or 0)
                    pv = _cards.prize_value(pk.get("id"))
                    can_ko = 1 if (hp > 0 and _our_best_dmg_vs(cur, pk) >= hp) else 0
                    return (can_ko, can_ko * pv, pv)
                best_i = max(range(n), key=bkey)
                if _opt_inplay_pk(cur, opts[best_i]) is not None:
                    return [best_i]
            if any(o.get("playerIndex") == _you(cur) for o in opts):  # promote (setup/switch/after KO)
                def pkey(i):
                    pk = _opt_inplay_pk(cur, opts[i])
                    if pk is None:
                        return (99, -1)
                    return (_cards.prize_value(pk.get("id")), -(int(pk.get("hp") or 0)))  # lowest prize, then most HP
                ranked = sorted(range(n), key=pkey)
                if _opt_inplay_pk(cur, opts[ranked[0]]) is not None:
                    return sorted(ranked[:k])
    except Exception:
        pass

    # Fallback (and all other select types): v4-style lowest-index legal — never crash/forfeit.
    return sorted(range(n))[:k]
