"""Echelon — CLONE-ROSTER trainer (offline, numpy; runs on the Mac host).

GAMES-013: the arena's field is too WEAK — a v4-piloted field barely separated v4/v5/v6
(0.08 spread, within noise). Field QUALITY is the whole ballgame. So seed the arena with
STRONGER, reality-mirroring opponents: imitation CLONES of the real top-tier archetypes.

A clone = the imitation_spike's exact linear softmax-over-candidates ranker, fit to ONE
archetype's TOP-TIER WINNER ACTIVE single-pick decisions. The clone shares the spike's exact
feature space — featurize/extract/train/standardize are REUSED VERBATIM (imported from
imitation_spike). The ONLY extension here is archetype recognition: the spike's deck_arch knows
lucario + dwebble_crustle; alakazam decks (Abra/Kadabra/Alakazam line) are present in the corpus
(121 seen, 73 winners) but classified "other", so this trainer supplies an alakazam branch.

Output per archetype -> clone_weights_{archetype}.json:
  {feat_names, weights, mu, sd, archetype, n_groups, n_games, holdout_top1, ...}
mu/sd are the TRAIN standardization so the in-arena PURE-PYTHON serve (clone_agent.py) is
bit-identical to train: standardize at train -> save mu/sd -> apply same mu/sd at serve.

Usage (host):  python .cabt-spike/echelon/train_clones.py
"""
from __future__ import annotations
import sys, os, json, collections
import numpy as np

# --- import the spike VERBATIM (its CardDB / featurize / extract / train / standardize / deck_arch).
#     We do NOT fork the feature space — the clone IS the spike's ranker, just per-archetype + serialized.
_SPIKE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .cabt-spike
if _SPIKE_DIR not in sys.path:
    sys.path.insert(0, _SPIKE_DIR)
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "imitation_spike", os.path.join(_SPIKE_DIR, "imitation_spike.py"))
spike = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(spike)

CardDB = spike.CardDB
featurize = spike.featurize        # REUSED verbatim — identical feature space train<->serve
extract = spike.extract            # REUSED verbatim — ACTIVE single-pick label gate + arch filter
train = spike.train                # REUSED verbatim — softmax-over-candidates linear ranker
standardize = spike.standardize    # REUSED verbatim — z-score; we capture its mu/sd for serve parity
top1 = spike.top1
FEAT_NAMES = spike.FEAT_NAMES
N_FEAT = spike.N_FEAT

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ARCHETYPES = ["lucario", "dwebble_crustle", "alakazam"]


# ------------------------------------------------------------------ archetype recognition extension
# The spike's deck_arch knows lucario + dwebble_crustle and returns "other" for everything else.
# extract() calls spike.deck_arch internally, so we extend it (alakazam branch) by monkeypatching the
# spike's binding. lucario/dwebble keep the spike's exact logic; only the "other" fall-through gains an
# alakazam check. This adds archetype COVERAGE without touching the feature space.
_orig_deck_arch = spike.deck_arch


def _deck_arch_ext(deck, db):
    a = _orig_deck_arch(deck, db)
    if a != "other":
        return a
    keys = " ".join(
        db.get(c)["name"].lower() for c in deck if db.get(c) and db.get(c)["is_pokemon"])
    if "alakazam" in keys or "kadabra" in keys:
        return "alakazam"
    return "other"


spike.deck_arch = _deck_arch_ext  # extract() now classifies alakazam winner-decks too


# ------------------------------------------------------------------ train-standardization mu/sd capture
def _train_mu_sd(groups):
    """Replicate spike.standardize's mu/sd EXACTLY (over all train rows). These exact mu/sd are saved
    so clone_agent.py applies the identical z-score at serve (train == serve)."""
    allrows = np.vstack([g[1] for g in groups])
    mu = allrows.mean(0)
    sd = allrows.std(0)
    sd[sd < 1e-6] = 1.0
    return mu, sd


def _split_by_game(groups, seed=0, frac=0.8):
    """Held-out split BY GAME (no decision from a train game leaks into test) — same discipline as the
    spike's CV split."""
    gids = sorted({g[0] for g in groups})
    r = np.random.RandomState(seed)
    gg = list(gids)
    r.shuffle(gg)
    cut = max(1, int(frac * len(gg)))
    ti = set(gg[:cut])
    tr = [g for g in groups if g[0] in ti]
    te = [g for g in groups if g[0] not in ti]
    return tr, te


def train_clone(db, archetype):
    groups, n_games, hw, hg = extract(db, arch_filter=archetype)
    n_g = len(groups)
    n_games_arch = n_games[archetype]
    if n_g < 50:
        return None, dict(archetype=archetype, n_groups=n_g, n_games=n_games_arch,
                          error="TOO FEW groups (<50) — skip; let the corpus grow")

    # held-out split by game
    tr, te = _split_by_game(groups, seed=0)
    # spike.standardize z-scores train; we ALSO capture the exact mu/sd to ship to serve.
    mu, sd = _train_mu_sd(tr)
    trn, ten = standardize(tr, te)        # spike's own standardize (uses the SAME mu/sd internally)
    w = train(trn, N_FEAT)                # spike's softmax-over-candidates ranker

    # held-out top-1: score test options with w on z-scored features (== serve-time computation)
    ho = top1(ten, lambda X, v4: X @ w)
    rand_exp = float(np.mean([1.0 / len(g[1]) for g in te])) if te else 0.0
    v4_acc = top1(te, lambda X, v4: v4)          # incumbent hand-priors, same held-out set
    avg_opts = float(np.mean([len(g[1]) for g in te])) if te else 0.0

    meta = dict(
        archetype=archetype,
        feat_names=FEAT_NAMES,
        n_feat=N_FEAT,
        weights=[float(x) for x in w],
        mu=[float(x) for x in mu],
        sd=[float(x) for x in sd],
        n_groups=n_g,
        n_games=int(n_games_arch),
        n_train_groups=len(tr),
        n_test_groups=len(te),
        holdout_top1=float(ho),
        v4_holdout_top1=float(v4_acc),
        random_baseline=float(rand_exp),
        lift_vs_v4=float(ho - v4_acc),
        avg_options=avg_opts,
    )
    return meta, meta


def main():
    db = CardDB()
    print(f"cards loaded: {len(db.info)}")
    print(f"building clone roster for: {', '.join(ARCHETYPES)}\n")
    summary = []
    for arch in ARCHETYPES:
        meta, _ = train_clone(db, arch)
        if meta is None or "error" in meta:
            err = (meta or {}).get("error", "unknown")
            print(f"  {arch:18s}: SKIPPED — {err} "
                  f"(groups={(meta or {}).get('n_groups')}, games={(meta or {}).get('n_games')})")
            continue
        out_path = os.path.join(OUT_DIR, f"clone_weights_{arch}.json")
        with open(out_path, "w") as f:
            json.dump(meta, f, indent=2)
        print(f"  {arch:18s}: winner-games={meta['n_games']:4d}  groups={meta['n_groups']:5d}"
              f"  (train {meta['n_train_groups']}/test {meta['n_test_groups']})")
        print(f"  {'':18s}  held-out top-1 = {meta['holdout_top1']:.3f}"
              f"  (v4 {meta['v4_holdout_top1']:.3f}, random {meta['random_baseline']:.3f},"
              f" lift vs v4 {meta['lift_vs_v4']:+.3f}, ~{meta['avg_options']:.1f} opts/decision)")
        print(f"  {'':18s}  -> {os.path.relpath(out_path)}")
        summary.append(meta)

    print("\n================  CLONE ROSTER  ================")
    if not summary:
        print("  NO clones trained — corpus lacks winner decisions for these archetypes.")
        return
    for m in summary:
        print(f"  {m['archetype']:18s} top-1={m['holdout_top1']:.3f}"
              f"  lift={m['lift_vs_v4']:+.3f}  (vs random {m['random_baseline']:.3f})")
    print("\n  (LOCAL learnability signal only — held-out top-1 says the clone LEARNED the archetype's"
          "\n   play pattern; the ARENA separation is the field-strength judge.)")


if __name__ == "__main__":
    main()
