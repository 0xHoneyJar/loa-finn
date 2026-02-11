#!/usr/bin/env bash
# provenance-stats.sh — Deterministic provenance statistics and trust_level computation
# Reuses the same awk paragraph detection logic as check-provenance.sh.
#
# Usage: provenance-stats.sh <document-path> [--json]
#
# Output (JSON): { "file": "...", "counts": { "CODE-FACTUAL": N, ... },
#                  "total_blocks": N, "code_factual_ratio": 0.XX,
#                  "trust_level": "high|medium|low" }
#
# trust_level thresholds:
#   high:   code_factual_ratio >= 0.90
#   medium: code_factual_ratio >= 0.60
#   low:    code_factual_ratio <  0.60
#
# Exit codes:
#   0 = Success
#   2 = Input file not found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOC_PATH="${1:-}"
JSON_OUTPUT=false

for arg in "$@"; do
  if [[ "$arg" == "--json" ]]; then
    JSON_OUTPUT=true
  fi
done

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  if $JSON_OUTPUT; then
    echo '{"error":"Input file not found","file":"'"${DOC_PATH:-}"'"}'
  else
    echo "ERROR: Input file not found: ${DOC_PATH:-<none>}" >&2
  fi
  exit 2
fi

# ── Awk state machine: count provenance-tagged blocks per class ──
# Uses shared paragraph-detector.awk for state machine + consumer-specific process_paragraph()
SHARED_AWK="$SCRIPT_DIR/shared/paragraph-detector.awk"
stats=$(awk -f "$SHARED_AWK" -f <(cat <<'CONSUMER_AWK'
BEGIN {
  total = 0
  code_factual = 0
  inferred = 0
  inf_architectural = 0
  inf_upgradeable = 0
  inf_pending_evidence = 0
  inf_unqualified = 0
  operational = 0
  external_ref = 0
  hypothesis = 0
  derived = 0
  untagged = 0
}

function process_paragraph(start, tag_class) {
  total++
  if (tag_class == "CODE-FACTUAL") code_factual++
  else if (tag_class == "INFERRED") {
    inferred++
    if (pending_tag_qualifier == "architectural") inf_architectural++
    else if (pending_tag_qualifier == "upgradeable") inf_upgradeable++
    else if (pending_tag_qualifier == "pending-evidence") inf_pending_evidence++
    else inf_unqualified++
  }
  else if (tag_class == "OPERATIONAL") operational++
  else if (tag_class == "EXTERNAL-REFERENCE") external_ref++
  else if (tag_class == "HYPOTHESIS") hypothesis++
  else if (tag_class == "DERIVED") derived++
  else untagged++
}

END {
  if (in_paragraph) process_paragraph(para_start, pending_tag_class)
  tagged = total - untagged
  print total " " code_factual " " inferred " " operational " " external_ref " " hypothesis " " derived " " untagged " " tagged " " inf_architectural " " inf_upgradeable " " inf_pending_evidence " " inf_unqualified
}
CONSUMER_AWK
) "$DOC_PATH")

# Parse awk output
read -r total cf inf op er hy dv ut tagged inf_arch inf_upg inf_pend inf_unq <<< "$stats"

# Compute ratio and trust_level
# DERIVED counts equivalent to CODE-FACTUAL per ADR-002
if [[ $tagged -gt 0 ]]; then
  # Use bc for floating point, fallback to awk
  ratio=$(awk "BEGIN { printf \"%.4f\", ($cf + $dv) / $tagged }" 2>/dev/null || echo "0.0000")
else
  ratio="0.0000"
fi

# Read configurable thresholds (fallback to hardcoded defaults)
# shellcheck source=shared/read-config.sh
source "$SCRIPT_DIR/shared/read-config.sh"
THRESHOLD_HIGH=$(read_config "ground_truth.provenance.thresholds.high" "0.90")
THRESHOLD_MEDIUM=$(read_config "ground_truth.provenance.thresholds.medium" "0.60")

# Determine trust_level from ratio
# Use awk for float comparison
trust_level=$(awk "BEGIN {
  r = $ratio + 0
  if (r >= $THRESHOLD_HIGH) print \"high\"
  else if (r >= $THRESHOLD_MEDIUM) print \"medium\"
  else print \"low\"
}")

if $JSON_OUTPUT; then
  jq -nc \
    --arg file "$DOC_PATH" \
    --argjson total "$total" \
    --argjson tagged "$tagged" \
    --argjson code_factual "$cf" \
    --argjson inferred "$inf" \
    --argjson operational "$op" \
    --argjson external_reference "$er" \
    --argjson hypothesis "$hy" \
    --argjson derived "$dv" \
    --argjson untagged "$ut" \
    --argjson inf_arch "$inf_arch" \
    --argjson inf_upg "$inf_upg" \
    --argjson inf_pend "$inf_pend" \
    --argjson inf_unq "$inf_unq" \
    --arg ratio "$ratio" \
    --arg trust_level "$trust_level" \
    '{
      file: $file,
      counts: {
        "CODE-FACTUAL": $code_factual,
        "INFERRED": $inferred,
        "OPERATIONAL": $operational,
        "EXTERNAL-REFERENCE": $external_reference,
        "HYPOTHESIS": $hypothesis,
        "DERIVED": $derived
      },
      INFERRED_BREAKDOWN: {
        "architectural": $inf_arch,
        "upgradeable": $inf_upg,
        "pending-evidence": $inf_pend,
        "unqualified": $inf_unq
      },
      total_blocks: $total,
      tagged_blocks: $tagged,
      untagged_blocks: $untagged,
      code_factual_ratio: ($ratio | tonumber),
      trust_level: $trust_level
    }'
else
  echo "Provenance Stats: $DOC_PATH"
  echo "  Total blocks:      $total (tagged: $tagged, untagged: $ut)"
  echo "  CODE-FACTUAL:      $cf"
  echo "  INFERRED:          $inf (architectural: $inf_arch, upgradeable: $inf_upg, pending-evidence: $inf_pend, unqualified: $inf_unq)"
  echo "  OPERATIONAL:       $op"
  echo "  EXTERNAL-REFERENCE: $er"
  echo "  HYPOTHESIS:        $hy"
  echo "  DERIVED:           $dv"
  echo "  Ratio:             $ratio (CODE-FACTUAL + DERIVED / tagged)"
  echo "  Trust Level:       $trust_level"
fi

exit 0
