---
title: Corpus Engine (cycle-053) — delivery vs plan · consultation #2
date: 2026-07-12
status: settled-testimony
task: bd-1vp7
subject: corpus-engine-cycle-053 (non-person)
protocol: grimoires/loa/lab/CONSULTATIONS.md (run verbatim — G2)
provenance:
  method: pre-registered questions → in-repo mining (code, PRD, ledgers, git traffic) → deterministic settle via cite-check
---

# Consultation #2 — the Corpus Engine: delivered vs planned

Pre-registered questions (before mining): (1) which of the Corpus Engine PRD's
FRs are delivered vs unbuilt; (2) did it meet its own V1 bar; (3) why did work
pivot away after 2026-06-14.

## Q1 — FRs delivered vs unbuilt · HIGH

**Partially delivered — the foundations landed the same day as the PRD; the
engine did not.** Delivered: GADGET #001 graduated into src as
`src/research/realness-verdict.ts` (+ `src/research/realness-verdict.test.ts`)
and the forecast registry exists (`src/research/forecast-registry.ts`,
`src/research/schemas/tetlock-forecast.ts`) — FR-4/FR-5's substrate. Unbuilt:
the engine itself — `src/corpus` does not exist; the scheduled dispatch (FR-1),
governed dune settle (FR-2), survival re-settle (FR-3), transactional intake
(FR-6), and the discrimination benchmark gating autonomy (FR-7) have no code
(FRs enumerated at `grimoires/loa/prd.md:L62-L90`). The deterministic-core and
schema-migration tasks remain open P0 beads (`grimoires/loa/prd.md` traces
them; tracker state read 2026-07-12).
Confidence: HIGH — ≥2 independent citations, git-verbatim tier (code files +
the PRD).

## Q2 — Did it meet its own V1 bar? · HIGH

**No.** The bar is written into the PRD: *"unattended, for ≥2 consecutive
scheduled cycles"* (`grimoires/loa/prd.md:L42-L42`). No scheduled run ever
happened: the dispatch path (FR-1) is unbuilt, and the lab's calibration
ledger (`grimoires/loa/lab/cabt-calibration-logged.jsonl`) records hand-run
entries only. The external blocker (dune-meter 405) cleared 2026-06-24 via
loa-freeside#301 with only env wiring left — the bar has been reachable for
18 days without an attempt.
Confidence: HIGH — independent citations at git-verbatim tier.

## Q3 — Why did work pivot away after 2026-06-14? · ABSTAIN

The record is silent. Commit traffic shows the pivot plainly — Corpus Engine
phase-a landed 2026-06-14 and from 2026-06-17 the energy is cabt arena +
roster work (`grimoires/loa/NOTES.md` carries the cabt lane; no
corpus-engine retro, halt note, or reprioritization decision exists anywhere
in the repo). Both candidate explanations (the cabt ladder's urgency; the
operator's zero-cost-settle preference) are uncited inferences — the
construct abstains rather than choose. **Notable pattern echo:** displacement
without verdict is the same shape the JANI consultation settled for the
founder's exits (consultation #1, Q2).

---

**Settle record:** citations validated via
`npx tsx src/lab/shop/cite-check.ts grimoires/loa/context/2026-07-12-corpus-engine-delivery-testimony.md`
(green at commit time); confidences re-derive per
`grimoires/loa/lab/CONSULTATIONS.md` rules v1 (Q1/Q2: ≥2 independent
git-verbatim citations = HIGH; Q3: record silent = ABSTAIN). One honest
ABSTAIN — the G2 acceptance's proof-of-discipline.

**Decision relevance (why this consultation was worth running):** the
reality-check's keep-conditional verdict named "Corpus Engine hits its own V1
bar" as one of two proofs that the lab deserves continued investment. This
testimony establishes the bar is 18 days reachable-but-unattempted — the
cheapest live test of the founder-pattern risk (machinery built, activation
deferred) that PRD §8 exists to counter.
