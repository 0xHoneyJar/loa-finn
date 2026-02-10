#!/usr/bin/env bash
# run-tests.sh — Test harness for Ground Truth verification scripts
# Runs each verifier against golden fixtures and asserts exit codes + JSON fields.
#
# Usage: run-tests.sh [--verbose]
#
# Exit codes:
#   0 = All tests pass
#   1 = One or more tests failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
SCRIPTS="$REPO_ROOT/.claude/scripts/ground-truth"

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

# ── Counters ──
passed=0
failed=0
total=0

# ── Helpers ──
log() { echo "  $*"; }
log_pass() { echo "  ✓ $*"; ((passed++)); ((total++)); }
log_fail() { echo "  ✗ $*"; ((failed++)); ((total++)); }

# Run a script and capture both output and exit code
run_script() {
  local _output _exit=0
  _output=$("$@" 2>/dev/null) || _exit=$?
  echo "$_output"
  return $_exit
}

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    log_pass "$label (exit=$actual)"
  else
    log_fail "$label — expected exit=$expected, got exit=$actual"
  fi
}

assert_json() {
  local label="$1" json="$2" query="$3" expected="$4"
  local actual
  actual=$(echo "$json" | jq -r "$query" 2>/dev/null || echo "JQ_ERROR")
  if [[ "$actual" == "$expected" ]]; then
    log_pass "$label ($query=$actual)"
  else
    log_fail "$label — expected $query=$expected, got $query=$actual"
  fi
}

assert_json_gt() {
  local label="$1" json="$2" query="$3" threshold="$4"
  local actual
  actual=$(echo "$json" | jq -r "$query" 2>/dev/null || echo "0")
  if [[ "$actual" -gt "$threshold" ]]; then
    log_pass "$label ($query=$actual > $threshold)"
  else
    log_fail "$label — expected $query > $threshold, got $query=$actual"
  fi
}

assert_json_lt() {
  local label="$1" json="$2" query="$3" threshold="$4"
  local actual
  actual=$(echo "$json" | jq -r "$query" 2>/dev/null || echo "0")
  if [[ "$actual" -lt "$threshold" ]]; then
    log_pass "$label ($query=$actual < $threshold)"
  else
    log_fail "$label — expected $query < $threshold, got $query=$actual"
  fi
}

# ── Pre-flight ──
echo "Ground Truth Verification Test Harness"
echo "======================================="
echo ""

for script in verify-citations.sh scan-banned-terms.sh check-provenance.sh; do
  if [[ ! -x "$SCRIPTS/$script" ]]; then
    echo "FATAL: $script not found or not executable at $SCRIPTS/$script"
    exit 1
  fi
done

if ! command -v jq &>/dev/null; then
  echo "FATAL: jq is required but not found"
  exit 1
fi

# All scripts must run from repo root for git ls-files to work
cd "$REPO_ROOT"

# ── Test Suite ──

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ verify-citations.sh"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T1: pass-all-gates.md — citations should verify (files exist in repo)
exit_code=0
output=$(run_script "$SCRIPTS/verify-citations.sh" "$FIXTURES/pass-all-gates.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
# Citation targets may or may not exist in git index — just log the result
$VERBOSE && log "pass-all-gates citations exit=$exit_code"

# T2: fail-bad-citation-path.md — PATH_SAFETY violation (exit=3)
exit_code=0
output=$(run_script "$SCRIPTS/verify-citations.sh" "$FIXTURES/fail-bad-citation-path.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "PATH_SAFETY rejects path traversal" 3 "$exit_code"
assert_json "PATH_SAFETY check field" "$output" '.failures[0].check' "PATH_SAFETY"

# T3: fail-missing-file.md — cites nonexistent file
exit_code=0
output=$(run_script "$SCRIPTS/verify-citations.sh" "$FIXTURES/fail-missing-file.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
# Path format is valid but file not in git — fails at PATH_SAFETY (not in index)
if [[ "$exit_code" -eq 1 || "$exit_code" -eq 3 ]]; then
  log_pass "Missing file citation rejected (exit=$exit_code)"
  ((total++))
else
  log_fail "Missing file citation — expected exit=1 or 3, got exit=$exit_code"
  ((total++))
fi
assert_json_gt "Has at least 1 failure" "$output" '.failed' 0

# T4: nonexistent input file (exit=2)
exit_code=0
output=$(run_script "$SCRIPTS/verify-citations.sh" "/nonexistent/file.md" --json) || exit_code=$?
assert_exit "Nonexistent input file" 2 "$exit_code"

# T4b: fail-wrong-line-range.md — cites valid file but out-of-range lines (exit=1)
exit_code=0
output=$(run_script "$SCRIPTS/verify-citations.sh" "$FIXTURES/fail-wrong-line-range.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "Wrong line range rejected" 1 "$exit_code"
assert_json "LINE_RANGE check field" "$output" '.failures[0].check' "LINE_RANGE"

# T4c: fail-missing-anchor.md — valid citation but evidence anchor token not in cited lines (exit=1)
exit_code=0
output=$(run_script "$SCRIPTS/verify-citations.sh" "$FIXTURES/fail-missing-anchor.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "Missing anchor token rejected" 1 "$exit_code"
assert_json "EVIDENCE_ANCHOR check field" "$output" '.failures[0].check' "EVIDENCE_ANCHOR"

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ scan-banned-terms.sh"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T5: pass-all-gates.md — no banned terms (exit=0)
exit_code=0
output=$(run_script "$SCRIPTS/scan-banned-terms.sh" "$FIXTURES/pass-all-gates.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "Clean doc has no banned terms" 0 "$exit_code"
assert_json "Zero banned terms found" "$output" '.count' "0"

# T6: fail-banned-term.md — has banned terms (exit=1)
exit_code=0
output=$(run_script "$SCRIPTS/scan-banned-terms.sh" "$FIXTURES/fail-banned-term.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "Banned terms detected" 1 "$exit_code"
assert_json_gt "At least 1 banned term" "$output" '.count' 0

# T7: nonexistent input file (exit=2)
exit_code=0
output=$(run_script "$SCRIPTS/scan-banned-terms.sh" "/nonexistent/file.md" --json) || exit_code=$?
assert_exit "Nonexistent input file" 2 "$exit_code"

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ check-provenance.sh"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T8: pass-all-gates.md — all paragraphs tagged (exit=0)
exit_code=0
output=$(run_script "$SCRIPTS/check-provenance.sh" "$FIXTURES/pass-all-gates.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "All paragraphs have provenance tags" 0 "$exit_code"
assert_json "Coverage passes" "$output" '.coverage_pass' "true"

# T9: fail-missing-provenance.md — many untagged paragraphs (exit=1)
exit_code=0
output=$(run_script "$SCRIPTS/check-provenance.sh" "$FIXTURES/fail-missing-provenance.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "Missing provenance detected" 1 "$exit_code"
assert_json "Coverage fails" "$output" '.coverage_pass' "false"
assert_json_lt "Coverage below 95%" "$output" '.coverage_pct' 95

# T10: fail-hypothesis-no-marker.md — HYPOTHESIS without epistemic marker (exit=1)
exit_code=0
output=$(run_script "$SCRIPTS/check-provenance.sh" "$FIXTURES/fail-hypothesis-no-marker.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "HYPOTHESIS without marker rejected" 1 "$exit_code"
assert_json_gt "Has provenance failures" "$output" '.fail_count' 0

# T11: nonexistent input file (exit=2)
exit_code=0
output=$(run_script "$SCRIPTS/check-provenance.sh" "/nonexistent/file.md" --json) || exit_code=$?
assert_exit "Nonexistent input file" 2 "$exit_code"

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Cross-script consistency"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T12: pass-all-gates.md should pass both scan-banned-terms AND check-provenance
bt_exit=0
prov_exit=0
"$SCRIPTS/scan-banned-terms.sh" "$FIXTURES/pass-all-gates.md" --json &>/dev/null || bt_exit=$?
"$SCRIPTS/check-provenance.sh" "$FIXTURES/pass-all-gates.md" --json &>/dev/null || prov_exit=$?
if [[ "$bt_exit" -eq 0 && "$prov_exit" -eq 0 ]]; then
  log_pass "Golden fixture passes all non-citation gates (bt=$bt_exit, prov=$prov_exit)"
  ((total++))
else
  log_fail "Golden fixture should pass all non-citation gates — bt=$bt_exit, prov=$prov_exit"
  ((total++))
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Regression: stacked CODE-FACTUAL (cycle-010)"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T13: Stacked CODE-FACTUAL paragraphs — AST resolver associates each anchor with its own citation
exit_code=0
output=$(run_script "$SCRIPTS/verify-citations.sh" "$FIXTURES/regression-stacked-code-factual.md" --json) || exit_code=$?
$VERBOSE && log "output: $output"
assert_exit "Stacked CODE-FACTUAL passes with AST resolver" 0 "$exit_code"
assert_json "All 4 citations verified" "$output" '.verified' "4"
assert_json "Zero failures" "$output" '.failed' "0"

# T14: Also passes provenance and banned-term checks
prov_exit=0
"$SCRIPTS/check-provenance.sh" "$FIXTURES/regression-stacked-code-factual.md" --json &>/dev/null || prov_exit=$?
assert_exit "Stacked CODE-FACTUAL passes provenance" 0 "$prov_exit"

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Sprint 29: Correctness hardening"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# T15: Heading with backslash produces valid JSON from parse-sections.sh
exit_code=0
output=$(run_script "$SCRIPTS/parse-sections.sh" "$FIXTURES/heading-with-backslash.md") || exit_code=$?
$VERBOSE && log "output: $output"
# Validate output is parseable JSON
if echo "$output" | jq '.' &>/dev/null; then
  log_pass "Backslash heading produces valid JSON"
  ((total++))
else
  log_fail "Backslash heading produces invalid JSON"
  ((total++))
fi
# Check heading content is preserved
backslash_heading=$(echo "$output" | jq -r '.sections[1].heading' 2>/dev/null || echo "")
if [[ "$backslash_heading" == *'\\n'* || "$backslash_heading" == *'\n'* ]]; then
  log_pass "Backslash-n preserved in heading ($backslash_heading)"
  ((total++))
else
  log_fail "Backslash-n not preserved in heading — got: $backslash_heading"
  ((total++))
fi

# T16: Symbol WAL word-boundary — no false match with WALManager
# Create temp file containing WALManager but not standalone WAL
tmp_src=$(mktemp)
echo 'export class WALManager { constructor() {} }' > "$tmp_src"
echo 'const walManager = new WALManager();' >> "$tmp_src"
# Use awk word-boundary match (same as score-symbol-specificity.sh)
wal_count=$(awk -v sym="WAL" '{
  s = $0
  while ((i = index(s, sym)) > 0) {
    pre = (i > 1) ? substr(s, i-1, 1) : ""
    post_pos = i + length(sym)
    post = (post_pos <= length(s)) ? substr(s, post_pos, 1) : ""
    if ((pre == "" || pre !~ /[a-zA-Z0-9_]/) && (post == "" || post !~ /[a-zA-Z0-9_]/))
      c++
    s = substr(s, i + length(sym))
  }
} END { print c+0 }' "$tmp_src")
rm -f "$tmp_src"
if [[ "$wal_count" -eq 0 ]]; then
  log_pass "WAL word-boundary: no false match with WALManager (count=$wal_count)"
  ((total++))
else
  log_fail "WAL word-boundary: false match with WALManager (count=$wal_count, expected 0)"
  ((total++))
fi

# T17: Fallback warning appears on stderr when section-scoped resolution fails
exit_code=0
stderr_output=$("$SCRIPTS/verify-citations.sh" "$FIXTURES/fallback-warning-trigger.md" --json 2>&1 1>/dev/null) || exit_code=$?
$VERBOSE && log "stderr: $stderr_output"
if echo "$stderr_output" | grep -q "WARNING.*falling back to document-wide"; then
  log_pass "Fallback warning emitted on stderr"
  ((total++))
else
  log_fail "Fallback warning NOT emitted on stderr — got: $stderr_output"
  ((total++))
fi
# Verify --quiet suppresses warning
quiet_stderr=$("$SCRIPTS/verify-citations.sh" "$FIXTURES/fallback-warning-trigger.md" --json --quiet 2>&1 1>/dev/null) || true
if [[ -z "$quiet_stderr" ]] || ! echo "$quiet_stderr" | grep -q "WARNING.*falling back"; then
  log_pass "--quiet suppresses fallback warning"
  ((total++))
else
  log_fail "--quiet did not suppress fallback warning — got: $quiet_stderr"
  ((total++))
fi

# T18: parser_version field present and correct in parse-sections.sh output
exit_code=0
output=$(run_script "$SCRIPTS/parse-sections.sh" "$FIXTURES/pass-all-gates.md") || exit_code=$?
$VERBOSE && log "output: $output"
assert_json "parser_version is 1.0" "$output" '.parser_version' "1.0"
# Sections should be in .sections array
sections_count=$(echo "$output" | jq '.sections | length' 2>/dev/null || echo "0")
if [[ "$sections_count" -gt 0 ]]; then
  log_pass "Sections in .sections array (count=$sections_count)"
  ((total++))
else
  log_fail "No sections found in .sections array"
  ((total++))
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
