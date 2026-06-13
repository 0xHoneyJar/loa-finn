# Trajectory Self-Audit — /ride (EXP-004 grounding pass)

> Generated 2026-06-12. Self-audit of the ride's reasoning quality and grounding. This pass refreshed
> the experiment-program + score/cost/substrate surface; it is NOT a full from-scratch ride.

## Execution Summary

| Phase | Action | Status | Output / Finding |
|-------|--------|--------|------------------|
| 0 | Preflight | complete | Loa 1.99.2; target = loa-finn (self); branch `feature/score-phase1` |
| 0.6 | Staleness | complete (override) | prior ride 4 days old (fresh), but operator's explicit EXP-004 re-ride + EXP-003 GO landed today → proceed |
| 0.5 | Probe | complete | 363 files / 83.6K LOC; large codebase → 2-agent Explore fan-out (code + docs) |
| 2 | Extraction | refreshed | 87 routes, 142 env vars, 14 tech-debt, 381 tests; score/cost/substrate mapped |
| 4 | Drift (3-way) | complete | Score 4.0; 1 CRITICAL status-drift (EXP-004 gap), 2 stale theses, 5 over-claims |
| 5 | Consistency | refreshed | 8/10; added C5 (score-core hexagonal + `precisionBar` placeholder) |
| 6 | PRD/SDD | NOT regenerated (by design) | `prd-finn-economy-os.md` / `sdd-finn-economy-os.md` are the product SoT; stale claims flagged, not overwritten |
| 6.5 | Reality files | refreshed | index, architecture-overview, .reality-meta refreshed with experiment program + score pipeline |
| 7 | Governance | refreshed | 9/10; experiment-program provenance noted strong |
| 9 | Self-audit | complete | this file |

## Grounding Analysis

The primary deliverable is `drift-report.md` (three-way, EXP-004 lens). Every claim is GROUNDED to a
`file:line` or a verdict artifact:
- Score gap: `src/score/edge/adapters.ts:22,36` (NotImplementedError), `screen.ts:5,37`, `index.ts:1-13`.
- Cost-of-play falsification: `readout.json` (H1 93.7%, H2 R²=0.018, H3 74 ms) vs `arch-finn-cost-of-play.md:16`.
- EXP-003 GO: `exp3-c2-settle.md:19-23,39,46-52` vs `prd-finn-economy-os.md:68-70`.
- Cost meter alignment: `src/cost/cost-atom.ts:30-71,346-394` ↔ `experiment-economics.md:29-33`.
GROUNDED ratio on the drift report's load-bearing claims: ~95% (the rest are FINDING-class artifacts
flagged for primary-source per the program's own epistemology discipline).

## Claims Requiring Validation (forward to operator)

1. **EXP-004 scope = Sprint 2 + Sprint 3** of `sprint-finn-score.md` — confirm this maps the "real sybil
   layer + labeled validation harness" graduation gate as intended.
2. **arch-finn-cost-of-play.md amendment** — the infra-dominated lede is falsified; confirm whether to
   amend the doc or leave it as a pre-registration record with the readout as the correction.
3. **PRD vertical-first amendment** — confirm folding the EXP-003 GO into PRD §1.2/§7.
4. **License (carried CRITICAL)** — `package.json:6` MIT vs AGPL-3.0; confirm the correct SPDX id.

## Hallucination Checklist

| Check | Result |
|-------|--------|
| Every drift claim cites a file:line or verdict artifact | YES |
| "Screen exists" distinguished from "sybil layer ships" | YES (status-drift framing, §1) |
| Falsified hypotheses attributed to the experiment's OWN readout, not invented | YES (`readout.json`) |
| EXP-003 GO quoted from settle artifacts, not paraphrased from memory | YES (`exp3-c1/c2-settle.md`) |
| Product PRD/SDD preserved (not clobbered) | YES (precedent: 06-08 judgment call) |
| No invented score endpoints (screen is internal-only) | YES (`screen.ts:5`) |

## Key Judgment Call

Did NOT regenerate `prd.md` / `sdd.md` or the rich `prd-finn-economy-os.md` / `sdd-finn-economy-os.md`.
The operator's ask was reality extraction + three-way drift toward EXP-004, not a product-doc rewrite.
Overwriting hand-authored product docs would be destructive and lossy (same call the 06-08 ride made).
Stale claims in those docs are surfaced in `drift-report.md` §2-3 with exact citations and recommended
amendments, leaving the promotion decision to the operator (force-chain discipline).

## Reasoning Quality Score: 9/10

Strong: the central EXP-004 finding is fully grounded and the #269 lesson maps cleanly onto code
(formula built, substrate unvalidated). One point withheld: no live operator interview (kaironic
re-ride), so the EXP-004 scope mapping rests on the sprint plan + settle artifacts, pending operator
confirmation of the four validation items above.
