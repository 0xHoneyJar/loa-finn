"""heuristic_v5 — the structurally-new scorer (GYGAX spec §A).

The live v4 (`heuristic.py`) scores legal options by **option TYPE only** (`heuristic.py:35-44`): two PLAY
options score identically, two ATTACH options score identically. It is blind to *which* Pokémon, *which*
energy, *which* turn. `arena_results.json` is the autopsy — 13 priors variants all clustered at 0.5 on the
sample deck. **The priors VECTOR is a dead lever.** The lever is STRUCTURAL features that make `_score`
SEE the board.

v5 keeps `heuristic`'s `_BASE` as a tie-break prior and keeps the `+1000` lethal rule UNCHANGED, then adds
six additive, interpretable, game-theoretic terms (§A.2-A.7). Each term:
  1. reads a real obs/CardData field (cited inline against `.cabt-spike/dl/cg/api.py`),
  2. scores in a bounded, named-`W_*` range so §B (field_eval) can tune *weights* — but the *terms* are
     the lever, deck-agnostic by construction (prize math, one-attach-per-turn economy transfer across
     decks; a tuned weight does not — see §B.4 anti-overfit).

Drop-in A/B-able: `choose(obs, deck)` has the SAME signature as `heuristic.choose` (`heuristic.py:47`).
NEVER crashes: any term that hits unexpected obs shape degrades to 0 (the accessors in cards_v5 already
degrade-to-zero; the per-term try/except here is the belt to that suspenders).
"""
from __future__ import annotations

from . import cards as _cards
from . import cards_v5 as _c5

# cg.api OptionType values (api.py:120-188) — same constants as heuristic.py:15.
PLAY, ATTACH, EVOLVE, ABILITY, DISCARD, RETREAT, ATTACK, END = 7, 8, 9, 10, 11, 12, 13, 14

# AreaType (api.py:11-23) — used to resolve an option's target Pokémon.
ACTIVE_AREA, BENCH_AREA = 4, 5

# Unchanged tie-break prior (identical to heuristic.py:20 — the committed champion _BASE).
_BASE = {ATTACH: 50.0, EVOLVE: 48.0, PLAY: 45.0, ABILITY: 42.0, ATTACK: 25.0, RETREAT: 10.0, DISCARD: 6.0, END: 2.0}

LETHAL = 1000.0  # UNCHANGED (heuristic.py:42-43) — lethal dominates everything (augury.py:74 prize signal).

# --- term weights (named so field_eval can tune; the TERMS are the lever, not these constants) ---
W_KO = 30.0    # A.2 prize-trade / KO math (in prize units, scaled below LETHAL)
W_DEV = 12.0   # A.3 bench width + evolution-line readiness
W_NRG = 14.0   # A.4 one-attach-per-turn energy economy
W_PIV = 16.0   # A.5 retreat / status pivot
W_ATK = 18.0   # A.6 earned-attack quality (non-lethal)
W_TMP = 6.0    # A.7 turn-phase tempo (tie-breaker, low weight by design)


# ----------------------------------------------------------------------------------------------------
# obs accessors — every field grounded against cg/api.py. Dict-shaped (agent passes obs as a dict).
# ----------------------------------------------------------------------------------------------------

def _you(cur) -> int:
    return int(cur.get("yourIndex", 0) or 0) if cur else 0


def _player(cur, idx):
    players = (cur or {}).get("players") or []
    return players[idx] if 0 <= idx < len(players) else None


def _active(player):
    """Active Pokémon dict or None (PlayerState.active is a list of size 0 or 1, api.py:352)."""
    if not player:
        return None
    act = player.get("active") or []
    return act[0] if act and act[0] else None


def _bench(player) -> list:
    return (player or {}).get("bench") or []


def _opt_target(cur, you, opt):
    """Resolve the Pokémon an ATTACH/EVOLVE/ABILITY option acts on, via Option.inPlayArea/inPlayIndex
    (api.py:157-164, 391-392). Returns the Pokemon dict (mine) or None. THIS target resolution is
    exactly what heuristic._score throws away (spec §A.0)."""
    me = _player(cur, you)
    if not me:
        return None
    area = opt.get("inPlayArea")
    idx = opt.get("inPlayIndex")
    if area == ACTIVE_AREA:
        return _active(me)
    if area == BENCH_AREA and idx is not None:
        bench = _bench(me)
        if 0 <= idx < len(bench):
            return bench[idx]
    return None


def _opp_active_hp(cur):
    """Opponent active hp (heuristic.py:23-32 logic, dict-shaped)."""
    opp = _player(cur, 1 - _you(cur))
    a = _active(opp)
    return a.get("hp") if a else None


# ----------------------------------------------------------------------------------------------------
# §A.2 — Prize-trade / KO math (the highest-value new term)
# ----------------------------------------------------------------------------------------------------

def ko_term(cur, you, opt) -> float:
    """Prize-equity of an ATTACK option (api.py:476-478 prize payouts; api.py:357 prize counts).

    - KO this turn (dmg >= opp hp): credit prizes_taken (normal 1 / ex 2 / megaEx 3) — `_c5.prize_value`.
    - Trade-down penalty: if MY active is itself an ex/megaEx and a normal return hit would KO it next
      turn, attacking-and-dying trades my 2-3 prize body for their 1 (spec §A.2). Subtract the liability
      gap. (Conservative proxy: only when I'm a higher prize-value body than what I'm taking.)
    - Setup-KO discount (×0.3): dmg doesn't KO now but brings them into range for next turn (spec §A.2 —
      1-ply threats are discounted, not full-credited; the card_aware regression lesson, augury.py:8-13).
    """
    if opt.get("type") != ATTACK or opt.get("attackId") is None:
        return 0.0
    dmg = _cards.attack_damage(opt["attackId"])
    if dmg <= 0:
        return 0.0
    opp = _player(cur, 1 - you)
    oa = _active(opp)
    if oa is None:
        return 0.0
    ohp = oa.get("hp") or 0
    me = _player(cur, you)
    ma = _active(me)

    score = 0.0
    if dmg >= ohp:
        # I KO their active — credit the prizes that KO yields.
        score += _c5.prize_value(oa.get("id"))
        # Trade-down: am I a fat body that dies on the obvious return? (spec §A.2 asymmetry penalty)
        if ma is not None:
            my_liability = _c5.prize_value(ma.get("id"))
            taken = _c5.prize_value(oa.get("id"))
            if my_liability > taken:
                # Will a plausible return hit KO me? Proxy: my current hp is low relative to maxHp.
                my_hp = ma.get("hp") or 0
                my_max = ma.get("maxHp") or 1
                if my_max and my_hp / my_max <= 0.5:
                    score -= (my_liability - taken) * 0.5  # discounted (return hit is not certain)
    else:
        # Not a KO now; is it a *setup* KO (chips them into next-turn range with a repeatable hit)?
        # Discounted threat: the opponent replies before my next swing (spec §A.2, ×0.3).
        if dmg >= ohp * 0.5:  # meaningful chip toward a 2-hit KO
            score += 0.3
    return score


# ----------------------------------------------------------------------------------------------------
# §A.3 — Bench development & evolution-line readiness
# ----------------------------------------------------------------------------------------------------

def development_term(cur, you, opt) -> float:
    """Bench-width ramp (diminishing) for PLAY-basic; evolution-line readiness for EVOLVE.

    Reads bench/benchMax (api.py:353-354), CardData.basic/stage1/stage2 (api.py:473-475), target
    Pokémon energies (api.py:345). Spec §A.3."""
    t = opt.get("type")
    me = _player(cur, you)
    if not me:
        return 0.0

    if t == PLAY:
        cid = opt.get("cardId")
        if cid is not None and _c5.is_basic(cid):
            bench = _bench(me)
            bmax = me.get("benchMax") or 5
            if bmax <= 0:
                return 0.0
            benched = len(bench)
            # Diminishing: first benched basics worth a lot (empty board loses — api.py:320 reason 3),
            # the last worth almost nothing. A flat prior over-develops (spec §A.3).
            return max(0.0, 1.0 - benched / float(bmax))
        return 0.0

    if t == EVOLVE:
        target = _opt_target(cur, you, opt)
        cid = opt.get("cardId")
        # stage2 completes a 3-card investment (heavier); stage1 lighter (spec §A.3).
        stage_weight = 1.0 if _c5.is_stage2(cid) else (0.6 if _c5.is_stage1(cid) else 0.4)
        if target is None:
            return stage_weight * 0.5  # can't see readiness -> half credit
        # Evolving an energized mon (active or powered bench) > a bare benchwarmer (readiness).
        energies = target.get("energies") or []
        readiness = 1.0 if energies else 0.4  # dead-evolve penalty for a no-energy line (spec §A.3)
        return stage_weight * readiness

    return 0.0


# ----------------------------------------------------------------------------------------------------
# §A.4 — Energy attachment economy (one attach per turn — the scarcest resource)
# ----------------------------------------------------------------------------------------------------

def energy_economy_term(cur, state, you, opt) -> float:
    """ATTACH that moves a Pokémon CLOSER to affording its attack scores high; type-correct beats
    mismatched; over-attach is wasted. Reads State.energyAttached (api.py:374), target energies
    (api.py:345), Attack.energies via cards_v5.attack_costs (api.py:490). Spec §A.4."""
    if opt.get("type") != ATTACH:
        return 0.0
    # If I've already used my manual attach this turn, the engine wouldn't offer it — but guard anyway.
    if state and state.get("energyAttached"):
        return 0.0
    target = _opt_target(cur, you, opt)
    if target is None:
        return 0.0
    tcid = target.get("id")
    have = list(target.get("energies") or [])
    atk_ids = []
    c = _c5._card(tcid)
    if c is not None:
        atk_ids = getattr(c, "attacks", None) or []
    if not atk_ids:
        return 0.2  # a Pokémon we can't price still benefits a little from energy (small, non-zero)

    # The attach adds ONE energy. Reward the best progress-toward-an-attack across this mon's attacks.
    # We measure marginal progress: progress with a generic added energy minus current progress.
    best_gain = 0.0
    over_attach = True
    for aid in atk_ids:
        cost_n = _c5.attack_cost_count(aid)
        if cost_n <= 0:
            continue
        cur_prog = _c5.energy_progress(have, aid)
        if cur_prog < 1.0:
            over_attach = False  # at least one attack still wants energy
        # Marginal: adding one more energy of a needed type. Approx as 1/cost_n step toward threshold.
        # Type-correct bonus folded in: if any unmet slot accepts a common color, count it stronger.
        step = 1.0 / cost_n
        reach = 1.0 if (cur_prog + step) >= 1.0 - 1e-9 else (cur_prog + step)
        best_gain = max(best_gain, reach - cur_prog)
    if over_attach:
        return 0.0  # all attacks already affordable -> attaching here is wasted economy (spec §A.4)
    # Active-priority under threat: if target is my only powered/relevant attacker, nudge up.
    me = _player(cur, you)
    ma = _active(me)
    active_bonus = 0.15 if (ma is not None and target is ma) else 0.0
    return min(1.0, best_gain + active_bonus)


# ----------------------------------------------------------------------------------------------------
# §A.5 — Retreat / pivot & status escape
# ----------------------------------------------------------------------------------------------------

def pivot_term(cur, you, opt) -> float:
    """RETREAT scores high to escape a dying or status-locked active when a healthier bench attacker
    exists; near-zero when it thrashes a good board. Reads status flags (api.py:360-364), active
    hp/maxHp, retreatCost (api.py:467) vs attached energies. Spec §A.5."""
    if opt.get("type") != RETREAT:
        return 0.0
    me = _player(cur, you)
    if not me:
        return 0.0
    ma = _active(me)
    if ma is None:
        return 0.0
    # Can I pay the retreat? (attached energies count vs retreatCost). If not affordable the engine
    # wouldn't offer it, but if it did, an unpayable retreat is worthless.
    rc = _c5.retreat_cost(ma.get("id"))
    have = len(ma.get("energies") or [])
    if rc > have:
        return 0.0

    score = 0.0
    # Status escape — a paralyzed/asleep/confused active is dead weight for a turn (spec §A.5).
    if me.get("paralyzed") or me.get("asleep"):
        score += 0.8
    if me.get("confused"):
        score += 0.4
    if me.get("poisoned") or me.get("burned"):
        score += 0.2
    # Escape a dying active when a fresher bench attacker is ready.
    my_hp = ma.get("hp") or 0
    my_max = ma.get("maxHp") or 1
    low = my_max and (my_hp / my_max) <= 0.4
    bench = _bench(me)
    healthier_ready = any(
        (b.get("hp") or 0) / max(1, (b.get("maxHp") or 1)) > (my_hp / max(1, my_max))
        and (b.get("energies"))
        for b in bench
    )
    if low and healthier_ready:
        score += 0.7
    # Anti-thrash: no bench to promote, or active is healthy & unafflicted -> retreat is a tempo sink.
    if not bench:
        return 0.0
    if score == 0.0:
        return -0.3  # needless retreat (spec §A.5 anti-thrash penalty)
    return min(1.0, score)


# ----------------------------------------------------------------------------------------------------
# §A.6 — Attack quality (affordable, efficient, not overkill) — for NON-lethal attacks
# ----------------------------------------------------------------------------------------------------

def attack_quality_term(cur, you, opt) -> float:
    """For ATTACK options that are NOT lethal (lethal already wins via A.1): weight damage by the
    FRACTION of opponent hp removed (not raw dmg), credit a CORRECT weakness match, penalize
    chipping into resistance / no progress. Reads attack_damage, attack type (CardData.energyType),
    opp weakness/resistance (api.py:470-471). Spec §A.6."""
    if opt.get("type") != ATTACK or opt.get("attackId") is None:
        return 0.0
    dmg = _cards.attack_damage(opt["attackId"])
    if dmg <= 0:
        return -0.2  # a 0-damage attack burns the turn (ATTACK ends the turn, heuristic.py:17)
    opp = _player(cur, 1 - you)
    oa = _active(opp)
    if oa is None:
        return 0.0
    ohp = oa.get("hp") or 0
    if dmg >= ohp:
        return 0.0  # lethal handled by A.1; this term only grades non-lethal swings

    # Damage-toward-KO, not raw damage: 60 into a 60-hp active >> 60 into a 200-hp tank.
    frac = min(1.0, dmg / float(ohp)) if ohp > 0 else 0.0
    score = frac

    # CORRECT weakness: attack's type must MATCH the opponent's weakness type (spec §A.6 — NOT the
    # crude 'has any weakness ×2' that regressed in card_aware, augury.py:50-54).
    me = _player(cur, you)
    ma = _active(me)
    atk_type = _c5.card_energy_type(ma.get("id")) if ma else None
    weak = _c5.weakness_type(oa.get("id"))
    resist = _c5.resistance_type(oa.get("id"))
    if atk_type is not None and weak is not None and _c5.energy_satisfies(atk_type, weak):
        score += 0.5  # exploit weakness — a kill-setup
    if atk_type is not None and resist is not None and _c5.energy_satisfies(atk_type, resist):
        score -= 0.4  # chipping into resistance is a wasted turn

    return max(-0.5, min(1.0, score))


# ----------------------------------------------------------------------------------------------------
# §A.7 — Turn-phase tempo ordering (low-weight tie-breaker)
# ----------------------------------------------------------------------------------------------------

def tempo_term(cur, state, you, opt) -> float:
    """Develop-before-attack EARLY (while an attach is unspent); spend free one-shot resources;
    keep END at the floor. Reads State.turn / energyAttached / supporterPlayed (api.py:368,374,372).
    Small global ordering, NOT a primary driver (spec §A.7)."""
    if not state:
        return 0.0
    t = opt.get("type")
    energy_unspent = not state.get("energyAttached")
    turn = int(state.get("turn", 0) or 0)
    early = turn <= 4  # early turns = setup phase (turn 1 is starting player's first, api.py:368)

    score = 0.0
    # Develop-before-attack early: bias develop/attach/evolve above attack while an attach is unspent.
    if early and energy_unspent:
        if t in (ATTACH, EVOLVE, PLAY, ABILITY):
            score += 0.5
        elif t == ATTACK:
            score -= 0.4  # attacking before setting up is the v1 trap (heuristic.py:17-19)
    # Spend a supporter draw-engine when it's free value (still available this turn).
    if t == ABILITY and not state.get("supporterPlayed"):
        score += 0.1
    # END only when nothing else has marginal value — keep it at the floor (handled by _BASE; here we
    # mildly discourage ending early with an unspent attach).
    if t == END and energy_unspent and early:
        score -= 0.3
    return score


# ----------------------------------------------------------------------------------------------------
# combined score
# ----------------------------------------------------------------------------------------------------

def _safe(fn, *args) -> float:
    """Run a term, degrade to 0.0 on ANY error (never crash a match — agent.py:89-90 is last resort)."""
    try:
        v = fn(*args)
        return float(v) if v is not None else 0.0
    except Exception:
        return 0.0


def _score(opt, cur, state) -> float:
    """Additive over interpretable terms (spec §A.0). _BASE tie-break + UNCHANGED lethal + 6 terms."""
    t = opt.get("type")
    s = _BASE.get(t, 20.0)
    you = _you(cur)

    # A.1 — UNCHANGED lethal rule (heuristic.py:42-43): +1000 when the OFFERED attack KOs the active.
    if t == ATTACK and opt.get("attackId") is not None:
        dmg = _cards.attack_damage(opt["attackId"])
        s += 0.1 * dmg  # the thin damage nudge, unchanged (heuristic.py:40)
        ohp = _opp_active_hp(cur)
        if ohp is not None and dmg > 0 and dmg >= ohp:
            s += LETHAL

    if cur is None:
        return s  # no board to read -> _BASE + lethal only (matches v4 behavior on bare obs)

    s += W_KO * _safe(ko_term, cur, you, opt)
    s += W_DEV * _safe(development_term, cur, you, opt)
    s += W_NRG * _safe(energy_economy_term, cur, state, you, opt)
    s += W_PIV * _safe(pivot_term, cur, you, opt)
    s += W_ATK * _safe(attack_quality_term, cur, you, opt)
    s += W_TMP * _safe(tempo_term, cur, state, you, opt)
    return s


def choose(obs, deck):
    """Return option indices for the current decision (drop-in A/B-able with heuristic.choose).

    SAME signature + same legality contract as heuristic.choose (heuristic.py:47-62):
      - select is None -> None (deck-selection handled by the agent.py caller).
      - empty options  -> [].
      - otherwise rank by -_score and return the legal count of lowest-index-broken ties, SORTED.
    Multi-select (maxCount>1, e.g. mulligan/discard-N) keeps the same legal-count behavior — the new
    terms target the MAIN single-pick decision where strategy lives (spec §A.0)."""
    sel = obs.get("select")
    if sel is None:
        return None
    opts = sel.get("option") or []
    if not opts:
        return []
    cur = obs.get("current")
    state = cur  # the State dict IS obs["current"] (api.py:442); same object, named for term clarity
    n = len(opts)
    minc = int(sel.get("minCount", 0) or 0)
    maxc = int(sel.get("maxCount", 1) or 1)
    k = min(max(maxc, 1), n)
    k = max(k, min(max(minc, 1), n))
    ranked = sorted(range(n), key=lambda i: (-_score(opts[i], cur, state), i))
    return sorted(ranked[:k])
