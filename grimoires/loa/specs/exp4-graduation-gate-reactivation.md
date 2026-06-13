---
hivemind:
  schema_version: "1.0"
  artifact_type: experiment-design
  product_area: "Finn — EXP-004 the graduation gate (validated forensic substrate before the product)"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "build the validated sybil substrate + precision/recall gate the Score forensic SKU needs before any external claim — the thing #269 lacked"}
  learning_status: directionally-correct
  source: team-internal
---

# EXP-004 — The Graduation Gate (re-activation of Sprint 2+3)

> The #269 lesson, turned into the build: a deterministic formula is **not** the product — the
> validated substrate must exist first. EXP-004 builds that substrate. It is **not a fresh scope** —
> it RE-ACTIVATES the already-pre-registered **Sprint 2 (FR-1/FR-7) + Sprint 3 (FR-2a)** of
> `grimoires/loa/sprint-finn-score.md:104-193`, whose bars + acceptance criteria already exist and
> already carry anti-p-hacking discipline. This doc grounds those bars against today's reality; it
> does not re-derive them. Read the sprint doc for the full task list.

## Why now (the settled priors)
- **EXP-003 GO-vertical / NO-GO-horizontal** (`exp3-c2-settle.md`): the verification wedge is real but
  vertical-first; the deterministic moat earns "forensic/court-admissible" only after a validated gate.
- **score-api #269 rescope**: the literal proof. A forensic SKU shipped on an *unvalidated* substrate
  (no sybil layer, no precision/recall, an inverted polarity bug) and was correctly held. EXP-004 is
  the gate it must clear.
- **`src/score` today**: Sprint-1 core is pure + unit-tested, but `edge/adapters.ts:22,36` throw
  `NotImplementedError` (fixtures-only) and `precisionBar` (`screen.ts:37`) is a carried placeholder.
  The substrate is the missing half.

## The two pre-registered kill gates (the bars — already set, do NOT relitigate)
EXP-004's bars ARE Sprint 2+3's acceptance criteria. Two falsifiable kill gates:

### PREMISE kill (Sprint 2 AC, `sprint-finn-score.md:129`)
Recompute Epoch-1 top-11 against **real Base/ACP on-chain data**. **GO** = theater signature holds
(shared-counterparty clusters AND buyer-counts banded ~100–200). **PREMISE-KILL** = top-11 genuinely
buyer-diverse (the theater thesis is wrong; the whole forensic premise dies).
> **Cross-check (EXP-002):** EXP-002 already settled this as theater off the platform API (a6c9 =
> PRIZE_DISTRIBUTOR, 39,999 registered → ~0 transacting). EXP-004's PREMISE smoke is the **on-chain,
> deterministic re-confirmation** of that — and a falsification check on EXP-002 itself. If on-chain
> disagrees with the API finding, that divergence is the headline.

### VALIDATION kill (Sprint 3 AC, `sprint-finn-score.md:174-177`)
Measure the screen's **precision/recall** against a **hand-labeled set (≥3 epochs, top-50, wash/
subsidy/plausibly-real)** vs a **pre-set precision bar fixed BEFORE results are seen** (Q1, anti-
p-hacking, persisted in `score_validation_runs.precision_bar`). **Below bar → every agent renders
INSUFFICIENT-EVIDENCE, never HIGH** — gates *publication*, not merge. This is the precision/recall
artifact #269 lacked entirely.

## Grounding deltas vs the sprint doc (today's reality)
1. **Route on-chain data through `@freeside/dune-meter`** where Dune is used — cost-capped, metered,
   CostAtom-emitting (the EXP-002 budget scar; never raw). Sprint 2's primary path is the read-only
   RPC pool (`src/x402/rpc-pool.ts`), which needs no Dune; any Dune supplement goes through dune-meter.
2. **EXP-002 forensic outputs seed the Sprint-3 labeled set** — the a6c9/wash-cluster/PRIZE_DISTRIBUTOR
   findings are candidate labels (wash/subsidy), reducing the cold-start on the hand-labeled fixtures.
3. **Q2 (event signatures/addresses)** is partly pre-resolved: EXP-002 recovered + cast-verified V1/V2
   ACP addresses + topic0s (`score-api/scripts/analysis/exp2/addresses.json`, reconciliation PASS).
   Reuse them; re-verify on Base before decoding (the §8 expiredAt lesson).
4. **The two kill gates are the experiment's settle events** — PREMISE and VALIDATION each settle
   GO/KILL on the spine, exactly like EXP-001's H1/H2/H3.

## Run via — `code-implement-and-review` (REQUIRED)
`~/.loa/constructs/substrates/construct-compositions/compositions/delivery/code-implement-and-review.yaml`
· implement (codex) ↔ FAGAN, ≤3.
`surface_class: data-validity`. Apply the EXP-002 grounding-first block (forbidden cwd, mandated reads,
proof-of-grounding). **Lesson from this very session: a converged FAGAN pass is NOT verification** —
both the dune-meter build and #269 converged and still had real defects an independent corpus caught.
On a data-validity surface, run the cross-model council (or grounded multi-lens panel while
construct-fagan#8 holds cheval down) before any GO is trusted.

## What NOT to do
- NO external "forensic/court-admissible" claim until BOTH kill gates pass (the #269 line).
- NO bar set after seeing results (Q1 anti-p-hacking — the bar is pinned first).
- NO raw Dune (route through dune-meter).
- NO treating PREMISE-KILL or VALIDATION-NO-GO as failure — both are first-class designed outcomes
  (a kill is a settled belief, the EXP-001/002/003 discipline).

## Verify (the gates)
- PREMISE smoke emits an explicit GO/KILL verdict off real on-chain data (operator-actionable).
- VALIDATION emits precision/recall + per-adversary breakdown vs the pre-set bar; NO-GO wired to
  all-INSUFFICIENT, unit-tested.
- Both settle on the spine. Only after BOTH GO does the Score forensic vertical earn its words.

## Spine
EXP-004 registers 2 bars (PREMISE + VALIDATION kill gates) at `pinned` tier — they're pre-registered
in the sprint doc. Settle events land when each gate fires.
