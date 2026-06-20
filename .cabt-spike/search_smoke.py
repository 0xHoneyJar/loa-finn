"""PROVE the REAL determinized search (FR-2) runs end-to-end with the competition cg.api.
linux/amd64 only. Uses the downloaded cg/ package (NOT pip). Drives a match via cg.game to an
in-game decision, then — following the proven PIMC pattern (g-kari/poke-ai) — converts the obs,
predicts a plausible opponent state (shuffled mirror-deck; the engine validates LENGTH not content),
calls search_begin -> search_step -> search_release. If DETERMINIZED_SEARCH_OK prints, FR-2 is real.
"""
import random
import sys

sys.path.insert(0, "/spike/dl")  # make the vendored competition `cg` package importable
from cg import game
from cg.api import search_begin, search_step, search_release, to_observation_class

rng = random.Random(0)
deck = [int(l) for l in open("/spike/dl/deck.csv") if l.strip()]
print("DECK_LEN", len(deck))

obs, _ = game.battle_start(deck, deck)
print("BATTLE_START obs_ok=%s" % (obs is not None))

# drive (random legal) until an in-game decision (both select and current present)
decision = None
for step in range(40):
    if obs is None:
        print("OBS_NONE step", step); break
    sel, cur = obs.get("select"), obs.get("current")
    if sel is not None and cur is not None and step >= 1:
        decision = obs; break
    if sel is None:
        print("SELECT_NONE step", step); break
    opts = sel.get("option") or []
    k = min(max(sel.get("minCount", 0), 1), sel.get("maxCount", 1), len(opts))
    obs = game.battle_select(rng.sample(range(len(opts)), k))

assert decision, "no in-game decision reached"
obs = decision
cur, sel = obs["current"], obs["select"]
you = cur["yourIndex"]
me, opp = cur["players"][you], cur["players"][1 - you]
print("DECISION yourIndex=%s nopts=%s" % (you, len(sel.get("option") or [])))

# predict hidden state (PIMC): shuffled mirror-deck; engine checks LENGTH, not contents
opp_prize_n = len(opp.get("prize") or [])
opp_hand_n = opp.get("handCount", 0) or 0
your_prize_n = len(me.get("prize") or [])
your_deck_n = me.get("deckCount", 0) or 0
opp_active = opp.get("active") or []
needs_face_down = bool(opp_active) and opp_active[0] is None

agent_obs = to_observation_class(obs)
opp_deck_pred = list(deck); rng.shuffle(opp_deck_pred)
your_deck_pred = list(deck); rng.shuffle(your_deck_pred); your_deck_pred = your_deck_pred[:max(0, your_deck_n)]
opp_prize_pred = [opp_deck_pred[k % len(opp_deck_pred)] for k in range(opp_prize_n)]
opp_hand_pred = [opp_deck_pred[k % len(opp_deck_pred)] for k in range(opp_hand_n)]
your_prize_pred = [your_deck_pred[k % max(1, len(your_deck_pred))] for k in range(your_prize_n)]
opp_active_pred = [opp_deck_pred[0]] if needs_face_down else []
print("PREDICT opp_deck=%d opp_prize=%d opp_hand=%d your_deck=%d your_prize=%d face_down=%s" % (
    len(opp_deck_pred), len(opp_prize_pred), len(opp_hand_pred),
    len(your_deck_pred), len(your_prize_pred), needs_face_down))

root = search_begin(
    agent_obs,
    your_deck=your_deck_pred, your_prize=your_prize_pred,
    opponent_deck=opp_deck_pred, opponent_prize=opp_prize_pred,
    opponent_hand=opp_hand_pred, opponent_active=opp_active_pred,
)
rsel = root.observation.select
print("SEARCH_BEGIN_OK searchId=%s root_select=%s nopts=%s" % (
    root.searchId, rsel is not None, (len(rsel.option) if rsel else 0)))

child = search_step(root.searchId, [0])
csel = child.observation.select
print("SEARCH_STEP_OK searchId=%s child_select=%s" % (child.searchId, csel is not None))
search_release(child.searchId)
search_release(root.searchId)
print("DETERMINIZED_SEARCH_OK")
