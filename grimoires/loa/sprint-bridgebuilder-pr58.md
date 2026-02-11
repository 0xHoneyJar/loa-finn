# Sprint Plan: BridgeBuilder PR #58 Findings — Deepening the Epistemic Architecture

**PRD**: grimoires/loa/prd-docs-rewrite.md (v1.2.0)
**SDD**: grimoires/loa/sdd-docs-rewrite.md (v1.2.0)
**Source**: BridgeBuilder review of PR #58 (11 comments, 14 findings + architectural recommendations)
**Cross-reference**: BridgeBuilder reviews of PR #55 (10 findings), PR #56 (5 findings), PR #57 (8 findings + 8 second-round findings, of which 4 are addressed here)
**Cycle**: cycle-017
**Branch**: `feature/bridgebuilder-pr58-deepening`

---

## Overview

This sprint plan addresses all 14 BridgeBuilder findings from the PR #58 review, plus 4 second-round findings from the PR #57 review (Parts 11-17) that were not resolved in cycle-016. The remaining 4 PR #57 second-round findings were already addressed by the cycle-016 sprints. Total scope: **14 + 4 = 18 findings**. The work spans three categories:

1. **Parser & Validator Hardening** — extract reset helper, widen DERIVED content window, escape allowlist metacharacters, document design decisions
2. **Provenance Intelligence Deepening** — per-document snapshots, INFERRED triage of the 17 unqualified blocks, unknown qualifier test, strict mode for CI
3. **Governance & Routing Preparation** — recalibration history trigger column, Hounfour provenance_routing config, model attribution slot

**Philosophy**: The BridgeBuilder observed that PR #58 built the "read-side epistemic infrastructure" — a six-layer stack from parsing through governance. This plan closes the remaining gaps in that stack and begins preparing the "write-side" bridge that connects provenance metadata to multi-model routing. Every finding below was identified through structured adversarial review; implementing them deepens the system's self-knowledge by one more layer.

**Findings Index** (PR #58 review: F1-F14, PR #57 second review: F9s-F16s):

| ID | Finding | Priority | Sprint |
|----|---------|----------|--------|
| F1 | Extract `reset_paragraph_state()` in paragraph-detector.awk | LOW | 1 |
| F2 | Document permissive qualifier regex as conscious design decision | LOW | 1 |
| F3 | Add comment explaining `\|\| true` guards pipefail propagation | LOW | 1 |
| F4 | DERIVED content window fixed at 5 lines; should use paragraph boundary | MEDIUM | 1 |
| F5 | Grep fallback leaf-key collision risk in read-config.sh | LOW | 1 |
| F6 | `LOA_CONFIG_FILE` env override undocumented | LOW | 1 |
| F7 | Track `unqualified` INFERRED count as health metric (→ Task 2.2 metric + Task 2.3 triage) | LOW | 2 |
| F8 | `pending-evidence` vs `upgradeable` routing value for Hounfour | LOW | 2 |
| F9 | Per-document stats not preserved in provenance-history.sh snapshots | MEDIUM | 2 |
| F10 | Add `--strict` mode for CI manifest-filesystem drift detection | LOW | 2 |
| F11 | No test for unknown INFERRED qualifier behavior | LOW | 1 |
| F12 | Test ratio calibration (1:24) — informational, no action | — | — |
| F13 | Allowlist `paste -sd '\|'` metacharacter escape | LOW | 1 |
| F14 | Reserve `model_attribution` slot for closed-loop feedback | LOW | 2 |
| F9s | Qualifier regex should validate against known qualifiers (PR #57) | MEDIUM | 1 |
| F10s | Per-document breakdown in snapshots (PR #57 — overlaps F9) | MEDIUM | 2 |
| F15s | Recalibration History table needs trigger snapshot column | MEDIUM | 2 |
| F16s | Hounfour config needs `provenance_routing` section | MEDIUM | 2 |

---

## Sprint 1: Parser Hardening & Documentation Discipline

**Goal**: Strengthen the shared parser, widen the DERIVED validation window, add defensive documentation, improve test coverage for edge cases

### Tasks

- [ ] **Task 1.1**: Extract `reset_paragraph_state()` helper in paragraph-detector.awk
  - The pattern `process_paragraph(para_start, pending_tag_class); in_paragraph = 0; pending_tag_class = ""; pending_tag_qualifier = ""` appears at 6 paragraph boundary points (lines 32, 39, 84, 91, 96, 101)
  - Extract into a named function `reset_paragraph_state()` that calls `process_paragraph()` and zeroes all three state variables
  - This prevents forgetting to reset a new variable if one is added in the future (e.g., `pending_tag_confidence`)
  - **Golden test**: Before/after output must be byte-identical for `pass-all-gates.md` and `pass-inferred-pending-evidence.md` through both check-provenance.sh and provenance-stats.sh
  - Reference: BridgeBuilder F1 — "K&R created clearerr() for the same reason"
  - Acceptance: 50/50 tests pass; 16/16 quality gates PASS; no byte-level output changes

- [ ] **Task 1.2**: Widen DERIVED content extraction to paragraph boundary
  - Current: `para_content=$(sed -n "${line_num},$((line_num + 10))p" "$DOC_PATH" | head -5)` — fixed 5-line window
  - Problem: Citations on line 6+ of a long DERIVED paragraph are invisible to the validator
  - **Implementation approach** (backward-compatible shared variable, no callback signature change):
    1. Add `para_end = NR` tracking in paragraph-detector.awk on each content line (line 109 area, alongside `para_first_line` assignment and on each continuation line)
    2. `para_end` becomes a shared variable accessible to consumers (like `pending_tag_qualifier`), NOT a callback parameter change
    3. The `process_paragraph(start, tag_class)` callback signature remains unchanged — no breaking interface change
    4. In check-provenance.sh consumer awk, emit `TAGGED <start> <end> <class>` using the shared `para_end` variable
    5. Update check-provenance.sh bash parser (lines 88-100) to read 3 fields: `line_num`, `end_num`, `tag_class` from TAGGED lines
    6. Replace `sed -n "${line_num},$((line_num + 10))p" | head -5` with `sed -n "${line_num},${end_num}p"` for content extraction
  - **Consumer inventory** (exhaustive grep for "TAGGED" across codebase):
    - `check-provenance.sh:62` — PRODUCER: emits `TAGGED` lines from awk consumer → UPDATE to emit `<start> <end> <class>`
    - `check-provenance.sh:128` — CONSUMER: bash `read` loop parsing TAGGED lines → UPDATE field parsing to handle 3 fields
    - `provenance-stats.sh` — NOT affected: uses `process_paragraph(start, tag_class)` callback directly, never emits/parses TAGGED text
    - `run-tests.sh` — NOT affected: no assertions on TAGGED line format (tests check exit codes and JSON output)
    - No other scripts match `grep -r "TAGGED" .claude/scripts/ground-truth/`
  - Reference: BridgeBuilder F4 — "MEDIUM priority correctness edge case"
  - Acceptance: (1) A new test fixture `pass-derived-long-paragraph.md` with a citation on line 7 passes DERIVED validation; (2) all existing T-D1 through T-D4 tests pass unchanged; (3) provenance-stats.sh produces byte-identical output before/after (callback unchanged); (4) golden test: check-provenance.sh output for `pass-all-gates.md` shows correct end lines

- [ ] **Task 1.3**: Document design decisions and add defensive comments
  - **F2**: Add comment in paragraph-detector.awk above the qualifier regex explaining: "Intentionally permissive — unknown qualifiers are parsed but counted as unqualified in consumers. Strict validation would couple the parser to the qualifier vocabulary. See provenance-spec.md for valid qualifiers."
  - **F3**: Add comment in check-provenance.sh above `wc -l || true` explaining: "|| true guards against pipefail propagation — grep returns exit 1 on no match, which propagates through sort -u to wc -l under set -o pipefail"
  - **F5**: Add comment in read-config.sh above the grep fallback explaining: "WARNING: Leaf-key matching has collision risk in configs with duplicate key names across nesting levels. The yq path is authoritative; this fallback only works for unique leaf keys."
  - **F6**: Add `LOA_CONFIG_FILE` to the header comment of read-config.sh and to `.claude/loa/reference/scripts-reference.md` under a "Environment Variables" section
  - Reference: BridgeBuilder F2, F3, F5, F6
  - Acceptance: All 4 comments added; scripts-reference.md updated; no functional changes; all tests pass

- [ ] **Task 1.4**: Escape allowlist metacharacters and add unknown qualifier test
  - **F13**: In check-provenance.sh allowlist processing, replace `sed 's/\./\\./g'` with comprehensive regex escape: `sed 's/[.+*?^$(){}|[\]\\]/\\&/g'` — this handles any special character in filenames
  - Add a one-line comment: "# Escape all regex metacharacters in allowlist entries (not just dots)"
  - **F11**: Create test fixture `tests/ground-truth/fixtures/pass-inferred-unknown-qualifier.md` with `<!-- provenance: INFERRED (banana) -->` paragraph
  - Add test T-I3 in run-tests.sh: verify check-provenance.sh accepts it (exit 0, 100% coverage) and provenance-stats.sh counts it as `unqualified` (not architectural/upgradeable/pending-evidence)
  - Reference: BridgeBuilder F11, F13
  - Acceptance: Metacharacter escape handles `+`, `(`, `?` in test; T-I3 passes; 52+ tests total

- [ ] **Task 1.5**: Final verification pass for Sprint 1
  - Run full test suite: `tests/ground-truth/run-tests.sh`
  - Run quality gates: `quality-gates.sh dummy --batch --json` — all 16 PASS
  - Verify no regressions in provenance-stats.sh JSON output format
  - Verify provenance-history.sh still produces valid JSONL snapshots
  - Acceptance: All tests pass; all quality gates PASS; no regressions

---

## Sprint 2: Provenance Intelligence & Routing Preparation

**Goal**: Enrich provenance snapshots with per-document data, triage INFERRED blocks, prepare governance and routing infrastructure for Hounfour integration

### Tasks

- [ ] **Task 2.1**: Add per-document breakdown and `--strict` mode to provenance-history.sh
  - Currently: per-document stats are computed but only aggregates are stored in the JSONL record
  - Add a `per_document` array to the snapshot JSON containing each document's full stats output
  - Structure: `"per_document": [{"path": "docs/architecture.md", "trust_level": "medium", "counts": {...}, "INFERRED_BREAKDOWN": {...}}, ...]`
  - This enables differential analysis: "which document's trust_level changed since last cycle?"
  - **`--strict` mode for CI** (F10):
    - Source of truth for expected docs: `generation-manifest.json` → `.documents[].path` (already used by provenance-history.sh)
    - `missing_docs`: documents listed in manifest whose files don't exist on filesystem
    - Without `--strict`: include `missing_docs` array in JSON output, exit 0
    - With `--strict`: exit non-zero if `missing_docs` is non-empty OR if `unqualified_inferred_count` exceeds threshold (Task 2.2)
  - **Acceptance tests** (deterministic):
    1. Create temporary test fixture: copy `generation-manifest.json`, add a nonexistent doc path `docs/phantom.md`
    2. Run `provenance-history.sh --strict` with modified manifest → assert exit code non-zero, assert `missing_docs` array contains `docs/phantom.md`
    3. Run `provenance-history.sh` (no --strict) with same manifest → assert exit code 0, assert `missing_docs` array still present in JSON
    4. Run `provenance-history.sh --strict` with real manifest → assert exit code 0 (no missing docs, assuming unqualified threshold met after Task 2.3 triage)
  - Reference: BridgeBuilder F9, F10, F10s
  - Acceptance: `per_document` array present in output; `--strict` exits non-zero on missing docs (proven by test); existing non-strict behavior unchanged; all 4 acceptance tests pass

- [ ] **Task 2.2**: Track `unqualified_inferred_count` as an explicit health metric
  - **F7 metric tracking**: Add `metrics.unqualified_inferred_count` field to provenance-history.sh JSONL snapshots
  - Compute from the aggregate INFERRED_BREAKDOWN: `unqualified_inferred_count = INFERRED_BREAKDOWN.unqualified`
  - Also add per-document `unqualified_inferred_count` in each `per_document[]` entry (from Task 2.1)
  - Add configurable quality gate threshold via read-config.sh: `ground_truth.thresholds.max_unqualified_inferred` (default: 10, target: 5)
  - When `--strict` is set (Task 2.1), exit non-zero if `unqualified_inferred_count` exceeds threshold
  - Reference: BridgeBuilder F7 — "Track unqualified INFERRED count as health metric"
  - Acceptance: (1) `metrics.unqualified_inferred_count` field present in JSONL snapshot; (2) per-document entries include the count; (3) `read-config.sh ground_truth.thresholds.max_unqualified_inferred 10` returns configured value; (4) `--strict` fails when threshold exceeded (test with fixture)

- [ ] **Task 2.3**: Triage the 17 unqualified INFERRED blocks
  - The baseline shows 17 INFERRED blocks all classified as `unqualified`
  - Review each INFERRED paragraph across all 16 documents and assign appropriate qualifiers:
    - `(architectural)` — cross-module reasoning that can't be cited to a single line
    - `(upgradeable)` — could become CODE-FACTUAL with citation work
    - `(pending-evidence)` — known to be groundable, evidence location identified
  - Update the provenance tags in the actual document markdown files
  - Run `provenance-history.sh --cycle cycle-017` to capture the post-triage snapshot
  - The `unqualified_inferred_count` metric (Task 2.2) will reflect the improvement automatically
  - Reference: BridgeBuilder F7, F8 — "The classification is the improvement"
  - Acceptance: `unqualified` count drops to ≤5; at least 3 qualifiers used; provenance-history.sh shows the shift; `metrics.unqualified_inferred_count` reflects new count; all quality gates still PASS

- [ ] **Task 2.4**: Add trigger snapshot column to ADR-001 Recalibration History
  - Current table: `| Date | Reviewer | Thresholds Changed | Rationale |`
  - New table: `| Date | Reviewer | Thresholds Changed | Trigger Snapshot | Rationale |`
  - The `Trigger Snapshot` column holds the commit hash from `provenance-history.jsonl` that triggered the review
  - Update the existing row to include the cycle-016 baseline commit hash
  - Update the Recalibration Protocol Step 1 to reference: "Record the commit hash of the snapshot that triggered this review in the Trigger Snapshot column"
  - Reference: BridgeBuilder F15s — "closes the evidentiary chain from observation to decision"
  - Acceptance: Table has 5 columns; existing row updated; protocol step references the new column

- [ ] **Task 2.5**: Add Hounfour provenance_routing config and model_attribution slot
  - **F16s**: Add a `provenance_routing` section to `.loa.config.yaml` under `ground_truth`:
    ```yaml
    provenance_routing:
      high_trust:       { prefer: "fast-code", avoid: "reasoning" }
      medium_trust:     { prefer: "reviewer", fallback: "reasoning" }
      low_trust:        { prefer: "reasoning", require_review: true }
      high_pending:     { prefer: "fast-code", tool_calling: required }
      high_unqualified: { prefer: "reasoning", auto_commit: false }
    ```
  - **F14**: Add a `model_attribution` placeholder to provenance-history.sh output (empty object `{}` by default, populated when Hounfour is active):
    ```json
    "model_attribution": {}
    ```
  - Add comment in provenance-history.sh: "# model_attribution: reserved for Hounfour Phase 5+ — will track which model processed each document"
  - Reference: BridgeBuilder F14, F16s
  - Acceptance: Config section parseable by read-config.sh; provenance-history.sh JSON includes `model_attribution: {}`; no functional change to routing (config is declarative/future-facing)

- [ ] **Task 2.6**: Final verification and snapshot capture
  - Run full test suite: all tests pass (54+, including new --strict mode tests and T-I3)
  - Run quality gates: 16/16 PASS
  - Run `provenance-history.sh --cycle cycle-017` to capture post-sprint snapshot
  - Verify per-document breakdown in new snapshot
  - Verify `metrics.unqualified_inferred_count` is present and reflects triage (≤5)
  - Verify INFERRED triage reflected in breakdown (unqualified count decreased)
  - Compare cycle-016 baseline vs cycle-017 snapshot to demonstrate measurable improvement
  - Update generation-manifest.json metadata timestamps
  - Acceptance: All gates pass; provenance-history.jsonl has 2 records; unqualified INFERRED decreased; per_document data present; `metrics.unqualified_inferred_count` present in new snapshot

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Paragraph end line shared variable breaks consumers | Low | Medium | No callback signature change (para_end is shared variable like pending_tag_qualifier); only check-provenance.sh TAGGED output changes; provenance-stats.sh unaffected; golden test on 5+ fixtures before/after; T-D1-D4 regression check |
| INFERRED triage introduces provenance tag errors | Low | Medium | Quality gates catch tag format issues; run check-provenance.sh per document after tagging |
| Allowlist metacharacter escape breaks existing entries | Low | Low | All current entries are simple names with only dots; test with current entries before/after |
| Per-document snapshot size grows linearly with corpus | Low | Low | 16 docs × ~200 bytes each ≈ 3KB per snapshot — negligible |

## Success Metrics

| Metric | Target |
|--------|--------|
| Tests | 54+ total, 0 failures |
| Quality Gates | 16/16 PASS |
| INFERRED unqualified | ≤5 (down from 17) |
| `metrics.unqualified_inferred_count` | Present in JSONL snapshots, reflects triage |
| Per-document data | Present in new snapshot (with per-doc `unqualified_inferred_count`) |
| `--strict` mode | Exits non-zero on missing docs (proven by acceptance test) |
| Findings addressed | 14 (PR #58) + 4 (PR #57 second round) = 18 |
| Sprint 1 tasks | 5 (Tasks 1.1–1.5) |
| Sprint 2 tasks | 6 (Tasks 2.1–2.6) |
| Documentation comments added | 6+ |
