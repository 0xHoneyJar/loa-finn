#!/usr/bin/env bash
# check-links.sh — Verify all markdown relative links resolve to existing files
# Integrated into quality-gates.sh as a blocking gate per SDD §5.3.
# Required for docs/index.md link validation.
#
# Usage: check-links.sh <document-path> [--json]
#
# Exit codes:
#   0 = All relative links resolve
#   1 = Broken links found
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
    jq -nc --arg file "${DOC_PATH:-}" '{"error":"Document not found","file":$file}'
  else
    echo "ERROR: Document path required and must exist: ${DOC_PATH:-<none>}" >&2
  fi
  exit 2
fi

# ── Get document directory and project root for path jail ──
doc_dir=$(dirname "$DOC_PATH")
project_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# ── Extract markdown links: [text](path) ──
# Skip external URLs (http://, https://, mailto:, #anchors)
broken="["
first=true
broken_count=0
total_count=0

line_num=0
in_fence=false

while IFS= read -r line || [[ -n "$line" ]]; do
  ((line_num++)) || true

  # Skip code fences
  if [[ "$line" =~ ^'```' ]]; then
    if $in_fence; then in_fence=false; else in_fence=true; fi
    continue
  fi
  $in_fence && continue

  # Skip HTML comments
  [[ "$line" =~ ^'<!--' ]] && continue

  # Extract all markdown links from this line
  # Pattern: [text](path) — capture the path part
  link_regex='\[([^]]*)\]\(([^)]+)\)'
  while [[ "$line" =~ $link_regex ]]; do
    link_text="${BASH_REMATCH[1]}"
    link_path="${BASH_REMATCH[2]}"
    # Remove the matched portion to find next link
    line="${line#*"${BASH_REMATCH[0]}"}"

    # Skip external URLs, anchors, and mailto
    [[ "$link_path" =~ ^https?:// ]] && continue
    [[ "$link_path" =~ ^mailto: ]] && continue
    [[ "$link_path" =~ ^# ]] && continue

    # Strip anchor from path (path#anchor -> path)
    link_file="${link_path%%#*}"

    # Skip empty paths
    [[ -z "$link_file" ]] && continue

    ((total_count++)) || true

    # Resolve relative to document directory
    resolved="$doc_dir/$link_file"

    # Normalize path (remove ./ and resolve ../)
    resolved=$(cd "$doc_dir" 2>/dev/null && realpath -m "$link_file" 2>/dev/null || echo "$resolved")

    # Project-root jail: reject paths that escape the repository
    if [[ "$resolved" != "$project_root"* ]]; then
      ((broken_count++)) || true
      if ! $first; then broken+=","; fi
      first=false
      broken+=$(jq -nc \
        --argjson line "$line_num" \
        --arg link "$link_path" \
        --arg resolved "(outside project root)" \
        --arg text "$link_text" \
        '{line: $line, link: $link, resolved: $resolved, text: $text}')
      continue
    fi

    if [[ ! -f "$resolved" && ! -d "$resolved" ]]; then
      ((broken_count++)) || true
      if ! $first; then broken+=","; fi
      first=false
      broken+=$(jq -nc \
        --argjson line "$line_num" \
        --arg link "$link_path" \
        --arg resolved "$resolved" \
        --arg text "$link_text" \
        '{line: $line, link: $link, resolved: $resolved, text: $text}')
    fi
  done
done < "$DOC_PATH"

broken+="]"

# ── Output ──
if $JSON_OUTPUT; then
  jq -nc \
    --arg file "$DOC_PATH" \
    --argjson total_links "$total_count" \
    --argjson broken_count "$broken_count" \
    --argjson broken "$broken" \
    '{file: $file, total_links: $total_links, broken_count: $broken_count, broken: $broken}'
else
  if [[ $broken_count -gt 0 ]]; then
    echo "FAIL: $broken_count broken link(s) out of $total_count total"
    echo "$broken" | jq -r '.[] | "  Line \(.line): [\(.text)](\(.link)) → \(.resolved)"' 2>/dev/null || echo "  $broken"
  else
    echo "PASS: All $total_count relative links resolve"
  fi
fi

if [[ $broken_count -gt 0 ]]; then
  exit 1
else
  exit 0
fi
