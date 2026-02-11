#!/usr/bin/env bash
# check-staleness.sh — Detect stale sections in Ground Truth documents
# Reads generation-manifest.json sections, checks each cited file's current
# content hash against stored content_hash, outputs which sections are stale.
#
# Usage: check-staleness.sh [<document-path>] [--json]
#        If no document specified, checks all documents in manifest.
#
# Exit codes:
#   0 = No stale sections (or no manifest)
#   1 = One or more sections are stale
#   2 = Manifest not found

set -euo pipefail

DOC_FILTER="${1:-}"
JSON_OUTPUT=false

for arg in "$@"; do
  if [[ "$arg" == "--json" ]]; then
    JSON_OUTPUT=true
  fi
done

# Skip doc filter if it looks like a flag
if [[ "$DOC_FILTER" == --* ]]; then
  DOC_FILTER=""
fi

MANIFEST="grimoires/loa/ground-truth/generation-manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  if $JSON_OUTPUT; then
    echo '{"error":"Manifest not found","manifest":"'"$MANIFEST"'"}'
  else
    echo "ERROR: Generation manifest not found at $MANIFEST" >&2
  fi
  exit 2
fi

# ── Check each document in manifest ──
stale_sections_json="["
first_stale=true
total_sections=0
stale_count=0

# Get document list from manifest
doc_count=$(jq '.documents | length' "$MANIFEST" 2>/dev/null || echo "0")

for ((d=0; d<doc_count; d++)); do
  doc_path=$(jq -r ".documents[$d].path" "$MANIFEST" 2>/dev/null)

  # Apply document filter if specified
  if [[ -n "$DOC_FILTER" && "$doc_path" != "$DOC_FILTER" ]]; then
    continue
  fi

  # Get sections for this document
  section_count=$(jq ".documents[$d].sections | length" "$MANIFEST" 2>/dev/null || echo "0")

  for ((s=0; s<section_count; s++)); do
    heading=$(jq -r ".documents[$d].sections[$s].heading" "$MANIFEST" 2>/dev/null)
    stored_hash=$(jq -r ".documents[$d].sections[$s].content_hash" "$MANIFEST" 2>/dev/null)
    stored_staleness_hash=$(jq -r ".documents[$d].sections[$s].staleness_hash // \"\"" "$MANIFEST" 2>/dev/null)
    start_line=$(jq -r ".documents[$d].sections[$s].start_line // 0" "$MANIFEST" 2>/dev/null)
    end_line=$(jq -r ".documents[$d].sections[$s].end_line // 0" "$MANIFEST" 2>/dev/null)
    cite_count=$(jq ".documents[$d].sections[$s].citations | length" "$MANIFEST" 2>/dev/null || echo "0")

    ((total_sections++)) || true

    # Skip sections with no citations (they can't be stale from code changes)
    if [[ "$cite_count" -eq 0 ]]; then
      continue
    fi

    # Check each cited file's current state
    section_stale=false
    changed_files_json="["
    first_changed=true

    for ((c=0; c<cite_count; c++)); do
      cite_path=$(jq -r ".documents[$d].sections[$s].citations[$c].path" "$MANIFEST" 2>/dev/null)

      if [[ ! -f "$cite_path" ]]; then
        # File was deleted — section is definitely stale
        section_stale=true
        if ! $first_changed; then changed_files_json+=","; fi
        first_changed=false
        changed_files_json+="{\"path\":\"$cite_path\",\"reason\":\"deleted\"}"
        continue
      fi

      # Compare current file hash with what it was at generation time
      current_hash=$(git hash-object "$cite_path" 2>/dev/null || echo "unknown")
      stored_file_hash=$(jq -r ".documents[$d].head_sha" "$MANIFEST" 2>/dev/null)

      # Check if the file has changed since the document was generated
      # We use git diff to check if the specific file changed since stored head_sha
      gen_hash=$(git rev-parse "$stored_file_hash:$cite_path" 2>/dev/null || echo "missing")
      cur_hash=$(git hash-object "$cite_path" 2>/dev/null || echo "unknown")

      if [[ "$gen_hash" != "$cur_hash" ]]; then
        section_stale=true
        if ! $first_changed; then changed_files_json+=","; fi
        first_changed=false
        changed_files_json+="{\"path\":\"$cite_path\",\"reason\":\"modified\",\"old_hash\":\"$gen_hash\",\"new_hash\":\"$cur_hash\"}"
      fi
    done

    changed_files_json+="]"

    # Section content staleness: compare staleness_hash (whitespace-normalized)
    # so formatting-only edits (blank lines, trailing spaces) don't trigger staleness
    if [[ -n "$stored_staleness_hash" && -f "$doc_path" && "$start_line" -gt 0 && "$end_line" -gt 0 ]]; then
      current_section=$(sed -n "${start_line},${end_line}p" "$doc_path" 2>/dev/null || echo "")
      current_staleness_hash=$(echo "$current_section" | tr -s '[:space:]' ' ' | git hash-object --stdin 2>/dev/null || echo "unknown")
      if [[ "$current_staleness_hash" != "$stored_staleness_hash" ]]; then
        section_stale=true
        changed_files_json="${changed_files_json%]}"
        if ! $first_changed; then changed_files_json+=","; fi
        first_changed=false
        changed_files_json+="{\"path\":\"$doc_path\",\"reason\":\"content_changed\"}]"
      fi
    fi

    if $section_stale; then
      ((stale_count++)) || true
      if ! $first_stale; then stale_sections_json+=","; fi
      first_stale=false

      stale_entry=$(jq -nc \
        --arg document "$doc_path" \
        --arg heading "$heading" \
        --argjson changed_files "$changed_files_json" \
        '{document: $document, heading: $heading, changed_files: $changed_files}')
      stale_sections_json+="$stale_entry"
    fi
  done
done

stale_sections_json+="]"

if $JSON_OUTPUT; then
  echo "{\"total_sections\":$total_sections,\"stale_count\":$stale_count,\"stale_sections\":$stale_sections_json}" | jq '.' 2>/dev/null || echo "{\"total_sections\":$total_sections,\"stale_count\":$stale_count,\"stale_sections\":$stale_sections_json}"
else
  if [[ $stale_count -eq 0 ]]; then
    echo "No stale sections found ($total_sections sections checked)"
  else
    echo "STALE: $stale_count of $total_sections sections need regeneration"
    echo "$stale_sections_json" | jq -r '.[] | "  [\(.document)] \(.heading): \(.changed_files | map(.path) | join(", "))"' 2>/dev/null || echo "$stale_sections_json"
  fi
fi

if [[ $stale_count -gt 0 ]]; then
  exit 1
else
  exit 0
fi
