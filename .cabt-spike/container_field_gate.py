# container_field_gate.py — RUN THE GATE GYGAX BUILT (vitalik's decisive test).
# vitalik's verdict: the sound verifier (field_eval held-out conjunctive gate) was bypassed for a
# cheaper per-deck grade. Fix: run it. Hold out LUCARIO (a skill deck v5 only TIES v4 at 0.506),
# train on monofighting+sample. Does v5 clear champion(v4) AND pimc on held-out lucario, CI lower > 0.5?
# If not -> the monofighting win was deck-shaped + the v4 head-to-head was exploit-the-sparring-partner.
import sys, os, json

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/cg_src")
from cabt.field_eval import FieldEvalConfig, run_field_eval

cfg = FieldEvalConfig(
    hero_decks=["lucario"],                              # v5 pilots the HELD-OUT skill deck
    opp_decks=["lucario", "monofighting", "sample"],     # universe = all 3 (validate_split needs train ⊆ universe)
    train_decks=["monofighting", "sample"],              # => HELD-OUT = {lucario}; v5-lucario vs varied opp decks
    confirm_n_per_seat=40,                               # 80/cell — tractable; pimc ~0.8s/match
    pimc_n_worlds=6,
    deck_dir="/app/decks",
    out_path="/app/out/field_eval_results.json",
)
report = run_field_eval(cfg, tier="confirm")
print("\n=== VERDICT ===", flush=True)
print("gate_pass (champion AND pimc clear held-out lucario, CI>0.5):", report["gate_pass"], flush=True)
print("field_score (mean held-out gate-cell winrate):", report["field_score"], flush=True)
print("gate_reasons:", report.get("gate_reasons"), flush=True)
print("per_gate_opponent (held-out):", json.dumps(report.get("per_gate_opponent_holdout"), indent=2)[:600], flush=True)
