#!/usr/bin/env bash
# parse-sections.sh — Parse markdown document into section tree with boundaries
# Outputs JSON array of {heading, start_line, end_line, depth} for each ## section.
# Handles fenced code blocks (skips headings inside them).
#
# Usage: parse-sections.sh <document-path> [--json]
#
# Exit codes:
#   0 = Success
#   2 = Input file not found or unreadable

set -euo pipefail

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

# ── awk state machine: extract section boundaries ──
# Handles fenced code blocks, frontmatter, and multi-line HTML comments
awk '
BEGIN {
  state = "NORMAL"
  fm_count = 0
  section_count = 0
  printf "{\"parser_version\":\"1.0\",\"sections\":["
}

# Frontmatter
state == "NORMAL" && /^---[[:space:]]*$/ && (NR <= 1 || fm_count == 0) {
  state = "IN_FRONTMATTER"; fm_count++; next
}
state == "IN_FRONTMATTER" {
  if (/^---[[:space:]]*$/) state = "NORMAL"
  next
}

# Fenced code blocks
state == "NORMAL" && /^```/ {
  state = "IN_FENCE"; next
}
state == "IN_FENCE" {
  if (/^```/) state = "NORMAL"
  next
}

# Multi-line HTML comments
state == "NORMAL" && /<!--/ && !/-->/ {
  state = "IN_HTML_COMMENT"; next
}
state == "IN_HTML_COMMENT" {
  if (/-->/) state = "NORMAL"
  next
}

# Heading detection in NORMAL state
state == "NORMAL" && /^#+[[:space:]]/ {
  # Count hash depth
  line = $0
  depth = 0
  while (substr(line, depth + 1, 1) == "#") depth++

  # Close previous section at this heading depth or shallower
  if (section_count > 0) {
    # Update end_line of last section to line before this heading
    sections_end[section_count] = NR - 1
  }

  section_count++
  # Extract heading text (strip leading hashes and spaces)
  heading = $0
  sub(/^#+[[:space:]]+/, "", heading)
  # Remove trailing whitespace
  sub(/[[:space:]]+$/, "", heading)

  sections_heading[section_count] = heading
  sections_start[section_count] = NR
  sections_depth[section_count] = depth
  sections_end[section_count] = NR  # Will be updated later
}

END {
  # Close last section at EOF
  if (section_count > 0) {
    sections_end[section_count] = NR
  }

  for (i = 1; i <= section_count; i++) {
    if (i > 1) printf ","
    # Escape heading for JSON (backslashes first, then quotes)
    h = sections_heading[i]
    gsub(/\\/, "\\\\", h)
    gsub(/"/, "\\\"", h)
    printf "{\"heading\":\"%s\",\"start_line\":%d,\"end_line\":%d,\"depth\":%d}", \
      h, sections_start[i], sections_end[i], sections_depth[i]
  }
  printf "]}"
}' "$DOC_PATH"

echo ""  # Trailing newline for clean output
