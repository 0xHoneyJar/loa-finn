#!/usr/bin/env bash
# verify-citations.sh — Deterministic citation verification for Ground Truth documents
# Implements 5-step checking: EXTRACT → PATH_SAFETY → FILE_EXISTS → LINE_RANGE → EVIDENCE_ANCHOR
#
# v2.0: AST-based evidence anchor resolution using section parser (replaces ±10 line proximity)
#
# Usage: verify-citations.sh <document-path> [--json]
#
# Exit codes:
#   0 = All citations verified
#   1 = One or more citations failed
#   2 = Input file not found or unreadable
#   3 = Path safety violation detected

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOC_PATH="${1:-}"
JSON_OUTPUT=false
QUIET=false

for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    --quiet) QUIET=true ;;
  esac
done

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  if $JSON_OUTPUT; then
    echo '{"error":"Input file not found or unreadable","file":"'"${DOC_PATH:-}"'"}'
  else
    echo "ERROR: Input file not found or unreadable: ${DOC_PATH:-<none>}" >&2
  fi
  exit 2
fi

# ── Step 1: EXTRACT citation patterns with line numbers ──
# Match backtick-wrapped paths: `path/file.ext:NN` or `path/file.ext:NN-MM`
# Also build per-section citation index using the section parser
citations=()
citation_doc_lines=()  # line number in the document where each citation appears
line_num=0

while IFS= read -r line; do
  ((line_num++)) || true
  tmpline="$line"
  while [[ "$tmpline" =~ \`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+:[0-9]+(-[0-9]+)?)\` ]]; do
    citations+=("${BASH_REMATCH[1]}")
    citation_doc_lines+=("$line_num")
    tmpline="${tmpline#*"${BASH_REMATCH[0]}"}"
  done
done < "$DOC_PATH"

total=${#citations[@]}

if [[ $total -eq 0 ]]; then
  if $JSON_OUTPUT; then
    echo '{"file":"'"$DOC_PATH"'","total_citations":0,"verified":0,"failed":0,"failures":[]}'
  else
    echo "No citations found in $DOC_PATH"
  fi
  exit 0
fi

# ── Step 1b: Build section-scoped citation index ──
# Parse sections from document, then map each citation to its containing section
sections_raw=""
if [[ -x "$SCRIPT_DIR/parse-sections.sh" ]]; then
  sections_raw=$("$SCRIPT_DIR/parse-sections.sh" "$DOC_PATH" 2>/dev/null || echo '{"parser_version":"1.0","sections":[]}')
else
  sections_raw='{"parser_version":"1.0","sections":[]}'
fi

# Check parser_version
parser_version=$(echo "$sections_raw" | jq -r '.parser_version // "unknown"' 2>/dev/null || echo "unknown")
if [[ "$parser_version" != "1.0" ]]; then
  echo "WARNING: Unexpected parser_version '$parser_version' (expected 1.0)" >&2
fi

# Extract sections array for consumption
sections_json=$(echo "$sections_raw" | jq '.sections' 2>/dev/null || echo "[]")

# Build associative arrays: citation → section heading, for Step 5 section-scoped lookup
declare -A cite_section_heading  # "citation" → section heading
declare -A section_citations     # "section_heading" → comma-separated citation list

for ((i=0; i<total; i++)); do
  cite="${citations[$i]}"
  doc_line="${citation_doc_lines[$i]}"

  # Find which section this citation belongs to (last section whose start_line <= doc_line)
  section_heading=""
  if [[ "$sections_json" != "[]" ]]; then
    section_heading=$(echo "$sections_json" | jq -r --argjson ln "$doc_line" '
      [.[] | select(.start_line <= $ln)] | last | .heading // ""
    ' 2>/dev/null || echo "")
  fi

  cite_section_heading["$cite"]="$section_heading"

  # Append to section_citations
  if [[ -n "$section_heading" ]]; then
    existing="${section_citations[$section_heading]:-}"
    if [[ -z "$existing" ]]; then
      section_citations["$section_heading"]="$cite"
    else
      section_citations["$section_heading"]="$existing,$cite"
    fi
  fi
done

# ── Results tracking ──
verified=0
failed=0
failures_json="["
first_failure=true
path_safety_violation=false
declare -A cite_actual_lines  # citation → actual lines content for step 5

for citation in "${citations[@]}"; do
  # Parse path and line range
  cite_path="${citation%%:*}"
  line_spec="${citation#*:}"

  if [[ "$line_spec" == *-* ]]; then
    line_start="${line_spec%-*}"
    line_end="${line_spec#*-}"
  else
    line_start="$line_spec"
    line_end="$line_spec"
  fi

  # ── Step 2: PATH_SAFETY ──
  # Reject dangerous paths BEFORE any file read
  check_failed=""

  # Reject paths with ..
  if [[ "$cite_path" == *..* ]]; then
    check_failed="PATH_SAFETY"
    fail_detail="Path contains '..': $cite_path"
    path_safety_violation=true
  fi

  # Reject paths starting with /
  if [[ -z "$check_failed" && "$cite_path" == /* ]]; then
    check_failed="PATH_SAFETY"
    fail_detail="Path starts with '/': $cite_path"
    path_safety_violation=true
  fi

  # Reject paths with control characters or spaces
  if [[ -z "$check_failed" && ! "$cite_path" =~ ^[a-zA-Z0-9_./-]+$ ]]; then
    check_failed="PATH_SAFETY"
    fail_detail="Path contains invalid characters: $cite_path"
    path_safety_violation=true
  fi

  # Require git ls-files exact match (NUL-delimited for safety)
  if [[ -z "$check_failed" ]]; then
    if ! git ls-files -z -- "$cite_path" 2>/dev/null | tr '\0' '\n' | grep -qx "$cite_path"; then
      check_failed="PATH_SAFETY"
      fail_detail="Path not in git index: $cite_path"
    fi
  fi

  # ── Step 3: FILE_EXISTS (defense-in-depth) ──
  if [[ -z "$check_failed" && ! -f "$cite_path" ]]; then
    check_failed="FILE_EXISTS"
    fail_detail="File does not exist: $cite_path"
  fi

  # ── Step 4: LINE_RANGE ──
  actual_lines=""
  if [[ -z "$check_failed" ]]; then
    actual_lines=$(sed -n "${line_start},${line_end}p" "$cite_path" 2>/dev/null || echo "")
    if [[ -z "$actual_lines" ]]; then
      check_failed="LINE_RANGE"
      fail_detail="Lines ${line_start}-${line_end} empty or out of range in $cite_path"
    fi
  fi

  if [[ -n "$check_failed" ]]; then
    ((failed++)) || true
    if ! $first_failure; then
      failures_json+=","
    fi
    first_failure=false

    # Build failure entry with proper JSON escaping via jq
    failure_entry=$(jq -nc \
      --arg citation "$citation" \
      --arg check "$check_failed" \
      --arg detail "$fail_detail" \
      --arg actual_lines "$(echo "$actual_lines" | head -1)" \
      '{citation: $citation, check: $check, detail: $detail, actual_lines: $actual_lines}')
    failures_json+="$failure_entry"
  else
    ((verified++)) || true
    # Store for step 5 evidence anchor verification
    cite_actual_lines["$citation"]="$actual_lines"
  fi
done

# ── Step 5: EVIDENCE_ANCHOR — AST-based section-scoped resolution (v2.0) ──
# For each <!-- evidence: ... --> tag, find its containing section, then locate
# the nearest *preceding* citation within that same section. This replaces the
# ±10 line proximity heuristic that caused the 14-failure regression in cycle-010.
while IFS= read -r anchor_entry; do
  [[ -z "$anchor_entry" ]] && continue
  anchor_line_num="${anchor_entry%%:*}"
  anchor_content="${anchor_entry#*:}"

  # Find which section this anchor belongs to
  anchor_section=""
  if [[ "$sections_json" != "[]" ]]; then
    anchor_section=$(echo "$sections_json" | jq -r --argjson ln "$anchor_line_num" '
      [.[] | select(.start_line <= $ln)] | last | .heading // ""
    ' 2>/dev/null || echo "")
  fi

  # Find the nearest preceding citation within the same section
  nearest=""
  nearest_distance=999999

  for ((i=0; i<total; i++)); do
    cite="${citations[$i]}"
    cite_doc_line="${citation_doc_lines[$i]}"

    # Must be in the same section
    cite_sec="${cite_section_heading[$cite]:-}"
    if [[ "$cite_sec" != "$anchor_section" ]]; then
      continue
    fi

    # Prefer preceding citations (cite_doc_line <= anchor_line_num + small margin)
    # The citation typically appears AFTER the evidence anchor in the paragraph text,
    # so we look for citations that follow the anchor within the same section
    distance=$((cite_doc_line - anchor_line_num))
    abs_distance=${distance#-}  # absolute value

    if [[ $abs_distance -lt $nearest_distance ]]; then
      nearest="$cite"
      nearest_distance=$abs_distance
    fi
  done

  # Fallback: if no section match, try any citation in document (graceful degradation)
  if [[ -z "$nearest" ]]; then
    if ! $QUIET; then
      echo "WARNING: evidence anchor at line $anchor_line_num has no section-scoped citation, falling back to document-wide search" >&2
    fi
    for ((i=0; i<total; i++)); do
      cite="${citations[$i]}"
      cite_doc_line="${citation_doc_lines[$i]}"
      distance=$((cite_doc_line - anchor_line_num))
      abs_distance=${distance#-}
      if [[ $abs_distance -lt $nearest_distance ]]; then
        nearest="$cite"
        nearest_distance=$abs_distance
      fi
    done
  fi

  if [[ -z "$nearest" ]]; then
    continue  # No citation found — check-provenance handles missing citation requirement
  fi

  # Look up the cited lines from our verified cache
  cited_content="${cite_actual_lines[$nearest]:-}"
  if [[ -z "$cited_content" ]]; then
    continue  # Citation wasn't verified (already failed steps 2-4) — skip anchor check
  fi

  # Parse and check symbol= tokens
  anchor_temp="$anchor_content"
  while [[ "$anchor_temp" =~ symbol=([a-zA-Z0-9_]+) ]]; do
    sym="${BASH_REMATCH[1]}"
    if ! echo "$cited_content" | grep -qF "$sym"; then
      ((failed++)) || true
      if ! $first_failure; then
        failures_json+=","
      fi
      first_failure=false
      failure_entry=$(jq -nc \
        --arg citation "$nearest" \
        --arg detail "Symbol [$sym] not found in cited lines" \
        '{citation: $citation, check: "EVIDENCE_ANCHOR", detail: $detail, actual_lines: ""}')
      failures_json+="$failure_entry"
    fi
    anchor_temp="${anchor_temp#*"${BASH_REMATCH[0]}"}"
  done

  # Parse and check literal= tokens
  anchor_temp="$anchor_content"
  while [[ "$anchor_temp" =~ literal=\"([^\"]+)\" ]]; do
    lit="${BASH_REMATCH[1]}"
    if ! echo "$cited_content" | grep -qF "$lit"; then
      ((failed++)) || true
      if ! $first_failure; then
        failures_json+=","
      fi
      first_failure=false
      failure_entry=$(jq -nc \
        --arg citation "$nearest" \
        --arg detail "Literal [$lit] not found in cited lines" \
        '{citation: $citation, check: "EVIDENCE_ANCHOR", detail: $detail, actual_lines: ""}')
      failures_json+="$failure_entry"
    fi
    anchor_temp="${anchor_temp#*"${BASH_REMATCH[0]}"}"
  done
done < <(grep -n '<!-- evidence:' "$DOC_PATH" 2>/dev/null || true)

failures_json+="]"

if $JSON_OUTPUT; then
  echo '{"file":"'"$DOC_PATH"'","total_citations":'"$total"',"verified":'"$verified"',"failed":'"$failed"',"failures":'"$failures_json"'}'
else
  echo "Citations: $total total, $verified verified, $failed failed"
  if [[ $failed -gt 0 ]]; then
    echo "FAILURES:"
    echo "$failures_json" | jq -r '.[] | "  [\(.check)] \(.citation): \(.detail)"' 2>/dev/null || echo "  $failures_json"
  fi
fi

if $path_safety_violation; then
  exit 3
elif [[ $failed -gt 0 ]]; then
  exit 1
else
  exit 0
fi
