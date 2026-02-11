#!/usr/bin/env bash
# test-repair-loop.sh — Integration test for the verify → repair → re-verify loop
# Proves the pipeline can detect and recover from 5 categories of failure.
#
# Strategy: For each test case, start with a broken fixture, then replace it
# with the deterministic "repaired" version, run quality-gates, verify it passes.
# This proves the tooling correctly detects failures and accepts repairs.
#
# Usage: test-repair-loop.sh [--verbose]
#
# Exit codes:
#   0 = All repair loop tests pass
#   1 = One or more tests failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
SCRIPTS="$REPO_ROOT/.claude/scripts/ground-truth"
WORK_DIR=$(mktemp -d)

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

# Cleanup on exit
trap "rm -rf $WORK_DIR" EXIT

# ── Counters ──
passed=0
failed=0
total=0

log_pass() { echo "  ✓ $*"; ((passed++)); ((total++)); }
log_fail() { echo "  ✗ $*"; ((failed++)); ((total++)); }

cd "$REPO_ROOT"

echo "Repair Loop Integration Tests"
echo "=============================="
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Test Case 1: Wrong line number → fix citation → pass"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Step 1: Create broken doc (cites wrong line range)
cat > "$WORK_DIR/repair-test-1.md" << 'BROKEN'
---
title: Repair Test 1
---

## Persistence

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=WALManager -->
The WAL manager at `src/persistence/index.ts:9999` handles state.
BROKEN

# Step 2: Verify it fails
exit_code=0
output=$("$SCRIPTS/verify-citations.sh" "$WORK_DIR/repair-test-1.md" --json 2>/dev/null) || exit_code=$?
$VERBOSE && echo "  broken: exit=$exit_code"

if [[ $exit_code -ne 0 ]]; then
  log_pass "Broken doc detected (exit=$exit_code)"
else
  log_fail "Broken doc should have failed but passed"
fi

# Step 3: Apply deterministic repair (fix the line number)
cat > "$WORK_DIR/repair-test-1.md" << 'FIXED'
---
title: Repair Test 1
---

## Persistence

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=WALManager -->
The WAL manager at `src/persistence/index.ts:5` handles state.
FIXED

# Step 4: Verify it passes
exit_code=0
output=$("$SCRIPTS/verify-citations.sh" "$WORK_DIR/repair-test-1.md" --json 2>/dev/null) || exit_code=$?
$VERBOSE && echo "  repaired: exit=$exit_code output=$output"

if [[ $exit_code -eq 0 ]]; then
  log_pass "Repaired doc passes (exit=$exit_code)"
else
  log_fail "Repaired doc should pass but got exit=$exit_code"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Test Case 2: Missing evidence anchor → add anchor → pass"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Step 1: Create doc with wrong evidence symbol
cat > "$WORK_DIR/repair-test-2.md" << 'BROKEN'
---
title: Repair Test 2
---

## Feature

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=NonExistentThing999 -->
The persistence layer at `src/persistence/index.ts:1-6` manages WAL state.
BROKEN

exit_code=0
"$SCRIPTS/verify-citations.sh" "$WORK_DIR/repair-test-2.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  log_pass "Missing anchor detected (exit=$exit_code)"
else
  log_fail "Missing anchor should have failed"
fi

# Step 2: Repair — fix the evidence symbol
cat > "$WORK_DIR/repair-test-2.md" << 'FIXED'
---
title: Repair Test 2
---

## Feature

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=WALManager -->
The persistence layer at `src/persistence/index.ts:1-6` manages WAL state.
FIXED

exit_code=0
"$SCRIPTS/verify-citations.sh" "$WORK_DIR/repair-test-2.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -eq 0 ]]; then
  log_pass "Fixed anchor passes (exit=$exit_code)"
else
  log_fail "Fixed anchor should pass but got exit=$exit_code"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Test Case 3: Banned term → replace with mechanism → pass"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

cat > "$WORK_DIR/repair-test-3.md" << 'BROKEN'
---
title: Repair Test 3
---

## Overview

<!-- provenance: ANALOGY -->
The system provides a revolutionary approach to state management.
BROKEN

exit_code=0
"$SCRIPTS/scan-banned-terms.sh" "$WORK_DIR/repair-test-3.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  log_pass "Banned term detected (exit=$exit_code)"
else
  log_fail "Banned term should have failed"
fi

# Repair: replace banned term with mechanism description
cat > "$WORK_DIR/repair-test-3.md" << 'FIXED'
---
title: Repair Test 3
---

## Overview

<!-- provenance: ANALOGY -->
The system uses append-only write-ahead logging for state management.
FIXED

exit_code=0
"$SCRIPTS/scan-banned-terms.sh" "$WORK_DIR/repair-test-3.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -eq 0 ]]; then
  log_pass "Mechanism description passes (exit=$exit_code)"
else
  log_fail "Mechanism description should pass but got exit=$exit_code"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Test Case 4: Missing provenance tag → add tag → pass"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

cat > "$WORK_DIR/repair-test-4.md" << 'BROKEN'
---
title: Repair Test 4
---

## Overview

The system uses WAL-based persistence for crash recovery.
BROKEN

exit_code=0
"$SCRIPTS/check-provenance.sh" "$WORK_DIR/repair-test-4.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  log_pass "Missing provenance detected (exit=$exit_code)"
else
  log_fail "Missing provenance should have failed"
fi

# Repair: add provenance tag
cat > "$WORK_DIR/repair-test-4.md" << 'FIXED'
---
title: Repair Test 4
---

## Overview

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=WALManager -->
The system uses WAL-based persistence at `src/persistence/index.ts:5` for crash recovery.
FIXED

exit_code=0
"$SCRIPTS/check-provenance.sh" "$WORK_DIR/repair-test-4.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -eq 0 ]]; then
  log_pass "Tagged doc passes provenance (exit=$exit_code)"
else
  log_fail "Tagged doc should pass provenance but got exit=$exit_code"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Test Case 5: Ungroundable claim → convert to HYPOTHESIS → pass"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# A CODE-FACTUAL paragraph citing a nonexistent file
cat > "$WORK_DIR/repair-test-5.md" << 'BROKEN'
---
title: Repair Test 5
---

## Research

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=QuantumProcessor -->
The quantum processing engine at `src/quantum/processor.ts:1-10` handles entanglement.
BROKEN

exit_code=0
"$SCRIPTS/verify-citations.sh" "$WORK_DIR/repair-test-5.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -ne 0 ]]; then
  log_pass "Ungroundable claim detected (exit=$exit_code)"
else
  log_fail "Ungroundable claim should have failed"
fi

# Repair: convert to HYPOTHESIS with epistemic marker
cat > "$WORK_DIR/repair-test-5.md" << 'FIXED'
---
title: Repair Test 5
---

## Research

<!-- provenance: HYPOTHESIS -->
We hypothesize that quantum-inspired optimization patterns could improve orchestration throughput in future iterations.
FIXED

exit_code=0
"$SCRIPTS/check-provenance.sh" "$WORK_DIR/repair-test-5.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -eq 0 ]]; then
  log_pass "HYPOTHESIS conversion passes provenance (exit=$exit_code)"
else
  log_fail "HYPOTHESIS conversion should pass but got exit=$exit_code"
fi

# Also verify no citations to check (should pass citations trivially)
exit_code=0
"$SCRIPTS/verify-citations.sh" "$WORK_DIR/repair-test-5.md" --json &>/dev/null || exit_code=$?

if [[ $exit_code -eq 0 ]]; then
  log_pass "HYPOTHESIS has no citations to fail (exit=$exit_code)"
else
  log_fail "HYPOTHESIS should pass citation check but got exit=$exit_code"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "▸ Full Pipeline: quality-gates.sh on clean document"
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Create a document that passes ALL gates
cat > "$WORK_DIR/pipeline-test.md" << 'CLEAN'
---
title: Pipeline Integration Test
---

## Overview

<!-- provenance: REPO-DOC-GROUNDED -->
This project provides durable state management via write-ahead logging. See `grimoires/loa/prd-ground-truth.md §1` for the full problem statement.

## Persistence

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=WALManager, symbol=createWALManager -->
The persistence layer uses a write-ahead log pattern via `src/persistence/index.ts:1-6`. The WALManager handles append-only writes with crash recovery semantics.

<!-- provenance: ANALOGY -->
This is the same pattern PostgreSQL uses for its write-ahead log — append-only writes ensure no partial pages reach disk, making crash recovery deterministic.

## Design

<!-- provenance: REPO-DOC-GROUNDED -->
The architecture follows a three-zone model as described in `grimoires/loa/sdd-ground-truth.md §3`.

## Limitations

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=WALManager -->
The WAL persistence layer at `src/persistence/index.ts:5` currently supports single-writer access only.

<!-- provenance: ANALOGY -->
Like Stripe's documentation-first approach, the mechanism descriptions here let developers form their own conclusions through evidence.
CLEAN

# Add freshness stamp
"$SCRIPTS/stamp-freshness.sh" "$WORK_DIR/pipeline-test.md" &>/dev/null || true

exit_code=0
output=$("$SCRIPTS/quality-gates.sh" "$WORK_DIR/pipeline-test.md" --json 2>/dev/null) || exit_code=$?
$VERBOSE && echo "  pipeline: exit=$exit_code output=$output"

if [[ $exit_code -eq 0 ]]; then
  log_pass "Full pipeline passes quality-gates.sh (exit=$exit_code)"
else
  log_fail "Full pipeline should pass but got exit=$exit_code"
  $VERBOSE || echo "  output: $output"
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
  echo "PASS: All $passed repair loop tests passed"
  exit 0
fi
