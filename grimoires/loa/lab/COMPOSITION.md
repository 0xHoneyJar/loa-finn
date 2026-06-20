---
status: design
created: 2026-06-14
cycle: cycle-053
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "loa-finn — the Agent R&D Lab: enriching the lab-cycle /compose composition"
  workstream: experimentation
  priority: high
  jtbd: {category: functional, description: "enrich the EXISTING lab-cycle composition with WEBB (candidate sourcing), mandated_reads hardening, and a discrimination acceptance test — grounded in SETTLE-003"}
  learning_status: directionally-correct
  source: team-internal
scope_note: "ENRICHMENT proposal for an EXISTING, PROVEN composition — NOT a new design. The composition `lab-cycle` already exists and has run with valid_run: ~/.loa/constructs/substrates/construct-compositions/compositions/experimentation/lab-cycle.yaml (prompted embodiment, NOT manifests; cut at the operator-pins-bars seam). This proposes 3 additive changes. Every claim cites a file that EXISTS and was read."
---

# COMPOSITION — enriching `lab-cycle`

> The realness loop is **already a running composition.** `lab-cycle.yaml` (authored
> 2026-06-13, run with `valid_run`) routes PROBE → REGISTER → DESIGN → ⟦pin bars⟧ →
> SETTLE → CALIBRATE via prompted general-purpose agents embodying the desks (read
> their `roster/*.md`). It does **not** need construct manifests — prompted
> embodiment is the V1 routing, and it works. This doc is the **enrichment** the
> operator asked for, grounded in what SETTLE-003 taught: three additive changes.

## What exists (the SoT — read, not assumed)

`~/.loa/constructs/substrates/construct-compositions/compositions/experimentation/lab-cycle.yaml`:
- `backend: headless-tmux`, `kind: workflow`, 7 stages in 2 segments.
- **Segment 1 (autonomous):** stage 1 JOBS `scope` → stage 2 **STAMETS** `probe`
  (the OSINT dig via k-hole `dig-search.ts`) → stage 3 TETLOCK `register` → stage 4
  PLATT `design`.
- **THE SEAM (the one human gate):** the operator **pins the falsification bars
  before any data is seen** — "you cannot move the goalposts," encoded mechanically.
- **Segment 2:** stage 5 SETTLE (deterministic — Dune / test / market, never an LLM)
  → stage 6 TETLOCK `calibrate` (Brier).
- Desks embodied by `persona:` + `notes:` instructing the agent to read the roster
  brief. References `roster/{tetlock,platt,jobs}.md` — **not WEBB** (she didn't exist
  when it was authored).

So the seam is at **pin-bars** (between DESIGN and SETTLE), not at SETTLE itself —
the anti-p-hacking crux. SETTLE is deterministic *inside* segment 2. Correct and
proven; the enrichments below do not move it.

## Enrichment 1 — add WEBB as stage 0 (`nominate`)

`lab-cycle` today starts at JOBS `scope`, which assumes the question already exists.
SETTLE-003 proved the question often comes from the **firehose**, not the operator's
head (the Kintara candidate was an Ansem repost). Add an optional upstream stage:

```yaml
  - stage: 0
    name: nominate
    construct: general-purpose
    persona: WEBB
    mode: fresh
    reads: [Intent, Operator-Model]      # Intent here = a raw signal / firehose item
    writes: [Artifact, Signal]            # → a candidate question + why-now
    role: primary
    thinking_effort: medium
    optional: true                        # skip when the operator brings the question
    notes: >
      EMBODY WEBB (read grimoires/loa/lab/roster/webb.md — the Weak-Signals desk).
      Given a fringe signal (a tweet, a trend, an anomaly), return a CANDIDATE
      QUESTION worth settling + the why-now (CIPHER: is its trajectory bending
      mainstream?). You NOMINATE; you never settle. Hand the candidate to JOBS to
      scope. When the SIGINT sensor (grok) is live, this stage's input is a standing
      firehose query, not a manual paste (see SIGINT-WIRING.md).
```

WEBB → JOBS is the natural funnel: WEBB finds *what's worth checking*, JOBS cuts it
to *the thinnest settle-able version*. Optional so an operator-brought question still
enters at stage 1 unchanged.

## Enrichment 2 — harden every stage with `mandated_reads`

The estate's runtime-fit defect: **construct adapters ignore task inputs** (observed
0/4 dispatches honored mandated reads in the cost-of-play run) — a stage that doesn't
*force* its reads can emit `converged: true` theater. `lab-cycle` uses `notes:` prose
("read roster/jobs.md") which is a request, not a gate. Proposal: add an explicit
`mandated_reads` list per stage AND assert in each segment's `valid_run` that the
files were actually opened (the proof-of-run already gates the composition; extend it
to cover reads). Minimum pinned set:

| stage | mandated_reads (pinned, asserted in valid_run) |
|---|---|
| 0 nominate (WEBB) | `roster/webb.md` |
| 1 scope (JOBS) | `roster/jobs.md` |
| 2 probe (STAMETS) | `METHODOLOGY.md` §1, `src/research/probe.ts` |
| 3 register (TETLOCK) | `roster/tetlock.md`, `src/research/spine-ledger.ts` |
| 4 design (PLATT) | `roster/platt.md`, `src/research/schemas/tetlock-forecast.ts` |
| 6 calibrate (TETLOCK) | `roster/tetlock.md` + the measured settle result |

This is the cheapest insurance against persona-fidelity drift — the desks are only as
real as the briefs they actually read.

## Enrichment 3 — the discrimination acceptance test

`lab-cycle` proves a *run* happened (`valid_run`). It does not yet prove the loop
*discriminates*. SETTLE-003 gives us the regression test: the loop must return
**different verdicts on different realities.** Pin two golden inputs:

| golden input | expected verdict | source |
|---|---|---|
| x402x SettlementRouter (Base) | **HELD[theater]** | SETTLE-001/002 |
| Kintara $KINS (Solana) | **HELD[real]** | SETTLE-003 |

A `lab-cycle` change that flips either verdict (or returns the same verdict for both)
is a regression — the instrument has stopped discriminating. This is the lab's
equivalent of a snapshot test, and it's the single most important guarantee: an
instrument that can't tell x402 from Kintara is broken, however green its `valid_run`.

## Model-tier note (the /compose emitter routes by tier)

When the desks graduate to stub manifests, declare `capabilities.model_tier` so the
emitter routes honestly (tier SoT = `loa-hounfour`; read via
`.claude/defaults/model-config.yaml`). PLATT (design rigor) and STAMETS (probe
reasoning) warrant `max`/`high`; JOBS/TETLOCK transcription warrant `mid`; SETTLE and
REGISTER are **not model calls** (deterministic instrument / file append) — declaring
them model-free is the honest downgrade (don't pay opus to append a JSONL line). Today
`lab-cycle` sets `thinking_effort` per stage (medium/high), which is the prompted-
embodiment analog — already correct in spirit.

## Boundary

These are ADDITIVE proposals to a working composition, not a rewrite. None moves the
pin-bars seam (the epistemic crux) or lets an LLM settle (epistemology §4). Applying
them is a System-Zone-adjacent edit to `lab-cycle.yaml` — gated, not done here. This
doc specifies; the operator (or a composition-authoring pass via the compositions
substrate) applies.

## Read next
- the SoT: `~/.loa/constructs/substrates/construct-compositions/compositions/experimentation/lab-cycle.yaml`
- `grimoires/loa/lab/METHODOLOGY.md` — the loop the composition encodes
- `grimoires/loa/lab/roster/webb.md` — the desk Enrichment 1 adds
- `grimoires/loa/lab/SETTLES.md` — the three runs Enrichment 3 turns into golden tests
