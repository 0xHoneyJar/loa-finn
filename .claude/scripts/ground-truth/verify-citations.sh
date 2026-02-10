#!/usr/bin/env bash
# verify-citations.sh — Deterministic citation verification for Ground Truth documents
# Implements 5-step checking: EXTRACT → PATH_SAFETY → FILE_EXISTS → LINE_RANGE → EVIDENCE_ANCHOR
#
# Usage: verify-citations.sh <document-path> [--json]
#
# Exit codes:
#   0 = All citations verified
#   1 = One or more citations failed
#   2 = Input file not found or unreadable
#   3 = Path safety violation detected

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
    echo '{"error":"Input file not found or unreadable","file":"'"${DOC_PATH:-}"'"}'
  else
    echo "ERROR: Input file not found or unreadable: ${DOC_PATH:-<none>}" >&2
  fi
  exit 2
fi

# ── Step 1: EXTRACT citation patterns ──
# Match backtick-wrapped paths: `path/file.ext:NN` or `path/file.ext:NN-MM`
citations=()
citation_lines=()

while IFS= read -r line; do
  # Extract all citation patterns from this line
  while [[ "$line" =~ \`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+:[0-9]+(-[0-9]+)?)\` ]]; do
    citations+=("${BASH_REMATCH[1]}")
    # Remove matched citation to find more on same line
    line="${line#*"${BASH_REMATCH[0]}"}"
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

  # ── Step 5: EVIDENCE_ANCHOR (checked separately per paragraph) ──
  # Evidence anchors are validated in check-provenance.sh or quality-gates.sh
  # verify-citations.sh only validates file/line accessibility
  # The EVIDENCE_ANCHOR check runs AFTER all citations are verified reachable

  if [[ -n "$check_failed" ]]; then
    ((failed++)) || true
    if ! $first_failure; then
      failures_json+=","
    fi
    first_failure=false

    # Escape JSON strings
    escaped_detail=$(echo "$fail_detail" | sed 's/"/\\"/g')
    escaped_lines=$(echo "$actual_lines" | head -1 | sed 's/"/\\"/g')

    failures_json+='{"citation":"'"$citation"'","check":"'"$check_failed"'","detail":"'"$escaped_detail"'","actual_lines":"'"$escaped_lines"'"}'
  else
    ((verified++)) || true
    # Store for step 5 evidence anchor verification
    cite_actual_lines["$citation"]="$actual_lines"
  fi
done

# ── Step 5: EVIDENCE_ANCHOR — verify tokens against cited lines ──
# Scan document for <!-- evidence: symbol=X, literal="Y" --> tags.
# For each anchor, find the nearest citation, parse tokens, check against cited lines.
while IFS= read -r anchor_entry; do
  [[ -z "$anchor_entry" ]] && continue
  anchor_line_num="${anchor_entry%%:*}"
  anchor_content="${anchor_entry#*:}"

  # Find nearest citation: search lines around anchor for a backtick citation
  search_start=$((anchor_line_num > 10 ? anchor_line_num - 10 : 1))
  search_end=$((anchor_line_num + 10))
  context=$(sed -n "${search_start},${search_end}p" "$DOC_PATH")

  nearest=""
  while [[ "$context" =~ \`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+:[0-9]+(-[0-9]+)?)\` ]]; do
    nearest="${BASH_REMATCH[1]}"
    context="${context#*"${BASH_REMATCH[0]}"}"
  done

  if [[ -z "$nearest" ]]; then
    continue  # No citation near anchor — check-provenance handles missing citation requirement
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
      escaped_sym=$(echo "$sym" | sed 's/"/\\"/g')
      failures_json+='{"citation":"'"$nearest"'","check":"EVIDENCE_ANCHOR","detail":"Symbol ['"$escaped_sym"'] not found in cited lines","actual_lines":""}'
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
      escaped_lit=$(echo "$lit" | sed 's/"/\\"/g')
      failures_json+='{"citation":"'"$nearest"'","check":"EVIDENCE_ANCHOR","detail":"Literal ['"$escaped_lit"'] not found in cited lines","actual_lines":""}'
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
