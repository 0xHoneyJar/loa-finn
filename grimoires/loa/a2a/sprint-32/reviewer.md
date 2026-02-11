# Sprint 32 Implementation Report

**Sprint**: Sprint 1 — Tooling & Templates (Global ID: 32)
**Cycle**: cycle-013 (Documentation Rewrite)
**Branch**: `feature/docs-rewrite`
**Date**: 2026-02-11

## Summary

All 18 tasks completed. Created 8 document templates, 7 quality gate scripts (2 new + 5 updated), 2 integration tests, security banned-terms infrastructure, and generation manifest tooling.

## Tasks Completed (18/18)

### Templates (Tasks 1.1–1.8) — All CLOSED

| Task | File | Status |
|------|------|--------|
| 1.1 readme.md | `.claude/skills/ground-truth/resources/templates/readme.md` | CLOSED (bd-1p2) |
| 1.2 module-doc.md | `.claude/skills/ground-truth/resources/templates/module-doc.md` | CLOSED (bd-1d9) |
| 1.3 operations-guide.md | `.claude/skills/ground-truth/resources/templates/operations-guide.md` | CLOSED (bd-250) |
| 1.4 api-reference.md | `.claude/skills/ground-truth/resources/templates/api-reference.md` | CLOSED (bd-f6z) |
| 1.5 security-doc.md | `.claude/skills/ground-truth/resources/templates/security-doc.md` | CLOSED (bd-6nk) |
| 1.6 contributing.md | `.claude/skills/ground-truth/resources/templates/contributing.md` | CLOSED (bd-1mw) |
| 1.7 changelog.md | `.claude/skills/ground-truth/resources/templates/changelog.md` | CLOSED (bd-1jb) |
| 1.8 index.md | `.claude/skills/ground-truth/resources/templates/index.md` | CLOSED (bd-ni3) |

All templates include TEMPLATE-META blocks with: type, size_limit, provenance_min, required_sections, and template-specific variables per SDD §3.3.

### Shell Scripts (Tasks 1.9–1.17) — All CLOSED

| Task | File | Status |
|------|------|--------|
| 1.9 check-agent-context.sh | `.claude/scripts/ground-truth/check-agent-context.sh` | CLOSED (bd-1mm) |
| 1.10 check-claim-grounding.sh | `.claude/scripts/ground-truth/check-claim-grounding.sh` | CLOSED (bd-3oy) |
| 1.11 export-gate-metrics.sh | `.claude/scripts/ground-truth/export-gate-metrics.sh` | CLOSED (bd-3od) |
| 1.12 banned-security-terms.txt | `grimoires/loa/ground-truth/banned-security-terms.txt` | CLOSED (bd-wtz1) |
| 1.13 quality-gates.sh | `.claude/scripts/ground-truth/quality-gates.sh` | CLOSED (bd-3kn4) |
| 1.14 test-pipeline-smoke.sh | `.claude/scripts/ground-truth/test-pipeline-smoke.sh` | CLOSED (bd-1484) |
| 1.15 test-gate-repair-loop.sh | `.claude/scripts/ground-truth/test-gate-repair-loop.sh` | CLOSED (bd-mqkc) |
| 1.16 update-generation-manifest.sh | `.claude/scripts/ground-truth/update-generation-manifest.sh` | CLOSED (bd-3d22) |
| 1.17 check-links.sh | `.claude/scripts/ground-truth/check-links.sh` | CLOSED (bd-3sxp) |

### Verification (Task 1.18) — CLOSED

| Task | Status |
|------|--------|
| 1.18 Verify architecture-overview template | CLOSED (bd-hkqz) — pre-existing template confirmed |

## Test Results

### Smoke Test: 32/32 passing

```
Pipeline Smoke Test: 32/32 passed
```

- 10 template existence checks (8 new + 2 pre-existing)
- 8 TEMPLATE-META block validation checks
- 7 gate script existence + executable checks
- 3 quality-gates.sh integration checks (runs, valid JSON, schema)
- 1 metrics append check
- 2 security terms file checks
- 1 manifest script check

### REPAIR Loop Test: PASS (3 iterations)

```
PASS: REPAIR loop converged in 3 iteration(s) (max: 3)
```

- Iteration 1: Detected missing `version` field → REPAIR added commit hash
- Iteration 2: Detected unverifiable evidence anchor → REPAIR removed anchor
- Iteration 3: All gates PASSED

## Architecture Decisions

### 1. Quality Gate Pipeline (SDD §5.3)

Reordered quality-gates.sh to 7-gate blocking pipeline:

1. **check-agent-context** — Schema validation (MUST run first)
2. **verify-citations** — Citation resolution
3. **check-provenance** — Paragraph provenance ≥80%
4. **check-claim-grounding** — CODE-FACTUAL claim coverage
5. **scan-banned-terms** — Marketing + security patterns
6. **check-links** — Relative link validation
7. **export-gate-metrics** — Append to gate-metrics.jsonl (non-blocking)

Plus inline gates: freshness-check, registry-consistency.
Plus warning gates: analogy-accuracy, mechanism-density, symbol-specificity, analogy-staleness.

### 2. JSON Output Safety

All JSON construction uses `jq` for proper escaping:
- `run_gate()` uses `printf '%s' | jq -Rs .` for output escaping
- `warnings_json` built via `jq -nc` with `--arg` parameters
- Final JSON output uses `jq -nc` with `--argjson`/`--arg` parameters
- Numeric values validated with `[[ =~ ^[0-9]+$ ]]` guards

### 3. Two-Tier Claim Grounding (SDD §5.2)

- **Tier 1** (citation-present): Validates `file:line` and `symbol=` references
- **Tier 2** (verb-pattern): Checks for mechanism verbs in CODE-FACTUAL sections
- Exempt patterns: "See", "For more", "Refer to", link-only sentences

### 4. AGENT-CONTEXT Parser (SDD §4.2)

Field boundary detection uses known-field regex to prevent parsing errors when values contain commas:
```bash
KNOWN_FIELDS="name|type|purpose|key_files|interfaces|dependencies|version"
```

### 5. Security Terms Infrastructure

- `banned-security-terms.txt`: Patterns for API keys, internal hostnames, PEM blocks, DB connection strings
- `banned-security-allow.txt`: RFC5737 IPs, loopback addresses, placeholder tokens
- Integrated as additional scan in quality-gates.sh gate 5

## Files Changed

### New Files (16)

| Path | Type | Lines |
|------|------|-------|
| `.claude/skills/ground-truth/resources/templates/readme.md` | Template | ~60 |
| `.claude/skills/ground-truth/resources/templates/module-doc.md` | Template | ~80 |
| `.claude/skills/ground-truth/resources/templates/operations-guide.md` | Template | ~90 |
| `.claude/skills/ground-truth/resources/templates/api-reference.md` | Template | ~85 |
| `.claude/skills/ground-truth/resources/templates/security-doc.md` | Template | ~95 |
| `.claude/skills/ground-truth/resources/templates/contributing.md` | Template | ~75 |
| `.claude/skills/ground-truth/resources/templates/changelog.md` | Template | ~50 |
| `.claude/skills/ground-truth/resources/templates/index.md` | Template | ~55 |
| `.claude/scripts/ground-truth/check-agent-context.sh` | Gate script | 191 |
| `.claude/scripts/ground-truth/check-claim-grounding.sh` | Gate script | ~150 |
| `.claude/scripts/ground-truth/check-links.sh` | Gate script | 119 |
| `.claude/scripts/ground-truth/update-generation-manifest.sh` | Gate script | 100 |
| `.claude/scripts/ground-truth/test-pipeline-smoke.sh` | Test | 173 |
| `.claude/scripts/ground-truth/test-gate-repair-loop.sh` | Test | ~115 |
| `grimoires/loa/ground-truth/banned-security-terms.txt` | Config | ~30 |
| `grimoires/loa/ground-truth/banned-security-allow.txt` | Config | ~10 |

### Modified Files (2)

| Path | Changes |
|------|---------|
| `.claude/scripts/ground-truth/quality-gates.sh` | Reordered to 7-gate pipeline, added JSON safety via jq |
| `.claude/scripts/ground-truth/export-gate-metrics.sh` | Added pipeline mode (--gates-json), SDD §5.4 schema |

## Bugs Found & Fixed During Implementation

1. **AGENT-CONTEXT field parsing**: `key_files=README.md, version=...` was parsed as a single value. Fixed with `KNOWN_FIELDS` boundary detection regex.
2. **untagged_count newlines**: `jq -r` output contained trailing newlines that broke `[[ ]]` arithmetic. Fixed with `tr -d '[:space:]'` and numeric validation.
3. **warnings_json control characters**: Raw string concatenation embedded unescaped newlines and UTF-8 chars (em-dash, ≥) in JSON. Fixed by building entire warnings array via `jq -nc`.
4. **check-links.sh regex**: Inline `[[ =~ ]]` regex with escaped `]` caused syntax error. Fixed by storing regex in variable first.
5. **Smoke test metrics ordering**: `line_count_before` was captured after quality-gates ran, so metrics append was never detected. Fixed by capturing before the run.

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| 8 new templates with TEMPLATE-META blocks | PASS |
| All templates match SDD §3.3 specification | PASS |
| 7 quality gate scripts executable | PASS |
| quality-gates.sh produces valid JSON output | PASS |
| Smoke test covers all components | PASS (32/32) |
| REPAIR loop converges in ≤3 iterations | PASS (3 iterations) |
| Security banned-terms infrastructure | PASS |
| Generation manifest script | PASS |
| Pre-existing templates preserved | PASS |
