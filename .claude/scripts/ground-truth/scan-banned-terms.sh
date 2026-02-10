#!/usr/bin/env bash
# scan-banned-terms.sh — Scan Ground Truth documents for banned superlatives
# Uses awk state machine to strip non-prose content before scanning.
#
# Usage: scan-banned-terms.sh <document-path> [--terms <terms-file>] [--json]
#
# Exit codes:
#   0 = No banned terms found
#   1 = Banned terms found
#   2 = Input file not found or unreadable

set -euo pipefail

DOC_PATH="${1:-}"
TERMS_FILE="grimoires/loa/ground-truth/banned-terms.txt"
JSON_OUTPUT=false

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --terms) TERMS_FILE="$2"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    *) shift ;;
  esac
done

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  if $JSON_OUTPUT; then
    echo '{"error":"Input file not found","file":"'"${DOC_PATH:-}"'"}'
  else
    echo "ERROR: Input file not found: ${DOC_PATH:-<none>}" >&2
  fi
  exit 2
fi

if [[ ! -f "$TERMS_FILE" ]]; then
  if $JSON_OUTPUT; then
    echo '{"error":"Terms file not found","file":"'"$TERMS_FILE"'"}'
  else
    echo "ERROR: Terms file not found: $TERMS_FILE" >&2
  fi
  exit 2
fi

# ── Awk state machine: strip non-prose content ──
# States: NORMAL, IN_FRONTMATTER, IN_FENCE, IN_HTML_COMMENT
# Outputs only NORMAL-state lines (prose to scan)
prose_content=$(awk '
BEGIN { state = "NORMAL"; line_num = 0; fm_count = 0 }
{
  line_num++

  # Frontmatter detection (--- at start of file)
  if (state == "NORMAL" && /^---[[:space:]]*$/) {
    if (line_num <= 1 || fm_count == 0) {
      state = "IN_FRONTMATTER"
      fm_count++
      next
    }
  }
  if (state == "IN_FRONTMATTER" && /^---[[:space:]]*$/) {
    state = "NORMAL"
    next
  }
  if (state == "IN_FRONTMATTER") next

  # Fenced code block detection
  if (state == "NORMAL" && /^```/) {
    state = "IN_FENCE"
    next
  }
  if (state == "IN_FENCE") {
    if (/^```/) state = "NORMAL"
    next
  }

  # HTML comment detection (single-line)
  if (state == "NORMAL" && /<!--.*-->/) {
    # Single-line comment — strip it and print rest
    gsub(/<!--.*-->/, "")
    if (length($0) > 0) print line_num ":" $0
    next
  }

  # HTML comment detection (multi-line start)
  if (state == "NORMAL" && /<!--/) {
    state = "IN_HTML_COMMENT"
    next
  }
  if (state == "IN_HTML_COMMENT") {
    if (/-->/) state = "NORMAL"
    next
  }

  # Blockquote lines — skip
  if (state == "NORMAL" && /^>/) next

  # Normal prose — output with line number
  if (state == "NORMAL") {
    print line_num ":" $0
  }
}' "$DOC_PATH")

# ── Build combined regex from terms file ──
terms_regex=""
while IFS= read -r term || [[ -n "$term" ]]; do
  # Skip empty lines and comments
  [[ -z "$term" || "$term" == \#* ]] && continue
  # Trim whitespace
  term=$(echo "$term" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -z "$term" ]] && continue

  if [[ -n "$terms_regex" ]]; then
    terms_regex+="|"
  fi
  terms_regex+="$term"
done < "$TERMS_FILE"

if [[ -z "$terms_regex" ]]; then
  if $JSON_OUTPUT; then
    echo '{"file":"'"$DOC_PATH"'","found":[],"count":0}'
  else
    echo "No terms to scan for"
  fi
  exit 0
fi

# ── Scan prose for banned terms ──
found_terms="["
first=true
count=0

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  line_num="${line%%:*}"
  line_content="${line#*:}"

  # Case-insensitive match
  matches=$(echo "$line_content" | grep -oiE "$terms_regex" 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    while IFS= read -r match; do
      [[ -z "$match" ]] && continue
      ((count++)) || true
      if ! $first; then
        found_terms+=","
      fi
      first=false
      match_lower=$(echo "$match" | tr '[:upper:]' '[:lower:]')
      term_entry=$(jq -nc \
        --arg term "$match_lower" \
        --argjson line "$line_num" \
        --arg context "$(echo "$line_content" | head -c 200)" \
        '{term: $term, line: $line, context: $context}')
      found_terms+="$term_entry"
    done <<< "$matches"
  fi
done <<< "$prose_content"

found_terms+="]"

if $JSON_OUTPUT; then
  echo '{"file":"'"$DOC_PATH"'","found":'"$found_terms"',"count":'"$count"'}'
else
  if [[ $count -gt 0 ]]; then
    echo "FAIL: $count banned term(s) found"
    echo "$found_terms" | jq -r '.[] | "  Line \(.line): \"\(.term)\" in: \(.context)"' 2>/dev/null || echo "  $found_terms"
  else
    echo "PASS: No banned terms found"
  fi
fi

if [[ $count -gt 0 ]]; then
  exit 1
else
  exit 0
fi
