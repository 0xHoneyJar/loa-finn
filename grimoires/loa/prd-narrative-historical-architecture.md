---
status: Draft
date: 2026-07-12
bead: bd-1vp7
author: soju + Claude (Fable 5)
sibling: prd.md (Corpus Engine, cycle-053 — composes with, does NOT displace)
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "loa-finn — Finn's Shop: identity, narrative & historical architecture, the gadget discipline, and the CLI seam"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "make finn self-legible — the repo answers 'what am I for, what gadgets exist, what's proven, where did I come from' from governed record in one consultation instead of an archaeology session"}
  learning_status: directionally-correct
  source: team-internal
---

# PRD — Finn's Shop: Narrative & Historical Architecture + the Gadget Discipline

> **One line:** install finn's identity (the minimalist gadget forge + appraiser) as
> governed, queryable substrate — so a fresh session answers "what is finn for, what
> gadgets exist, what's proven?" in ONE consultation, and the discipline + CLI seam
> grow from that record instead of from re-excavation.

## 0. Why this, why now (grounded)

On 2026-07-12 the operator asked "what do we aim to achieve with loa-finn and where
is it at now?" — answering took **three multi-agent archaeology workflows (~1.8M
subagent tokens)**: a reality-check sweep, a lineage dig, and a person-construct
consultation. The identity they recovered already existed in the repo, twice: the
founder's birth thesis (*"start with nothing, add only what's load-bearing… loa-finn
is our k3s moment"* — research-minimal-pi.md, commit 421f4a44, 2026-02-06) and the
operator's own gadget-factory frame (*"a lab where we make small gadgets, test them
out, throw them away, or sell them"* — gadget-factory-brief.md, 2026-06-14,
status: candidate). **The repo could not tell its own story.** That is the defect
this PRD fixes — and today's session is the measured baseline.

The precedent is landed: the JANI construct v0 (roster/jani.md + the six-verdict
testimony, commit fd4e5425) proved the consultation shape — retrieval + citation,
epistemic layers, fail-closed ABSTAIN (2 of 6), ethics line.

> Sources: user-description.md:1-24 · gadget-factory-brief.md:19-31 ·
> research-minimal-pi.md §"The Name" · context/2026-07-12-jani-construct-testimony.md ·
> interview 2026-07-12 (operator reframe: "minimalism is kind of the purpose… small
> pieces of software… high bar for quality and rigor… eventually a CLI that slots
> into Loa")

## 1. Vision

**Finn is the Loa ecosystem's minimalist gadget forge and appraiser.** He produces
small, rigorous, falsifiable instruments — tests them against reality — and keeps,
sells, or throws each one. Not a monolith; never a monolith. The identity is
continuous from genesis to today: Jani's k3s thesis (2026-02-06) → the operator's
gadget factory (2026-06-14) → the operator's independent re-derivation (2026-07-12,
this interview) — three statements of one thesis, and the convergence is itself
evidence the identity is real.

**Narrative & historical architecture is what makes that identity durable.** Jani
formalized naming as "narrative architecture… a coherent memetic framework [so]
humans and AI agents form a consistent mental model" (ecosystem-architecture.md,
commit 03a513ad). This PRD extends it onto the time axis: the estate's HISTORY —
origin intent, README lives, PRD arcs, handoffs, verdicts — as governed, queryable
substrate. The shop remembers what it is for.

> Sources: gadget-factory-brief.md epigraph · lore/neuromancer.yaml
> finn-construct-oracle · ARCHITECTURE.md §1 (design law) · lineage dig 2026-07-12

## 2. Users & stakeholders

| Who | Relationship | Note |
|---|---|---|
| **Operator (soju)** | primary — consults, curates, gates promotion | interview 2026-07-12 |
| **Fresh sessions / agents** | first-class consumers — the self-legibility bar is FOR them | G1 below |
| **Other estate operators** | secondary (Eileen drives origin/main since late June) | lineage dig |
| **Jani** | consent stakeholder on the Predecessor Desk — posture: **internal-only, indefinitely**; his live words supersede; retire on objection | interview Q (consent), roster/jani.md ethics line |

## 3. Goals & success metrics

- **G1 — Self-legibility (the bar).** A fresh session (or agent) answers, with
  citations, in ONE consultation: *what is finn for · what gadgets exist and their
  keep/sell/throw status · what's proven (settles/verdicts) · where did it come
  from.* **Baseline:** 2026-07-12 — three workflows, ~1.8M tokens. **Target:**
  one consultation, minutes. Measured by the probe protocol (§7 Verify).
- **G2 — Consultation protocol proven beyond its first subject.** ≥1 further
  consultation (any subject: person, repo-lineage, or decision) run through the
  protocol: pre-registered questions → cited verdicts → ABSTAIN honored.
- **G3 — Gadget ledger live.** Every existing instrument has a ledger row with
  status + evidence; no gadget exists outside the ledger.
- **Non-goals:** external revenue / selling gadgets (inherited explicit non-goal —
  prd.md:44, operator 2026-06-14); outward-facing JANI surfaces (consent posture);
  resurrecting the runtime/deploy story (reality-check verdict 2026-07-12).

> Sources: interview 2026-07-12 (success-bar selection: self-legibility) ·
> prd.md:44 · project_loa-finn-reality-check memory

## 4. Tracks & functional requirements

### Track 1 — Identity (V1 center of gravity)

- **FR-1 Identity doc truth.** finn's identity docs state the gadget-forge thesis
  with lineage citations: update `grimoires/loa/BEAUVOIR.md` (identity) and
  README's "Why Finn" to the shop frame; **fix the falsified README line**
  ("runtime is in production-shaped use" — contradicted by 56/56 failed deploys +
  NXDOMAIN). Truth-repair is part of identity.
  - AC: no identity claim in README/BEAUVOIR contradicts the evidence record.
- **FR-2 Gadget ledger.** `grimoires/loa/lab/GADGETS.md` — one row per instrument:
  name · what it is · status (KEEP/SELL/THROW/CANDIDATE) · check (the test that
  binds it) · graduation state (lab → src/). Seeded with #001 realness-verdict
  (BUILT, 5/5) + the metabolism instruments (solver, exploitability, ledgers —
  bd-ryza) + candidates from gadget-factory-brief (#002/#003).
  - AC: ledger exists; every `lab/gadgets/*` and `src/lab/metabolism/*` instrument
    has a row; each row's check is runnable.
- **FR-3 Lineage substrate.** The 2026-07-12 archaeology lands as governed docs:
  README lives, PRD arc, handoff record (custody grant summarized, never inlined),
  cosmology chain — as `grimoires/loa/lore/lineage.md` (or context/ dated docs),
  each claim commit-cited.
  - AC: the lineage answers "where did finn come from" with citations; JANI desk
    links to it.
- **FR-4 Consultation protocol.** The JANI-v0 shape codified as a reusable
  protocol doc: pre-registered questions → corpus miners → cited verdicts with
  confidence → ABSTAIN honored → testimony persisted in context/ (dated). Reuses
  the settle/calibration discipline (a consultation is a settle-shaped act;
  deterministic where scoring, never LLM-settled).
  - AC: protocol doc exists; consultation #2 (G2) runs through it verbatim.
- **FR-5 Corpus intake + provenance.** `grimoires/loa/lab/corpus/` intake
  convention: provenance tiers stamped at intake (git-verbatim > account-verbatim >
  captured > CLAIMED), internal-only handling for person-corpus, misattribution
  guards as first-class records. V1 acquisitions: **operator Discord export**
  (the ERR-era channels + the 2026-05-04 custody-grant conversation — promotes the
  weakest layer toward primary), **custody-grant signing** (one cockpit gesture),
  **dead `~/hivemind` symlink fix** (bonfire-side, one line). Backlog beads: the
  missing "Jester Arc" essay + `merlin/agentic-base.md`.
  - AC: intake convention doc + at least the Discord export stamped in with tiers.

### Track 2 — The gadget discipline (codification)

- **FR-6 Lifecycle.** Codify: intake (idea/research) → build (the lab's compose
  lane, FAGAN-gated) → test (the check that binds it) → verdict (KEEP/SELL/THROW,
  recorded in the ledger with evidence) → graduation (lab/gadgets → src/ via
  /implement, per corpus-engine FR-5 precedent).
  - AC: lifecycle doc; the next gadget built after this cycle follows it end-to-end.
- **FR-7 Rigor floor.** Every gadget ships its CHECK, not just its operation
  (design law); thresholds validated before autonomy (inherit corpus-engine FR-7
  discrimination-benchmark pattern); minimalism enforced — a gadget that grows past
  "small" splits or graduates.
  - AC: no ledger row without a runnable check.

### Track 3 — The CLI seam (spec, then build — gated)

- **FR-8 finn-cli spec (V1 deliverable).** Spec the composition surface that slots
  into Loa beside freeside-cli/loa-cli: `finn doctor` (identity + ledger + corpus
  health), `finn gadgets` (list/status/checks), `finn consult` (run a consultation
  against the record), `finn settles` (read SETTLES/verdicts). Contract: the CLI
  **reads the ledgers — it owns no state**; the identity layer is its data model.
  - AC: spec reviewed; every verb maps to a substrate artifact that exists (T1/T2).
- **FR-9 finn-cli v0 build (GATED).** Build begins only after Track 1+2 acceptance
  ("spec then build" — operator). Minimum: `doctor` + `gadgets`.
  - AC: v0 runs against the real ledgers; `finn doctor` passes the self-legibility
    probe's data needs.

## 5. Non-functional requirements

- **Minimalism as enforced shape** (the k3s thesis): every FR delivered as the
  smallest honest artifact; deletion over addition; no new services, no new state
  stores — grimoire docs + light tooling only until FR-9.
- **Provenance stickiness:** tiers stamped at intake never stripped through
  consultation or handoff (Straylight discipline).
- **Fail-closed epistemics:** ABSTAIN over fabrication everywhere; insufficient is
  INSUFFICIENT (Custodian discipline applied to memory).
- **Privacy:** person-corpus internal-only; vault content summarized, never inlined
  in committed docs; no outward JANI surface.
- **Deterministic settle:** anything scored (probe pass/fail, ledger checks) is a
  deterministic check, never an LLM verdict.

## 6. Scope

**V1 (this cycle):** Track 1 (FR-1..5) + Track 2 codification (FR-6..7) + FR-8 spec.
**V2 (gated, same PRD):** FR-9 CLI v0 build; consultation #3+; corpus backlog beads.
**Out of scope:** external gadget sales/packaging; outward JANI/person surfaces;
runtime/deploy resurrection; automating raw-source acquisition; any monolith move.

## 7. Verify (the probe protocol — G1's instrument)

1. A fresh session (no prior context) is given the three questions: *what is finn
   for / what gadgets exist + status / what's proven + where from.*
2. Pass iff it answers all three **with citations that re-run** (file:line, commit,
   ledger row) via ≤1 consultation (the protocol doc + ledgers + lineage), no
   archaeology workflows.
3. Record the run (tokens, minutes, citation spot-check) next to the 2026-07-12
   baseline in the testimony convention.
4. Regression guard: the probe re-runs after any identity-doc change (cheap, doc-only).

## 8. Risks & mitigations

| Risk | Evidence | Mitigation |
|---|---|---|
| **Founder-pattern: machinery built, activation deferred** | JANI dig voice-note #1 (cycle-035 shadow-forever; soft-launch checklist never ticked) | G1 is a *measured probe*, not shipped machinery; the cycle is not done until the probe runs |
| Caricature leak / misattribution in person-constructs | ARCHITECTURE.md §6; one guard already on file | FR-5 misattribution guards; never-as-them rule; internal-only |
| Second-hand corpus decays | raw Discord sources absent estate-wide | FR-5 export acquisition; provenance tiers make weakness visible |
| Scope creep back toward monolith | the Feb–May platform accretion arc (lineage) | NFR minimalism; §6 out-of-scope; ledger forces small units |
| Identity docs drift again | README falsified line stood ~1 month | FR-1 AC + §7.4 regression probe |

> Sources: lineage dig 2026-07-12 · jani-construct testimony Q2/Q3 ·
> reality-check 2026-07-12 · interview decisions (frame, bar, CLI gating, corpus
> scope, consent) — all recorded 2026-07-12.
