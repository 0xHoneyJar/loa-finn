#!/usr/bin/env bash
# scripts/validate-gt-yaml.sh — Validate Ground Truth YAML files
#
# Checks:
#   1. YAML parses cleanly
#   2. Required fields present on every invariant
#   3. No duplicate invariant IDs
#   4. Source files exist in the repo
#   5. Line ranges are plausible (positive integers)
#
# Usage:
#   ./scripts/validate-gt-yaml.sh                          # validate all GT YAML files
#   ./scripts/validate-gt-yaml.sh contracts.yaml           # validate specific file
#
# Exit codes:
#   0 — all checks pass
#   1 — validation failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GT_DIR="$REPO_ROOT/grimoires/loa/ground-truth"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

errors=0
warnings=0

fail() {
  echo -e "${RED}FAIL${NC}: $1" >&2
  ((errors++))
}

warn() {
  echo -e "${YELLOW}WARN${NC}: $1" >&2
  ((warnings++))
}

pass() {
  echo -e "${GREEN}PASS${NC}: $1"
}

# Determine which files to validate
if [[ $# -gt 0 ]]; then
  files=("$@")
else
  # Validate contracts.yaml specifically (other YAML files have different schemas)
  if [[ -f "$GT_DIR/contracts.yaml" ]]; then
    files=("$GT_DIR/contracts.yaml")
  else
    mapfile -t files < <(find "$GT_DIR" -name 'contracts*.yaml' -type f 2>/dev/null)
  fi
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No YAML files found to validate"
  exit 0
fi

for yaml_file in "${files[@]}"; do
  # Resolve relative paths
  if [[ ! "$yaml_file" = /* ]]; then
    yaml_file="$GT_DIR/$yaml_file"
  fi

  if [[ ! -f "$yaml_file" ]]; then
    fail "File not found: $yaml_file"
    continue
  fi

  basename_file="$(basename "$yaml_file")"
  echo "━━━ Validating: $basename_file ━━━"

  # 1. YAML parse check
  if ! python3 - "$yaml_file" <<'PARSEOF' 2>&1; then
import yaml, sys
try:
    with open(sys.argv[1]) as f:
        yaml.safe_load(f)
except yaml.YAMLError as e:
    print(f'YAML parse error: {e}', file=sys.stderr)
    sys.exit(1)
PARSEOF
    fail "$basename_file: YAML parse error"
    continue
  fi
  pass "YAML parses cleanly"

  # 2-5. Detailed validation via Python
  validation_output=$(python3 - "$yaml_file" "$REPO_ROOT" <<'VALIDEOF'
import yaml, sys, os

with open(sys.argv[1]) as f:
    data = yaml.safe_load(f)

repo_root = sys.argv[2]
errors = []
warnings = []

# Check top-level fields
required_top = ['version', 'commit', 'domains']
for field in required_top:
    if field not in data:
        errors.append(f'Missing required top-level field: {field}')

if 'domains' not in data:
    for e in errors:
        print(f'ERROR: {e}')
    sys.exit(1)

# Track all IDs for duplicate check
all_ids = []

for domain in data['domains']:
    domain_name = domain.get('name', '<unnamed>')

    if 'name' not in domain:
        errors.append(f'Domain missing name field')
    if 'invariants' not in domain:
        errors.append(f'Domain {domain_name}: missing invariants array')
        continue

    for inv in domain['invariants']:
        inv_id = inv.get('id', '<no-id>')

        # Required fields
        required_inv = ['id', 'name', 'statement', 'source', 'enforcement', 'severity']
        for field in required_inv:
            if field not in inv:
                errors.append(f'{inv_id}: missing required field \"{field}\"')

        # Check ID uniqueness
        if inv_id in all_ids:
            errors.append(f'{inv_id}: duplicate invariant ID')
        all_ids.append(inv_id)

        # Severity must be error or warning
        sev = inv.get('severity', '')
        if sev not in ('error', 'warning', 'info'):
            errors.append(f'{inv_id}: severity must be error|warning|info, got \"{sev}\"')

        # Source file exists
        source = inv.get('source', {})
        src_file = source.get('file', '')
        if src_file:
            full_path = os.path.join(repo_root, src_file)
            if not os.path.isfile(full_path):
                warnings.append(f'{inv_id}: source file not found: {src_file}')

        # Enforcement file exists
        enf = inv.get('enforcement', {})
        enf_file = enf.get('file', '')
        if enf_file:
            full_path = os.path.join(repo_root, enf_file)
            if not os.path.isfile(full_path):
                warnings.append(f'{inv_id}: enforcement file not found: {enf_file}')

        # Line ranges are positive integers
        for lines_field in [source.get('lines', source.get('line')), enf.get('lines', [])]:
            if lines_field is None:
                continue
            if isinstance(lines_field, int):
                lines_field = [lines_field]
            if isinstance(lines_field, list):
                for ln in lines_field:
                    if not isinstance(ln, int) or ln < 0:
                        errors.append(f'{inv_id}: invalid line number: {ln}')

        # Failure block recommended
        if 'failure' not in inv:
            warnings.append(f'{inv_id}: missing failure block (recommended)')

for e in errors:
    print(f'ERROR: {e}')
for w in warnings:
    print(f'WARNING: {w}')

print(f'SUMMARY: {len(all_ids)} invariants, {len(errors)} errors, {len(warnings)} warnings')
sys.exit(1 if errors else 0)
VALIDEOF
) || true

  # Parse and display results
  while IFS= read -r line; do
    case "$line" in
      ERROR:*)
        fail "${line#ERROR: }"
        ;;
      WARNING:*)
        warn "${line#WARNING: }"
        ;;
      SUMMARY:*)
        echo "  ${line#SUMMARY: }"
        ;;
      *)
        echo "  $line"
        ;;
    esac
  done <<< "$validation_output"

  echo ""
done

# Final summary
echo "━━━ Final Result ━━━"
if [[ $errors -gt 0 ]]; then
  echo -e "${RED}FAILED${NC}: $errors errors, $warnings warnings"
  exit 1
else
  echo -e "${GREEN}PASSED${NC}: 0 errors, $warnings warnings"
  exit 0
fi
