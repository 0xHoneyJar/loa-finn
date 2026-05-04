#!/usr/bin/env bash
# scripts/gt-drift-check.sh — GT Citation Drift Detector (Sprint 4 T-4.2)
#
# Compares GT line-range citations against current file content.
# Detects when cited line ranges have shifted or content no longer exists.
#
# Drift states:
#   ALIGNED — citation still accurate (function/content at cited lines)
#   SHIFTED — content moved but still exists in the file
#   BROKEN  — content no longer exists at cited location or file
#
# Usage:
#   ./scripts/gt-drift-check.sh              # Human-readable report
#   ./scripts/gt-drift-check.sh --json       # JSON output
#
# Exit codes:
#   0 — all citations ALIGNED or SHIFTED (warnings)
#   1 — at least one BROKEN citation (error)
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

# Extract citations with function names from contracts.yaml
citations=$(python3 - "$GT_YAML" <<'PYEOF'
import yaml, json, sys
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f)
results = []
for domain in data['domains']:
    for inv in domain['invariants']:
        inv_id = inv['id']
        enf = inv.get('enforcement', {})
        enf_file = enf.get('file', '')
        enf_lines = enf.get('lines', [])
        enf_func = enf.get('function', '')
        if enf_file and (enf_lines or enf_func):
            results.append({
                'id': inv_id,
                'file': enf_file,
                'lines': enf_lines,
                'function': enf_func,
            })
print(json.dumps(results))
PYEOF
)

aligned=0
shifted=0
broken=0
total=0

if $JSON_MODE; then
  echo "{"
  echo "  \"entries\": ["
fi

first=true
GT_CITATIONS="$citations" python3 - "$REPO_ROOT" "$JSON_MODE" <<'PYEOF'
import json, sys, os, re

repo_root = sys.argv[1]
entries = json.loads(os.environ['GT_CITATIONS'])
json_mode = sys.argv[2] == 'true'

aligned = 0
shifted = 0
broken = 0
results = []

def find_function_in_file(file_lines, func_name):
    """Search for a function name in file, return line number or None."""
    if not func_name or func_name == 'N/A':
        return None
    search_term = func_name.split('(')[0].strip().split()[-1]
    for i, line in enumerate(file_lines, 1):
        if search_term in line:
            return i
    return None

def get_search_term(func_name):
    """Extract the searchable portion of a function name."""
    return func_name.split('(')[0].strip().split()[-1]

for entry in entries:
    inv_id = entry['id']
    src_file = entry['file']
    lines = entry['lines']
    func_name = entry['function']
    full_path = os.path.join(repo_root, src_file)

    if not os.path.isfile(full_path):
        status = 'BROKEN'
        reason = 'file not found'
        broken += 1
    elif not lines or all(l == 0 for l in lines):
        # Empty lines — do file-level function search if function name available
        if func_name and func_name != 'N/A':
            with open(full_path) as f:
                file_lines = f.readlines()
            found_at = find_function_in_file(file_lines, func_name)
            search_term = get_search_term(func_name)
            if found_at:
                status = 'ALIGNED'
                reason = f'function "{search_term}" found at line {found_at} (no line citation)'
                aligned += 1
            else:
                status = 'BROKEN'
                reason = f'function "{search_term}" not found in file (no line citation)'
                broken += 1
        else:
            status = 'ALIGNED'
            reason = 'no line citation, no function to verify'
            aligned += 1
    else:
        with open(full_path) as f:
            file_lines = f.readlines()

        total_lines = len(file_lines)
        min_line = min(lines)
        max_line = max(lines)

        if max_line > total_lines:
            # Lines exceed file length — check if function exists elsewhere
            if func_name and func_name != 'N/A':
                found_at = find_function_in_file(file_lines, func_name)
                if found_at:
                    status = 'SHIFTED'
                    reason = f'function found at line {found_at} (cited {min_line}-{max_line})'
                    shifted += 1
                else:
                    status = 'BROKEN'
                    reason = f'cited lines {min_line}-{max_line} exceed file length {total_lines}'
                    broken += 1
            else:
                status = 'BROKEN'
                reason = f'cited lines {min_line}-{max_line} exceed file length {total_lines}'
                broken += 1
        else:
            # Check if function/content exists at cited location
            cited_content = ''.join(file_lines[min_line-1:max_line])

            if func_name and func_name != 'N/A':
                search_term = get_search_term(func_name)
                if search_term in cited_content:
                    status = 'ALIGNED'
                    reason = f'function "{search_term}" found at cited lines'
                    aligned += 1
                else:
                    # Function not at cited lines — search whole file
                    found_at = find_function_in_file(file_lines, func_name)
                    if found_at:
                        status = 'SHIFTED'
                        reason = f'function "{search_term}" found at line {found_at} (cited {min_line}-{max_line})'
                        shifted += 1
                    else:
                        status = 'BROKEN'
                        reason = f'function "{search_term}" not found in file'
                        broken += 1
            else:
                # No function name to verify — assume aligned if lines are within range
                status = 'ALIGNED'
                reason = 'within file bounds (no function to verify)'
                aligned += 1

    results.append({
        'id': inv_id,
        'file': src_file,
        'lines': lines,
        'function': func_name,
        'status': status,
        'reason': reason,
    })

if json_mode:
    first = True
    for r in results:
        if not first:
            print(',')
        first = False
        print(f'    {{"id": "{r["id"]}", "status": "{r["status"]}", "file": "{r["file"]}", "reason": "{r["reason"]}"}}', end='')
    print()
    print('  ],')
    print(f'  "aligned": {aligned},')
    print(f'  "shifted": {shifted},')
    print(f'  "broken": {broken}')
    print('}')
else:
    for r in results:
        status = r['status']
        if status == 'ALIGNED':
            color = '\033[0;32m'
        elif status == 'SHIFTED':
            color = '\033[0;33m'
        else:
            color = '\033[0;31m'
        nc = '\033[0m'
        print(f'  {color}{status:8s}{nc} {r["id"]:15s} {r["file"]}:{r["lines"]}')
        if status != 'ALIGNED':
            print(f'           {r["reason"]}')
    print()
    print('━━━ Drift Summary ━━━')
    print(f'Total citations: {len(results)}')
    print(f'Aligned: {aligned} | Shifted: {shifted} | Broken: {broken}')

if broken > 0:
    sys.exit(1)
PYEOF
