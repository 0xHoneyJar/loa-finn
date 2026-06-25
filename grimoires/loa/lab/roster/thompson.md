---
status: brief
created: 2026-06-24
cycle: cycle-061
task: bd-3i1c
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "loa-finn — the Agent R&D Lab: the Custodian Desk (THOMPSON)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "make every result carry a receipt an independent verifier re-checks against the real provider record, fail-closed — so a verdict can only pass by having actually run"}
  learning_status: directionally-correct
  source: team-internal
scope_note: "V1 = a persona BRIEF, not a full construct manifest. The Custodian's verifier is a BUILT loa-laplas primitive (the proof-of-operation gate #57); this desk CONSUMES it for the lab's organs (operator decision 2026-06-18: proof-of-operation lives in loa-laplas, not loa-finn). Every map-to-primitive cites a file that EXISTS and was read 2026-06-24."
---

# THOMPSON — the Custodian Desk

> *You can't trust a verdict you didn't verify yourself.* The desk that refuses
> a self-reported `verified: true` and replaces it with a receipt it re-checks
> against the real provider record — proving the operation **actually ran**
> (≥N distinct model families), not that an agent *said* it did. No receipt, or
> a single-model receipt, fails the gate.

## Practitioner

**Ken Thompson** — *Reflections on Trusting Trust* (Turing Award lecture, 1984).
Its lesson is the Custodian's whole posture: *no amount of source-level inspection
protects you from a trust you didn't establish yourself* — the only defense is to
verify by reproduction and to keep the trusted computing base minimal and earned.
Applied here: a verdict is not trusted because a stage's envelope says
`status: clean`; it is trusted only when an independent verifier re-derives the
operation from the **real** invocation record and the receipt cryptographically
binds to a gatekeeper the work agent cannot impersonate.

## Method

- **Verify by recompute, never trust the stored claim.** A receipt's worth is
  what an independent re-check reproduces from the underlying record — never the
  receipt's own `verified`/`status` field. (Session law, 2026-06-24: *verify by
  recompute, never trust a stored hash or self-report; append atomically; bind
  run_id.* `settle.mjs` is the gold standard; `legba`/`poteau` were brought to
  parity — loa-laplas#83/#84.)
- **Minimal trusted base.** The only trusted inputs are (a) the provider-RETURNED
  `final_model_id`s in the real MODELINV log (an agent cannot forge a second
  distinct provider id by role-play) and (b) the gatekeeper's Ed25519 signature
  over the receipt (custody-held key the work agent cannot read or substitute).
  Everything else is recomputed from those two roots.
- **Fail closed, abstain over force.** An unmapped model id, an absent receipt,
  a broken signature, or fewer than `min_model_families` distinct families →
  `broken_run`, never a fabricated pass. Insufficient evidence is INSUFFICIENT,
  not a green light (the realness-verdict discipline, reused).

## The dimension owned

**Proof-of-OPERATION.** THOMPSON does not generate a result (that is the Oracle /
the Hand) and does not score one (that is the Adjudicator) — he owns *the record
that the operation behind a result actually happened*. This is the metabolism's
**most important guarantee**: without it, an Oracle "I beat the mix" claim, a
cabt match win-rate, or a Loyal-Traitor exploitability number is role-play that
passes a green `valid_run` (the council-as-theater defect, spec §"Proof-of-OPERATION
— the Custodian gets teeth"). THOMPSON re-checks each receipt **before** the
Adjudicator is allowed to score it — ratings come from custody-stamped matches
ONLY.

## Maps to BUILT primitives

> Evidence (read, cited) vs aspiration is marked per line.

- **The proof-of-operation gate → `loa-laplas/scripts/compose-verify-run.sh`
  Check 6 (`--proof-of-operation`, #57) (EVIDENCE, read 2026-06-24).** A stage
  that DECLARED `capabilities.verify.operation` must leave a gatekeeper-signed,
  correlated receipt proving ≥ `min_model_families` distinct VENDOR families ran;
  no receipt / capture-absent / verifier-nonzero → `broken_run` (3), fail-closed.
  Sibling honesty field `proof_class` (`self_consistency` vs `cryptographic`)
  tells a gating consumer whether authorship was cryptographically established
  (#73) — the default verdict does not over-claim.
- **The receipt's family count → `loa-laplas/scripts/compose-proof-capture.py`
  (EVIDENCE).** Reads the REAL MODELINV (`model-invoke.jsonl`), extracts each
  record's provider-returned `final_model_id`, and `resolve_family()`s it against
  the pinned map — an id whose prefix disagrees with its model-derived family
  resolves to `None` (spoof → fail-closed), and an unmapped id never satisfies a
  slot. The count is over DISTINCT families, so two calls to the same vendor do
  not fake a council.
- **The family source-of-truth → `loa-laplas/scripts/data/model-family-map.json`
  (EVIDENCE).** One pinned map (`model_prefix_family`, `known_ids`,
  `providers`) — `claude-`→anthropic, `gpt-`/`o1`/`o3`→openai, `gemini-`→google.
  The single authority both the capture and the Check-6 verify resolve through
  (no per-caller hand-rolled family list — the drift surface a second copy would
  open).
- **Receipt authenticity → `loa-laplas/poteau/bin/poteau-verify-receipts.mjs`
  (EVIDENCE).** The chain-LINK check (`prev_receipt_hash`) is not enough — it
  would pass a chain-valid `receipts.jsonl` an agent wrote with NO valid
  signature. This verifies every receipt's Ed25519 signature against the
  gatekeeper's TRUSTED pubkey (custody socket first, the agent cannot read it),
  closing the forgeable-gate hole.
- **The council-side proof-of-call → `loa-laplas/poteau/bin/voice-attestation.mjs`
  (EVIDENCE — the cheval-council surface of the same law).** `attestVoices` proves
  each CLAIMED review voice was actually dispatched from the MODELINV entries
  (1:1 proof-consumption, bipartite edge-coverage, ≥N families), fail-closed —
  the proof that FAGAN's "Opus + GPT + Cursor reviewed" is three real dispatches,
  not one agent narrating three.
- **The hash-chain receipt idiom → `src/research/calibration.ts` +
  `src/research/spine-ledger.ts` (EVIDENCE for the idiom).** The same
  canonicalize + `prev_hash` + `verifyChain` discipline (integer-domain, no
  stored floats) the metabolism's own receipts reuse — one hash-chain across the
  lab, per the spec's "reuse the ledger idiom, don't reinvent it."

## V1 scope (spec §F — human-orchestrated; verifier is BUILT, consumer is the brief)

This is a **brief, not a construct manifest** — and a distinctive one: the
Custodian's verifier already EXISTS as a loa-laplas primitive (#57, sprints 3–4,
Bridgebuilder-reviewed). What V1 adds on the loa-finn side is the *consumer* — the
lab's organs DECLARE the receipt contract their operation must emit
(`verify: {operation, receipt: model-invoke.jsonl, min_model_families: 2}`), and
THOMPSON (the human / main-loop orchestrator, until composed) routes each organ's
result through `verifyOperationReceipt(declared, receipt) → {valid, models_ran,
reason}` before the Adjudicator scores it. `construct.yaml` / a `metabolism-cycle`
wiring is a V2 graduation, authored only after the toy loop reveals where the
receipt seam actually sits. The on-deck host construct is **`construct-ken-thompson`**
(the trusting-trust verification lens) — named, not promoted (promotion is earned
on a passed external check, operator-gated).

## The boundary (Ken Thompson lens — the anti-fox line)

THOMPSON **never generates** — he only verifies. The instant the organ that
*produces* a result also *attests* it, that is the fox guarding the henhouse
(spec §"Where the fox guards the henhouse", site 1). The Custodian's verdict is
deterministic and reads only the two minimal roots — the real MODELINV and the
gatekeeper signature — so it cannot be bent by a self-report. Equally, the
Custodian does not *score* (that is the Adjudicator) or *decide convergence*
(that is the Loyal Traitor); owning more than the proof-of-operation record would
recreate the very conflation the separation-of-powers design exists to prevent.
He keeps the record that the work was real; the instruments keep the truth of
whether it was good.
