# Governance Report

> Refreshed by `/ride` 2026-06-12 (EXP-004 lens). 2026-06-08 findings carried forward.

## Artifact Presence

| Artifact | Present | Notes |
|----------|---------|-------|
| `CHANGELOG.md` | YES | Keep-a-Changelog + semver; includes glossary |
| `CONTRIBUTING.md` | YES | 9KB — dev setup, workflow, standards |
| `SECURITY.md` | YES | 15KB — auth architecture, audit trail, vuln reporting |
| `.github/CODEOWNERS` | YES | Auto-assigns reviewers (maintainer @janitooor) |
| Semver tags | YES | **230 tags** (latest reachable from `feature/score-phase1` HEAD = `v1.67.0`) — disciplined release cadence |
| `LICENSE.md` | YES | GNU AGPL-3.0 |
| ADRs | PARTIAL | Only 2 (`docs/adr/ADR-001`, `ADR-002`) — both about provenance taxonomy |
| Issue/PR templates | YES | `.github/ISSUE_TEMPLATE/*`, `PULL_REQUEST_TEMPLATE.md` |
| Branch protection doc | YES | `.github/BRANCH_PROTECTION.md` |

## Score: 9/10 — Strong governance

Mature release process (230 semver tags), full contributor/security/ownership docs, CI templates.

## Gaps / Recommendations

1. **License field mismatch (CRITICAL)**: `package.json` `"license": "MIT"` contradicts AGPL-3.0
   `LICENSE.md` + README. Fix to `AGPL-3.0-or-later`. (See drift-report.md.)
2. **ADR coverage thin**: Only provenance-taxonomy decisions are recorded. Major architectural
   decisions (economic layer, x402 chain choice, single-writer WAL, arrakis S2S boundary,
   substrate runtime) have no ADRs — captured only in sprint/PRD docs. Recommend backfilling ADRs.
3. **Module docs lag code**: `docs/modules/` covers ~8 of 27 modules; `score`, `cost`, `substrate`
   have no module doc (see INVENTORY.md).
4. **Experiment-program provenance is strong**: EXP-001/002/003 each carry pre-registered bars +
   settled verdict artifacts (`readout.json`, `exp3-c1/c2-settle.md`) — the measurement-register
   discipline from `epistemology-deterministic-layers.md` is honored by convention (no code gate enforces it).
