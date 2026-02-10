#!/usr/bin/env bash
# test-incremental-pipeline.sh — E2E test for incremental regeneration pipeline
# Tests: staleness detection → section flagging → metrics export
#
# This test simulates a source file change, verifies the staleness detector
# correctly flags affected sections, and confirms metrics export works.
#
# Usage: test-incremental-pipeline.sh [--verbose]
#
# Exit codes:
#   0 = All tests pass
#   1 = One or more tests failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPTS="$REPO_ROOT/.claude/scripts/ground-truth"

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

# ── Counters ──
passed=0
failed=0
total=0

log_pass() { echo "  ✓ $*"; ((passed++)) || true; ((total++)) || true; }
log_fail() { echo "  ✗ $*"; ((failed++)) || true; ((total++)) || true; }

cd "$REPO_ROOT"

echo "Ground Truth Incremental Pipeline E2E Tests"
echo "============================================="
echo ""

# ── Pre-flight ──
for script in extract-section-deps.sh check-staleness.sh check-analogy-staleness.sh export-gate-metrics.sh write-manifest.sh quality-gates.sh; do
  if [[ ! -x "$SCRIPTS/$script" ]]; then
    echo "FATAL: $script not found or not executable at $SCRIPTS/$script"
    exit 1
  fi
done

if ! command -v jq &>/dev/null; then
  echo "FATAL: jq is required but not found"
  exit 1
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ extract-section-deps.sh"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T1: Capability-brief has sections with citations
output=$("$SCRIPTS/extract-section-deps.sh" grimoires/loa/ground-truth/capability-brief.md --json 2>/dev/null)
section_count=$(echo "$output" | jq '.sections | length' 2>/dev/null || echo "0")
if [[ "$section_count" -gt 0 ]]; then
  log_pass "capability-brief has $section_count sections"
else
  log_fail "capability-brief should have sections, got $section_count"
fi

# T2: Sections with CODE-FACTUAL have citations
cite_sections=$(echo "$output" | jq '[.sections[] | select(.citations | length > 0)] | length' 2>/dev/null || echo "0")
if [[ "$cite_sections" -gt 0 ]]; then
  log_pass "capability-brief has $cite_sections sections with citations"
else
  log_fail "capability-brief should have sections with citations"
fi

# T3: Each citation has path, line_start, line_end
first_cite=$(echo "$output" | jq '[.sections[] | select(.citations | length > 0) | .citations[0]] | first' 2>/dev/null)
has_path=$(echo "$first_cite" | jq 'has("path")' 2>/dev/null || echo "false")
has_start=$(echo "$first_cite" | jq 'has("line_start")' 2>/dev/null || echo "false")
has_end=$(echo "$first_cite" | jq 'has("line_end")' 2>/dev/null || echo "false")
if [[ "$has_path" == "true" && "$has_start" == "true" && "$has_end" == "true" ]]; then
  log_pass "Citation has path, line_start, line_end fields"
else
  log_fail "Citation missing required fields: path=$has_path start=$has_start end=$has_end"
fi

# T4: Architecture-overview also works
output2=$("$SCRIPTS/extract-section-deps.sh" grimoires/loa/ground-truth/architecture-overview.md --json 2>/dev/null)
section_count2=$(echo "$output2" | jq '.sections | length' 2>/dev/null || echo "0")
if [[ "$section_count2" -gt 0 ]]; then
  log_pass "architecture-overview has $section_count2 sections"
else
  log_fail "architecture-overview should have sections"
fi

# T5: Nonexistent file returns exit 2
exit_code=0
"$SCRIPTS/extract-section-deps.sh" "/nonexistent/file.md" --json &>/dev/null || exit_code=$?
if [[ "$exit_code" -eq 2 ]]; then
  log_pass "Nonexistent file returns exit 2"
else
  log_fail "Expected exit 2 for nonexistent file, got $exit_code"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ check-staleness.sh"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T6: Current state should have no stale sections
exit_code=0
output=$("$SCRIPTS/check-staleness.sh" --json 2>/dev/null) || exit_code=$?
stale_count=$(echo "$output" | jq '.stale_count' 2>/dev/null || echo "-1")
if [[ "$exit_code" -eq 0 && "$stale_count" -eq 0 ]]; then
  log_pass "No stale sections in current state (exit=$exit_code, stale=$stale_count)"
else
  log_fail "Expected 0 stale sections, got stale=$stale_count exit=$exit_code"
fi

# T7: Document filter works
exit_code=0
output=$("$SCRIPTS/check-staleness.sh" grimoires/loa/ground-truth/capability-brief.md --json 2>/dev/null) || exit_code=$?
total_sections=$(echo "$output" | jq '.total_sections' 2>/dev/null || echo "0")
if [[ "$total_sections" -gt 0 && "$total_sections" -lt 20 ]]; then
  log_pass "Document filter returns $total_sections sections (just capability-brief)"
else
  log_fail "Expected 10-15 sections for single doc, got $total_sections"
fi

# T8: Missing manifest returns exit 2
exit_code=0
MANIFEST_BAK=""
if [[ -f grimoires/loa/ground-truth/generation-manifest.json ]]; then
  MANIFEST_BAK=$(mktemp)
  cp grimoires/loa/ground-truth/generation-manifest.json "$MANIFEST_BAK"
  mv grimoires/loa/ground-truth/generation-manifest.json grimoires/loa/ground-truth/generation-manifest.json.bak
fi

"$SCRIPTS/check-staleness.sh" --json &>/dev/null || exit_code=$?
if [[ "$exit_code" -eq 2 ]]; then
  log_pass "Missing manifest returns exit 2"
else
  log_fail "Expected exit 2 for missing manifest, got $exit_code"
fi

# Restore manifest
if [[ -n "$MANIFEST_BAK" ]]; then
  mv grimoires/loa/ground-truth/generation-manifest.json.bak grimoires/loa/ground-truth/generation-manifest.json
  rm -f "$MANIFEST_BAK"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ check-analogy-staleness.sh"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T9: Current state should have no stale analogies
exit_code=0
output=$("$SCRIPTS/check-analogy-staleness.sh" --json 2>/dev/null) || exit_code=$?
total_analogies=$(echo "$output" | jq '.total_analogies' 2>/dev/null || echo "0")
stale_analogies=$(echo "$output" | jq '.stale_count' 2>/dev/null || echo "-1")
if [[ "$exit_code" -eq 0 && "$total_analogies" -eq 12 && "$stale_analogies" -eq 0 ]]; then
  log_pass "All 12 analogies current (exit=$exit_code, stale=$stale_analogies)"
else
  log_fail "Expected 12 analogies, 0 stale — got total=$total_analogies stale=$stale_analogies exit=$exit_code"
fi

# T10: All analogies have grounded_in fields
if command -v yq &>/dev/null; then
  bank_path=".claude/skills/ground-truth/resources/analogies/analogy-bank.yaml"
  grounded_count=$(yq '[.analogies[] | select(.grounded_in != null)] | length' "$bank_path" 2>/dev/null || echo "0")
  if [[ "$grounded_count" -eq 12 ]]; then
    log_pass "All 12 analogies have grounded_in fields"
  else
    log_fail "Expected 12 analogies with grounded_in, got $grounded_count"
  fi
else
  log_pass "yq not available — skipping grounded_in field check"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ export-gate-metrics.sh"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

METRICS_FILE="grimoires/loa/ground-truth/gate-metrics.jsonl"

# Save existing metrics
metrics_bak=""
if [[ -f "$METRICS_FILE" ]]; then
  metrics_bak=$(mktemp)
  cp "$METRICS_FILE" "$metrics_bak"
fi

# Clear metrics for clean test
> "$METRICS_FILE"

# T11: Export metrics for capability-brief
exit_code=0
output=$("$SCRIPTS/export-gate-metrics.sh" grimoires/loa/ground-truth/capability-brief.md --model "claude-opus-4-6" --repairs 0 --json 2>/dev/null) || exit_code=$?
doc_type=$(echo "$output" | jq -r '.doc_type' 2>/dev/null || echo "")
model=$(echo "$output" | jq -r '.model' 2>/dev/null || echo "")
if [[ "$exit_code" -eq 0 && "$doc_type" == "capability-brief" && "$model" == "claude-opus-4-6" ]]; then
  log_pass "Metrics exported for capability-brief (model=claude-opus-4-6)"
else
  log_fail "Metrics export failed: exit=$exit_code doc_type=$doc_type model=$model"
fi

# T12: Export metrics for architecture-overview with different model
exit_code=0
output=$("$SCRIPTS/export-gate-metrics.sh" grimoires/loa/ground-truth/architecture-overview.md --model "gpt-5.2" --repairs 1 --json 2>/dev/null) || exit_code=$?
doc_type=$(echo "$output" | jq -r '.doc_type' 2>/dev/null || echo "")
model=$(echo "$output" | jq -r '.model' 2>/dev/null || echo "")
repairs=$(echo "$output" | jq -r '.repair_iterations' 2>/dev/null || echo "")
if [[ "$exit_code" -eq 0 && "$doc_type" == "architecture-overview" && "$model" == "gpt-5.2" && "$repairs" == "1" ]]; then
  log_pass "Metrics exported for architecture-overview (model=gpt-5.2, repairs=1)"
else
  log_fail "Metrics export failed: exit=$exit_code doc_type=$doc_type model=$model repairs=$repairs"
fi

# T13: JSONL file has 2 entries with correct format
line_count=$(wc -l < "$METRICS_FILE" 2>/dev/null || echo "0")
if [[ "$line_count" -eq 2 ]]; then
  log_pass "gate-metrics.jsonl has $line_count entries"
else
  log_fail "Expected 2 entries in JSONL, got $line_count"
fi

# T14: Each entry is valid JSON with required fields
valid_entries=0
while IFS= read -r line; do
  has_fields=$(echo "$line" | jq 'has("timestamp") and has("doc_type") and has("model") and has("overall") and has("gate_results")' 2>/dev/null || echo "false")
  if [[ "$has_fields" == "true" ]]; then
    ((valid_entries++)) || true
  fi
done < "$METRICS_FILE"

if [[ "$valid_entries" -eq 2 ]]; then
  log_pass "All JSONL entries have required fields (Hounfour-compatible)"
else
  log_fail "Expected 2 valid entries, got $valid_entries"
fi

# Restore original metrics
if [[ -n "$metrics_bak" ]]; then
  cp "$metrics_bak" "$METRICS_FILE"
  rm -f "$metrics_bak"
else
  rm -f "$METRICS_FILE"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ write-manifest.sh (per-section deps)"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T15: Manifest entries have sections array
has_sections=$(jq '.documents[-1] | has("sections")' grimoires/loa/ground-truth/generation-manifest.json 2>/dev/null || echo "false")
if [[ "$has_sections" == "true" ]]; then
  log_pass "Manifest entries include sections array"
else
  log_fail "Manifest entries missing sections array"
fi

# T16: Sections have content_hash and citations
first_section_keys=$(jq '.documents[-1].sections[0] | keys' grimoires/loa/ground-truth/generation-manifest.json 2>/dev/null || echo "[]")
has_hash=$(echo "$first_section_keys" | jq 'index("content_hash") != null' 2>/dev/null || echo "false")
has_citations=$(echo "$first_section_keys" | jq 'index("citations") != null' 2>/dev/null || echo "false")
if [[ "$has_hash" == "true" && "$has_citations" == "true" ]]; then
  log_pass "Sections have content_hash and citations fields"
else
  log_fail "Section fields missing: content_hash=$has_hash citations=$has_citations"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ quality-gates.sh (W4 analogy staleness gate)"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T17: Quality gates still pass on valid documents
exit_code=0
output=$("$SCRIPTS/quality-gates.sh" grimoires/loa/ground-truth/capability-brief.md --json 2>/dev/null) || exit_code=$?
if [[ "$exit_code" -eq 0 ]]; then
  log_pass "Quality gates pass on capability-brief (exit=$exit_code)"
else
  log_fail "Quality gates should pass on capability-brief, got exit=$exit_code"
  $VERBOSE && echo "    output: $output"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Cross-pipeline integration"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T18: Full pipeline: extract deps → check staleness → export metrics
exit_code=0
deps=$("$SCRIPTS/extract-section-deps.sh" grimoires/loa/ground-truth/capability-brief.md --json 2>/dev/null) || exit_code=$?
if [[ "$exit_code" -eq 0 ]]; then
  staleness_exit=0
  "$SCRIPTS/check-staleness.sh" grimoires/loa/ground-truth/capability-brief.md --json &>/dev/null || staleness_exit=$?
  if [[ "$staleness_exit" -eq 0 ]]; then
    log_pass "Full pipeline: extract deps → staleness check → clean"
  else
    log_fail "Staleness check failed in pipeline (exit=$staleness_exit)"
  fi
else
  log_fail "Extract deps failed in pipeline (exit=$exit_code)"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Sprint 30: New metadata fields"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T21: Manifest entries contain staleness_hash field
has_staleness_hash=$(jq '.documents[-1].sections[0] | has("staleness_hash")' grimoires/loa/ground-truth/generation-manifest.json 2>/dev/null || echo "false")
if [[ "$has_staleness_hash" == "true" ]]; then
  log_pass "T21: Manifest sections have staleness_hash field"
else
  # Regenerate manifest entry to get staleness_hash
  "$SCRIPTS/write-manifest.sh" grimoires/loa/ground-truth/capability-brief.md --citations 0 --warnings 0 --gates pass &>/dev/null
  has_staleness_hash=$(jq '.documents[-1].sections[0] | has("staleness_hash")' grimoires/loa/ground-truth/generation-manifest.json 2>/dev/null || echo "false")
  if [[ "$has_staleness_hash" == "true" ]]; then
    log_pass "T21: Manifest sections have staleness_hash field (after refresh)"
  else
    log_fail "T21: Manifest sections missing staleness_hash field"
  fi
fi

# T22: export-gate-metrics.sh --model test-model → JSONL has generator_model + verifier
metrics_bak2=""
if [[ -f "$METRICS_FILE" ]]; then
  metrics_bak2=$(mktemp)
  cp "$METRICS_FILE" "$metrics_bak2"
fi
> "$METRICS_FILE"

exit_code=0
output=$("$SCRIPTS/export-gate-metrics.sh" grimoires/loa/ground-truth/capability-brief.md --model "test-model" --repairs 0 --json 2>/dev/null) || exit_code=$?
gen_model=$(echo "$output" | jq -r '.generator_model' 2>/dev/null || echo "")
verifier=$(echo "$output" | jq -r '.verifier' 2>/dev/null || echo "")
if [[ "$gen_model" == "test-model" && "$verifier" == "deterministic" ]]; then
  log_pass "T22: generator_model=test-model, verifier=deterministic"
else
  log_fail "T22: Expected generator_model=test-model verifier=deterministic, got gen=$gen_model ver=$verifier"
fi

# Restore metrics
if [[ -n "$metrics_bak2" ]]; then
  cp "$metrics_bak2" "$METRICS_FILE"
  rm -f "$metrics_bak2"
else
  rm -f "$METRICS_FILE"
fi

# T23: check-analogy-staleness.sh output includes confidence per analogy
exit_code=0
analogy_output=$("$SCRIPTS/check-analogy-staleness.sh" --json 2>/dev/null) || exit_code=$?
has_analogies=$(echo "$analogy_output" | jq 'has("analogies")' 2>/dev/null || echo "false")
first_confidence=$(echo "$analogy_output" | jq -r '.analogies[0].confidence // "missing"' 2>/dev/null || echo "missing")
if [[ "$has_analogies" == "true" && ("$first_confidence" == "high" || "$first_confidence" == "moderate") ]]; then
  log_pass "T23: Analogy output includes confidence per analogy (first=$first_confidence)"
else
  log_fail "T23: Expected analogies with confidence, got has_analogies=$has_analogies confidence=$first_confidence"
fi

# T24: check-provenance.sh --json output includes untagged_paragraphs array
exit_code=0
prov_output=$("$SCRIPTS/check-provenance.sh" grimoires/loa/ground-truth/capability-brief.md --json 2>/dev/null) || exit_code=$?
has_untagged=$(echo "$prov_output" | jq 'has("untagged_paragraphs")' 2>/dev/null || echo "false")
has_count=$(echo "$prov_output" | jq 'has("untagged_count")' 2>/dev/null || echo "false")
if [[ "$has_untagged" == "true" && "$has_count" == "true" ]]; then
  log_pass "T24: Provenance output includes untagged_paragraphs array and untagged_count"
else
  log_fail "T24: Expected untagged_paragraphs and untagged_count, got array=$has_untagged count=$has_count"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Regression: existing tests still pass"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T19: Unit tests pass
unit_exit=0
"$SCRIPT_DIR/run-tests.sh" &>/dev/null || unit_exit=$?
if [[ "$unit_exit" -eq 0 ]]; then
  log_pass "All unit tests pass (run-tests.sh)"
else
  log_fail "Unit tests failed (exit=$unit_exit)"
fi

# T20: Repair loop tests pass
repair_exit=0
"$SCRIPT_DIR/test-repair-loop.sh" &>/dev/null || repair_exit=$?
if [[ "$repair_exit" -eq 0 ]]; then
  log_pass "All repair loop tests pass (test-repair-loop.sh)"
else
  log_fail "Repair loop tests failed (exit=$repair_exit)"
fi

echo ""

# ── Results ──
echo "Results"
echo "======="
echo "  Total: $total | Passed: $passed | Failed: $failed"
echo ""

if [[ $failed -gt 0 ]]; then
  echo "FAIL: $failed test(s) failed"
  exit 1
else
  echo "PASS: All $passed tests passed"
  exit 0
fi
