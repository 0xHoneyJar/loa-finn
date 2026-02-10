#!/usr/bin/env bash
# score-symbol-specificity.sh — TF-IDF symbol specificity scorer for evidence anchors
# Computes approximate TF-IDF for each evidence anchor symbol and flags low-specificity ones.
#
# Usage: score-symbol-specificity.sh <document-path> [--json] [--threshold 0.01]
#
# Exit codes:
#   0 = All symbols above threshold (or no evidence anchors found)
#   1 = One or more symbols below threshold
#   2 = Input file not found

set -euo pipefail

DOC_PATH="${1:-}"
JSON_OUTPUT=false
THRESHOLD="0.01"

shift || true
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    --threshold)
      # Next arg is the threshold value — handled by shift below
      ;;
    *)
      # Check if previous arg was --threshold
      if [[ "${prev_arg:-}" == "--threshold" ]]; then
        THRESHOLD="$arg"
      fi
      ;;
  esac
  prev_arg="$arg"
done

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  echo '{"error":"Input file not found","file":"'"${DOC_PATH:-}"'"}' >&2
  exit 2
fi

# ── Built-in reject list: common JS/TS keywords ──
REJECT_LIST="export const function import return async class interface type let var default from require module extends implements new this static void typeof instanceof delete in of"

is_rejected() {
  local sym="$1"
  for rejected in $REJECT_LIST; do
    if [[ "$sym" == "$rejected" ]]; then
      return 0
    fi
  done
  return 1
}

# ── Extract evidence anchor symbols ──
symbols=()
symbol_citations=()  # parallel array: the citation associated with each symbol

while IFS= read -r anchor_line; do
  [[ -z "$anchor_line" ]] && continue
  line_num="${anchor_line%%:*}"
  content="${anchor_line#*:}"

  # Find associated citation (next line with backtick path)
  citation=""
  # Read up to 5 lines after the anchor to find its citation
  while IFS= read -r next_line; do
    if [[ "$next_line" =~ \`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+:[0-9]+(-[0-9]+)?)\` ]]; then
      citation="${BASH_REMATCH[1]}"
      break
    fi
  done < <(sed -n "$((line_num + 1)),$((line_num + 5))p" "$DOC_PATH")

  # Extract symbol= tokens
  tmp="$content"
  while [[ "$tmp" =~ symbol=([a-zA-Z0-9_]+) ]]; do
    symbols+=("${BASH_REMATCH[1]}")
    symbol_citations+=("$citation")
    tmp="${tmp#*"${BASH_REMATCH[0]}"}"
  done
done < <(grep -n '<!-- evidence:' "$DOC_PATH" 2>/dev/null || true)

total_symbols=${#symbols[@]}

if [[ $total_symbols -eq 0 ]]; then
  if $JSON_OUTPUT; then
    echo '{"file":"'"$DOC_PATH"'","total_symbols":0,"scores":[],"warnings":[]}'
  else
    echo "No evidence anchor symbols found in $DOC_PATH"
  fi
  exit 0
fi

# ── Count total tracked files for IDF ──
total_files=$(git ls-files '*.ts' '*.js' '*.tsx' '*.jsx' '*.py' '*.sh' 2>/dev/null | wc -l)
total_files=$((total_files > 0 ? total_files : 1))

# ── Compute TF-IDF per symbol ──
scores_json="["
warnings_json="["
first_score=true
first_warning=true
has_warnings=false

for ((i=0; i<total_symbols; i++)); do
  sym="${symbols[$i]}"
  citation="${symbol_citations[$i]}"
  cite_path="${citation%%:*}"

  # Check reject list first
  if is_rejected "$sym"; then
    if ! $first_warning; then warnings_json+=","; fi
    first_warning=false
    has_warnings=true
    warnings_json+='{"symbol":"'"$sym"'","citation":"'"$citation"'","reason":"rejected_keyword","score":0,"message":"Common keyword rejected by built-in list"}'

    if ! $first_score; then scores_json+=","; fi
    first_score=false
    scores_json+='{"symbol":"'"$sym"'","citation":"'"$citation"'","tf":0,"idf":0,"tfidf":0,"status":"rejected"}'
    continue
  fi

  # TF: occurrences in cited file / total identifiers in file
  tf=0
  if [[ -n "$cite_path" && -f "$cite_path" ]]; then
    sym_count=$(grep -coF "$sym" "$cite_path" 2>/dev/null || echo "0")
    total_identifiers=$(wc -w < "$cite_path" 2>/dev/null || echo "1")
    total_identifiers=$((total_identifiers > 0 ? total_identifiers : 1))
    # Use awk for floating point
    tf=$(awk "BEGIN { printf \"%.6f\", $sym_count / $total_identifiers }")
  fi

  # IDF: log(total_files / files_containing_symbol)
  files_with_sym=$(git ls-files '*.ts' '*.js' '*.tsx' '*.jsx' '*.py' '*.sh' 2>/dev/null | xargs grep -lF "$sym" 2>/dev/null | wc -l || echo "0")
  files_with_sym=$((files_with_sym > 0 ? files_with_sym : 1))
  idf=$(awk "BEGIN { printf \"%.6f\", log($total_files / $files_with_sym) / log(2) }")

  # TF-IDF
  tfidf=$(awk "BEGIN { printf \"%.6f\", $tf * $idf }")

  # Determine status
  status="pass"
  below=$(awk "BEGIN { print ($tfidf < $THRESHOLD) ? 1 : 0 }")
  if [[ "$below" == "1" ]]; then
    status="warning"
    has_warnings=true
    if ! $first_warning; then warnings_json+=","; fi
    first_warning=false
    warnings_json+='{"symbol":"'"$sym"'","citation":"'"$citation"'","reason":"low_specificity","score":'"$tfidf"',"message":"TF-IDF '"$tfidf"' below threshold '"$THRESHOLD"'"}'
  fi

  if ! $first_score; then scores_json+=","; fi
  first_score=false
  scores_json+='{"symbol":"'"$sym"'","citation":"'"$citation"'","tf":'"$tf"',"idf":'"$idf"',"tfidf":'"$tfidf"',"status":"'"$status"'"}'
done

scores_json+="]"
warnings_json+="]"

if $JSON_OUTPUT; then
  echo '{"file":"'"$DOC_PATH"'","total_symbols":'"$total_symbols"',"threshold":'"$THRESHOLD"',"scores":'"$scores_json"',"warnings":'"$warnings_json"'}'
else
  echo "Symbol Specificity: $total_symbols symbols analyzed (threshold=$THRESHOLD)"
  if $has_warnings; then
    echo "WARNINGS:"
    echo "$warnings_json" | jq -r '.[] | "  [\(.reason)] \(.symbol): \(.message)"' 2>/dev/null || echo "  $warnings_json"
  else
    echo "PASS: All symbols above threshold"
  fi
fi

if $has_warnings; then
  exit 1
else
  exit 0
fi
