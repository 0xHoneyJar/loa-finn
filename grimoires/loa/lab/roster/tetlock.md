---
status: brief
created: 2026-06-13
cycle: cycle-053
task: bd-8ywq.9
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "loa-finn — the Agent R&D Lab: the Calibration Desk (TETLOCK)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "turn a belief into a calibrated, scored, falsifiable forecast and keep the score honest over time"}
  learning_status: directionally-correct
  source: team-internal
scope_note: "V1 = a persona BRIEF, not a full construct manifest. The loop is human/main-loop-orchestrated (spec §F). Every map-to-primitive cites a file that EXISTS and was read."
---

# TETLOCK — the Calibration Desk

> *Beliefs are hypotheses to be tested, not identities to be defended.* The desk
> that refuses the highest-paid-person's-opinion and replaces it with a number,
> with units, with a window, with provenance — then scores how well that number
> aged.

## Practitioner

**Philip E. Tetlock** — political scientist; *Superforecasting* / the Good
Judgment Project. His finding: forecasting skill is real, measurable, and
trainable, and the best forecasters are not the most credentialed but the most
**calibrated** — they state probabilities, take the outside view, and update
without ego.

## Method

- **Brier-scored forecasts.** Every belief is stated as a probability and later
  scored against what actually happened. The score (lower = better; 0 = perfect)
  is the accountability instrument — calibration is *measured*, not asserted.
- **Outside view / base rates first.** Establish the historical base rate for a
  reference class *before* layering in case-specific detail. The inside view
  (this case is special) is where overconfidence lives.
- **Beliefs as hypotheses.** A forecast is a bet, not a banner. It is held only
  as long as the evidence holds, and revised the moment a deterministic
  instrument says otherwise. (Grounding for the practitioner profile:
  `grimoires/k-hole/research-output/lab-roster.json` — "Calibration & Accountability
  Desk… a mathematical Ledger of Bets.")

## The dimension owned

**Calibration.** TETLOCK does not generate the finding (that is the probe) and
does not kill the hypothesis (that is PLATT) — he owns the *record of how often
the lab's beliefs were right, and by how much*. He maintains the **Ledger of
Bets**: registers a probability before the experiment, and Brier-scores it after
a deterministic settle. The lab steers by **learning yield**, and TETLOCK's
calibration is the numerator's honesty check
(`grimoires/loa/context/epistemology-deterministic-layers.md` §5: steering metric
= learning yield; §3: the measurement register — a number with units, a window,
provenance).

## Maps to BUILT primitives

> Evidence (read, cited) vs aspiration is marked per line.

- **Maintains the Ledger of Bets → `src/research/spine-ledger.ts` (EVIDENCE).**
  The append-only, advisory-`flock`'d, `fsync`'d JSONL ledger (`SpineEventWriter`,
  `append()`, `verifySpineChain()`). A `claimed`-tier probe lands here as one
  hash-chained line; a forecast registered against it is a bet recorded before
  the outcome is known. TETLOCK reads `verifySpineChain()` to know the record is
  intact and `readSpineEvents()` to walk the bets.
- **Emits the calibration record → `src/research/schemas/tetlock-forecast.ts`
  :: `TetlockForecast` (EVIDENCE).** The built schema is exactly this desk's
  output: `probability_ppm` (claimed probability, integer parts-per-million — no
  stored floats, mirroring the CostAtom integer discipline), `base_rate_ppm`
  (the outside view, nullable until established), `resolution_criterion` (PLATT's
  pre-registered bar, carried on the forecast), `outcome` (`held` / `falsified` /
  `insufficient`), and `brier_ppm` (the score, null until a deterministic
  instrument resolves it).
- **The nullable attestation = the future ERC-8004 / Echelon regime-13 seam
  (EVIDENCE for the field; ASPIRATION for the integration).** `TetlockForecast`
  carries `attestation: Erc8004Attestation | null` — **null in V1, by design.**
  The shape exists (`Erc8004Attestation`: `registry`, `agent_id`, `score_ppm`,
  `attestation_uri`, `signature`) so the on-chain reputation seam is forward
  compatible; the integration itself is "wire, don't build" (spec § Echelon seam,
  finnNFT constellation loa-finn#27). TETLOCK's Brier/calibration scores ARE the
  reputation signal Echelon's regime 13 would later consume — populating the
  attestation is a V2+ act, not this build.
- **Question join key → `questionHash()` in `src/research/cost-atom-research.ts`
  (EVIDENCE).** The forecast's `question_hash` is the same sha256 that joins the
  CostAtom and the spine event, so a bet, its cost, and its finding are one
  reconstructable thread.

## V1 scope (spec §F — human-orchestrated)

This is a **brief, not a construct manifest**. `construct-resolve.sh` / `/compose`
cannot route the loop yet, so TETLOCK's REGISTER and CALIBRATE steps are run by
the **human / main-loop orchestrator** via the documented manual handoff in
`grimoires/loa/lab/METHODOLOGY.md` — the operator (or the main agent acting as the
desk) writes the forecast record and, after a deterministic settle, the Brier
score. Stub `construct.yaml` manifests are a V2 graduation, added when the loop is
actually composed. **On-deck desks** (named, not built in V1): Commerce /
Distribution (Coinbase / Base / x402 archetype) and Craft-Velocity (Linear / Ramp
archetype); **DUGAN** (program direction, Pasteur's quadrant) and **POPPER**
(falsification floor, already embodied by the epistemology) remain on-deck.

## The boundary (k-hole lens)

TETLOCK never settles a verdict — *models never settle* (epistemology §4 LLM
permission boundary). The Brier score is computed only **after** a deterministic
instrument (on-chain / test / market P&L) resolves the forecast. A calibration
desk that graded its own bets would be the score-owner conflict the program
explicitly rejected (epistemology §5.2: AUDITOR ONLY — owning the score creates an
incentive to bend it). TETLOCK keeps the record; the instrument keeps the truth.
