# ranker.py — Sprint 2: rate a submission against a REFERENCE FIELD (not just the champion), all as
# symmetric subprocess workers (SDD R1), and place it on an Elo scale anchored to the references'
# known standings. Reuses the Sprint-1 coordinator (match_runner.Worker / _play / _assemble_replay).
# Scoped per R5: a fixed small reference field (champion + v6 + greedy), not an O(N²) all-submissions
# round-robin — enough to place a submission honestly; full round-robin is a later enhancement.
import math, os, time
import match_runner as M

# (name, bundle_dir, deck_path, anchor_elo) — anchors are the references' coliseum standings (GAMES-016).
FIELD = [
    ("champion-dwebble", M.CHAMPION_DIR, M.CHAMPION_DECK, 1246),
    ("ref-v6", os.path.join(M.HERE, "field", "v6"), os.path.join(M.HERE, "field", "v6", "deck.csv"), 913),
    ("ref-greedy", os.path.join(M.HERE, "field", "greedy"), os.path.join(M.HERE, "field", "greedy", "deck.csv"), 872),
]
HEADLINE = "champion-dwebble"   # the match we keep as the watchable replay


def _implied_elo(anchor, wins, n):
    p = (wins + 0.5) / (n + 1)
    p = min(max(p, 1e-3), 1 - 1e-3)
    return anchor + 400 * math.log10(p / (1 - p))


def rank_submission(bundle_dir, foreign_deck_path, n_per_seat=3):
    """Play the submission vs each reference (symmetric workers, seat-swapped). Returns
    (result dict with field Elo + per-opponent breakdown, replay dict|None)."""
    foreign_deck = M._load_deck(foreign_deck_path)
    try:
        os.chmod(bundle_dir, 0o755)
    except OSError:
        pass
    foreign = M.Worker(bundle_dir)
    per_opp, total_w, total_n, errors, replay = [], 0, 0, [], None
    try:
        for name, ref_dir, ref_deck_path, anchor in FIELD:
            ref_deck = M._load_deck(ref_deck_path)
            try:
                os.chmod(ref_dir, 0o755)
            except OSError:
                pass
            ref = M.Worker(ref_dir)
            w = dec = 0
            rep_steps = rep_meta = None
            try:
                for i in range(n_per_seat * 2):
                    deadline = time.time() + M.PER_MATCH_WALLCLOCK
                    fseat = 0 if i % 2 == 0 else 1
                    if fseat == 0:
                        d0, d1, w0, w1 = foreign_deck, ref_deck, foreign, ref
                    else:
                        d0, d1, w0, w1 = ref_deck, foreign_deck, ref, foreign
                    try:
                        result, steps = M._play(d0, d1, w0, w1, deadline)
                    except (TimeoutError, RuntimeError) as e:
                        result, steps = None, []
                        errors.append(f"{name}: {e}")
                        foreign.respawn(); ref.respawn()    # F7: always respawn (desync), not only if dead
                    if result is None:
                        continue
                    dec += 1
                    won = (result == fseat)
                    w += 1 if won else 0
                    if name == HEADLINE and rep_steps is None:
                        rep_steps, rep_meta = steps, {"foreign_seat": fseat, "result_seat": result, "won": won, "vs": name}
            finally:
                ref.close()
            elo_i = _implied_elo(anchor, w, dec) if dec else None
            per_opp.append({"opponent": name, "anchor": anchor, "wins": w, "losses": dec - w,
                            "decisive": dec, "impliedElo": round(elo_i) if elo_i is not None else None})
            total_w += w
            total_n += dec
            if name == HEADLINE and rep_steps:
                replay = M._assemble_replay(rep_steps, rep_meta)
    finally:
        foreign.close()
    elos = [o["impliedElo"] for o in per_opp if o["impliedElo"] is not None]
    field_elo = round(sum(elos) / len(elos)) if elos else None
    return {"elo": field_elo, "wins": total_w, "losses": total_n - total_w, "decisive": total_n,
            "winPct": round(total_w / total_n, 3) if total_n else 0.0,
            "perOpponent": per_opp, "errors": errors}, replay
