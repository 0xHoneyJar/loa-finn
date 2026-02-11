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
# Same paragraph detection logic as check-provenance.sh for consistency
stats=$(awk '
BEGIN {
  state = "NORMAL"
  fm_count = 0
  in_paragraph = 0
  pending_tag_class = ""
  total = 0
  code_factual = 0
  inferred = 0
  operational = 0
  external_ref = 0
  hypothesis = 0
  derived = 0
  untagged = 0
}

function count_paragraph(tag_class) {
  total++
  if (tag_class == "CODE-FACTUAL") code_factual++
  else if (tag_class == "INFERRED") inferred++
  else if (tag_class == "OPERATIONAL") operational++
  else if (tag_class == "EXTERNAL-REFERENCE") external_ref++
  else if (tag_class == "HYPOTHESIS") hypothesis++
  else if (tag_class == "DERIVED") derived++
  else untagged++
}

{
  # Frontmatter
  if (state == "NORMAL" && /^---[[:space:]]*$/ && (NR <= 1 || fm_count == 0)) {
    if (in_paragraph) { count_paragraph(pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
    state = "IN_FRONTMATTER"; fm_count++; next
  }
  if (state == "IN_FRONTMATTER") { if (/^---[[:space:]]*$/) state = "NORMAL"; next }

  # Fenced code blocks
  if (state == "NORMAL" && /^```/) {
    if (in_paragraph) { count_paragraph(pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
    state = "IN_FENCE"; next
  }
  if (state == "IN_FENCE") { if (/^```/) state = "NORMAL"; next }

  # Multi-line HTML comments
  # Accepts optional subclassification: <!-- provenance: INFERRED (architectural) -->
  if (state == "NORMAL" && /<!--/ && !/-->/) {
    if (match($0, /<!-- provenance: [A-Z_-]+/)) {
      tmp = substr($0, RSTART, RLENGTH)
      sub(/<!-- provenance: /, "", tmp)
      sub(/ .*/, "", tmp)  # Strip any qualifier after class name
      pending_tag_class = tmp
    }
    state = "IN_HTML_COMMENT"; next
  }
  if (state == "IN_HTML_COMMENT") { if (/-->/) state = "NORMAL"; next }

  # Single-line HTML comments (provenance tags)
  # Accepts optional subclassification: <!-- provenance: INFERRED (architectural) -->
  if (state == "NORMAL" && /<!--.*-->/) {
    if (match($0, /<!-- provenance: [A-Z_-]+/)) {
      tmp = substr($0, RSTART, RLENGTH)
      sub(/<!-- provenance: /, "", tmp)
      sub(/ .*/, "", tmp)  # Strip any qualifier after class name
      pending_tag_class = tmp
    }
    next
  }

  # Skip non-taggable lines in NORMAL state
  if (state == "NORMAL") {
    # Headings
    if (/^#+[[:space:]]/) {
      if (in_paragraph) { count_paragraph(pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
      next
    }
    # Table rows
    if (/^\|/) {
      if (in_paragraph) { count_paragraph(pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
      next
    }
    # Blockquotes
    if (/^>/) {
      if (in_paragraph) { count_paragraph(pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
      next
    }
    # Blank lines end paragraphs
    if (/^[[:space:]]*$/) {
      if (in_paragraph) { count_paragraph(pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
      next
    }
    # Non-blank, non-control line = paragraph content
    if (!in_paragraph) {
      in_paragraph = 1
    }
  }
}

END {
  if (in_paragraph) count_paragraph(pending_tag_class)
  tagged = total - untagged
  print total " " code_factual " " inferred " " operational " " external_ref " " hypothesis " " derived " " untagged " " tagged
}' "$DOC_PATH")

# Parse awk output
read -r total cf inf op er hy dv ut tagged <<< "$stats"

# Compute ratio and trust_level
# DERIVED counts equivalent to CODE-FACTUAL per ADR-002
if [[ $tagged -gt 0 ]]; then
  # Use bc for floating point, fallback to awk
  ratio=$(awk "BEGIN { printf \"%.4f\", ($cf + $dv) / $tagged }" 2>/dev/null || echo "0.0000")
else
  ratio="0.0000"
fi

# Determine trust_level from ratio
# Use awk for float comparison
trust_level=$(awk "BEGIN {
  r = $ratio + 0
  if (r >= 0.90) print \"high\"
  else if (r >= 0.60) print \"medium\"
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
  echo "  INFERRED:          $inf"
  echo "  OPERATIONAL:       $op"
  echo "  EXTERNAL-REFERENCE: $er"
  echo "  HYPOTHESIS:        $hy"
  echo "  DERIVED:           $dv"
  echo "  Ratio:             $ratio (CODE-FACTUAL + DERIVED / tagged)"
  echo "  Trust Level:       $trust_level"
fi

exit 0
