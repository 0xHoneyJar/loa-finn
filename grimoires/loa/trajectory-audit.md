# Trajectory Self-Audit — /ride --enriched

> Generated 2026-06-08. Self-audit of the ride's reasoning quality and grounding.

## Execution Summary

| Phase | Action | Status | Output / Finding |
|-------|--------|--------|------------------|
| 0 | Preflight | complete | Loa 1.99.2; target = loa-finn; checksums present |
| 0.5 | Probe | complete | 359 files / 81.6K LOC → prioritized strategy (large) |
| 1 | Claims | complete (non-interactive) | 18 claims from context files (no live interview — agent run) |
| 2 | Extraction | complete | 105 routes, 125 env vars, 14 tech-debt, 374 tests, 10 tables |
| 2b | Hygiene | complete | 5 flagged (spike dir, backups, dup lockfile, deprecated aliases) |
| 3 | Legacy inventory | complete | 146 docs; CLAUDE.md 3/7 |
| 4 | Drift | complete | Score 6.5; 1 critical (license), 9 shadow modules, 4 stale |
| 5 | Consistency | complete | Score 8/10 |
| 6 | PRD/SDD | complete | Written to `*-ride-reality.md` (preserved hand-authored prd.md/sdd.md) |
| 6.5 | Reality files | complete | 9 files, ~5770 tokens (budget 8500) |
| 7 | Governance | complete | Score 9/10; 230 tags |
| 8 | Legacy deprecation | **skipped** | Blanket-deprecating real docs would be destructive |
| 9 | Self-audit | complete | this file |
| 12 | Gap tracker | complete | 7 gaps (GAP-001..007-a51c) |
| 13 | Decision archaeology | complete | 2 ADRs (both current); major-decision ADR gap filed |
| 14 | Terminology | complete | 30 terms, 6 domains |

## Grounding Analysis

- **PRD** (`prd-ride-reality.md`): ~33 GROUNDED, 1 INFERRED, 4 ASSUMPTION (roadmap). ~87% grounded
  of current-behavior claims. Target (>80%) met.
- **SDD** (`sdd-ride-reality.md`): ~40 GROUNDED, 2 INFERRED, 0 ASSUMPTION. ~95% grounded. Target met.

## Claims Requiring Validation

1. License intent (GAP-001) — MIT vs AGPL.
2. THE PLAN v3 build-target commitment (GAP-005) — roadmap items are candidate, not implemented.
3. Horizontal-scaling intent (GAP-003) — README vs scale-out-design doc.

## Hallucination Checklist

| Check | Result |
|-------|--------|
| Every PRD/SDD feature cites a file path | YES |
| Roadmap items clearly separated from current behavior | YES ([ASSUMPTION]/§5) |
| No invented endpoints | YES (routes from `server.ts` grep) |
| No invented DB tables | YES (10 from `schema.ts`) |
| Module file counts measured, not estimated | YES (`find` counts) |
| License claim cross-checked | YES (LICENSE.md + package.json + README) |

## Key Judgment Call

The repo's `grimoires/loa/prd.md` and `sdd.md` are **genuine hand-authored, feature-specific**
documents (Per-NFT Personality, Jani+Claude, 2026-03-26), not stale ride output. Overwriting them
would have destroyed real planning work and violated zone-state safety. The ride wrote its
whole-system reverse-engineered artifacts to `prd-ride-reality.md` / `sdd-ride-reality.md` instead.
This is the conservative, reversible, evidence-respecting choice.

## Reasoning Quality Score: 9/10

Strong grounding (README provenance tags + config.ts + schema.ts + measured counts). One point
withheld: no live operator interview was possible (agent invocation), so tribal-knowledge claims
rest on documentation rather than operator confirmation.
