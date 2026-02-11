#!/usr/bin/env bash
# check-provenance.sh — Validate provenance tags in Ground Truth documents
# Uses awk state machine for paragraph detection, then validates per-class citation rules.
#
# Usage: check-provenance.sh <document-path> [--json]
#
# Exit codes:
#   0 = All provenance checks pass
#   1 = Provenance checks failed
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
  if $JSON_OUTPUT; then
    echo '{"error":"Input file not found","file":"'"${DOC_PATH:-}"'"}'
  else
    echo "ERROR: Input file not found: ${DOC_PATH:-<none>}" >&2
  fi
  exit 2
fi

# ── Awk state machine: detect paragraphs and their provenance tags ──
# Output format: TAGGED|UNTAGGED|CHECK_FAIL <line_num> <class> <detail>
analysis=$(awk '
BEGIN {
  state = "NORMAL"
  fm_count = 0
  in_paragraph = 0
  para_start = 0
  pending_tag = ""
  pending_tag_class = ""
  para_first_line = ""
  current_section = ""
  total_paragraphs = 0
  tagged_paragraphs = 0
}

function emit_paragraph(start, tag_class,    preview) {
  total_paragraphs++
  if (tag_class != "") {
    tagged_paragraphs++
    print "TAGGED " start " " tag_class
  } else {
    preview = para_first_line
    gsub(/"/, "\\\"", preview)
    if (length(preview) > 80) preview = substr(preview, 1, 80)
    sec = current_section
    gsub(/"/, "\\\"", sec)
    print "UNTAGGED " start " NONE " sec "\t" preview
  }
}

{
  # ── State transitions ──

  # Frontmatter
  if (state == "NORMAL" && /^---[[:space:]]*$/ && (NR <= 1 || fm_count == 0)) {
    if (in_paragraph) { emit_paragraph(para_start, pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
    state = "IN_FRONTMATTER"; fm_count++; next
  }
  if (state == "IN_FRONTMATTER") { if (/^---[[:space:]]*$/) state = "NORMAL"; next }

  # Fenced code blocks
  if (state == "NORMAL" && /^```/) {
    if (in_paragraph) { emit_paragraph(para_start, pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
    state = "IN_FENCE"; next
  }
  if (state == "IN_FENCE") { if (/^```/) state = "NORMAL"; next }

  # Multi-line HTML comments
  if (state == "NORMAL" && /<!--/ && !/-->/) {
    # Check for provenance tag (mawk-compatible: no 3-arg match)
    # Accepts optional subclassification: <!-- provenance: INFERRED (architectural) -->
    if (match($0, /<!-- provenance: [A-Z_-]+/)) {
      tmp = substr($0, RSTART, RLENGTH)
      sub(/<!-- provenance: /, "", tmp)
      sub(/ .*/, "", tmp)  # Strip any qualifier after class name
      pending_tag_class = tmp
    }
    state = "IN_HTML_COMMENT"; next
  }
  if (state == "IN_HTML_COMMENT") { if (/-->/) state = "NORMAL"; next }

  # Single-line HTML comments (provenance tags or evidence anchors)
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
      if (in_paragraph) { emit_paragraph(para_start, pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
      current_section = $0
      sub(/^#+[[:space:]]+/, "", current_section)
      next
    }
    # Table rows
    if (/^\|/) {
      if (in_paragraph) { emit_paragraph(para_start, pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
      next
    }
    # Blockquotes
    if (/^>/) {
      if (in_paragraph) { emit_paragraph(para_start, pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
      next
    }
    # Blank lines end paragraphs
    if (/^[[:space:]]*$/) {
      if (in_paragraph) { emit_paragraph(para_start, pending_tag_class); in_paragraph = 0; pending_tag_class = "" }
      next
    }
    # Non-blank, non-control line = paragraph content
    if (!in_paragraph) {
      in_paragraph = 1
      para_start = NR
      para_first_line = $0
    }
  }
}

END {
  if (in_paragraph) emit_paragraph(para_start, pending_tag_class)
  print "SUMMARY " total_paragraphs " " tagged_paragraphs
}' "$DOC_PATH")

# ── Parse analysis results ──
total_paragraphs=0
tagged_paragraphs=0
failures_json="["
first_failure=true
fail_count=0
untagged_json="["
first_untagged=true

while IFS= read -r line; do
  type="${line%% *}"
  rest="${line#* }"

  if [[ "$type" == "SUMMARY" ]]; then
    total_paragraphs="${rest%% *}"
    tagged_paragraphs="${rest#* }"
    continue
  fi

  line_num="${rest%% *}"
  tag_class="${rest#* }"
  tag_class="${tag_class%% *}"

  if [[ "$type" == "UNTAGGED" ]]; then
    ((fail_count++)) || true
    if ! $first_failure; then failures_json+=","; fi
    first_failure=false
    failures_json+='{"check":"TAG_COVERAGE","line":'"$line_num"',"detail":"Paragraph missing provenance tag"}'

    # Build untagged_paragraphs entry with section and preview
    # Format from awk: UNTAGGED <line> NONE <section>\t<preview>
    untagged_detail="${rest#* }"       # strip line_num
    untagged_detail="${untagged_detail#* }"  # strip "NONE"
    untagged_section="${untagged_detail%%	*}"
    untagged_preview="${untagged_detail#*	}"
    if [[ "$untagged_section" == "$untagged_preview" ]]; then
      # No tab separator — no section context
      untagged_section=""
    fi
    if ! $first_untagged; then untagged_json+=","; fi
    first_untagged=false
    untagged_entry=$(jq -nc \
      --argjson line "$line_num" \
      --arg preview "$untagged_preview" \
      --arg section "$untagged_section" \
      '{line: $line, preview: $preview, section: $section}')
    untagged_json+="$untagged_entry"
  fi

  if [[ "$type" == "TAGGED" ]]; then
    # Read the paragraph content to check class-specific rules
    # Get a few lines starting from para_start
    para_content=$(sed -n "${line_num},$((line_num + 10))p" "$DOC_PATH" | head -5)

    case "$tag_class" in
      CODE-FACTUAL)
        # Must contain a backtick file:line citation
        if ! echo "$para_content" | grep -qE '`[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+:[0-9]+'; then
          ((fail_count++)) || true
          if ! $first_failure; then failures_json+=","; fi
          first_failure=false
          failures_json+='{"check":"CODE_FACTUAL_CITATION","line":'"$line_num"',"class":"CODE-FACTUAL","detail":"CODE-FACTUAL paragraph missing file:line citation"}'
        fi
        ;;
      HYPOTHESIS)
        # Must start with epistemic marker
        first_line=$(echo "$para_content" | head -1)
        if ! echo "$first_line" | grep -qiE '(we hypothesize|we are exploring|we believe|early evidence suggests|it is plausible)'; then
          ((fail_count++)) || true
          if ! $first_failure; then failures_json+=","; fi
          first_failure=false
          failures_json+='{"check":"HYPOTHESIS_MARKER","line":'"$line_num"',"class":"HYPOTHESIS","detail":"HYPOTHESIS paragraph missing epistemic marker prefix"}'
        fi
        ;;
      EXTERNAL-REFERENCE)
        # Must contain URL or paper reference
        if ! echo "$para_content" | grep -qE '(https?://|http://|\([A-Z][a-z]+,?\s+[0-9]{4}\))'; then
          ((fail_count++)) || true
          if ! $first_failure; then failures_json+=","; fi
          first_failure=false
          failures_json+='{"check":"EXTERNAL_REFERENCE_CITATION","line":'"$line_num"',"class":"EXTERNAL-REFERENCE","detail":"EXTERNAL-REFERENCE paragraph missing URL or paper reference"}'
        fi
        ;;
      DERIVED)
        # Must contain ≥2 backtick file:line citations OR a script reference
        citation_count=$(echo "$para_content" | grep -oE '`[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+:[0-9]+' | wc -l)
        has_script_ref=$(echo "$para_content" | grep -qE '`(provenance-stats\.sh|extract-doc-deps\.sh|quality-gates\.sh|generation-manifest\.json|verify-citations\.sh|check-provenance\.sh)`' && echo "yes" || echo "no")
        if [[ $citation_count -lt 2 && "$has_script_ref" != "yes" ]]; then
          ((fail_count++)) || true
          if ! $first_failure; then failures_json+=","; fi
          first_failure=false
          failures_json+='{"check":"DERIVED_MULTI_CITATION","line":'"$line_num"',"class":"DERIVED","detail":"DERIVED paragraph requires ≥2 file:line citations or a computation script reference"}'
        fi
        ;;
    esac
  fi
done <<< "$analysis"

failures_json+="]"
untagged_json+="]"
untagged_count=$(echo "$untagged_json" | jq 'length' 2>/dev/null || echo "0")

# ── Calculate coverage ──
if [[ $total_paragraphs -gt 0 ]]; then
  coverage_pct=$((tagged_paragraphs * 100 / total_paragraphs))
else
  coverage_pct=100
fi

# TAG_COVERAGE gate: ≥95%
coverage_pass=true
if [[ $coverage_pct -lt 95 ]]; then
  coverage_pass=false
fi

overall_pass=true
if [[ "$coverage_pass" == "false" || $fail_count -gt 0 ]]; then
  overall_pass=false
fi

if $JSON_OUTPUT; then
  echo '{"file":"'"$DOC_PATH"'","total_paragraphs":'"$total_paragraphs"',"tagged_paragraphs":'"$tagged_paragraphs"',"coverage_pct":'"$coverage_pct"',"coverage_pass":'"$coverage_pass"',"failures":'"$failures_json"',"fail_count":'"$fail_count"',"untagged_count":'"$untagged_count"',"untagged_paragraphs":'"$untagged_json"'}'
else
  echo "Provenance: $tagged_paragraphs/$total_paragraphs paragraphs tagged ($coverage_pct%)"
  if [[ "$overall_pass" == "true" ]]; then
    echo "PASS: All provenance checks pass"
  else
    echo "FAIL: $fail_count provenance issue(s)"
    echo "$failures_json" | jq -r '.[] | "  [\(.check)] Line \(.line): \(.detail)"' 2>/dev/null || echo "  $failures_json"
  fi
fi

if [[ "$overall_pass" == "true" ]]; then
  exit 0
else
  exit 1
fi
