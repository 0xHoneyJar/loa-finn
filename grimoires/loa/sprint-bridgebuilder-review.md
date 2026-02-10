# Sprint Plan: Bridgebuilder Review Hardening

> **Cycle**: 012 — Bridgebuilder Review Hardening: PR #52 Findings
> **Source**: [PR #52 Bridgebuilder Review](https://github.com/0xHoneyJar/loa-finn/pull/52)
> **PRD**: `grimoires/loa/prd-ground-truth.md` v1.1.0
> **SDD**: `grimoires/loa/sdd-ground-truth.md` v1.1.0 + `grimoires/loa/sdd-hounfour-phase5.md`
> **Date**: 2026-02-10
> **Sprints**: 3 (global IDs 29-31)
> **Total Tasks**: 17
> **Scope**: Cross-domain — Ground Truth shell pipeline + Hounfour TypeScript security/ensemble
> **Branch**: `feature/bridgebuilder-review-hardening`

---

## Overview

This sprint plan implements all actionable findings from the Bridgebuilder review of PR #52. The review identified 4 critical/medium findings requiring code changes, plus 7 praise findings with embedded improvement suggestions.

### Finding → Task Mapping

| # | Finding | Severity | Sprint | Tasks |
|---|---------|----------|--------|-------|
| F1 | parse-sections.sh parser_version | Praise+Suggestion | 1 | 1.4 |
| F2 | verify-citations.sh fallback warning | Praise+Suggestion | 1 | 1.3 |
| F3 | Dynamic REAL_CITATIONS from manifest | Praise+Suggestion | 2 | 2.1 |
| F4 | Normalized staleness hash | Praise+Suggestion | 2 | 2.2 |
| F5 | generator_model in gate-metrics.jsonl | Praise+Suggestion | 2 | 2.5 |
| F6 | Budget circuit breaker + JTI replay TTL | High | 3 | 3.1, 3.2 |
| F7 | TF-IDF precision (identifier count, word-boundary, src-only) | Medium | 1 | 1.2 |
| F8 | Track untagged paragraph content | Praise+Suggestion | 2 | 2.3 |
| F9 | Ensemble consensus → best_of_n with gate scorer | Medium | 3 | 3.3 |
| F10 | JSON escaping → jq --arg migration | Medium | 1 | 1.1 |
| F11 | Analogy bank confidence field | Praise+Suggestion | 2 | 2.4 |

---

## Sprint 1: Shell Pipeline Correctness Hardening (Global ID: 29)

> **Goal**: Eliminate latent correctness bugs in the Ground Truth shell pipeline identified by the Bridgebuilder review. Focus on JSON escaping safety, TF-IDF precision, and defensive logging.
>
> **CRITICAL ORDERING**: Task 1.4 (parse-sections.sh schema change) MUST be implemented first as a single atomic changeset including all consumer updates. Tasks 1.1 JSON escaping changes to parse-sections.sh must be part of or after Task 1.4. The schema change affects the entire pipeline — treat it like a compiler AST format migration.

### Task 1.1 — Migrate JSON Construction from sed to jq --arg

**Finding**: F10 (Medium — JSON escaping risk)
**Files**: `verify-citations.sh`, `quality-gates.sh`, `extract-section-deps.sh`, `export-gate-metrics.sh`, `parse-sections.sh`

**Description**: Replace all manual JSON construction using `sed 's/"/\\"/g'` with `jq -n --arg` for proper escaping. `jq --arg` handles quotes, backslashes, control characters, and unicode — the manual approach only handles quotes.

**Implementation**:
- [ ] Audit all ground-truth scripts for manual JSON string construction
- [ ] Replace `echo "{\"key\": \"$escaped_val\"}"` patterns with `jq -n --arg key "$val" '{key: $key}'`
- [ ] Preserve existing output format (JSON structure unchanged, only construction method changes)
- [ ] Special attention to `parse-sections.sh` awk output (may need post-processing via jq)

**Acceptance Criteria**:
- [ ] Zero instances of `sed 's/"/\\"/g'` remain in ground-truth scripts
- [ ] All JSON output passes `jq .` validation (including headings with backslashes, backticks, unicode)
- [ ] All existing tests pass (some fixtures/assertions may need updates for Task 1.4 schema change — update atomically)
- [ ] New test: heading containing `\n` literal (backslash-n, not newline) produces valid JSON
- [ ] parse-sections.sh jq migration implemented AFTER or WITH Task 1.4 schema change (never before)

**Estimated Effort**: Medium (5 scripts, ~20 replacement sites)

---

### Task 1.2 — TF-IDF Precision: Identifier Count, Word-Boundary, Source-Only Corpus

**Finding**: F7 (Medium — TF-IDF precision gap)
**Files**: `.claude/scripts/ground-truth/score-symbol-specificity.sh`

**Description**: Three precision improvements to the symbol specificity scorer:

1. **TF denominator**: Replace `wc -w` (word count) with identifier extraction. Word count includes operators, literals, and comments — systematically underestimates TF by ~2x. **Portability note**: Use `awk` for word-boundary matching instead of `grep -P` (PCRE), which is unavailable on macOS/BSD and some minimal CI images. Portable alternative: `awk '/\b'"$symbol"'\b/{c++} END{print c}' "$file"` or `perl -ne 'print if /\b'"$symbol"'\b/'`.

2. **Word-boundary matching**: Replace `grep -coF "$symbol"` (substring match) with portable word-boundary match. Prevents `WAL` matching `WALManager`, `WALLET`, etc. **Implementation**: Use `awk` or `perl` instead of `grep -P` for PCRE word boundaries. Add a portability preflight check in the test harness that verifies the matching tool is available.

3. **Source-only IDF corpus**: Filter `git ls-files` to `src/` paths only, excluding test files, fixtures, config files. Test files inflate IDF by referencing the same symbols as production code.

**Implementation**:
- [ ] Replace TF calculation with identifier-count denominator
- [ ] Replace symbol grep with word-boundary regex
- [ ] Add `src/` path filter to IDF corpus calculation
- [ ] Recalibrate threshold (currently 0.01) by running scorer against all generated documents
- [ ] Document new threshold with calibration data in script comments

**Acceptance Criteria**:
- [ ] `wc -w` replaced with identifier extraction (via `awk` or `perl`, not `grep -P`)
- [ ] `grep -coF` replaced with portable word-boundary matching (awk/perl, NOT grep -P)
- [ ] IDF corpus scoped to `src/` paths
- [ ] Threshold recalibrated with justification documented in script
- [ ] All existing tests pass (scorer is WARNING-level, so no blocking changes)
- [ ] New test: symbol `WAL` in a file containing `WALManager` is not double-counted
- [ ] Portability: works on both GNU and BSD environments (no `grep -P` dependency)
- [ ] Preflight check in test harness: verify matching tool available, fail with actionable message if not

---

### Task 1.3 — Add Fallback Warning in verify-citations.sh

**Finding**: F2 (Praise + cautionary note)
**Files**: `.claude/scripts/ground-truth/verify-citations.sh`

**Description**: When section-scoped evidence anchor resolution fails and falls back to document-wide search, log a warning to stderr. Silent fallback masks structural problems (parsing failure or malformed document).

**Implementation**:
- [ ] Add `echo "WARNING: anchor '$symbol' at line $anchor_line has no section-scoped citation, falling back to document-wide search" >&2` at the fallback point (~line 200)
- [ ] Ensure warning does not affect JSON output (stderr only)
- [ ] Add `--quiet` flag to suppress warnings (for use in property tests where fallback is expected for invalid docs)

**Acceptance Criteria**:
- [ ] Warning emitted on stderr when section-scoped resolution fails
- [ ] JSON output unchanged (stdout only)
- [ ] `--quiet` flag suppresses warnings
- [ ] All existing tests pass (property tests may need `--quiet` or `2>/dev/null`)

**Estimated Effort**: Small

---

### Task 1.4 — Add parser_version to parse-sections.sh Output

**Finding**: F1 (Praise + suggestion)
**Files**: `.claude/scripts/ground-truth/parse-sections.sh`

**Description**: Add `"parser_version": "1.0"` to the JSON output so downstream consumers can detect schema changes. This script is consumed by `verify-citations.sh`, `extract-section-deps.sh`, and transitively by `check-staleness.sh` — it's the AST format for the entire pipeline.

**Implementation**:
- [ ] Wrap current array output in an object: `{"parser_version": "1.0", "sections": [...]}`
- [ ] Update all consumers to read `.sections[]` instead of `.[]`
- [ ] Add version check in consumers: warn if parser_version is unexpected

**Acceptance Criteria**:
- [ ] Output is `{"parser_version": "1.0", "sections": [...]}` (object, not bare array)
- [ ] `verify-citations.sh` reads `.sections[]` and checks `parser_version`
- [ ] `extract-section-deps.sh` reads `.sections[]` and checks `parser_version`
- [ ] All 159 existing tests pass
- [ ] New test: parser outputs valid versioned JSON

**Estimated Effort**: Small-Medium (3 consumers to update)

---

### Task 1.5 — Unit Tests for Correctness Changes

**Finding**: Cross-cutting
**Files**: `tests/ground-truth/run-tests.sh`, `tests/ground-truth/fixtures/`

**Description**: Add unit tests covering the specific correctness fixes in Tasks 1.1-1.4.

**Implementation**:
- [ ] T15: Heading with backslash (`Section with \n literal`) produces valid JSON from parse-sections.sh
- [ ] T16: Symbol `WAL` specificity score with file containing `WALManager` — no false match
- [ ] T17: verify-citations.sh fallback warning appears on stderr for intentionally broken section mapping
- [ ] T18: parser_version field present and correct in parse-sections.sh output

**Acceptance Criteria**:
- [ ] 4 new tests added to run-tests.sh
- [ ] All new + existing tests pass (163+ total)

**Estimated Effort**: Small

---

### Task 1.6 — Full Regression Test Run

**Finding**: Cross-cutting
**Files**: All test harnesses

**Description**: Run all 4 test harnesses after Sprint 1 changes to verify zero regressions.

**Acceptance Criteria**:
- [ ] `tests/ground-truth/run-tests.sh` — all pass (31+ unit tests)
- [ ] `tests/ground-truth/test-repair-loop.sh` — all pass (12 repair tests)
- [ ] `tests/ground-truth/run-property-tests.sh` — all pass (100 property tests)
- [ ] `tests/ground-truth/test-incremental-pipeline.sh` — all pass (20 E2E tests)
- [ ] Total: 163+ tests, 0 failures

**Estimated Effort**: Small (execution only)

---

## Sprint 2: Test Infrastructure & Data Quality (Global ID: 30)

> **Goal**: Make the test infrastructure self-maintaining, enrich metadata for multi-model routing, and add quality signals for tracking documentation health over time.

### Task 2.1 — Dynamic REAL_CITATIONS from Generation Manifest

**Finding**: F3 (Praise + suggestion)
**Files**: `tests/ground-truth/generate-test-documents.sh`

**Description**: Replace the hardcoded `REAL_CITATIONS` array with dynamic citation sourcing from `generation-manifest.json`. The current array requires manual maintenance when code changes — the same brittleness that plagued early Selenium test suites.

**Implementation**:
- [ ] Read citations from `generation-manifest.json` via `jq`: extract `.documents[].sections[].citations[]` with `path`, `line_start`, `line_end`
- [ ] Build citation strings in the existing format: `"path:start-end|symbol1,symbol2"`
- [ ] Extract symbols from evidence anchors in the generated documents (or from manifest if available)
- [ ] Fall back to hardcoded array if manifest is missing or empty (backward compatibility)
- [ ] Limit to 20 citations maximum (current array has ~12)

**Manifest Schema Contract** (required fields for dynamic citation sourcing):
```json
{
  "documents": {
    "<path>": {
      "sections": [
        {
          "heading": "string",
          "citations": [
            {"path": "string", "line_start": "number", "line_end": "number"}
          ]
        }
      ]
    }
  }
}
```
The `sections[].citations[]` array must be non-empty for at least some sections. If the manifest exists but has no citations (e.g., freshly generated without section deps), fall back to hardcoded array.

**Acceptance Criteria**:
- [ ] `REAL_CITATIONS` populated from manifest when available and citations non-empty
- [ ] Fallback to hardcoded array when manifest missing OR manifest has zero citations
- [ ] Contract test: generate a manifest via `write-manifest.sh`, assert `documents[].sections[].citations[]` paths exist and are non-empty
- [ ] Validate manifest version field (`manifest_version` or `parser_version`) if present — warn on unexpected version
- [ ] All 100 property tests still pass
- [ ] Valid documents use citations that actually exist in the codebase (verified via `git ls-files`)

**Estimated Effort**: Medium

---

### Task 2.2 — Dual-Hash Staleness Detection (Normalized + Raw)

**Finding**: F4 (Praise + architectural observation)
**Files**: `.claude/scripts/ground-truth/extract-section-deps.sh`, `.claude/scripts/ground-truth/check-staleness.sh`

**Description**: Add a normalized content hash alongside the existing integrity hash. The current hash includes all markdown markup, so formatting-only changes (blank lines, heading case) trigger unnecessary regeneration. Two hashes, two purposes:

- `content_hash` (existing): Raw byte-exact hash for integrity verification
- `staleness_hash` (new): Whitespace-normalized hash for change detection

**Implementation**:
- [ ] In `extract-section-deps.sh`: compute `staleness_hash` via `tr -s '[:space:]' ' ' | git hash-object --stdin`
- [ ] Add `staleness_hash` to section output alongside existing `content_hash`
- [ ] In `check-staleness.sh`: compare `staleness_hash` for change detection (not `content_hash`)
- [ ] In `write-manifest.sh`: store both hashes in manifest entries

**Acceptance Criteria**:
- [ ] Manifest entries contain both `content_hash` and `staleness_hash`
- [ ] `check-staleness.sh` uses `staleness_hash` for comparison
- [ ] Adding a blank line to a section does NOT trigger staleness
- [ ] Changing actual content DOES trigger staleness
- [ ] All E2E pipeline tests pass

**Estimated Effort**: Medium

---

### Task 2.3 — Track Untagged Paragraph Content as Quality Signal

**Finding**: F8 (Research observation)
**Files**: `.claude/scripts/ground-truth/check-provenance.sh`, `.claude/scripts/ground-truth/quality-gates.sh`

**Description**: The 95% provenance coverage threshold allows 5% of paragraphs to escape tagging. Over time, the untagged 5% may accumulate the weakest claims. Track which paragraphs are untagged and report them as a quality signal.

**Implementation**:
- [ ] In `check-provenance.sh`: when a paragraph lacks a provenance tag, record its line number and first 80 characters
- [ ] Add `untagged_paragraphs` array to the JSON output (line, preview, section)
- [ ] In `quality-gates.sh`: include `untagged_count` and `untagged_paragraphs` in gate output (informational, not blocking)
- [ ] In `export-gate-metrics.sh`: include `untagged_count` in metrics entry

**Acceptance Criteria**:
- [ ] `check-provenance.sh --json` output includes `untagged_paragraphs` array
- [ ] Each entry has `{line, preview, section}` fields
- [ ] `quality-gates.sh` reports untagged count (non-blocking)
- [ ] Metrics export includes `untagged_count`
- [ ] All existing tests pass (provenance check still uses 95% threshold)

**Estimated Effort**: Medium

---

### Task 2.4 — Analogy Bank Confidence Field + Weighted Generation

**Finding**: F11 (Praise + suggestion)
**Files**: `.claude/skills/ground-truth/resources/analogies/analogy-bank.yaml`, `.claude/scripts/ground-truth/check-analogy-staleness.sh`

**Description**: Add a `confidence` field (high/moderate/low) to each analogy bank entry. High-confidence analogies get prominent placement; moderate ones get qualifiers ("in some ways similar to..."). Staleness of high-confidence analogies is a more urgent signal.

**Implementation**:
- [ ] Add `confidence: high|moderate` to all 12 analogy-bank.yaml entries
- [ ] Assess each analogy: "high" if structural match is strong and well-documented; "moderate" if match is partial
- [ ] In `check-analogy-staleness.sh`: report confidence level alongside staleness status
- [ ] In SKILL.md: add generation guidance for confidence-weighted analogy placement
- [ ] Update quality-gates.sh Gate W4 output to include confidence in warning messages

**Acceptance Criteria**:
- [ ] All 12 analogies have `confidence` field
- [ ] `check-analogy-staleness.sh` output includes `confidence` per analogy
- [ ] SKILL.md documents confidence-weighted generation guidance
- [ ] All E2E tests pass

**Estimated Effort**: Small-Medium

---

### Task 2.5 — Add generator_model + verifier Fields to Gate Metrics

**Finding**: F5 (Praise + critical observation)
**Files**: `.claude/scripts/ground-truth/export-gate-metrics.sh`

**Description**: For the Hounfour feedback loop to work, gate metrics must distinguish the orchestrating model from the generating model. Add `generator_model` and `verifier` fields to the JSONL output. Add `--model` flag to allow the router to specify the generator.

**Implementation**:
- [ ] Add `--model` flag to `export-gate-metrics.sh` (overrides default model detection)
- [ ] Add `generator_model` field to JSONL entry (from `--model` flag or "unknown")
- [ ] Add `verifier: "deterministic"` field (always deterministic for Ground Truth)
- [ ] Preserve existing `model` field for backward compatibility (orchestrator context)

**Acceptance Criteria**:
- [ ] `--model qwen3-coder-next` → JSONL entry has `"generator_model": "qwen3-coder-next"`
- [ ] Without `--model` → `"generator_model": "unknown"`
- [ ] `"verifier": "deterministic"` present in all entries
- [ ] Existing `model` field unchanged
- [ ] E2E pipeline tests pass (T11-T14 may need updates for new fields)

**Estimated Effort**: Small

---

### Task 2.6 — E2E Tests for New Metadata Fields

**Finding**: Cross-cutting
**Files**: `tests/ground-truth/test-incremental-pipeline.sh`

**Description**: Update E2E test suite to cover new metadata fields from Tasks 2.1-2.5.

**Implementation**:
- [ ] T21: Manifest entries contain `staleness_hash` field
- [ ] T22: `export-gate-metrics.sh --model test-model` → JSONL has `generator_model` field
- [ ] T23: `check-analogy-staleness.sh` output includes `confidence` per analogy
- [ ] T24: `check-provenance.sh --json` output includes `untagged_paragraphs` array

**Acceptance Criteria**:
- [ ] 4 new E2E tests added
- [ ] All new + existing tests pass (167+ total across all harnesses)

**Estimated Effort**: Small

---

## Sprint 3: Hounfour Security & Ensemble Hardening (Global ID: 31)

> **Goal**: Address the two High-severity security observations and the Medium-severity ensemble architecture gap from the Bridgebuilder review. All TypeScript changes with tests.

### Task 3.1 — Active Budget Circuit Breaker

**Finding**: F6a (High — budget state uncertainty)
**Files**: `src/hounfour/budget.ts`, `src/hounfour/router.ts`

**Description**: When budget ledger writes fail, the system sets `budgetStateUnknown = true` but the router doesn't check it. In fail-open mode, requests continue without cost recording indefinitely. Add an active circuit breaker that force-closes after a configurable window.

**Implementation**:
- [ ] Add `unknownSince: Date | null` timestamp to BudgetEnforcer (set when budgetStateUnknown becomes true, cleared on recovery)
- [ ] Add `isBudgetCircuitOpen(maxUnknownMs: number): boolean` method
- [ ] In `router.ts`: check `budget.isBudgetCircuitOpen(MAX_UNKNOWN_BUDGET_WINDOW)` before dispatch
- [ ] Throw `HounfourError('BUDGET_CIRCUIT_OPEN', ...)` when circuit opens
- [ ] Default `MAX_UNKNOWN_BUDGET_WINDOW`: 300_000 (5 minutes) — configurable
- [ ] Add recovery detection: when ledger write succeeds after failure, clear `unknownSince`

**Acceptance Criteria**:
- [ ] `budgetStateUnknown = true` for > 5 minutes → requests rejected with BUDGET_CIRCUIT_OPEN
- [ ] Recovery clears the circuit (ledger write success resets unknownSince)
- [ ] Transient failures (< 5 minutes) do not trigger circuit break
- [ ] Configurable threshold via constructor options
- [ ] Test: simulate 6 minutes of ledger failure → verify circuit opens
- [ ] Test: simulate failure then recovery → verify circuit closes

**Estimated Effort**: Medium

---

### Task 3.2 — JTI Replay Protection with Explicit TTL and Redis Backing

**Finding**: F6b (High — JTI replay window)
**Files**: `src/hounfour/jti-replay.ts`, `src/hounfour/redis/` (new module)

**Description**: The JWT validation checks `jti` for replay protection, but the replay detection window must match or exceed the JWT `exp` claim. Add explicit TTL, maximum set size with LRU eviction, and Redis-backed persistence for multi-instance deployments.

**TTL Derivation Algorithm** (security-critical — must be explicit):
```
ttlSec = clamp(exp - now + CLOCK_SKEW_SEC, MIN_TTL_SEC, MAX_TTL_SEC)
where:
  CLOCK_SKEW_SEC = 60      (tolerance for clock drift between services)
  MIN_TTL_SEC    = 30      (floor — even short-lived tokens get replay protection)
  MAX_TTL_SEC    = 7200    (ceiling — cap memory usage for long-lived tokens)
```

**Validation ordering**: Validate JWT signature + standard claims (exp, nbf, iss, aud) FIRST, then apply replay guard using derived TTL. Expired tokens are rejected by claims validation before reaching the JTI check — replay guard only protects valid, non-expired tokens.

**Implementation**:
- [ ] Add `JtiReplayGuard` class with TTL derived from JWT `exp` claim per algorithm above
- [ ] In-memory `Map<string, number>` with periodic cleanup (sweep entries older than TTL every 60s)
- [ ] Maximum set size (default: 100_000) with oldest-first eviction
- [ ] `RedisJtiReplayGuard` extending base: uses `SET jti:${jti} 1 EX ${ttlSec} NX` for atomic check-and-set
- [ ] Redis module follows existing pattern in `src/hounfour/redis/` (idempotency, circuit, budget)
- [ ] Factory function: `createJtiReplayGuard(config)` → Redis if available, in-memory fallback
- [ ] Integrate into `jwt-auth.ts`: validate signature + claims FIRST, then check JTI replay

**Acceptance Criteria**:
- [ ] JTI seen within TTL → reject with 401 (replay detected)
- [ ] JTI seen after TTL → accept (window expired, ID reclaimed)
- [ ] In-memory guard enforces max set size (evicts oldest on overflow)
- [ ] Redis guard uses `SET ... EX ... NX` for atomic replay detection
- [ ] TTL derived from `exp` claim with clock skew, clamped to [30s, 7200s]
- [ ] Expired token rejected by claims validation before JTI check (ordering verified)
- [ ] Test: replay within TTL → rejected
- [ ] Test: replay after TTL → accepted
- [ ] Test: short-lived token (exp in 30s) → TTL = 90s (30 + 60 skew)
- [ ] Test: long-lived token (exp in 3h) → TTL capped at 7200s
- [ ] Test: expired token → rejected at claims validation, JTI guard not reached
- [ ] Test: 100,001st JTI evicts oldest entry
- [ ] Test: Redis unavailable → falls back to in-memory
- [ ] Test: clock skew boundary (exp - now = -30s but within skew → still protected)

**Estimated Effort**: Large (new module + Redis integration)

---

### Task 3.3 — Ensemble best_of_n with Quality Gate Scorer

**Finding**: F9 (Medium — consensus on prose doesn't work)
**Files**: `src/hounfour/ensemble.ts`, `src/hounfour/types.ts`

**Description**: The `consensus` strategy uses majority vote on field values. For prose (documentation), models produce different wording — consensus degrades to `first_complete`. For Ground Truth multi-model generation, use `best_of_n` with quality gate pass rate as the scoring function.

**Implementation (Part A — Scorer Hook)**:
- [ ] Add `ScorerFunction` type: `(result: CompletionResult) => Promise<number>` (0.0-1.0)
- [ ] Add `scorer` option to `best_of_n` strategy configuration
- [ ] Default scorer: output length (existing behavior)
- [ ] Add `consensus_mode: 'field_vote' | 'scorer'` option for future flexibility
- [ ] Preserve existing `consensus` behavior as `field_vote` (backward compatible)

**Implementation (Part B — Quality Gate Scorer Adapter)**:
- [ ] Create `QualityGateScorer` class in `src/hounfour/quality-gate-scorer.ts`
- [ ] Scorer writes candidate text to temp file, spawns `quality-gates.sh` via tool sandbox
- [ ] Parse JSON output from quality-gates.sh: extract `gates_passed / gates_total` as score
- [ ] Enforce timeout per gate run (default: 30s) — return score 0.0 on timeout
- [ ] Enforce budget per gate run (prevent gate execution from consuming unbounded resources)
- [ ] Handle gate script failure gracefully: score = 0.0, log error, do not throw
- [ ] Integration test: `best_of_n` with 2 candidates — one passes all gates, one fails citations → correct selection

**Acceptance Criteria**:
- [ ] `best_of_n` accepts custom `scorer` function
- [ ] Scorer receives full `CompletionResult`, returns 0.0-1.0 score
- [ ] Highest-scoring result is returned
- [ ] Ties broken by first result (deterministic)
- [ ] Existing `consensus` behavior unchanged (backward compatible)
- [ ] `QualityGateScorer` spawns shell scripts in sandbox with timeout
- [ ] Gate script failure → score 0.0 (not thrown error)
- [ ] Test: 3 results scored [0.5, 0.9, 0.7] → result 2 returned
- [ ] Test: custom scorer called for each result
- [ ] Integration test: best_of_n with quality gate scorer — selects candidate with most gates passed

**Estimated Effort**: Large (scorer hook + production adapter + sandbox integration)

---

### Task 3.4 — Pool Registry Provider Validation at Construction Time

**Finding**: From agent code review (not a numbered finding)
**Files**: `src/hounfour/pool-registry.ts`

**Description**: `PoolRegistry` doesn't validate that provider/model references in pool definitions actually exist in the provider registry. Invalid references are only caught at runtime when resolving a pool. Add construction-time validation for fail-fast behavior.

**Implementation**:
- [ ] Accept `ProviderRegistry` reference in `PoolRegistry` constructor
- [ ] On construction: validate all pool model references exist in provider registry
- [ ] On construction: validate all fallback chain references exist as pool IDs
- [ ] Throw `ConfigurationError` with specific pool/model details on validation failure
- [ ] Existing cycle detection for fallback chains preserved

**Acceptance Criteria**:
- [ ] Pool referencing nonexistent model → throws at construction time
- [ ] Pool with fallback referencing nonexistent pool → throws at construction time
- [ ] Valid pools construct without error
- [ ] Test: pool with `model: "nonexistent-model"` → ConfigurationError
- [ ] Test: pool with `fallback: "nonexistent-pool"` → ConfigurationError

**Estimated Effort**: Small-Medium

---

### Task 3.5 — TypeScript Tests for Security and Ensemble Changes

**Finding**: Cross-cutting
**Files**: `tests/finn/budget-vectors.test.ts`, `tests/finn/ensemble.test.ts`, new test files

**Description**: Comprehensive tests for all Sprint 3 changes.

**Implementation**:
- [ ] `budget-circuit-breaker.test.ts`: transient failure tolerance, circuit open after window, recovery
- [ ] `jti-replay.test.ts`: replay detection, TTL expiry, max size eviction, Redis fallback
- [ ] `ensemble-scorer.test.ts`: custom scorer, tie-breaking, backward compatibility
- [ ] `pool-registry-validation.test.ts`: invalid model, invalid fallback, valid configuration
- [ ] Integration test: budget circuit breaker + router (request rejected on circuit open)

**Acceptance Criteria**:
- [ ] All new tests pass
- [ ] All existing tests pass (no regressions)
- [ ] Coverage for all error paths (circuit open, replay detected, scorer failure)

**Estimated Effort**: Medium

---

## Summary

| Sprint | Global ID | Label | Tasks | Focus |
|--------|-----------|-------|-------|-------|
| Sprint 1 | 29 | Shell Pipeline Correctness Hardening | 6 | JSON escaping, TF-IDF precision, defensive logging |
| Sprint 2 | 30 | Test Infrastructure & Data Quality | 6 | Self-maintaining tests, richer metadata, quality signals |
| Sprint 3 | 31 | Hounfour Security & Ensemble Hardening | 5 | Budget circuit breaker, JTI replay, ensemble scoring |
| **Total** | | | **17** | |

### Dependencies

```
Sprint 1 ──→ Sprint 2 (Sprint 2 tests depend on Sprint 1 JSON format changes)
Sprint 1 ──→ Sprint 3 (independent, can run in parallel if separate agent)
Sprint 2 ──→ Sprint 3 (Task 2.5 generator_model informs Task 3.3 scorer integration)
```

### Risk Assessment

| Risk | Mitigation |
|------|------------|
| parse-sections.sh output format change (Task 1.4) breaks consumers | **Atomic changeset**: Task 1.4 implemented first, includes ALL consumer updates + test fixture updates in single commit. No intermediate state where old array format is expected. |
| TF-IDF threshold recalibration (Task 1.2) changes existing behavior | Scorer is WARNING-level only; no blocking impact. Portable matching (awk/perl, no grep -P) |
| `grep -P` (PCRE) unavailable on macOS/BSD/minimal CI (Task 1.2) | **Eliminated**: Use awk/perl for word-boundary matching. Add portability preflight check in test harness. |
| Redis JTI module (Task 3.2) adds infrastructure dependency | Factory function with in-memory fallback; no hard Redis requirement |
| JTI TTL misconfiguration allows replay or rejects valid tokens | **Explicit algorithm**: TTL derived from JWT exp claim with 60s clock skew, clamped [30s, 7200s]. 8 test cases including boundary conditions. |
| Ensemble scorer API change (Task 3.3) affects existing callers | Scorer is optional parameter; existing behavior preserved as default |
| Quality gate scorer adapter (Task 3.3 Part B) shell spawning in sandbox | Timeout + budget enforcement per gate run; failure returns score 0.0, does not throw |
| Manifest schema drift breaks dynamic citation sourcing (Task 2.1) | **Contract test**: assert required paths exist after write-manifest.sh; fallback to hardcoded on schema mismatch |

### Success Metrics

- All 167+ tests pass after Sprint 1+2 (163 existing + 4 new unit + 4 new E2E, minus any collapsed)
- Zero manual JSON escaping (`sed 's/"/\\"/g'`) in ground-truth scripts
- Budget circuit breaker triggers within 5 minutes of sustained ledger failure
- JTI replay detected within TTL window across both in-memory and Redis guards
- Ensemble scorer selects highest-gate-pass-rate generation in multi-model scenario
