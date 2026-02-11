# Sprint 28: Incremental Pipeline + Ecosystem Integration — Implementation Report

> **Cycle**: cycle-011 (Ground Truth v2)
> **Global Sprint ID**: 28
> **Branch**: `feature/ground-truth-v2`
> **Status**: All 7 tasks completed

## Summary

Added per-section dependency tracking to the generation manifest, staleness detection for both document sections and analogy bank entries, incremental regeneration support in SKILL.md, `grounded_in` fields for all 12 analogies, quality gate metrics export in Hounfour-compatible JSONL format, and a 20-test E2E validation suite.

## Tasks Completed

### 2.1 — Per-Section Dependency Tracker
- **File**: `.claude/scripts/ground-truth/extract-section-deps.sh` (new, 96 lines)
- **File**: `.claude/scripts/ground-truth/write-manifest.sh` (modified, 115 lines — was 105)
- **Implementation**: Parses each section's citations into `{path, line_start, line_end}` objects with section `content_hash`. Manifest entries now include a `sections` array.
- **Verified**: capability-brief has 12 sections (8 with citations), architecture-overview has 11 sections (6 with citations)

### 2.2 — Staleness Detector
- **File**: `.claude/scripts/ground-truth/check-staleness.sh` (new, 118 lines)
- **Implementation**: Reads manifest sections, compares each cited file's current git hash against the stored `head_sha` version. Outputs stale sections with changed file details.
- **Verified**: Returns 0 stale sections on current state, correctly returns exit 2 for missing manifest

### 2.3 — Incremental SKILL.md Workflow
- **File**: `.claude/skills/ground-truth/SKILL.md` (modified, +20 lines)
- **Implementation**: Added `--incremental` flag documentation. When set, runs `check-staleness.sh` to identify stale sections, regenerates only those sections, preserves non-stale sections byte-for-byte, then runs VERIFY on full document.
- **Verified**: Prompt workflow correctly documents incremental path

### 2.4 — Analogy Bank `grounded_in` Field
- **File**: `.claude/skills/ground-truth/resources/analogies/analogy-bank.yaml` (modified)
- **Implementation**: All 12 analogies now have `grounded_in` arrays pointing to specific source files. 14 unique repo-relative paths across all analogies.
- **Verified**: All 14 paths validated by `git ls-files` (all exist in repo)

### 2.5 — Analogy Staleness Checker
- **File**: `.claude/scripts/ground-truth/check-analogy-staleness.sh` (new, 114 lines)
- **File**: `.claude/scripts/ground-truth/quality-gates.sh` (modified, +16 lines — Gate W4)
- **Implementation**: Reads analogy-bank.yaml, checks each `grounded_in` path's current hash against baseline SHA from manifest. Integrated as WARNING Gate W4 in quality-gates.sh.
- **Verified**: All 12 analogies current, 0 stale. Gate W4 runs without affecting blocking gate results.

### 2.6 — Quality Gate Metrics Exporter
- **File**: `.claude/scripts/ground-truth/export-gate-metrics.sh` (new, 107 lines)
- **File**: `grimoires/loa/ground-truth/gate-metrics.jsonl` (auto-generated)
- **Implementation**: Runs quality-gates.sh, extracts per-gate pass/fail, appends JSONL entry with timestamp, doc_type, model, overall, citations_verified, repair_iterations, gate_results, head_sha.
- **Verified**: Both document types exported. JSONL format includes `model` field for per-model comparison. Hounfour-compatible.

### 2.7 — E2E Validation Test
- **File**: `tests/ground-truth/test-incremental-pipeline.sh` (new, 232 lines)
- **Implementation**: 20 tests across 7 sections: extract-section-deps (5), check-staleness (3), check-analogy-staleness (2), export-gate-metrics (4), write-manifest (2), quality-gates W4 (1), cross-pipeline (1), regression (2).
- **Verified**: All 20 tests pass. Existing unit (27) and property (100) tests also pass.

## Test Results

| Suite | Tests | Passed | Failed |
|-------|-------|--------|--------|
| Unit tests (run-tests.sh) | 27 | 27 | 0 |
| Repair loop (test-repair-loop.sh) | 12 | 12 | 0 |
| Property tests (run-property-tests.sh) | 100 | 100 | 0 |
| E2E incremental pipeline (test-incremental-pipeline.sh) | 20 | 20 | 0 |
| **Total** | **159** | **159** | **0** |

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `.claude/scripts/ground-truth/extract-section-deps.sh` | New | 96 |
| `.claude/scripts/ground-truth/write-manifest.sh` | Modified | 115 (was 105) |
| `.claude/scripts/ground-truth/check-staleness.sh` | New | 118 |
| `.claude/skills/ground-truth/SKILL.md` | Modified | 310 (was 290) |
| `.claude/skills/ground-truth/resources/analogies/analogy-bank.yaml` | Modified | 137 (was 121) |
| `.claude/scripts/ground-truth/check-analogy-staleness.sh` | New | 114 |
| `.claude/scripts/ground-truth/quality-gates.sh` | Modified | 294 (was 278) |
| `.claude/scripts/ground-truth/export-gate-metrics.sh` | New | 107 |
| `grimoires/loa/ground-truth/gate-metrics.jsonl` | New (auto-generated) | 2 |
| `tests/ground-truth/test-incremental-pipeline.sh` | New | 232 |

## Acceptance Criteria Status

- [x] `generation-manifest.json` tracks per-section checksums and cited file paths
- [x] When a cited file changes, only sections citing that file are flagged for regeneration
- [x] `--incremental` flag in `/ground-truth` triggers section-level regeneration instead of full rewrite
- [x] Each analogy-bank.yaml entry has a `grounded_in` field pointing to specific code paths
- [x] Staleness checker detects when a `grounded_in` code path has changed since the analogy was curated
- [x] Quality gate pass rate (per model, per document type) is exported to `grimoires/loa/ground-truth/gate-metrics.jsonl`
- [x] Metrics format is consumable by Hounfour's ensemble orchestrator (#31)
