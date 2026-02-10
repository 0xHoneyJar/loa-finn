# Sprint Plan: Ground Truth v2 — Verification Hardening & Incremental Pipeline

> **Cycle**: cycle-011
> **Branch**: `feature/ground-truth-v2`
> **Source**: PR #51 BridgeBuilder review findings (5 critical improvements + 1 ecosystem integration)
> **PRD**: `grimoires/loa/prd-ground-truth.md` v1.1.0
> **SDD**: `grimoires/loa/sdd-ground-truth.md` v1.1.0
> **Predecessor**: cycle-010 (Ground Truth v1.0.0 — 2 sprints, 26 tasks, all completed)

---

## Executive Summary

PR #51's BridgeBuilder review identified 5 concrete improvements to the Ground Truth verification pipeline and 1 ecosystem integration point. These improvements evolve the verification layer from **pragmatic heuristics** (±10 line proximity, example-based tests, full regeneration) to **structural guarantees** (AST-based resolution, property-based tests, incremental pipeline).

The improvements are organized into 2 sprints:

| Sprint | Theme | Tasks | Global ID |
|--------|-------|-------|-----------|
| Sprint 1 | Structural Verification + Property Testing | 8 | 27 |
| Sprint 2 | Incremental Pipeline + Ecosystem Integration | 7 | 28 |

**Total**: 15 tasks across 2 sprints.

---

## Sprint 1: Structural Verification + Property Testing

> **Global ID**: sprint-27
> **Goal**: Replace the ±10 line proximity heuristic with AST-based evidence anchor resolution, add TF-IDF specificity thresholds for evidence symbols, and introduce property-based testing for all verification scripts.

### Deliverables

- [x] AST-based evidence anchor resolver in `verify-citations.sh`
- [x] TF-IDF symbol specificity checker script
- [x] Property-based test generator for verification scripts
- [x] Updated test suite with structural + property tests passing

### Acceptance Criteria

- [x] Evidence anchors are resolved by parsing markdown section structure, not ±10 line proximity
- [x] Each evidence anchor is associated with its nearest *preceding* citation within the same `##` section
- [x] Two CODE-FACTUAL paragraphs within 10 lines of each other no longer confuse the verifier (the regression from Sprint 2 cycle-010)
- [x] Evidence anchor symbols with TF-IDF score below threshold (configurable, default 0.01) trigger a warning
- [x] Common symbols (`export`, `const`, `function`, `import`, `return`) are rejected as evidence anchors
- [x] Property-based test generator produces 50+ random valid documents that all pass quality gates
- [x] Property-based test generator produces 50+ random invalid documents that all fail the appropriate gate
- [x] All existing tests (23 unit + 12 integration = 35 total) continue to pass
- [x] New property tests added to `tests/ground-truth/`

### Technical Tasks

- [x] **1.1 — Markdown section parser** → **[G-1]**
  Build a bash/awk function that parses a markdown document into a section tree. Each `##` heading starts a new section. Track section boundaries (start line, end line) and nesting depth. Output: JSON array of `{heading, start_line, end_line, depth}`.
  - **File**: `.claude/scripts/ground-truth/parse-sections.sh`
  - **AC**: Correctly identifies all `##` sections in `capability-brief.md` and `architecture-overview.md`
  - **Dependencies**: None

- [x] **1.2 — AST-based evidence anchor resolution** → **[G-1]**
  Rewrite `verify-citations.sh` Step 5 (EVIDENCE_ANCHOR) to use the section parser from 1.1. For each `<!-- evidence: ... -->` tag, find the nearest *preceding* citation within the same section (not ±10 lines). Fall back to same-section search if no preceding citation found.
  - **File**: `.claude/scripts/ground-truth/verify-citations.sh` (lines 152-212)
  - **AC**: The 14-failure regression from architecture-overview generation (cycle-010 Sprint 2 iteration 1) would not occur with the new resolver
  - **Dependencies**: 1.1

- [x] **1.3 — Section-scoped citation index** → **[G-1]**
  During Step 1 (EXTRACT), build a per-section citation index: `{section_heading → [{citation, line_num}]}`. This index is consumed by Step 5 instead of the ±10 line context search.
  - **File**: `.claude/scripts/ground-truth/verify-citations.sh` (lines 33-56)
  - **AC**: Index correctly maps all citations in both generated documents to their containing sections
  - **Dependencies**: 1.1

- [x] **1.4 — TF-IDF symbol scorer** → **[G-1]**
  Create a script that computes approximate TF-IDF scores for symbols across the codebase. For each evidence anchor symbol, compute: `TF = occurrences in cited file / total symbols in file`, `IDF = log(total files / files containing symbol)`. Symbols with `TF-IDF < threshold` emit a WARNING.
  - **File**: `.claude/scripts/ground-truth/score-symbol-specificity.sh`
  - **AC**: `WALManager` scores higher than `export`; `createApp` scores higher than `const`
  - **AC**: Common JS/TS keywords (`export`, `const`, `function`, `import`, `return`, `async`, `class`, `interface`, `type`) are on a built-in reject list regardless of TF-IDF score
  - **Dependencies**: None

- [x] **1.5 — Integrate specificity into quality gates** → **[G-1]**
  Add a new WARNING gate to `quality-gates.sh` that runs `score-symbol-specificity.sh` on each evidence anchor. Non-blocking (warning only) for v2.0 — may become blocking in v3.
  - **File**: `.claude/scripts/ground-truth/quality-gates.sh`
  - **AC**: Quality gates output includes `symbol-specificity` gate with per-anchor scores
  - **Dependencies**: 1.4

- [x] **1.6 — Property-based test generator** → **[G-2]**
  Create a script that generates random valid and invalid Ground Truth documents. Valid documents have correct provenance tags, real citations, matching evidence anchors. Invalid documents have one specific defect each (wrong path, missing tag, banned term, bad line range, etc.).
  - **File**: `tests/ground-truth/generate-test-documents.sh`
  - **AC**: Generates ≥50 valid + ≥50 invalid documents
  - **AC**: Each invalid document has exactly one defect type, documented in a companion JSON manifest
  - **Dependencies**: None

- [x] **1.7 — Property test runner** → **[G-2]**
  Create a test harness that runs all generated documents through `quality-gates.sh` and verifies: (1) all valid documents pass, (2) all invalid documents fail, (3) each invalid document fails on the *expected* gate.
  - **File**: `tests/ground-truth/run-property-tests.sh`
  - **AC**: 100% pass rate on valid documents, 100% correct-gate-failure on invalid documents
  - **AC**: Integrates with existing `run-tests.sh` test suite
  - **Dependencies**: 1.6

- [x] **1.8 — Regression test: stacked CODE-FACTUAL paragraphs** → **[G-1, G-2]**
  Add a dedicated test fixture that reproduces the 14-failure regression from cycle-010 Sprint 2: two CODE-FACTUAL paragraphs within 10 lines of each other, each with different evidence anchors. Verify the AST-based resolver correctly associates each anchor with its own citation.
  - **File**: `tests/ground-truth/fixtures/regression-stacked-code-factual.md`
  - **AC**: Test passes with AST-based resolver; would fail with ±10 line heuristic
  - **Dependencies**: 1.2

### Dependencies

- Requires cycle-010 codebase (all Ground Truth v1 scripts present)
- No external dependencies

### Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| awk-based markdown parser can't handle edge cases (nested code blocks with `##` headings inside) | Misidentified section boundaries | Use state machine with IN_FENCE state (already proven in `check-provenance.sh`) |
| TF-IDF computation expensive on large codebases | Slow quality gates | Cache symbol frequencies per HEAD SHA in `generation-manifest.json` |
| Property test generator produces unrealistic documents | Tests pass but don't catch real bugs | Base generator templates on actual `capability-brief.md` and `architecture-overview.md` structure |

### Success Metrics

- 0 regressions in existing 35 tests
- ≥100 property tests (50 valid + 50 invalid) passing
- Stacked CODE-FACTUAL regression test passes
- Evidence anchor resolution is section-scoped, not proximity-based

---

## Sprint 2: Incremental Pipeline + Ecosystem Integration

> **Global ID**: sprint-28
> **Goal**: Enable incremental document regeneration based on per-section dependency tracking, add analogy bank staleness detection, and export quality gate metrics as a Hounfour routing signal.

### Deliverables

- [x] Per-section citation dependency graph in `generation-manifest.json`
- [x] Incremental regeneration mode in SKILL.md
- [x] Analogy bank staleness checker with `grounded_in` field
- [x] Quality gate metrics exporter for Hounfour routing

### Acceptance Criteria

- [x] `generation-manifest.json` tracks per-section checksums and cited file paths
- [x] When a cited file changes, only sections citing that file are flagged for regeneration
- [x] `--incremental` flag in `/ground-truth` triggers section-level regeneration instead of full rewrite
- [x] Each analogy-bank.yaml entry has a `grounded_in` field pointing to specific code paths
- [x] Staleness checker detects when a `grounded_in` code path has changed since the analogy was curated
- [x] Quality gate pass rate (per model, per document type) is exported to `grimoires/loa/ground-truth/gate-metrics.jsonl`
- [x] Metrics format is consumable by Hounfour's ensemble orchestrator (#31)

### Technical Tasks

- [x] **2.1 — Per-section dependency tracker** → **[G-3]**
  After each document generation, extract per-section citation dependencies: for each `##` section, list all cited `file:line` paths. Store in `generation-manifest.json` under a `sections` array with `{heading, citations: [{path, line_start, line_end}], content_hash}`.
  - **File**: `.claude/scripts/ground-truth/write-manifest.sh` (extend)
  - **File**: `.claude/scripts/ground-truth/extract-section-deps.sh` (new)
  - **AC**: Manifest has per-section entries for both generated documents
  - **Dependencies**: Sprint 1 task 1.1 (section parser)

- [x] **2.2 — Staleness detector** → **[G-3]**
  Create a script that reads `generation-manifest.json` sections, checks each cited file's current content hash against the stored `content_hash`, and outputs which sections are stale.
  - **File**: `.claude/scripts/ground-truth/check-staleness.sh`
  - **AC**: When `src/persistence/index.ts` changes, the "Durable State Management" section in capability-brief is flagged as stale
  - **AC**: When no cited files have changed, output is empty (no stale sections)
  - **Dependencies**: 2.1

- [x] **2.3 — Incremental SKILL.md workflow** → **[G-3]**
  Add `--incremental` flag support to SKILL.md. When set, the GENERATE stage receives only the stale sections from the staleness detector. The generator rewrites only those sections, preserving the rest of the document. The VERIFY stage runs on the full document.
  - **File**: `.claude/skills/ground-truth/SKILL.md` (extend Stage 3)
  - **AC**: Incremental mode regenerates only stale sections
  - **AC**: Full-document verification still runs after partial regeneration
  - **AC**: Non-stale sections are byte-identical before and after incremental regeneration
  - **Dependencies**: 2.2

- [x] **2.4 — Analogy bank `grounded_in` field** → **[G-4]**
  Extend `analogy-bank.yaml` schema with a `grounded_in` field per entry. This field contains an array of repo-relative file paths that make the structural similarity claim true. When those files change, the analogy may need re-curation.
  - **File**: `.claude/skills/ground-truth/resources/analogies/analogy-bank.yaml`
  - **AC**: All 12 existing analogies have `grounded_in` fields populated
  - **AC**: `grounded_in` paths are validated by `git ls-files` (must exist in repo)
  - **Dependencies**: None

- [x] **2.5 — Analogy staleness checker** → **[G-4]**
  Create a script that reads `analogy-bank.yaml`, checks each `grounded_in` path's current content against a stored hash, and flags analogies where the grounding code has changed.
  - **File**: `.claude/scripts/ground-truth/check-analogy-staleness.sh`
  - **AC**: When `src/persistence/index.ts` changes, the PostgreSQL WAL analogy is flagged
  - **AC**: Output includes the specific analogy entry and the changed file path
  - **AC**: Integrates as a WARNING gate in `quality-gates.sh`
  - **Dependencies**: 2.4

- [x] **2.6 — Quality gate metrics exporter** → **[G-5]**
  After each quality gate run, append a metrics entry to `grimoires/loa/ground-truth/gate-metrics.jsonl`. Each entry includes: timestamp, document type, model used (from generation metadata), gate results (pass/fail per gate), repair iterations needed, total citations verified.
  - **File**: `.claude/scripts/ground-truth/export-gate-metrics.sh`
  - **File**: `grimoires/loa/ground-truth/gate-metrics.jsonl` (auto-generated)
  - **AC**: JSONL format with one entry per generation run
  - **AC**: Includes `model` field (e.g., "claude-opus-4-6", "gpt-5.2") for per-model comparison
  - **AC**: Hounfour-compatible: can be consumed by `src/hounfour/router.ts` for routing decisions
  - **Dependencies**: None

- [x] **2.7 — E2E validation: incremental + staleness pipeline** → **[G-3, G-4, G-5]**
  End-to-end test: modify a single source file, run staleness detection, verify correct sections are flagged, run incremental regeneration, verify quality gates pass, verify metrics are exported.
  - **File**: `tests/ground-truth/test-incremental-pipeline.sh`
  - **AC**: Full pipeline from file change → staleness detect → incremental regen → verify → metrics export
  - **AC**: All existing tests continue to pass (no regressions)
  - **Dependencies**: 2.1, 2.2, 2.3, 2.5, 2.6

### Dependencies

- Sprint 1 must be completed (AST-based section parser is reused)
- Hounfour routing integration (task 2.6) is a write-only export; does not require Hounfour Phase 5 to be complete

### Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Incremental regeneration produces inconsistent documents (stale section references a new section) | Document coherence breaks | VERIFY runs on full document after partial regeneration; coherence failures caught by existing gates |
| Analogy staleness produces too many false positives (minor code changes flag all analogies) | Alert fatigue; team ignores staleness warnings | Use content hash comparison, not file modification time; threshold on change magnitude |
| Gate metrics JSONL grows unbounded | Disk usage | Add rotation policy matching `metering.ledger_rotation` config (max 50MB, 30-day archive) |

### Success Metrics

- Incremental regeneration is ≥50% faster than full regeneration (measured by section count, not wall clock)
- All 12 analogy bank entries have `grounded_in` fields
- Gate metrics JSONL has entries for both document types
- 0 regressions in all tests (35 existing + Sprint 1 property tests)

---

## Appendix A: Improvement Mapping

| PR #51 Comment | Finding | Sprint | Task(s) |
|----------------|---------|--------|---------|
| Critical Analysis §1 | ±10 line proximity heuristic is fragile | Sprint 1 | 1.1, 1.2, 1.3, 1.8 |
| Critical Analysis §2 | Verification scripts need their own verification | Sprint 1 | 1.6, 1.7 |
| Critical Analysis §3 | No incremental regeneration | Sprint 2 | 2.1, 2.2, 2.3, 2.7 |
| Critical Analysis §4 | Analogy bank is static | Sprint 2 | 2.4, 2.5 |
| Critical Analysis §5 | Evidence anchor specificity threshold | Sprint 1 | 1.4, 1.5 |
| Hounfour Connection | Multi-model quality gate routing signal | Sprint 2 | 2.6 |

## Appendix B: Goal Traceability

| ID | Goal | Sprint Tasks |
|----|------|-------------|
| G-1 | Structural verification replacing proximity heuristics | 1.1, 1.2, 1.3, 1.4, 1.5, 1.8 |
| G-2 | Property-based testing for verification scripts | 1.6, 1.7, 1.8 |
| G-3 | Incremental regeneration pipeline | 2.1, 2.2, 2.3, 2.7 |
| G-4 | Analogy bank staleness detection | 2.4, 2.5 |
| G-5 | Multi-model quality gate routing signal | 2.6, 2.7 |

## Appendix C: File Impact Map

| File | Action | Sprint |
|------|--------|--------|
| `.claude/scripts/ground-truth/parse-sections.sh` | New | Sprint 1 |
| `.claude/scripts/ground-truth/verify-citations.sh` | Modify (Step 5 rewrite) | Sprint 1 |
| `.claude/scripts/ground-truth/score-symbol-specificity.sh` | New | Sprint 1 |
| `.claude/scripts/ground-truth/quality-gates.sh` | Modify (add gates) | Sprint 1, Sprint 2 |
| `tests/ground-truth/generate-test-documents.sh` | New | Sprint 1 |
| `tests/ground-truth/run-property-tests.sh` | New | Sprint 1 |
| `tests/ground-truth/fixtures/regression-stacked-code-factual.md` | New | Sprint 1 |
| `.claude/scripts/ground-truth/write-manifest.sh` | Modify (per-section deps) | Sprint 2 |
| `.claude/scripts/ground-truth/extract-section-deps.sh` | New | Sprint 2 |
| `.claude/scripts/ground-truth/check-staleness.sh` | New | Sprint 2 |
| `.claude/skills/ground-truth/SKILL.md` | Modify (--incremental flag) | Sprint 2 |
| `.claude/skills/ground-truth/resources/analogies/analogy-bank.yaml` | Modify (grounded_in) | Sprint 2 |
| `.claude/scripts/ground-truth/check-analogy-staleness.sh` | New | Sprint 2 |
| `.claude/scripts/ground-truth/export-gate-metrics.sh` | New | Sprint 2 |
| `grimoires/loa/ground-truth/gate-metrics.jsonl` | New (auto-generated) | Sprint 2 |
| `tests/ground-truth/test-incremental-pipeline.sh` | New | Sprint 2 |
| `grimoires/loa/ground-truth/generation-manifest.json` | Modify (sections array) | Sprint 2 |
