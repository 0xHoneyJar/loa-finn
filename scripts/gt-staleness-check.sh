#!/usr/bin/env bash
# scripts/gt-staleness-check.sh — GT Citation Staleness Detector (Sprint 4 T-4.1)
#
# Reads contracts.yaml and GT markdown files, extracts file:line citations,
# and checks if cited source files have been modified since the GT was written.
#
# Staleness states:
#   FRESH   — source file unchanged since GT commit
#   STALE   — source file modified after GT commit
#   MISSING — cited source file no longer exists
#
# Usage:
#   ./scripts/gt-staleness-check.sh              # Human-readable report
#   ./scripts/gt-staleness-check.sh --json       # JSON output
#
# Exit codes:
#   0 — all citations FRESH or STALE (warnings)
#   1 — at least one MISSING citation (error)
#   2 — contracts.yaml not found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GT_DIR="$REPO_ROOT/grimoires/loa/ground-truth"
GT_YAML="$GT_DIR/contracts.yaml"

JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

if [[ ! -f "$GT_YAML" ]]; then
  echo "ERROR: contracts.yaml not found" >&2
  exit 2
fi

cd "$REPO_ROOT"

# Get GT commit from contracts.yaml
gt_commit=$(python3 - "$GT_YAML" <<'PYEOF'
import yaml, sys
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f)
print(data.get('commit', 'HEAD'))
PYEOF
)

# Extract unique source files from contracts.yaml
mapfile -t source_files < <(python3 - "$GT_YAML" <<'PYEOF'
import yaml, sys
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f)
files = set()
for domain in data['domains']:
    for inv in domain['invariants']:
        src = inv.get('source', {})
        if src.get('file'):
            files.add(src['file'])
        enf = inv.get('enforcement', {})
        if enf.get('file'):
            files.add(enf['file'])
for f in sorted(files):
    print(f)
PYEOF
)

# Also extract citations from GT markdown files
mapfile -t md_citations < <(
  grep -ohP 'file=[a-zA-Z0-9/._ -]+\.(ts|js|json)' "$GT_DIR"/*.md 2>/dev/null | \
    sed 's/^file=//' | sort -u
)

# Combine and deduplicate
all_files=()
declare -A seen
for f in "${source_files[@]}" "${md_citations[@]}"; do
  [[ -z "$f" ]] && continue
  # Strip line numbers if present
  f_clean=$(echo "$f" | sed 's/:[0-9].*$//')
  if [[ -z "${seen[$f_clean]:-}" ]]; then
    seen[$f_clean]=1
    all_files+=("$f_clean")
  fi
done

fresh=0
stale=0
missing=0
total=${#all_files[@]}

if $JSON_MODE; then
  echo "{"
  echo "  \"gt_commit\": \"$gt_commit\","
  echo "  \"total_files\": $total,"
  echo "  \"entries\": ["
fi

first=true
for src_file in "${all_files[@]}"; do
  full_path="$REPO_ROOT/$src_file"

  if [[ ! -f "$full_path" ]]; then
    ((missing++)) || true
    status="MISSING"
    days=""
  else
    # Get last modification commit for this file
    last_commit=$(git log --follow -1 --format='%H' -- "$src_file" 2>/dev/null || echo "")

    if [[ -z "$last_commit" ]]; then
      # File exists but not tracked by git
      status="FRESH"
      days="0"
      ((fresh++)) || true
    else
      # Check if source was modified after GT commit
      gt_date=$(git log -1 --format='%at' "$gt_commit" 2>/dev/null || echo "0")
      src_date=$(git log -1 --format='%at' "$last_commit" 2>/dev/null || echo "0")

      if [[ "$src_date" -gt "$gt_date" ]]; then
        status="STALE"
        days=$(( (src_date - gt_date) / 86400 ))
        ((stale++)) || true
      else
        status="FRESH"
        days="0"
        ((fresh++)) || true
      fi
    fi
  fi

  if $JSON_MODE; then
    $first || echo ","
    first=false
    echo -n "    {\"file\": \"$src_file\", \"status\": \"$status\", \"days_since_gt\": ${days:-null}}"
  else
    case "$status" in
      FRESH)   printf "  \033[0;32m%-8s\033[0m %s\n" "$status" "$src_file" ;;
      STALE)   printf "  \033[0;33m%-8s\033[0m %s (+%s days)\n" "$status" "$src_file" "$days" ;;
      MISSING) printf "  \033[0;31m%-8s\033[0m %s\n" "$status" "$src_file" ;;
    esac
  fi
done

if $JSON_MODE; then
  echo ""
  echo "  ],"
  echo "  \"fresh\": $fresh,"
  echo "  \"stale\": $stale,"
  echo "  \"missing\": $missing"
  echo "}"
else
  echo ""
  echo "━━━ Staleness Summary ━━━"
  echo "Total cited files: $total"
  echo "Fresh: $fresh | Stale: $stale | Missing: $missing"
fi

if [[ $missing -gt 0 ]]; then
  exit 1
fi
exit 0
