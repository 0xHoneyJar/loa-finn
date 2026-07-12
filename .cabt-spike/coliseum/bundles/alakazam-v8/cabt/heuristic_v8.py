"""heuristic_v8 — the "Powerful Hand" Alakazam-aware pilot (a FOCUSED extension of heuristic_v7).

The converged Alakazam deck's win-condition is **Powerful Hand**: Alakazam's attack deals damage that
SCALES WITH HAND SIZE (~20 per card; a full 8-card hand ≈ 160). The optimal line is **HOARD cards, then
swing with a full hand**. v4/v7 do the OPPOSITE — they play the hand out (draw > search > develop, attack
LAST), so they swing Powerful Hand on a 2-3 card hand for 40-60. That structural anti-synergy is the single
reason a flat pilot collapses this deck. v8 fixes exactly that, and nothing else:

  1. POWERFUL-HAND MODE — when our Active is the hand-scaling attacker (detected by ATTACK-TEXT, never a
     hardcoded id) and the attack is AFFORDABLE: at hand-size >= N (=6) SWING (suppress draw/search/develop
     and take Powerful Hand); below N we HOARD with our OWN scorer — we do NOT delegate hand-building to v7.
  2. STAGE-2 PRIORITY — favor evolving the Abra→Kadabra→Alakazam line. The win-con Stage-2 (Alakazam) is
     identified by ATTACK-TEXT (the card being evolved into is itself a hand-scaler); Rare Candy is identified
     by card NAME. BOTH fire against the real engine — see the NAME-ACCESS note below for how NAME detection
     sources the already-loaded card DB without touching the frozen cards.py.
  3. DEFER TO v7 — every other situation (non-Alakazam Active, no hand-scaling attack, card-select, retreat,
     attack-phase below N, all other select types) calls through to ``_v7.choose`` UNCHANGED. We reuse v7's
     helpers/constants (``_my_active``, ``_energy_count``, ``_should_retreat``, ``_main_score``, the
     OptionType/SelectType constants) rather than duplicating them.
  4. DEFENSIVE / NEVER CRASH — any missing obs field, unknown card, or off-engine data falls through to v7
     (which itself degrades to v4-style lowest-index legal). Identical ``choose(obs, deck)`` signature +
     legality contract as v7.

NAME-ACCESS (the spec's ``cards.card(id).name`` wrapper does not exist — but NAME detection is still LIVE):
  ``src/cabt/cards.py`` exposes NO public ``card()`` accessor (verified by grep), and SCOPE freezes cards.py,
  so the spec's literal ``cards.card(id).name`` call is unavailable. The card DB is nonetheless ALREADY loaded
  into the module global ``cards._CARDS`` (``{cardId: CardData}``, populated by ``cards._ensure()``), and those
  CardData objects carry the very ``.name`` field heuristic_v7's ``_hand_card_name`` assumes. Reading that
  global is READ-ONLY — it does NOT modify cards.py — so it stays within SCOPE. ``_card_name`` therefore sources
  the name straight from ``cards._CARDS``, making Rule 2's Rare-Candy mechanic LIVE against the engine (and
  letting Rule 1's hoard scorer tell draw/search trainers from board-develop). It degrades to "" off-engine, so
  it never crashes. The only tradeoff is reaching a module-private global; that is the cost of cards.py being
  frozen, and is preferred over leaving an explicitly-required mechanic inert. (Note: v7's own ``_hand_card_name``
  routes through the non-existent ``cards.card`` → "" so v7's name reads ARE dead — which is exactly why Rule 1
  owns its hoard scorer rather than delegating to v7 below the swing threshold.) RECOMMENDED FOLLOW-UP (out of
  this SCOPE): add a public read-only ``card_name(id)`` accessor to cards.py so this rule and v7 can both drop
  the private-global reach.
"""
from __future__ import annotations

import re

from . import cards as _cards
from . import heuristic_v7 as _v7

# Swing once the hand is this big (Powerful Hand ≈ 20×hand ⇒ 6 cards ≈ 120, enough to KO most bodies).
_FULL_HAND = 6

# Whether the card DB exposes names. The loaded ``cards._CARDS`` global carries the same ``.name`` v7 relies on,
# so NAME detection is LIVE (True in the engine). The capability check still degrades gracefully: were the global
# ever absent, every NAME-based feature (Rare Candy) gates off rather than crashing. The ATTACK-TEXT path (the
# win-con fix + win-con-evolve priority) is independent of names and is always active.
_CARDS_HAS_NAME = hasattr(_cards, "_CARDS")

# The evolution line + skip-trainer this deck rides on, by NAME (only consulted when _CARDS_HAS_NAME is True).
_RARE_CANDY = "rare candy"
_BASIC = "abra"        # Rare Candy's jump-from Basic
_STAGE2 = "alakazam"   # the hand-scaling Stage-2 win-con

# Hand-scaling attack signature: a damage-scaling cue ("for each" / "number of" / "times the number of")
# followed, within the same sentence, by "card(s) … in (your/their) hand". Requiring the scaling cue avoids
# false positives like "draw cards until you have 6 cards in your hand". attack_text is already lowercased.
_HAND_SCALE_RE = re.compile(
    r"(?:for each|number of|times the number of)[^.]*?card[^.]*?in (?:your |their )?hand"
)


# --------------------------------------------------------------------------- hand-scaling detection (engine)

def _scaling_attack_id(card_id):
    """The attackId on ``card_id`` whose effect text scales with hand size, or None. Pure ATTACK-TEXT —
    works against the closed engine (``attack_ids``/``attack_text`` are live; no name needed)."""
    if card_id is None:
        return None
    try:
        for aid in _cards.attack_ids(card_id):
            if _HAND_SCALE_RE.search(_cards.attack_text(aid)):
                return aid
    except Exception:
        return None
    return None


def _hand_scaling_attack(pk):
    """The hand-scaling attackId on an in-play Pokémon ``pk``, or None ⇒ pk is NOT the Powerful-Hand attacker
    ⇒ caller defers to v7."""
    return _scaling_attack_id(pk.get("id")) if pk else None


def _is_hand_scaler(card_id) -> bool:
    """True when a card (e.g. an evolution card in hand) is itself the hand-scaling win-con (Alakazam)."""
    return _scaling_attack_id(card_id) is not None


# --------------------------------------------------------------------------- obs-dict reads (defensive)

def _hand_size(cur) -> int:
    try:
        return len(cur["players"][_v7._you(cur)].get("hand") or [])
    except Exception:
        return 0


def _bench_size(cur) -> int:
    try:
        return len(cur["players"][_v7._you(cur)].get("bench") or [])
    except Exception:
        return 0


def _hand_card_id(cur, opt):
    """The card-id an EVOLVE/PLAY option plays out of hand (via opt['index'], the same hand-index shape v7's
    ``_hand_card_name`` uses). None on any malformed shape."""
    try:
        hand = cur["players"][_v7._you(cur)].get("hand") or []
        idx = opt.get("index")
        if idx is None or not (0 <= idx < len(hand)):
            return None
        return hand[idx].get("id")
    except Exception:
        return None


def _affordable(ma, attack_id) -> bool:
    try:
        return _cards.attack_cost(attack_id) <= _v7._energy_count(ma)
    except Exception:
        return False


# --------------------------------------------------------------------------- NAME-based (live via cards._CARDS)

def _card_name(card_id) -> str:
    """Lowercased card name by id, sourced from the already-loaded ``cards._CARDS`` module global (the spec's
    ``cards.card(id)`` wrapper does not exist; the global holds the same ``.name``-bearing CardData). READ-ONLY —
    never mutates the frozen cards.py. Degrades to "" off-engine / on any unknown id, so it never crashes."""
    try:
        _cards._ensure()  # idempotent; guarantees the DB is loaded (no-op once any public accessor has run)
        c = (getattr(_cards, "_CARDS", None) or {}).get(card_id)
        return (getattr(c, "name", "") or "").lower() if c is not None else ""
    except Exception:
        return ""


def _hand_names(cur) -> list[str]:
    try:
        hand = cur["players"][_v7._you(cur)].get("hand") or []
        return [_card_name(h.get("id")) for h in hand if h]
    except Exception:
        return []


def _inplay_names(cur) -> list[str]:
    """Lowercased names of our Active + Bench Pokémon."""
    out: list[str] = []
    try:
        me = cur["players"][_v7._you(cur)]
        for a in (me.get("active") or []):
            if a:
                out.append(_card_name(a.get("id")))
        for b in (me.get("bench") or []):
            if b:
                out.append(_card_name(b.get("id")))
    except Exception:
        pass
    return out


def _play_kind(cur, opt) -> str:
    """Classify a PLAY option by card NAME (live via ``_card_name``) into 'draw' | 'search' | 'develop',
    reusing v7's ``_DRAW_WORDS``/``_SEARCH_WORDS`` so both pilots share one trainer taxonomy. RULE 1's hoard
    scorer uses this to rank net-hand-positive trainers above board-develop below the swing threshold."""
    nm = _card_name(_hand_card_id(cur, opt))
    if any(w in nm for w in _v7._DRAW_WORDS):
        return "draw"
    if any(w in nm for w in _v7._SEARCH_WORDS):
        return "search"
    return "develop"


def _is_rare_candy(cur, opt) -> bool:
    """True when a PLAY option plays Rare Candy out of hand — by NAME, live via ``_card_name``/``cards._CARDS``
    (NOT v7's ``_hand_card_name``, whose ``cards.card(...)`` call raises and is caught → "" off the wrapper)."""
    return _RARE_CANDY in _card_name(_hand_card_id(cur, opt))


def _rare_candy_ready(cur) -> bool:
    """Rare Candy is worth playing only when it can skip a Basic straight to Alakazam: a Stage-2 (Alakazam)
    in hand AND its Basic (Abra) already in play."""
    return any(_STAGE2 in nm for nm in _hand_names(cur)) and any(_BASIC in nm for nm in _inplay_names(cur))


# --------------------------------------------------------------------------- RULE 1: hoard / swing (own scorer)

def _powerful_main(cur, opts, ph_aid, affordable, hand_n, bench_n):
    """MAIN-phase pick while our Active IS the hand-scaler. Returns option indices, or None to defer to v7.

    When affordable AND hand_n >= N: SWING — ANY ATTACK option scores top (so we take Powerful Hand directly,
    OR enter a two-step attack flow whose submenu the ST_ATTACK branch then resolves to ph_aid). Below N we
    HOARD with our OWN scoring — we do NOT delegate to v7, because v7's draw-first ranking routes through its
    own ``_hand_card_name`` (which calls the non-existent ``cards.card`` → "" ⇒ draw/search go unrecognised), so
    below N v7 would EVOLVE/over-ATTACH the hand away (the very dump v8 exists to stop).

    BUILD hand size below the threshold: draw/search trainers (net hand-positive — the spec's "draw/search are
    fine") stay TOP, while board-develop — which SPENDS a card — is demoted below END alongside the other dumps.
    The draw/search-vs-develop split needs the card NAME; that is now LIVE via ``_play_kind``/``cards._CARDS``
    (see the NAME-ACCESS note), resolving the residual the prior round escalated. We demote the dumps below END:
    further EVOLVE (we are already the win-con Active), surplus ATTACH once affordable, premature ATTACK, and
    board-develop. ATTACH stays TOP while NOT yet affordable (it ENABLES the swing).
    """
    if _v7._should_retreat(cur, opts):
        return None  # let v7 own the defensive multi-prizer retreat (never fires for a 1-prize Alakazam)
    swing = affordable and hand_n >= _FULL_HAND
    n = len(opts)

    def score(i: int) -> float:
        o = opts[i]
        t = o.get("type")
        if t == _v7.ATTACK:
            if swing:
                # SWING: exact Powerful Hand first, else any ATTACK option (enter the attack flow → submenu).
                return 100000.0 if o.get("attackId") == ph_aid else 99000.0
            return 20.0                                   # below END — do NOT attack prematurely
        if t == _v7.PLAY:
            if bench_n == 0:
                return 800.0                              # empty-bench instant-loss guard (v7's)
            kind = _play_kind(cur, o)
            if kind == "draw":
                return 790.0                              # draw refuels the hand toward the swing
            if kind == "search":
                return 770.0                              # search finds the line / thins the deck
            return 34.0                                   # develop SPENDS a card → below END (a hoard dump)
        if t == _v7.ATTACH:
            return 790.0 if not affordable else 40.0      # need energy to enable the swing; once affordable, a dump
        if t == _v7.ABILITY:
            return 600.0
        if t == _v7.END:
            return 500.0                                  # the HOARD floor — beats every dump + premature attack
        if t == _v7.EVOLVE:
            return 35.0                                   # already the win-con Active → further evolve dumps a card
        if t == _v7.RETREAT:
            return 30.0
        if t == _v7.DISCARD:
            return 25.0
        return 100.0                                      # unknowns: below END, above the demoted dumps

    return [max(range(n), key=score)]


# --------------------------------------------------------------------------- RULE 2: Stage-2 setup overlay

def _is_wincon_evolve(cur, opt) -> bool:
    """True when an EVOLVE option plays the hand-scaling Stage-2 (Alakazam) out of hand — by ATTACK-TEXT, so it
    fires against the real engine. (Kadabra, the Stage-1, has no hand-scaling attack and so rides v7's generic
    EVOLVE priority; the line still advances Abra→Kadabra→Alakazam, with the Alakazam step boosted highest.)"""
    if opt.get("type") != _v7.EVOLVE:
        return False
    return _is_hand_scaler(_hand_card_id(cur, opt))


def _stage2_main(cur, opts):
    """MAIN-phase pick while our Active is NOT yet the hand-scaler (setup): v7's scorer plus two Stage-2
    overlays — favor the win-con evolution (ATTACK-TEXT) and play Rare Candy only with a real Stage-2 target
    (NAME, live via ``cards._CARDS``). Both fire against the engine. Returns None to let v7 own (e.g. retreat)."""
    if _v7._should_retreat(cur, opts):
        return None
    bench_n = _bench_size(cur)
    n = len(opts)

    def score(i: int) -> float:
        o = opts[i]
        base = float(_v7._main_score(cur, o, bench_n))
        if _is_wincon_evolve(cur, o):
            return max(base, 788.0)                       # bring the win-con online ahead of generic develop
        if _CARDS_HAS_NAME and _is_rare_candy(cur, o):
            # Skip to Alakazam only with a target in hand (below v7's draw=790 / empty-bench=800 guards so it
            # never overrides draw-for-info or the instant-loss guard); otherwise never burn it (above END only).
            return 785.0 if _rare_candy_ready(cur) else 2.0
        return base

    return [max(range(n), key=score)]


# --------------------------------------------------------------------------- policy

def choose(obs, deck):
    """Drop-in for heuristic.choose: same signature + legality contract as v7. Intercepts ONLY the spots where
    v7 is wrong for the Alakazam deck; defers wholesale to v7 otherwise. Never crashes / forfeits."""
    if obs is None:
        return []
    try:
        sel = obs.get("select")
    except Exception:
        return []
    if sel is None or not (sel.get("option") or []):
        return _v7.choose(obs, deck)

    opts = sel.get("option") or []
    cur = obs.get("current")
    st = sel.get("type")
    maxc = int(sel.get("maxCount", 1) or 1)

    try:
        if cur is not None:
            ma = _v7._my_active(cur)
            ph_aid = _hand_scaling_attack(ma)

            # ---- RULE 1: POWERFUL-HAND MODE — our Active IS the hand-scaling attacker ----
            if ph_aid is not None:
                hand_n = _hand_size(cur)

                if st == _v7.ST_MAIN and maxc == 1:
                    affordable = _affordable(ma, ph_aid)
                    bench_n = _bench_size(cur)
                    pick = _powerful_main(cur, opts, ph_aid, affordable, hand_n, bench_n)
                    if pick is not None:
                        return pick
                    return _v7.choose(obs, deck)

                if st == _v7.ST_ATTACK:
                    # Attack-selection phase: with a full hand take Powerful Hand (not a low-base chip attack
                    # that v7's base-damage read — blind to the text scaling — would otherwise prefer).
                    if hand_n >= _FULL_HAND:
                        for i, o in enumerate(opts):
                            if o.get("attackId") == ph_aid:
                                return [i]
                    return _v7.choose(obs, deck)

                # Any other phase while the attacker is active → v7.
                return _v7.choose(obs, deck)

            # ---- RULE 2: STAGE-2 PRIORITY — Active not yet the attacker (setup) ----
            if st == _v7.ST_MAIN and maxc == 1:
                pick = _stage2_main(cur, opts)
                if pick is not None:
                    return pick
    except Exception:
        pass

    # ---- RULES 3 & 4: everything else → defer to v7 (which itself never crashes) ----
    return _v7.choose(obs, deck)
