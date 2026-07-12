"""
v8 threat-aware + expert-sequencing heuristic agent — PTCG-ABC (cycle: ptcg-agent).

Two layers on top of the proven develop-then-attack heuristic:

THREAT (v7, the ~638 sweet spot) — from a 152-game study (tools/study_game.py); #1 loss cause is
conceding 2-/3-prize KOs (losers gave up 59 three-prize KOs vs winners' 25):
  - RETREAT a multi-prize Active the opponent can KO NEXT turn, when we have no KO of our own (surgical —
    v7.1's wider/earlier retreat over-defended → 545; reverted).
  - promote the SMALLEST prize liability into the Active spot (keep ex/Mega safe on the Bench).
Threats read straight from the board (opp Active's attacks × energy × our Weakness) — never a deck guess.

SEQUENCING (v10, re-merged after v8 settled to 635 — the 355 was a fresh-read mirage): maximise info,
delay irreversible commitments — ATTACH energy LAST (above attacks so we never skip it), DRAW before
SEARCH. Plus one CO-DESIGN tune for this deck: EVOLVE the Mega ASAP (bricking was our #1 loss cause).
v11 PILOT ADDITIONS (teaching the pilot tech, per the meta survey where Boss is in all top-10 decks):
  - BOSS'S ORDERS / gust targeting (_boss_target): when choosing among the OPPONENT'S Pokémon, drag up
    the one we can KO for the most prizes (not the cheapest — the default would do the opposite).
  - RECOIL SAFETY (_self_damage): never use a non-lethal attack that KOs our own Active (e.g. Hariyama's
    Wild Press, 70 self-damage) — heal/develop instead. KO attacks are still taken.
v11 DECK = a 1-PRIZE beatdown (NOT the Mega): Makuhita→Hariyama (210 one-shot, recoil offset by Cook/Jumbo
Ice Cream heals) + Bloodmoon Ursaluna backup + Boss + Switch + Hero's Cape. Pivot off the 3-prize Mega
after the meta survey: 8 of the top 10 run 1-prize attackers; the lone 3-prize deck was last.
Everything below is the proven base policy.


Interface (from kit/sample_submission): agent(obs_dict) -> list[int].
The engine enumerates the LEGAL options each decision (obs.select.option); we return option
INDICES, length in [minCount, maxCount], no duplicates. At game start obs.select is None → return
the 60-card deck (IDs from deck.csv).

This is a *policy over enumerated legal options*, not a move generator — the engine handles legality.
Priors encoded here come straight from the Gygax analysis (analysis/augury-card-pool.md,
strategy/cabal-matchups.md):
  - Prize-race + KO-threshold thinking: prefer attacks that actually KO (damage × Weakness vs the
    defender's current HP, read from the observation + the engine's own card/attack data).
  - Tempo: develop (attach Energy / evolve) before throwing a non-lethal attack; never pass with a
    KO available.
  - Keep the Bench small (vs Dragapult-style spread).
  - Safe, beneficial defaults for coin/first/activate/count prompts.

DESIGN NOTE: the native engine (cg/libcg.so) is Linux-x86 only, so this is validated on Kaggle, not
on the dev Mac. Every branch is defensive: any failure falls through to a guaranteed-legal default,
so the agent never crashes or forfeits on an unhandled prompt. First Kaggle run is its validation.
"""
__version__ = "v16syl"
import os, re

try:
    from cg.api import to_observation_class
except Exception:  # pragma: no cover - cg only present in the submission sandbox
    to_observation_class = None

try:
    from cg.api import all_card_data, all_attack
except Exception:
    all_card_data = all_attack = None

# --- Enum int values (mirrored from cg/api.py so logic works without importing the enums; the file
#     notes new values may be appended during the competition, so we treat unknowns gracefully). ---
class OT:  # OptionType
    NUMBER, YES, NO, CARD, TOOL_CARD, ENERGY_CARD, ENERGY = 0, 1, 2, 3, 4, 5, 6
    PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END, SKILL, SPECIAL_CONDITION = 7, 8, 9, 10, 11, 12, 13, 14, 15, 16

class ST:  # SelectType
    MAIN, CARD, ATTACHED_CARD, CARD_OR_ATTACHED_CARD, ENERGY, SKILL, ATTACK, EVOLVE, COUNT, YES_NO, SPECIAL_CONDITION = range(11)

# --- Runtime data built from the engine itself (cardId -> CardData, attackId -> Attack). ---
CARD = {}
ATK = {}


def _init_db():
    global CARD, ATK
    try:
        if all_card_data:
            CARD = {c.cardId: c for c in all_card_data()}
    except Exception:
        CARD = {}
    try:
        if all_attack:
            ATK = {a.attackId: a for a in all_attack()}
    except Exception:
        ATK = {}


_init_db()


def read_deck_csv():
    """Return the 60 card IDs of our deck (bundled deck.csv)."""
    path = "deck.csv"
    if not os.path.exists(path):
        path = "/kaggle_simulations/agent/deck.csv"
    with open(path) as f:
        lines = [x.strip() for x in f.read().split("\n") if x.strip()]
    return [int(lines[i]) for i in range(60)]


# --------------------------------------------------------------------------- helpers

def _g(o, name, default=None):
    return getattr(o, name, default) if o is not None else default


def _my_active(state):
    try:
        yi = state.yourIndex
        act = state.players[yi].active
        return act[0] if act else None
    except Exception:
        return None


def _opp_active(state):
    try:
        yi = state.yourIndex
        act = state.players[1 - yi].active
        return act[0] if act else None
    except Exception:
        return None


def _bench_count(state):
    try:
        return len(state.players[state.yourIndex].bench or [])
    except Exception:
        return 0


def _side_discard(state, idx):
    """The discard pile (list of Cards) for player `idx`, or None. Discard is public (INTERFACE.md)."""
    try:
        return state.players[idx].discard
    except Exception:
        return None


_ETYPE = {"w": 3, "r": 2, "g": 1, "p": 5, "d": 7, "l": 4, "f": 6, "m": 8, "c": 0}  # energy {token} -> CardData.energyType


def _count_basic_energy(cards, letter):
    """Count Basic {letter} Energy cards in a list (e.g. a discard pile). Name-based primary (matches the
    codebase's runtime classification and naturally excludes a same-type Pokemon); energyType fallback for
    robustness — the engine is Linux-only so this can't be exercised here, and a silent miss wastes a slot."""
    if not cards:
        return 0
    token = "{" + letter + "}"
    want = _ETYPE.get(letter)
    n = 0
    for card in cards:
        c = CARD.get(_g(card, "id"))
        if c is None:
            continue
        nm = (getattr(c, "name", "") or "").lower()
        by_name = "energy" in nm and token in nm
        # fallback: an energy card carries the type but has no attacks / no HP (a Pokemon of the type does)
        by_type = (want is not None and getattr(c, "energyType", None) == want
                   and not (getattr(c, "attacks", None) or []) and int(getattr(c, "hp", 0) or 0) == 0)
        if by_name or by_type:
            n += 1
    return n


def _conditional_damage(txt, attacker, defender, discard=None):
    """Best-effort TRUE bonus damage from an attack's effect text — the base-damage-only blind spot that
    made us misread scaling attacks (e.g. an opponent's Psychic that scales with Energy on OUR Active:
    base 10 we read as 20, real ~320). Engine ATK.text only; off-engine ATK is empty -> 0 (safe/unchanged).
    Handles the common 'for each ...' patterns; coin-flip damage -> expected value. attacker/defender are
    the two Active Pokémon from the ATTACKING side's POV ('your opponent's Active' = defender). The fully
    general fix is the engine 1-ply (search_step, next) — this covers the high-value scaling patterns now."""
    if not txt:
        return 0
    t = txt.lower()
    def energy(pk):
        return len(getattr(pk, "energyCards", []) or []) if pk is not None else 0
    def counters(pk):
        if pk is None:
            return 0
        mh = int(getattr(pk, "maxHp", 0) or 0); hp = int(getattr(pk, "hp", 0) or 0)
        return max(0, mh - hp) // 10
    bonus = 0
    for m in re.finditer(r"(\d+)\s*(?:more\s+)?damage for each ([^.]+)", t):
        n = int(m.group(1)); what = m.group(2)
        if "energy attached to your opponent" in what or "energy attached to the defending" in what:
            bonus += n * energy(defender)
        elif "energy attached to both" in what:
            bonus += n * (energy(attacker) + energy(defender))
        elif "energy attached to" in what:                       # ...your / this Pokémon
            tm = re.search(r"\{([wrgpdlfmc])\}\s*energy", what)   # typed ramp ("{W} Energy"): count only that type
            if tm:
                want = _ETYPE.get(tm.group(1))
                bonus += n * sum(1 for e in (getattr(attacker, "energies", []) or []) if e == want)
            else:
                bonus += n * energy(attacker)
        elif "in your discard" in what:                          # "{X} Energy card in your discard pile" (Kyogre
            tm = re.search(r"\{([wrgpdlfmc])\}", what)            # Riptide = 20× Basic {W} Energy in OUR discard).
            if tm and discard is not None:                       # un-sticks the Mega's secondary attacker.
                bonus += n * _count_basic_energy(discard, tm.group(1))
        elif "damage counter on your opponent" in what or "damage counter on the defending" in what:
            bonus += n * counters(defender)
        elif "damage counter on this" in what or "damage counter on your" in what:
            bonus += n * counters(attacker)
        elif "heads" in what:                                    # multi-coin "for each heads" -> expected value
            cm = re.search(r"flip (\d+) coin", t)
            bonus += n * (int(cm.group(1)) if cm else 1) // 2
        # benched / prize / ancient patterns: board-specific; left to the engine 1-ply (next lever).
        # NOTE: future-discard scaling (Hammer-lanche "100× per {W} discarded from the top 6") is unknowable
        # pre-execution — only the engine 1-ply (search_step) can read the Mega ex's MAIN weapon. (Part B.)
    # single-coin conditional ("If heads, this attack does N more damage") — not "for each", so the main
    # regex misses it (~15 cards). EV of one coin at +N = N/2. (Fixes UNDER-reading coin-KO threats.)
    for m in re.finditer(r"if heads, this attack does (\d+) more damage", t):
        bonus += int(m.group(1)) // 2
    return bonus


def _attack_value(state, attack_id):
    """(kos, effective_damage) for an attackId vs the opponent's Active. TRUE damage = base + conditional
    (scaling) from the attack text, then Weakness ×2 — fixing the old base-damage-only floor that misread
    scaling attacks. Returns (False, 0) when data is missing."""
    try:
        a = ATK.get(attack_id)
        if a is None:
            return (False, 0)
        base = int(getattr(a, "damage", 0) or 0)
        defender = _opp_active(state)
        attacker = _my_active(state)
        if defender is None:
            return (False, base)
        dmg = base + _conditional_damage(getattr(a, "text", "") or "", attacker, defender,
                                         _side_discard(state, state.yourIndex))
        eff = dmg
        try:
            dcard = CARD.get(defender.id)
            acard = CARD.get(attacker.id) if attacker is not None else None
            txt = (getattr(a, "text", "") or "").lower()
            if dcard is not None and acard is not None and "affected by weakness" not in txt:
                wk = getattr(dcard, "weakness", None)
                atype = getattr(acard, "energyType", None)
                if wk is not None and atype is not None and wk == atype:
                    eff = dmg * 2  # current ruleset Weakness ×2 (unless the attack ignores Weakness)
        except Exception:
            pass
        hp = int(getattr(defender, "hp", 0) or 0)
        return (hp > 0 and eff >= hp, eff)
    except Exception:
        return (False, 0)


# ----------------------------------------------------------------- threat awareness (v7)
# Grounded in the 152-game study (tools/study_game.py): the #1 loss cause is conceding 2-/3-prize KOs
# (losers gave up 59 three-prize KOs vs winners' 25). So: protect multi-prize attackers. Deck-agnostic —
# it reads the board in front of us, never guesses the opponent's deck.

def _prize_value(pk):
    """Prizes the opponent takes if this Pokémon is KO'd: Mega-ex 3, ex 2, else 1 (cg/api.py CardData)."""
    c = CARD.get(_g(pk, "id"))
    if c is None:
        return 1
    if getattr(c, "megaEx", False):
        return 3
    if getattr(c, "ex", False):
        return 2
    return 1


def _opt_prize_hp(state, opt):
    """(prize_value, hp) for the Pokémon an option references — an in-play body (current HP) or, at setup,
    a hand card (max HP). Used to avoid promoting a multi-prize liability into the Active spot."""
    try:
        pi = _g(opt, "playerIndex")
        area = _g(opt, "area")
        idx = int(_g(opt, "index", 0) or 0)
        pl = state.players[pi if pi is not None else state.yourIndex]
        pk = None
        if area == 4:                                  # ACTIVE
            pk = pl.active[0] if pl.active else None
        elif area == 5:                                # BENCH
            b = pl.bench or []
            pk = b[idx] if 0 <= idx < len(b) else None
        if pk is not None:
            return (_prize_value(pk), int(_g(pk, "hp", 0) or 0))
    except Exception:
        pass
    c = CARD.get(_g(opt, "cardId"))                     # fall back to the card (e.g. setup from hand)
    if c is not None:
        pv = 3 if getattr(c, "megaEx", False) else (2 if getattr(c, "ex", False) else 1)
        return (pv, int(getattr(c, "hp", 0) or 0))
    return (1, 0)


def _opp_max_dmg(state, horizon):
    """(max_dmg, my_hp): the most damage the opponent's Active can deal to ours given `horizon` extra
    Energy attaches, damage ×2 on our Weakness. Reads their card's attacks (CardData.attacks); Energy
    matched by COUNT only (most decks run matching energy) — overestimates threat, the safe side for
    defence. horizon=1 = immediate next turn; 2 = one turn of warning (v7.1 retreats earlier)."""
    ma = _my_active(state)
    oa = _opp_active(state)
    if ma is None or oa is None:
        return (0, 0)
    my_hp = int(_g(ma, "hp", 0) or 0)
    ocard = CARD.get(_g(oa, "id"))
    if ocard is None:
        return (0, my_hp)
    avail = len(_g(oa, "energies", []) or []) + horizon
    macard = CARD.get(_g(ma, "id"))
    my_weak = getattr(macard, "weakness", None) if macard else None
    opp_type = getattr(ocard, "energyType", None)
    best = 0
    for aid in (getattr(ocard, "attacks", []) or []):
        atk = ATK.get(aid)
        if atk is None:
            continue
        if len(getattr(atk, "energies", []) or []) > avail:
            continue
        # TRUE damage = base + conditional/scaling (from the opp's POV: attacker=their Active oa,
        # defender=our Active ma). This is the Alakazam-class fix: a Psychic that scales with energy on
        # OUR Active now reads ~320, not 20 — so the threat-retreat actually fires against it.
        otxt = (getattr(atk, "text", "") or "").lower()
        dmg = int(getattr(atk, "damage", 0) or 0) + _conditional_damage(otxt, oa, ma,
                                                                        _side_discard(state, 1 - state.yourIndex))
        if my_weak is not None and opp_type is not None and my_weak == opp_type \
                and "affected by weakness" not in otxt:
            dmg *= 2
        best = max(best, dmg)
    return (best, my_hp)


def _i_have_ko(state, opts):
    """True if a listed ATTACK option KOs the opponent's Active this turn (engine lists only affordable attacks)."""
    for o in opts:
        if _g(o, "type") == OT.ATTACK and _attack_value(state, _g(o, "attackId"))[0]:
            return True
    return False


def _should_retreat_to_save(state, opts):
    """v7 (the ~638 sweet spot): retreat our multi-prize Active ONLY when the opponent can KO it NEXT turn
    AND we have no KO of our own — let a 1-prize body take the hit. SURGICAL: v7.1's wider/earlier retreat
    (2-turn horizon + retreat-when-damaged) over-defended → passivity → 545, so we reverted it.
    RETREAT being a legal option already implies a bench body and a payable retreat cost."""
    ma = _my_active(state)
    if ma is None or _prize_value(ma) < 2:              # only worth it for ex/Mega liabilities
        return False
    if _i_have_ko(state, opts):                         # we can take a prize NOW — attack, don't flee
        return False
    # loa:shortcut: only flee an UNDEVELOPED multi-prizer (<=1 energy). v12's fixed threat-read now SEES
    # scaling threats across the whole meta, so an unguarded retreat fires constantly on a developed Mega
    # (energy-scaling threats peak exactly when it's developed) -> v7.1/545 passivity. A developed attacker
    # is our win condition: stand and trade, don't flee into a 1-prize body that also dies. Fleeing an
    # undeveloped Mega (not attacking anyway) is a near-free 3-prize save. Ceiling: under-defends a developed
    # ex vs a NON-scaling KO — right for THIS deck (Mega=win-con); relax to >2 / gate on deck if we run a tank.
    if len(getattr(ma, "energyCards", []) or []) > 1:
        return False
    dmg, hp = _opp_max_dmg(state, 1)                    # immediate (next-turn) threat only
    return dmg >= hp


# Name-based card classification (CardData has NO trainer effect text at runtime — only name). Covers
# common draw supporters / search items + our deck's Lillie's / Mega Signal / Cyrano / Poké Pad.
_DRAW_WORDS = ("research", "determination", "iono", "marnie", "cynthia", "colress", "hop", "judge", "shauna", "sonia")
_SEARCH_WORDS = ("ball", "signal", "cyrano", "communication", "nest", "candy", "search", "capturing", "circhester", "pad")
_HEAL_WORDS = ("cook", "ice cream", "potion", "cake", "nurse")  # HP-heal trainers (this deck: Cook 70, Jumbo Ice Cream 80)


def _play_kind(state, opt):
    """Classify a PLAY option's card (our hand is visible) as a hand-refresh 'draw', a 'search', or ''."""
    try:
        hand = state.players[state.yourIndex].hand or []
        idx = _g(opt, "index", None)
        if idx is None or not (0 <= idx < len(hand)):
            return ""
        c = CARD.get(_g(hand[idx], "id"))
        nm = (getattr(c, "name", "") or "").lower() if c is not None else ""
    except Exception:
        return ""
    if any(w in nm for w in _DRAW_WORDS):
        return "draw"
    if any(w in nm for w in _SEARCH_WORDS):
        return "search"
    return ""


def _heal_min_energy(state, opt):
    """If a PLAY option is an HP-heal trainer, the energy its Active must have for the heal to do anything
    (Jumbo Ice Cream heals only at 3+ energy; Cook/Potion = 0); else None. Name-based — runtime CardData has
    no trainer effect text (same constraint as _play_kind). Jumbo silently no-ops below 3 energy, so the
    score must not waste it there."""
    try:
        hand = state.players[state.yourIndex].hand or []
        idx = _g(opt, "index", None)
        if idx is None or not (0 <= idx < len(hand)):
            return None
        c = CARD.get(_g(hand[idx], "id"))
        nm = (getattr(c, "name", "") or "").lower() if c is not None else ""
    except Exception:
        return None
    if not any(w in nm for w in _HEAL_WORDS):
        return None
    return 3 if "ice cream" in nm else 0


def _opt_pokemon(state, opt):
    """The Pokémon (any player) a CARD option references, or None."""
    try:
        pi = _g(opt, "playerIndex")
        if pi is None:
            return None
        area = _g(opt, "area"); idx = int(_g(opt, "index", 0) or 0)
        pl = state.players[pi]
        if area == 4:                                   # ACTIVE
            return pl.active[0] if pl.active else None
        if area == 5:                                   # BENCH
            b = pl.bench or []
            return b[idx] if 0 <= idx < len(b) else None
    except Exception:
        pass
    return None


def _our_best_dmg_vs(state, target):
    """Estimate our Active's best attack damage vs a given target (×2 on the target's Weakness)."""
    ma = _my_active(state)
    if ma is None or target is None:
        return 0
    acard = CARD.get(_g(ma, "id")); tcard = CARD.get(_g(target, "id"))
    if acard is None:
        return 0
    atype = getattr(acard, "energyType", None)
    tweak = getattr(tcard, "weakness", None) if tcard else None
    best = 0
    for aid in (getattr(acard, "attacks", []) or []):
        atk = ATK.get(aid)
        if atk is None:
            continue
        dmg = int(getattr(atk, "damage", 0) or 0)
        if tweak is not None and atype is not None and tweak == atype:
            dmg *= 2
        best = max(best, dmg)
    return best


def _boss_target(state, opts):
    """Pick which OPPONENT Pokémon to drag up (Boss's Orders / gust / snipe): one we can KO this turn for
    the most prizes; else the highest-prize, most-developed target. Beats the default 'cheapest' logic,
    which would gust their weakest Pokémon — the opposite of what gust is for."""
    best_i, best_key = None, None
    for i, o in enumerate(opts):
        pk = _opt_pokemon(state, o)
        if pk is None:
            continue
        hp = int(_g(pk, "hp", 0) or 0)
        pv = _prize_value(pk)
        energy = len(getattr(pk, "energyCards", []) or [])
        can_ko = 1 if (hp > 0 and _our_best_dmg_vs(state, pk) >= hp) else 0
        key = (can_ko, can_ko * pv, pv, energy, -hp)    # KO-able > high-prize > developed > low-HP
        if best_key is None or key > best_key:
            best_key, best_i = key, i
    return [best_i] if best_i is not None else None


def _self_damage(attack_id):
    """Recoil — damage an attack deals to its own user, parsed from the attack text (0 if none)."""
    a = ATK.get(attack_id)
    if a is None:
        return 0
    txt = (getattr(a, "text", "") or "").lower()
    m = re.search(r"(\d+)\s*damage to (?:itself|this pok)", txt)
    return int(m.group(1)) if m else 0


def _main_score(state, opt):
    """Priority for a MAIN-phase option — v10 = v7 threat-defense + v8 sequencing, CO-DESIGNED to the Mega
    deck. Order: take a KO > draw (max info) > search (find pieces) > EVOLVE the Mega online (raised for
    THIS deck — bricking was our #1 loss cause, 50% of v7's games) > develop bench > ability > ATTACH
    energy (the last irreversible commit, but above any attack so we never skip it) > attack > end.
    Threat-retreat / safe-promotion live in _policy (the v7 layer)."""
    t = _g(opt, "type")
    if t == OT.ATTACK:
        kos, eff = _attack_value(state, _g(opt, "attackId"))
        if kos:
            return 90000 + eff                              # take the prize
        ma = _my_active(state)                              # recoil safety: don't suicide for no prize
        sd = _self_damage(_g(opt, "attackId"))
        if sd > 0 and ma is not None and sd >= int(_g(ma, "hp", 0) or 0):
            return 30                                       # this attack KOs our OWN Active — heal/develop instead
        return 350 + min(eff, 99)                           # else attack is near-last
    if t == OT.PLAY:
        hmin = _heal_min_energy(state, opt)                  # co-design: heal IS this deck's engine (Wild Press
        if hmin is not None:                                 # recoils 70/turn; Cook/Jumbo offset it).
            ma = _my_active(state)
            ma_e = len(getattr(ma, "energyCards", []) or []) if ma else 0
            if ma_e < hmin:
                return 100                                   # Jumbo no-ops below 3 energy — don't waste it
            dmg_on_me = (int(getattr(ma, "maxHp", 0) or 0) - int(_g(ma, "hp", 0) or 0)) if ma else 0
            if dmg_on_me <= 0:
                return 50                                    # full HP — never waste a heal
            opp, my_hp = _opp_max_dmg(state, 1)
            # loa:shortcut: assume a ~70-80 heal (Cook 70 / Jumbo 80). Fire the urgent tier ONLY for a
            # SAVABLE lethal (heal converts the KO into a survive). _opp_max_dmg OVER-reads threat, so an
            # unbounded `opp >= my_hp` over-fired 88000 on phantom/overkill hits, wasting the supporter.
            if my_hp <= opp < my_hp + 80:
                return 88000                                 # heal to SURVIVE — beats all but taking our own KO
            return 740                                       # damaged but safe — clear recoil before it stacks
        b = _bench_count(state)
        if b == 0:
            return 800                                       # never sit on an empty Bench (instant-loss guard)
        kind = _play_kind(state, opt)
        if kind == "draw":
            return 790                                       # draw FIRST — act on maximum information
        if kind == "search":
            return 770                                       # search AFTER draw (don't shuffle away a searched card)
        return 760 if b < 4 else (700 if b < 5 else 100)     # develop the bench
    if t == OT.EVOLVE:
        return 765         # co-design: evolve the Mega ASAP (above bench) — bricking was the #1 loss cause
    if t == OT.ABILITY:
        return 600         # use abilities (info/effects) before committing energy
    if t == OT.ATTACH:
        return 500         # COMMIT LAST: after develop/evolve/ability, but ABOVE any attack (<=449)
    if t == OT.RETREAT:
        return 150
    if t == OT.DISCARD:
        return 120
    if t == OT.END:
        return 1
    return 100


def _yes_no_index(sel, prefer_yes):
    yes = no = None
    for i, o in enumerate(sel.option):
        if _g(o, "type") == OT.YES:
            yes = i
        elif _g(o, "type") == OT.NO:
            no = i
    if prefer_yes and yes is not None:
        return [yes]
    if (not prefer_yes) and no is not None:
        return [no]
    return [0]


def _legalize(pick, sel):
    """Guarantee a valid selection: distinct indices in range, count in [minCount, maxCount]."""
    n = len(sel.option)
    lo = max(0, int(getattr(sel, "minCount", 0) or 0))
    hi = int(getattr(sel, "maxCount", lo) or lo)
    hi = min(hi, n)
    lo = min(lo, hi)
    clean = []
    if pick:
        for i in pick:
            if isinstance(i, int) and 0 <= i < n and i not in clean:
                clean.append(i)
    clean = clean[:hi]
    if len(clean) < lo:                       # top up with the first unused indices
        for i in range(n):
            if len(clean) >= lo:
                break
            if i not in clean:
                clean.append(i)
    return clean


# --------------------------------------------------------------------------- policy

def _policy(obs):
    sel = obs.select
    state = obs.current
    st = _g(sel, "type")
    ctx = _g(sel, "context")
    opts = sel.option

    # MAIN phase: first, defend a threatened multi-prize Active (the #1 loss cause); else pick the
    # single highest-priority action.
    if st == ST.MAIN:
        if _should_retreat_to_save(state, opts):
            ridx = next((i for i, o in enumerate(opts) if _g(o, "type") == OT.RETREAT), None)
            if ridx is not None:
                return [ridx]
        best = max(range(len(opts)), key=lambda i: _main_score(state, opts[i]))
        return [best]

    # Choosing which attack: KO first, then avoid self-KO recoil, then biggest effective hit.
    if st == ST.ATTACK:
        ma = _my_active(state); mhp = int(_g(ma, "hp", 0) or 0) if ma else 0
        def key(i):
            aid = _g(opts[i], "attackId")
            kos, eff = _attack_value(state, aid)
            safe = 0 if (mhp and _self_damage(aid) >= mhp) else 1   # demote attacks that KO our own Active
            return (1 if kos else 0, safe, eff)
        return [max(range(len(opts)), key=key)]

    # Yes/No prompts: beneficial defaults (go first to set up; take heads; activate good effects).
    if st == ST.YES_NO:
        prefer_yes = True   # IS_FIRST, MULLIGAN(redraw), ACTIVATE, COIN_HEAD, FIRST_EFFECT → yes
        return _yes_no_index(sel, prefer_yes)

    # Count prompts: usually "more is better" (draw more, place more damage counters on opponent).
    if st == ST.COUNT:
        def cval(o):
            return _g(o, "number", _g(o, "count", 0)) or 0
        return [max(range(len(opts)), key=lambda i: cval(opts[i]))]

    # Energy selection (attach/pay/discard): take the minimum required, first valid — let the engine
    # constrain. (v1: no fine Energy routing yet.)
    if st in (ST.ENERGY, ST.ATTACHED_CARD):
        return None  # → _legalize picks the first minCount

    # Boss's Orders / gust / snipe — when we're choosing among the OPPONENT'S Pokémon, drag up the BEST
    # target (one we can KO for the most prizes), not the cheapest. Detected by option owner = opponent.
    if st in (ST.CARD, ST.CARD_OR_ATTACHED_CARD) and opts:
        oppi = 1 - int(_g(state, "yourIndex", 0) or 0)
        if any(_g(o, "playerIndex") == oppi for o in opts):
            pick = _boss_target(state, opts)
            if pick is not None:
                return pick

    # Choosing who stands in OUR Active spot (setup / switch / after a KO): put up the SMALLEST prize
    # liability (a 1-prize wall), not an ex/Mega — keep multi-prizers safe on the Bench (study finding #4).
    if st in (ST.CARD, ST.CARD_OR_ATTACHED_CARD) and ctx in (1, 3, 4):  # SETUP_ACTIVE / SWITCH / TO_ACTIVE
        def ascore(o):
            pv, hp = _opt_prize_hp(state, o)
            return (-pv, hp)                            # lowest prize value first, then most HP
        order = sorted(range(len(opts)), key=lambda i: ascore(opts[i]), reverse=True)
        lo = max(0, int(_g(sel, "minCount", 0) or 0))
        hi = min(int(_g(sel, "maxCount", lo) or lo), len(opts))
        k = lo if lo > 0 else min(1, hi)
        return order[:k] if k > 0 else []

    # Card selection (search / draw / setup / discard targets): light preference, else first valid.
    if st in (ST.CARD, ST.CARD_OR_ATTACHED_CARD, ST.EVOLVE):
        # Prefer our own win-condition pieces when searching to hand / putting into play.
        def cscore(o):
            cid = _g(o, "cardId")
            c = CARD.get(cid) if cid is not None else None
            if c is None:
                return 0
            s = 0
            if getattr(c, "ex", False) or getattr(c, "megaEx", False):
                s += 30
            if getattr(c, "basic", False) or getattr(c, "stage1", False) or getattr(c, "stage2", False):
                s += 10
            return s
        order = sorted(range(len(opts)), key=lambda i: cscore(opts[i]), reverse=True)
        lo = max(0, int(_g(sel, "minCount", 0) or 0))
        hi = min(int(_g(sel, "maxCount", lo) or lo), len(opts))
        k = lo if lo > 0 else min(1, hi)        # take the minimum required (or 1 if optional-but-useful)
        return order[:k] if k > 0 else []

    return None  # everything else → safe default in _legalize


def agent(obs_dict):
    """Entry point. Returns the deck at game start, else a legal list of option indices."""
    if to_observation_class is None:
        # cg unavailable (shouldn't happen in the sandbox) — minimal safe response.
        sel = (obs_dict or {}).get("select")
        if not sel:
            return read_deck_csv()
        n = len(sel.get("option", []) or [])
        lo = max(0, int(sel.get("minCount", 0) or 0))
        return list(range(min(lo if lo else 1, n)))
    obs = to_observation_class(obs_dict)
    if obs.select is None:
        return read_deck_csv()
    try:
        pick = _policy(obs)
    except Exception:
        pick = None
    return _legalize(pick, obs.select)
