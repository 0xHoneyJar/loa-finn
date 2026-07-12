"""Assemble the full STORM-formatted research paper from the council workflow output."""
import json, re

SRC = "/private/tmp/claude-501/-Users-zksoju-Documents-GitHub-loa-finn/0096fa8b-e991-440e-9b04-80ac7e0e497c/tasks/wy2b5qy19.output"
OUT = "/Users/zksoju/Documents/GitHub/loa-finn/grimoires/loa/research/2026-06-22-storm-paper-two-evidence-loops.md"

d = json.load(open(SRC))
r = d["result"]
if isinstance(r, str):
    r = json.loads(r)

SEAT_TITLES = {
    "practitioner": "Practitioner — gygax (the seat that ran the bets)",
    "academic": "Academic / Rigor — the calibration + Brier lens",
    "skeptic": "Skeptic — ken-thompson (verify by reproduction)",
    "economist": "Economist / Cost — the cost-atom / scarce-slot lens",
    "historian": "Historian — worldline / MINKOWSKI (what's conserved)",
}

def trim(text):
    """Drop the trailing construct JSON sidecar + the mandated-read confirmation preamble for readability."""
    t = text
    # cut the trailing ```json ... ``` construct sidecar
    i = t.find("```json")
    if i != -1:
        t = t[:i].rstrip()
    # drop a leading "MANDATED READS ..." confirmation line/paragraph
    t = re.sub(r"^MANDATED READS?[^\n]*\n+", "", t, flags=re.IGNORECASE)
    t = re.sub(r"^[^\n]*Brief H1[^\n]*\n+", "", t)
    return t.strip()

parts = []
parts.append("""# STORM Research Paper — Two Evidence Loops for cabt

*A multi-perspective adversarial research council comparing **soju/loa-finn's** coliseum/calibration loop against
**El Capitan [OHM]'s** gym/TurnTrace/FunSearch loop, run via the Stanford STORM method (5 expert perspectives →
contradiction map → synthesis → adversarial peer-review), with **our own constructs as the opposing seats**.
2026-06-22.*

> **How to read this.** §1–§4 are the raw STORM method output (perspectives, contradictions, synthesis, peer-review)
> — the full epistemic trail, including the over-claims the peer-review caught. **§5 is the corrected, send-ready
> conclusion** (the companion briefing). If you want the answer, read §5 first; if you want the *reasoning*, read in
> order and watch §4 dismantle §3. The peer-review (fagan) graded the synthesis **B− / "revise before sending"** and
> caught three over-claims that flattered our own loop — those corrections are folded into §5.
""")

parts.append("\n---\n\n## §1 — The Five Perspectives\n")
for key, txt in zip(r["perspectiveKeys"], r["perspectives"]):
    parts.append(f"\n### {SEAT_TITLES.get(key, key)}\n\n{trim(txt)}\n")

parts.append("\n---\n\n## §2 — Contradiction Map\n\n" + r["contradiction"].strip() + "\n")
parts.append("\n---\n\n## §3 — Synthesis (the briefing — NOTE: §4 corrects three claims here)\n\n" + r["synthesis"].strip() + "\n")
parts.append("\n---\n\n## §4 — Adversarial Peer-Review (fagan)\n\n" + r["review"].strip() + "\n")
parts.append("""
---

## §5 — Corrected, send-ready conclusion (post-peer-review)

The companion file **`2026-06-22-two-evidence-loops.md`** is the corrected briefing — it folds in every fix §4
demanded. The load-bearing corrections, for the record:

1. **Cross-engine AGREEMENT is not a realness rung.** Two field-blind, self-play-rooted instruments grading the same
   closed engine share the *same* blind spot — agreement is shared bias read twice. The informative event is
   **disagreement adjudicated by the ladder.** (A genuine re-implementation earns a small agreement-credit: it rules
   out per-engine artifacts.)
2. **No "~470 Elo deck axis."** 807.5 − 719.1 = **+88** (the only constructive deck gain, N=1); 470 was the deck
   *downside*. The pilot is *not* flat on the ladder (v8 held +21.9 UP). Upside is small on **both** axes now that
   we're on the converged top deck; neither is "the lever."
3. **Frozen-drift senses the meta-shift of already-submitted agents — it cannot evaluate a novel candidate.** A new
   FunSearch output still costs a slot.
4. **The Brier "overconfidence" is a ~0.017 near-tie and the loop self-corrected** — not a standing defect, and not
   ammunition against a teammate's loop.
5. **Two seats we were missing:** the *game-theorist* (the field is non-stationary + rock-paper-scissors — imitating
   the converged meta is a Red Queen treadmill; the move is counter-meta search) and *objective-framing* (does the
   "Simulation" category score the best agent or the best methodology?).

— council seats: gygax · calibration-lens · ken-thompson · cost-atom-lens · worldline · fagan (review).
""")

open(OUT, "w").write("\n".join(parts))
print("wrote", OUT, "(", len("\n".join(parts)), "chars )")
