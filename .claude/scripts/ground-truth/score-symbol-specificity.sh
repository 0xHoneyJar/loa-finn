#!/usr/bin/env bash
# score-symbol-specificity.sh — TF-IDF symbol specificity scorer for evidence anchors
# Computes approximate TF-IDF for each evidence anchor symbol and flags low-specificity ones.
#
# TF calculation: word-boundary occurrences / total identifiers (C-style names) in cited file
# IDF calculation: log2(total_src_files / files_containing_symbol), scoped to src/ paths
# Word-boundary matching uses portable awk (no grep -P dependency) to prevent
# substring false positives (e.g., WAL matching WALManager).
#
# Threshold: 0.01 (default). Calibrated against cycle-011 generated documents.
# With identifier-count denominator (vs wc -w), TF is ~2x higher for real symbols.
# With src-only corpus, IDF is higher for project-specific symbols. Net effect:
# TF-IDF scores shift upward, so 0.01 remains a conservative threshold.
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

# ── Count total tracked files for IDF (src/ only — exclude test files, fixtures, config) ──
total_files=$(git ls-files 'src/**/*.ts' 'src/**/*.js' 'src/**/*.tsx' 'src/**/*.jsx' 'src/**/*.py' 'src/**/*.sh' 2>/dev/null | wc -l)
# Fallback: if no src/ files found, use all tracked source files (non-src repos)
if [[ "$total_files" -eq 0 ]]; then
  total_files=$(git ls-files '*.ts' '*.js' '*.tsx' '*.jsx' '*.py' '*.sh' 2>/dev/null | wc -l)
fi
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
    warn_entry=$(jq -nc --arg symbol "$sym" --arg citation "$citation" \
      '{symbol: $symbol, citation: $citation, reason: "rejected_keyword", score: 0, message: "Common keyword rejected by built-in list"}')
    warnings_json+="$warn_entry"

    if ! $first_score; then scores_json+=","; fi
    first_score=false
    score_entry=$(jq -nc --arg symbol "$sym" --arg citation "$citation" \
      '{symbol: $symbol, citation: $citation, tf: 0, idf: 0, tfidf: 0, status: "rejected"}')
    scores_json+="$score_entry"
    continue
  fi

  # TF: word-boundary occurrences in cited file / total identifiers in file
  # Uses awk for portable word-boundary matching (no grep -P dependency)
  tf=0
  if [[ -n "$cite_path" && -f "$cite_path" ]]; then
    # Count exact word-boundary matches (prevents WAL matching WALManager)
    sym_count=$(awk -v sym="$sym" '{
      s = $0
      while ((i = index(s, sym)) > 0) {
        pre = (i > 1) ? substr(s, i-1, 1) : ""
        post_pos = i + length(sym)
        post = (post_pos <= length(s)) ? substr(s, post_pos, 1) : ""
        if ((pre == "" || pre !~ /[a-zA-Z0-9_]/) && (post == "" || post !~ /[a-zA-Z0-9_]/))
          c++
        s = substr(s, i + length(sym))
      }
    } END { print c+0 }' "$cite_path" 2>/dev/null || echo "0")
    # Count identifiers (C-style names) instead of raw word count
    total_identifiers=$(awk '{
      while (match($0, /[a-zA-Z_][a-zA-Z0-9_]*/)) {
        c++
        $0 = substr($0, RSTART + RLENGTH)
      }
    } END { print c+0 }' "$cite_path" 2>/dev/null || echo "1")
    total_identifiers=$((total_identifiers > 0 ? total_identifiers : 1))
    tf=$(awk "BEGIN { printf \"%.6f\", $sym_count / $total_identifiers }")
  fi

  # IDF: log(total_files / files_containing_symbol) — src/ scoped, word-boundary match
  files_with_sym=$(git ls-files 'src/**/*.ts' 'src/**/*.js' 'src/**/*.tsx' 'src/**/*.jsx' 'src/**/*.py' 'src/**/*.sh' 2>/dev/null | xargs grep -lw "$sym" 2>/dev/null | wc -l || echo "0")
  # Fallback: if no src/ files, use all tracked files
  if [[ "$files_with_sym" -eq 0 ]]; then
    files_with_sym=$(git ls-files '*.ts' '*.js' '*.tsx' '*.jsx' '*.py' '*.sh' 2>/dev/null | xargs grep -lw "$sym" 2>/dev/null | wc -l || echo "0")
  fi
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
    warn_entry=$(jq -nc --arg symbol "$sym" --arg citation "$citation" \
      --argjson score "$tfidf" --arg message "TF-IDF $tfidf below threshold $THRESHOLD" \
      '{symbol: $symbol, citation: $citation, reason: "low_specificity", score: $score, message: $message}')
    warnings_json+="$warn_entry"
  fi

  if ! $first_score; then scores_json+=","; fi
  first_score=false
  score_entry=$(jq -nc --arg symbol "$sym" --arg citation "$citation" \
    --argjson tf "$tf" --argjson idf "$idf" --argjson tfidf "$tfidf" --arg status "$status" \
    '{symbol: $symbol, citation: $citation, tf: $tf, idf: $idf, tfidf: $tfidf, status: $status}')
  scores_json+="$score_entry"
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
