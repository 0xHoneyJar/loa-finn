#!/usr/bin/env bash
# scripts/gt-health.sh — GT Health Check (Sprint 4 T-4.3)
#
# Combines staleness + drift + YAML validation into a single health report.
# Designed for CI integration (gt-health job).
#
# Exit codes:
#   0 — healthy (all checks pass)
#   1 — stale (warnings present but no broken citations)
#   2 — broken (broken citations or missing files)
#
# Usage:
#   ./scripts/gt-health.sh              # Human-readable
#   ./scripts/gt-health.sh --json       # JSON output

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

overall_status="healthy"
yaml_ok=true
staleness_ok=true
drift_ok=true

echo "━━━ GT Health Check ━━━"
echo ""

# 1. YAML validation
echo "▸ YAML Validation"
if bash "$SCRIPT_DIR/validate-gt-yaml.sh" 2>&1; then
  echo ""
else
  yaml_ok=false
  overall_status="broken"
  echo ""
fi

# 2. Staleness check
echo "▸ Staleness Check"
staleness_exit=0
bash "$SCRIPT_DIR/gt-staleness-check.sh" 2>&1 || staleness_exit=$?
echo ""

if [[ $staleness_exit -eq 1 ]]; then
  staleness_ok=false
  if [[ "$overall_status" == "healthy" ]]; then
    overall_status="stale"
  fi
elif [[ $staleness_exit -eq 2 ]]; then
  staleness_ok=false
  overall_status="broken"
fi

# 3. Drift check
echo "▸ Drift Check"
drift_exit=0
bash "$SCRIPT_DIR/gt-drift-check.sh" 2>&1 || drift_exit=$?
echo ""

if [[ $drift_exit -eq 1 ]]; then
  drift_ok=false
  if [[ "$overall_status" == "healthy" ]]; then
    overall_status="stale"
  fi
fi

# Summary
echo "━━━ Overall Health ━━━"
echo ""
printf "  YAML:      %s\n" "$( $yaml_ok && echo "✓ PASS" || echo "✗ FAIL" )"
printf "  Staleness: %s\n" "$( $staleness_ok && echo "✓ PASS" || echo "✗ FAIL" )"
printf "  Drift:     %s\n" "$( $drift_ok && echo "✓ PASS" || echo "✗ FAIL" )"
echo ""

case "$overall_status" in
  healthy)
    echo "Status: HEALTHY"
    exit 0
    ;;
  stale)
    echo "Status: STALE (warnings)"
    exit 1
    ;;
  broken)
    echo "Status: BROKEN (errors)"
    exit 2
    ;;
esac
