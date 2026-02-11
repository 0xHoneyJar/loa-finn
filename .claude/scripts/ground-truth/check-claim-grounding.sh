#!/usr/bin/env bash
# check-claim-grounding.sh — Validate factual claim grounding in Ground Truth documents
# Implements two-tier detection heuristic per SDD §5.2:
#   Tier 1: citation-present (any sentence with file path or symbol anchor)
#   Tier 2: verb-pattern (CODE-FACTUAL sections only)
#
# Usage: check-claim-grounding.sh <document-path> [--json]
#
# Exit codes:
#   0 = All CODE-FACTUAL sections pass claim coverage
#   1 = Ungrounded claims found in CODE-FACTUAL sections
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

# ── Tier 1 patterns: citation targets ──
CITATION_PATTERN='(src/|lib/|app/|\.ts[: ]|\.js[: ]|\.yaml[: ]|\.json[: ]|#[A-Z][a-zA-Z]+)'

# ── Tier 2 patterns: factual-claim verbs ──
VERB_PATTERN='\b(validates|returns|ensures|handles|processes|calls|imports|exports|implements|extends)\b'

# ── Non-claim allowlist ──
EXEMPT_PATTERN='^(See |For more|Refer to|\[.*\]\(|\s*$|#{1,6} |>|```|\s*-\s*\[)'

# ── Scan document ──
# Track whether we're in a CODE-FACTUAL section
in_code_factual=false
in_fence=false
in_comment=false
in_agent_context=false

violations="["
first=true
total_claims=0
grounded_claims=0
ungrounded_claims=0

add_violation() {
  local line_num="$1" message="$2" tier="$3" severity="${4:-error}"
  if ! $first; then violations+=","; fi
  first=false
  violations+='{"line":'"$line_num"',"message":'"$(echo "$message" | jq -Rs .)"',"tier":"'"$tier"'","severity":"'"$severity"'"}'
}

line_num=0
prev_provenance=""

while IFS= read -r line || [[ -n "$line" ]]; do
  ((line_num++)) || true

  # Track code fences
  if [[ "$line" =~ ^'```' ]]; then
    if $in_fence; then
      in_fence=false
    else
      in_fence=true
    fi
    continue
  fi
  $in_fence && continue

  # Track HTML comments
  if [[ "$line" =~ '<!--' ]] && [[ "$line" =~ '-->' ]]; then
    # Single-line comment — check for provenance
    if [[ "$line" =~ 'provenance: CODE-FACTUAL' ]] || [[ "$line" =~ 'provenance-expectation: CODE-FACTUAL' ]]; then
      in_code_factual=true
      prev_provenance="CODE-FACTUAL"
    elif [[ "$line" =~ 'provenance:' ]]; then
      prev_provenance=$(echo "$line" | grep -oP 'provenance:\s*\K[A-Z_-]+' || true)
      # Non-CODE-FACTUAL section
    fi
    # Check for AGENT-CONTEXT
    if [[ "$line" =~ 'AGENT-CONTEXT' ]]; then
      in_agent_context=true
    fi
    continue
  fi
  if [[ "$line" =~ '<!--' ]]; then
    in_comment=true
    if [[ "$line" =~ 'AGENT-CONTEXT' ]]; then
      in_agent_context=true
    fi
    continue
  fi
  if [[ "$line" =~ '-->' ]]; then
    in_comment=false
    in_agent_context=false
    continue
  fi
  $in_comment && continue
  $in_agent_context && continue

  # Track section changes (## headings reset context)
  if [[ "$line" =~ ^'## ' ]]; then
    in_code_factual=false
    prev_provenance=""
    continue
  fi

  # Skip heading lines
  [[ "$line" =~ ^'#' ]] && continue

  # Skip empty lines
  [[ -z "${line// /}" ]] && continue

  # Skip exempt patterns
  if echo "$line" | grep -qE "$EXEMPT_PATTERN" 2>/dev/null; then
    continue
  fi

  # ── Tier 1: Citation-present detection ──
  if echo "$line" | grep -qE "$CITATION_PATTERN" 2>/dev/null; then
    ((total_claims++)) || true
    # Has a citation target — check if provenance exists
    if [[ -n "$prev_provenance" ]]; then
      ((grounded_claims++)) || true
    else
      ((ungrounded_claims++)) || true
      add_violation "$line_num" "Tier 1: Sentence with citation target lacks provenance tag" "tier1" "error"
    fi
    continue
  fi

  # ── Tier 2: Verb-pattern detection (CODE-FACTUAL sections only) ──
  if $in_code_factual; then
    if echo "$line" | grep -qiE "$VERB_PATTERN" 2>/dev/null; then
      ((total_claims++)) || true
      if [[ -n "$prev_provenance" ]]; then
        ((grounded_claims++)) || true
      else
        ((ungrounded_claims++)) || true
        add_violation "$line_num" "Tier 2: Factual-claim verb in CODE-FACTUAL section lacks provenance" "tier2" "error"
      fi
    fi
  elif echo "$line" | grep -qiE "$VERB_PATTERN" 2>/dev/null; then
    # Outside CODE-FACTUAL: advisory only
    if [[ -z "$prev_provenance" ]]; then
      add_violation "$line_num" "Tier 2: Factual-claim verb outside CODE-FACTUAL section (advisory)" "tier2" "warning"
    fi
  fi

done < "$DOC_PATH"

violations+="]"

# ── Count errors ──
error_count=$(echo "$violations" | jq '[.[] | select(.severity == "error")] | length' 2>/dev/null || echo "0")
warning_count=$(echo "$violations" | jq '[.[] | select(.severity == "warning")] | length' 2>/dev/null || echo "0")
passed=true
if [[ "$error_count" -gt 0 ]]; then
  passed=false
fi

# ── Output ──
if $JSON_OUTPUT; then
  echo '{"file":"'"$DOC_PATH"'","passed":'"$passed"',"total_claims":'"$total_claims"',"grounded":'"$grounded_claims"',"ungrounded":'"$ungrounded_claims"',"errors":'"$error_count"',"warnings":'"$warning_count"',"violations":'"$violations"'}'
else
  if $passed; then
    echo "PASS: Claim grounding check ($total_claims claims, $grounded_claims grounded, $warning_count warnings)"
  else
    echo "FAIL: $ungrounded_claims ungrounded claim(s) in CODE-FACTUAL sections"
    echo "$violations" | jq -r '.[] | select(.severity == "error") | "  Line \(.line): \(.message)"' 2>/dev/null || true
  fi
fi

if $passed; then
  exit 0
else
  exit 1
fi
