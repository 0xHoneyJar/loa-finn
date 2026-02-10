#!/usr/bin/env bash
# extract-section-deps.sh — Extract per-section citation dependencies from a Ground Truth document
# For each ## section, lists all cited file:line paths and computes a content hash.
# Output is consumed by write-manifest.sh for incremental regeneration tracking.
#
# Usage: extract-section-deps.sh <document-path> [--json]
#
# Exit codes:
#   0 = Dependencies extracted successfully
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
  echo '{"error":"Input file not found","file":"'"${DOC_PATH:-}"'"}' >&2
  exit 2
fi

# ── Parse sections using section parser ──
sections_raw='{"parser_version":"1.0","sections":[]}'
if [[ -x "$SCRIPT_DIR/parse-sections.sh" ]]; then
  sections_raw=$("$SCRIPT_DIR/parse-sections.sh" "$DOC_PATH" 2>/dev/null || echo '{"parser_version":"1.0","sections":[]}')
fi

# Check parser_version
parser_version=$(echo "$sections_raw" | jq -r '.parser_version // "unknown"' 2>/dev/null || echo "unknown")
if [[ "$parser_version" != "1.0" ]]; then
  echo "WARNING: Unexpected parser_version '$parser_version' (expected 1.0)" >&2
fi

# Extract sections array for consumption
sections_json=$(echo "$sections_raw" | jq '.sections' 2>/dev/null || echo "[]")
num_sections=$(echo "$sections_json" | jq 'length' 2>/dev/null || echo "0")

if [[ "$num_sections" -eq 0 ]]; then
  echo '{"file":"'"$DOC_PATH"'","sections":[]}'
  exit 0
fi

# ── Extract citations per section ──
result_json='{"file":"'"$DOC_PATH"'","sections":['
first_section=true

for ((s=0; s<num_sections; s++)); do
  heading=$(echo "$sections_json" | jq -r ".[$s].heading" 2>/dev/null)
  start_line=$(echo "$sections_json" | jq -r ".[$s].start_line" 2>/dev/null)
  end_line=$(echo "$sections_json" | jq -r ".[$s].end_line" 2>/dev/null)

  # Extract section content for hashing
  section_content=$(sed -n "${start_line},${end_line}p" "$DOC_PATH" 2>/dev/null || echo "")
  content_hash=$(echo "$section_content" | git hash-object --stdin 2>/dev/null || echo "unknown")
  # Whitespace-normalized hash for change detection (formatting-only edits don't trigger staleness)
  staleness_hash=$(echo "$section_content" | tr -s '[:space:]' ' ' | git hash-object --stdin 2>/dev/null || echo "unknown")

  # Extract citations from this section's lines
  citations_json="["
  first_cite=true

  while IFS= read -r line; do
    tmpline="$line"
    while [[ "$tmpline" =~ \`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+:[0-9]+(-[0-9]+)?)\` ]]; do
      citation="${BASH_REMATCH[1]}"
      cite_path="${citation%%:*}"
      line_spec="${citation#*:}"

      if [[ "$line_spec" == *-* ]]; then
        line_start="${line_spec%-*}"
        line_end="${line_spec#*-}"
      else
        line_start="$line_spec"
        line_end="$line_spec"
      fi

      if ! $first_cite; then citations_json+=","; fi
      first_cite=false
      cite_entry=$(jq -nc --arg path "$cite_path" --argjson ls "$line_start" --argjson le "$line_end" \
        '{path: $path, line_start: $ls, line_end: $le}')
      citations_json+="$cite_entry"

      tmpline="${tmpline#*"${BASH_REMATCH[0]}"}"
    done
  done <<< "$section_content"

  citations_json+="]"

  # Build section entry
  if ! $first_section; then result_json+=","; fi
  first_section=false

  section_entry=$(jq -nc \
    --arg heading "$heading" \
    --argjson start_line "$start_line" \
    --argjson end_line "$end_line" \
    --arg content_hash "$content_hash" \
    --arg staleness_hash "$staleness_hash" \
    --argjson citations "$citations_json" \
    '{heading: $heading, start_line: $start_line, end_line: $end_line, content_hash: $content_hash, staleness_hash: $staleness_hash, citations: $citations}')
  result_json+="$section_entry"
done

result_json+=']}'

if $JSON_OUTPUT; then
  echo "$result_json" | jq '.' 2>/dev/null || echo "$result_json"
else
  echo "$result_json" | jq -r '.sections[] | "\(.heading): \(.citations | length) citations (hash: \(.content_hash | .[0:8]))"' 2>/dev/null || echo "$result_json"
fi

exit 0
