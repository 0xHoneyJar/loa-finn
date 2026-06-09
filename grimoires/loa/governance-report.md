# Governance Report

> `/ride --enriched` 2026-06-08.

## Artifact Presence

| Artifact | Present | Notes |
|----------|---------|-------|
| `CHANGELOG.md` | YES | Keep-a-Changelog + semver; includes glossary |
| `CONTRIBUTING.md` | YES | 9KB — dev setup, workflow, standards |
| `SECURITY.md` | YES | 15KB — auth architecture, audit trail, vuln reporting |
| `.github/CODEOWNERS` | YES | Auto-assigns reviewers (maintainer @janitooor) |
| Semver tags | YES | **230 tags**, latest `v1.115.0` — disciplined release cadence |
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
3. **Module docs lag code**: `docs/modules/` covers 8 of 28 modules (see INVENTORY.md).
