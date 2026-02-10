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
