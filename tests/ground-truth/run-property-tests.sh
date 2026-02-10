#!/usr/bin/env bash
# run-property-tests.sh — Property test harness for Ground Truth verification
# Runs generated documents through quality gates and verifies:
#   (1) All valid documents pass
#   (2) All invalid documents fail
#   (3) Each invalid document fails on the expected gate
#
# Usage: run-property-tests.sh [--count N] [--verbose]
#
# Exit codes:
#   0 = All property tests pass
#   1 = One or more property tests failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPTS="$REPO_ROOT/.claude/scripts/ground-truth"

VERBOSE=false
COUNT=50

for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=true ;;
    --count) : ;;
    *)
      if [[ "${prev_arg:-}" == "--count" ]]; then
        COUNT="$arg"
      fi
      ;;
  esac
  prev_arg="$arg"
done

# ── Counters ──
passed=0
failed=0
total=0

log_pass() { ((passed++)) || true; ((total++)) || true; $VERBOSE && echo "  ✓ $*" || true; }
log_fail() { ((failed++)) || true; ((total++)) || true; echo "  ✗ $*"; }

cd "$REPO_ROOT"

echo "Ground Truth Property Test Harness"
echo "==================================="
echo ""

# ── Step 1: Generate test documents ──
WORK_DIR=$(mktemp -d)
trap "rm -rf $WORK_DIR" EXIT

echo "Generating $COUNT valid + $COUNT invalid documents..."
gen_output=$("$SCRIPT_DIR/generate-test-documents.sh" "$WORK_DIR" --count "$COUNT" --json 2>&1)
valid_count=$(echo "$gen_output" | jq -r '.valid_count' 2>/dev/null || echo "0")
invalid_count=$(echo "$gen_output" | jq -r '.invalid_count' 2>/dev/null || echo "0")
echo "Generated: $valid_count valid, $invalid_count invalid"
echo ""

# ── Step 2: Test valid documents ──
echo "▸ Valid documents (expect all PASS)"
valid_passed=0
valid_failed=0

for doc in "$WORK_DIR/valid"/doc-*.md; do
  [[ -f "$doc" ]] || continue
  basename=$(basename "$doc")

  # Run verify-citations (the most likely gate to fail on valid docs)
  exit_code=0
  output=$("$SCRIPTS/verify-citations.sh" "$doc" --json 2>/dev/null) || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    # Also run check-provenance and scan-banned-terms
    prov_exit=0
    "$SCRIPTS/check-provenance.sh" "$doc" --json &>/dev/null || prov_exit=$?

    ban_exit=0
    "$SCRIPTS/scan-banned-terms.sh" "$doc" --json &>/dev/null || ban_exit=$?

    if [[ $prov_exit -eq 0 && $ban_exit -eq 0 ]]; then
      log_pass "$basename passes all gates"
      ((valid_passed++)) || true
    else
      log_fail "$basename — citations pass but prov=$prov_exit ban=$ban_exit"
      ((valid_failed++)) || true
      $VERBOSE && echo "    provenance=$prov_exit banned=$ban_exit"
    fi
  else
    log_fail "$basename — verify-citations exit=$exit_code"
    ((valid_failed++)) || true
    $VERBOSE && echo "    output: $output"
  fi
done

echo "  Valid: $valid_passed passed, $valid_failed failed"
echo ""

# ── Step 3: Test invalid documents ──
echo "▸ Invalid documents (expect all FAIL on correct gate)"
invalid_correct=0
invalid_wrong_gate=0
invalid_unexpected_pass=0

# Load manifest
manifest="$WORK_DIR/invalid/manifest.json"
if [[ ! -f "$manifest" ]]; then
  echo "FATAL: Manifest not found at $manifest"
  exit 1
fi

for doc in "$WORK_DIR/invalid"/doc-*.md; do
  [[ -f "$doc" ]] || continue
  basename=$(basename "$doc")

  # Look up expected defect from manifest
  expected_gate=$(jq -r --arg f "$basename" '.[] | select(.file == $f) | .expected_gate' "$manifest" 2>/dev/null || echo "unknown")
  defect_type=$(jq -r --arg f "$basename" '.[] | select(.file == $f) | .defect_type' "$manifest" 2>/dev/null || echo "unknown")

  # Run the expected gate script
  exit_code=0
  case "$expected_gate" in
    verify-citations)
      "$SCRIPTS/verify-citations.sh" "$doc" --json &>/dev/null || exit_code=$?
      ;;
    check-provenance)
      "$SCRIPTS/check-provenance.sh" "$doc" --json &>/dev/null || exit_code=$?
      ;;
    scan-banned-terms)
      "$SCRIPTS/scan-banned-terms.sh" "$doc" --json &>/dev/null || exit_code=$?
      ;;
    *)
      log_fail "$basename — unknown expected gate: $expected_gate"
      continue
      ;;
  esac

  if [[ $exit_code -ne 0 ]]; then
    log_pass "$basename correctly fails $expected_gate ($defect_type)"
    ((invalid_correct++)) || true
  else
    log_fail "$basename — expected $expected_gate to fail ($defect_type) but it passed"
    ((invalid_unexpected_pass++)) || true
  fi
done

echo "  Invalid: $invalid_correct correct failures, $invalid_unexpected_pass unexpected passes, $invalid_wrong_gate wrong gate"
echo ""

# ── Results ──
echo "Results"
echo "======="
echo "  Total: $total | Passed: $passed | Failed: $failed"
echo "  Valid docs: $valid_passed/$valid_count passing"
echo "  Invalid docs: $invalid_correct/$invalid_count correct gate failures"
echo ""

if [[ $failed -gt 0 ]]; then
  echo "FAIL: $failed property test(s) failed"
  exit 1
else
  echo "PASS: All $passed property tests passed"
  exit 0
fi
