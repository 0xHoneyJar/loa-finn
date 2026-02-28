#!/usr/bin/env bash
# scripts/gt-traceability-report.sh — GT Invariant → Test Traceability Report (T-3.4)
#
# Maps GT invariant IDs from contracts.yaml to their test coverage.
# Searches test files for invariant ID references and assertion functions.
#
# Usage:
#   ./scripts/gt-traceability-report.sh           # Full report
#   ./scripts/gt-traceability-report.sh --json     # JSON output
#
# Exit codes:
#   0 — report generated (even if some invariants uncovered)
#   1 — contracts.yaml not found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GT_YAML="$REPO_ROOT/grimoires/loa/ground-truth/contracts.yaml"
TESTS_DIR="$REPO_ROOT/tests"

JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

if [[ ! -f "$GT_YAML" ]]; then
  echo "ERROR: contracts.yaml not found at $GT_YAML" >&2
  exit 1
fi

# Extract invariant IDs from contracts.yaml
mapfile -t inv_ids < <(python3 -c "
import yaml
with open('$GT_YAML') as f:
    data = yaml.safe_load(f)
for domain in data['domains']:
    for inv in domain['invariants']:
        print(inv['id'])
")

total=${#inv_ids[@]}
covered=0
uncovered=0

if $JSON_MODE; then
  echo "{"
  echo "  \"total\": $total,"
  echo "  \"entries\": ["
fi

first=true
for inv_id in "${inv_ids[@]}"; do
  # Search test files for this invariant ID
  matches=$(grep -rn "$inv_id" "$TESTS_DIR" --include="*.test.ts" --include="*.spec.ts" 2>/dev/null | head -5 || true)

  if [[ -n "$matches" ]]; then
    ((covered++)) || true
    if $JSON_MODE; then
      $first || echo ","
      first=false
      # Get first match file:line
      first_file=$(echo "$matches" | head -1 | cut -d: -f1 | sed "s|$REPO_ROOT/||")
      first_line=$(echo "$matches" | head -1 | cut -d: -f2)
      match_count=$(echo "$matches" | wc -l)
      echo -n "    {\"id\": \"$inv_id\", \"status\": \"covered\", \"file\": \"$first_file\", \"line\": $first_line, \"matches\": $match_count}"
    else
      first_file=$(echo "$matches" | head -1 | cut -d: -f1 | sed "s|$REPO_ROOT/||")
      first_line=$(echo "$matches" | head -1 | cut -d: -f2)
      printf "  %-15s → %s:%s\n" "$inv_id" "$first_file" "$first_line"
    fi
  else
    ((uncovered++)) || true
    if $JSON_MODE; then
      $first || echo ","
      first=false
      echo -n "    {\"id\": \"$inv_id\", \"status\": \"uncovered\", \"file\": null, \"line\": null, \"matches\": 0}"
    else
      printf "  %-15s → NO TEST COVERAGE\n" "$inv_id"
    fi
  fi
done

if $JSON_MODE; then
  echo ""
  echo "  ],"
  echo "  \"covered\": $covered,"
  echo "  \"uncovered\": $uncovered,"
  pct=$((100 * covered / total))
  echo "  \"coverage_percent\": $pct"
  echo "}"
else
  echo ""
  echo "━━━ Summary ━━━"
  echo "Total invariants: $total"
  echo "Covered: $covered ($(( 100 * covered / total ))%)"
  echo "Uncovered: $uncovered"
fi
