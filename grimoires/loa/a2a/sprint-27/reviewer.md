# Sprint 27: Structural Verification + Property Testing — Implementation Report

> **Cycle**: cycle-011 (Ground Truth v2)
> **Global Sprint ID**: 27
> **Branch**: `feature/ground-truth-v2`
> **Status**: All 8 tasks completed

## Summary

Replaced the ±10 line proximity heuristic in `verify-citations.sh` Step 5 with AST-based section-scoped evidence anchor resolution. Added TF-IDF symbol specificity scoring, property-based testing (100 generated test documents), and a regression test for the stacked CODE-FACTUAL failure from cycle-010.

## Tasks Completed

### 1.1 — Markdown Section Parser
- **File**: `.claude/scripts/ground-truth/parse-sections.sh` (new, 96 lines)
- **Implementation**: awk state machine parsing `##` headings with IN_FRONTMATTER, IN_FENCE, IN_HTML_COMMENT state handling
- **Output**: JSON array of `{heading, start_line, end_line, depth}`
- **Verified**: Correctly parses both `capability-brief.md` (12 sections) and `architecture-overview.md` (11 sections)

### 1.2 — AST-Based Evidence Anchor Resolution
- **File**: `.claude/scripts/ground-truth/verify-citations.sh` (modified, 152→222 lines in Step 5)
- **Implementation**: For each `<!-- evidence: -->` tag, finds its containing section via `parse-sections.sh`, then locates the nearest citation within that same section
- **Key change**: Replaces `search_start=$((anchor_line_num - 10))` with section-scoped jq query
- **Regression**: The 14-failure stacked CODE-FACTUAL case now passes

### 1.3 — Section-Scoped Citation Index
- **File**: `.claude/scripts/ground-truth/verify-citations.sh` (Step 1b, new block)
- **Implementation**: During extraction, maps each citation to its containing section heading using `parse-sections.sh` output
- **Data structures**: `cite_section_heading[]` and `section_citations[]` associative arrays

### 1.4 — TF-IDF Symbol Scorer
- **File**: `.claude/scripts/ground-truth/score-symbol-specificity.sh` (new, 157 lines)
- **Implementation**: Computes TF (occurrences in cited file / total words) × IDF (log2(total_files / files_with_symbol))
- **Reject list**: 22 common JS/TS keywords (export, const, function, import, etc.)
- **Results on capability-brief.md**: `WALManager` scores 0.137, `createApp` scores 0.011, all pass threshold

### 1.5 — Integrate Specificity into Quality Gates
- **File**: `.claude/scripts/ground-truth/quality-gates.sh` (modified, Gate W3 added)
- **Implementation**: Non-blocking WARNING gate running `score-symbol-specificity.sh` on each evidence anchor
- **Output**: Reports count and names of low-specificity symbols

### 1.6 — Property-Based Test Generator
- **File**: `tests/ground-truth/generate-test-documents.sh` (new, 242 lines)
- **Implementation**: Generates N valid documents (real citations, correct provenance) and N invalid documents (one defect each)
- **Defect types**: 8 categories: wrong_path, missing_provenance, banned_term, bad_line_range, wrong_evidence_symbol, hypothesis_no_marker, path_traversal, missing_citation_in_code_factual
- **Manifest**: JSON companion at `invalid/manifest.json` mapping each document to its defect type and expected gate

### 1.7 — Property Test Runner
- **File**: `tests/ground-truth/run-property-tests.sh` (new, 129 lines)
- **Implementation**: Generates test documents, runs each valid doc through all 3 gate scripts, runs each invalid doc through its expected gate
- **Results**: 50/50 valid pass, 50/50 invalid fail on correct gate (100% pass rate)

### 1.8 — Regression Test: Stacked CODE-FACTUAL
- **File**: `tests/ground-truth/fixtures/regression-stacked-code-factual.md` (new fixture)
- **Implementation**: 4 CODE-FACTUAL paragraphs in 2 sections, each with different citations and evidence anchors
- **Test**: Added to `run-tests.sh` — 4 new assertions verify AST resolver correctly associates each anchor
- **Verification**: All 4 citations verified, 0 failures

## Test Results

| Suite | Tests | Passed | Failed |
|-------|-------|--------|--------|
| Unit tests (run-tests.sh) | 27 | 27 | 0 |
| Repair loop (test-repair-loop.sh) | 12 | 12 | 0 |
| Property tests (run-property-tests.sh) | 100 | 100 | 0 |
| **Total** | **139** | **139** | **0** |

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `.claude/scripts/ground-truth/parse-sections.sh` | New | 96 |
| `.claude/scripts/ground-truth/verify-citations.sh` | Modified | 270 (was 233) |
| `.claude/scripts/ground-truth/score-symbol-specificity.sh` | New | 157 |
| `.claude/scripts/ground-truth/quality-gates.sh` | Modified | 273 (was 261) |
| `tests/ground-truth/generate-test-documents.sh` | New | 242 |
| `tests/ground-truth/run-property-tests.sh` | New | 129 |
| `tests/ground-truth/run-tests.sh` | Modified | 259 (was 246) |
| `tests/ground-truth/fixtures/regression-stacked-code-factual.md` | New | 36 |

## Acceptance Criteria Status

- [x] Evidence anchors resolved by section structure, not ±10 line proximity
- [x] Each anchor associated with nearest citation within same `##` section
- [x] Stacked CODE-FACTUAL regression no longer confuses the verifier
- [x] TF-IDF threshold configurable (default 0.01), triggers WARNING
- [x] Common keywords (`export`, `const`, etc.) rejected by built-in list
- [x] Property generator produces ≥50 valid + ≥50 invalid documents
- [x] Property runner: 100% pass rate on valid, 100% correct-gate-failure on invalid
- [x] All existing tests continue to pass (27 unit + 12 repair loop = 39 total)
- [x] New property tests added to `tests/ground-truth/`
