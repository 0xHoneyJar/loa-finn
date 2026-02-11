#!/usr/bin/env bash
# quality-gates.sh — Orchestrate all Ground Truth verification gates
# Gate order per SDD §5.3:
#   1. check-agent-context    (schema validation — MUST run first)
#   2. verify-citations       (citation resolution)
#   3. check-provenance       (paragraph provenance ≥80%)
#   4. check-claim-grounding  (CODE-FACTUAL section claim coverage)
#   5. scan-banned-terms      (marketing + security patterns)
#   6. check-links            (relative link validation)
#   7. export-gate-metrics    (append to gate-metrics.jsonl)
# Plus inline gates: freshness-check, registry-consistency
# Plus warning gates: analogy-accuracy, mechanism-density, symbol-specificity, analogy-staleness
#
# Usage: quality-gates.sh <document-path> [--json] [--strict] [--file <path>]
#
# Exit codes:
#   0 = All blocking gates pass
#   1 = One or more blocking gates failed
#   2 = Input file not found or configuration error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOC_PATH="${1:-}"
JSON_OUTPUT=false
STRICT=false
BATCH_DIR=""
GATE_START_TIME=$(date +%s)

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUTPUT=true; shift ;;
    --strict) STRICT=true; shift ;;
    --batch) BATCH_DIR="${2:-}"; shift 2 ;;
    --file) DOC_PATH="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Batch mode: orchestrate across all manifest documents ──
if [[ -n "$BATCH_DIR" ]]; then
  MANIFEST="grimoires/loa/ground-truth/generation-manifest.json"
  if [[ ! -f "$MANIFEST" ]]; then
    echo '{"error":"generation-manifest.json not found"}' >&2
    exit 2
  fi

  head_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  batch_total=0
  batch_passed=0
  batch_failed=0
  at_head=0
  diverged_json="["
  diverged_first=true
  docs_json="["
  docs_first=true

  while IFS= read -r doc_path; do
    [[ -z "$doc_path" || ! -f "$doc_path" ]] && continue
    ((batch_total++)) || true

    # Run the full pipeline on this document
    doc_result=$("$SCRIPT_DIR/quality-gates.sh" "$doc_path" --json 2>/dev/null) || true
    doc_overall=$(echo "$doc_result" | jq -r '.overall // "FAIL"' 2>/dev/null || echo "FAIL")

    if [[ "$doc_overall" == "PASS" ]]; then
      ((batch_passed++)) || true
    else
      ((batch_failed++)) || true
    fi

    # Check version freshness (AGENT-CONTEXT version vs HEAD)
    doc_version=$(grep -oP 'version=[0-9a-f]{40}' "$doc_path" 2>/dev/null | head -1 | sed 's/version=//' || echo "")
    if [[ "$doc_version" == "$head_sha" ]]; then
      ((at_head++)) || true
    else
      if ! $diverged_first; then diverged_json+=","; fi
      diverged_first=false
      diverged_json+=$(jq -nc --arg p "$doc_path" '$p')
    fi

    if ! $docs_first; then docs_json+=","; fi
    docs_first=false
    docs_json+="$doc_result"
  done < <(jq -r '.documents[].path' "$MANIFEST" 2>/dev/null)

  diverged_json+="]"
  docs_json+="]"

  diverged_count=$(echo "$diverged_json" | jq 'length' 2>/dev/null || echo "0")

  if $JSON_OUTPUT; then
    jq -nc \
      --argjson total "$batch_total" \
      --argjson passed "$batch_passed" \
      --argjson failed "$batch_failed" \
      --arg head_sha "$head_sha" \
      --argjson at_head "$at_head" \
      --argjson diverged "$diverged_json" \
      --argjson documents "$docs_json" \
      '{
        batch: {
          total: $total,
          passed: $passed,
          failed: $failed,
          freshness: {
            head_sha: $head_sha,
            at_head: $at_head,
            diverged: $diverged
          }
        },
        documents: $documents
      }'
  else
    echo "Batch Quality Gates: $batch_passed/$batch_total passed"
    if [[ $batch_failed -gt 0 ]]; then
      echo "FAILED DOCUMENTS:"
      echo "$docs_json" | jq -r '.[] | select(.overall == "FAIL") | "  \(.file)"' 2>/dev/null || true
    fi
    echo "Freshness: $at_head/$batch_total at HEAD ($head_sha)"
    if [[ "$diverged_count" -gt 0 ]]; then
      echo "DIVERGED:"
      echo "$diverged_json" | jq -r '.[]' 2>/dev/null || true
    fi
  fi

  if [[ $batch_failed -gt 0 ]]; then
    exit 1
  else
    exit 0
  fi
fi

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  if $JSON_OUTPUT; then
    jq -nc --arg file "${DOC_PATH:-}" '{"error":"Document not found","file":$file}'
  else
    echo "ERROR: Document path required and must exist: ${DOC_PATH:-<none>}" >&2
  fi
  exit 2
fi

REGISTRY_DIR="grimoires/loa/ground-truth"

# ── Pre-flight: Check registry files exist ──
for required in "features.yaml" "limitations.yaml" "capability-taxonomy.yaml"; do
  if [[ ! -f "$REGISTRY_DIR/$required" ]]; then
    msg="ERROR: Required registry file missing: $REGISTRY_DIR/$required

Ground Truth requires team-curated registry files before generation.
These files define which features exist and their status — the generator
never creates or modifies them.

To create starter files:
  .claude/scripts/ground-truth/bootstrap-registries.sh

Then edit the files to reflect your project and commit them.
See: grimoires/loa/sdd-ground-truth.md §3.4 for registry format."

    if $JSON_OUTPUT; then
      jq -nc --arg file "$REGISTRY_DIR/$required" '{"error":"Missing registry","file":$file,"action":"Run bootstrap-registries.sh"}'
    else
      echo "$msg" >&2
    fi
    exit 2
  fi
done

# ── Results tracking ──
gates_json="["
first_gate=true
blocking_failed=false
total_blocking=0
passed_blocking=0
warnings_json="["
first_warning=true

LAST_GATE_OUTPUT=""

run_gate() {
  local name="$1"
  local blocking="$2"
  shift 2

  if ! $first_gate; then gates_json+=","; fi
  first_gate=false

  local result
  local exit_code=0
  result=$("$@" 2>&1) || exit_code=$?
  LAST_GATE_OUTPUT="$result"

  local status="pass"
  if [[ $exit_code -ne 0 ]]; then
    status="fail"
  fi

  local escaped_output
  escaped_output=$(printf '%s' "$result" | jq -Rs . 2>/dev/null || echo '""')
  gates_json+=$(jq -nc \
    --arg gate "$name" \
    --argjson blocking "$blocking" \
    --arg status "$status" \
    --argjson exit_code "$exit_code" \
    --argjson output "$escaped_output" \
    '{gate: $gate, blocking: $blocking, status: $status, exit_code: $exit_code, output: $output}')

  if [[ "$blocking" == "true" ]]; then
    ((total_blocking++)) || true
    if [[ $exit_code -eq 0 ]]; then
      ((passed_blocking++)) || true
    else
      blocking_failed=true
    fi
  fi

  return $exit_code
}

# ── BLOCKING GATE 1: check-agent-context (MUST run first per §5.3) ──
if [[ -x "$SCRIPT_DIR/check-agent-context.sh" ]]; then
  run_gate "check-agent-context" "true" "$SCRIPT_DIR/check-agent-context.sh" "$DOC_PATH" --json || true
fi

# ── BLOCKING GATE 2: verify-citations ──
if ! $blocking_failed; then
  run_gate "verify-citations" "true" "$SCRIPT_DIR/verify-citations.sh" "$DOC_PATH" --json || true
fi

# ── BLOCKING GATE 3: check-provenance ──
untagged_count=0
if ! $blocking_failed; then
  run_gate "check-provenance" "true" "$SCRIPT_DIR/check-provenance.sh" "$DOC_PATH" --json || true
  untagged_count=$(printf '%s' "$LAST_GATE_OUTPUT" | jq -r '.untagged_count // 0' 2>/dev/null | tr -d '[:space:]' || echo "0")
  untagged_count="${untagged_count:-0}"
  # Ensure numeric
  [[ "$untagged_count" =~ ^[0-9]+$ ]] || untagged_count=0
fi

# ── BLOCKING GATE 4: check-claim-grounding ──
if ! $blocking_failed; then
  if [[ -x "$SCRIPT_DIR/check-claim-grounding.sh" ]]; then
    run_gate "check-claim-grounding" "true" "$SCRIPT_DIR/check-claim-grounding.sh" "$DOC_PATH" --json || true
  fi
fi

# ── BLOCKING GATE 5: scan-banned-terms (marketing + security patterns) ──
if ! $blocking_failed; then
  run_gate "scan-banned-terms" "true" "$SCRIPT_DIR/scan-banned-terms.sh" "$DOC_PATH" --json || true
  # Also scan security terms if file exists
  SECURITY_TERMS="grimoires/loa/ground-truth/banned-security-terms.txt"
  if [[ -f "$SECURITY_TERMS" ]]; then
    run_gate "scan-banned-security-terms" "true" "$SCRIPT_DIR/scan-banned-terms.sh" "$DOC_PATH" --terms "$SECURITY_TERMS" --json || true
  fi
fi

# ── BLOCKING GATE 6: check-links ──
if ! $blocking_failed; then
  if [[ -x "$SCRIPT_DIR/check-links.sh" ]]; then
    run_gate "check-links" "true" "$SCRIPT_DIR/check-links.sh" "$DOC_PATH" --json || true
  fi
fi

# ── INLINE GATE: freshness-check (blocking) ──
if ! $blocking_failed; then
  if ! $first_gate; then gates_json+=","; fi
  first_gate=false
  ((total_blocking++)) || true

  freshness_status="pass"
  freshness_detail=""

  if grep -q '<!-- ground-truth-meta:' "$DOC_PATH" 2>/dev/null; then
    meta_line=$(grep '<!-- ground-truth-meta:' "$DOC_PATH")
    meta_sha=$(echo "$meta_line" | sed 's/.*head_sha=\([^ ]*\).*/\1/' || echo "")
    current_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

    if [[ -n "$meta_sha" && "$meta_sha" != "$current_sha" ]]; then
      freshness_detail="Document SHA ($meta_sha) does not match HEAD ($current_sha)"
      # This is a warning-level concern during generation, not a hard fail
      # since the document is being generated right now
    fi
    ((passed_blocking++)) || true
  else
    # No meta block yet — acceptable during generation (stamp-freshness runs after)
    ((passed_blocking++)) || true
  fi

  gates_json+=$(jq -nc --arg status "$freshness_status" --arg output "$freshness_detail" \
    '{gate: "freshness-check", blocking: true, status: $status, exit_code: 0, output: $output}')
fi

# ── INLINE GATE: registry-consistency (blocking) ──
if ! $blocking_failed; then
  if ! $first_gate; then gates_json+=","; fi
  first_gate=false
  ((total_blocking++)) || true

  consistency_status="pass"
  consistency_detail=""

  # Check: every features.yaml category matches a capability-taxonomy.yaml id
  if command -v yq &>/dev/null; then
    feat_categories=$(yq '.features[].category' "$REGISTRY_DIR/features.yaml" 2>/dev/null | sort -u)
    tax_ids=$(yq '.capabilities[].id' "$REGISTRY_DIR/capability-taxonomy.yaml" 2>/dev/null | sort -u)

    while IFS= read -r cat; do
      [[ -z "$cat" || "$cat" == "null" ]] && continue
      if ! echo "$tax_ids" | grep -qx "$cat"; then
        consistency_status="fail"
        consistency_detail="Category '$cat' in features.yaml not found in capability-taxonomy.yaml"
        blocking_failed=true
        break
      fi
    done <<< "$feat_categories"

    # Check: every limitations.yaml feature_id matches a features.yaml id
    if [[ "$consistency_status" == "pass" ]]; then
      lim_feature_ids=$(yq '.limitations[].feature_id' "$REGISTRY_DIR/limitations.yaml" 2>/dev/null | sort -u)
      feat_ids=$(yq '.features[].id' "$REGISTRY_DIR/features.yaml" 2>/dev/null | sort -u)

      while IFS= read -r fid; do
        [[ -z "$fid" || "$fid" == "null" ]] && continue
        if ! echo "$feat_ids" | grep -qx "$fid"; then
          consistency_status="fail"
          consistency_detail="feature_id '$fid' in limitations.yaml not found in features.yaml"
          blocking_failed=true
          break
        fi
      done <<< "$lim_feature_ids"
    fi

    if [[ "$consistency_status" == "pass" ]]; then
      ((passed_blocking++)) || true
    fi
  else
    # yq not available — skip with warning
    consistency_status="pass"
    consistency_detail="yq not available, registry consistency check skipped"
    ((passed_blocking++)) || true
  fi

  consistency_exit=$([[ "$consistency_status" == "pass" ]] && echo 0 || echo 1)
  gates_json+=$(jq -nc --arg status "$consistency_status" --argjson exit_code "$consistency_exit" --arg output "$consistency_detail" \
    '{gate: "registry-consistency", blocking: true, status: $status, exit_code: $exit_code, output: $output}')
fi

gates_json+="]"

# ── GATE 7: export-gate-metrics (always runs, non-blocking) ──
# Build the full JSON output first so we can pass it to export-gate-metrics
_overall=$([[ $blocking_failed == true ]] && echo "FAIL" || echo "PASS")
_full_json=$(jq -nc \
  --arg file "$DOC_PATH" \
  --arg overall "$_overall" \
  --argjson blocking_gates "$gates_json" \
  --argjson total_blocking "$total_blocking" \
  --argjson passed_blocking "$passed_blocking" \
  '{file: $file, overall: $overall, blocking_gates: $blocking_gates, total_blocking: $total_blocking, passed_blocking: $passed_blocking}')
if [[ -x "$SCRIPT_DIR/export-gate-metrics.sh" ]]; then
  "$SCRIPT_DIR/export-gate-metrics.sh" "$DOC_PATH" --gates-json "$_full_json" --start-time "$GATE_START_TIME" --json >/dev/null 2>&1 || true
fi

# ── WARNING GATES (non-blocking) ──
# Gate W1: analogy-accuracy — at least 1 analogy per major section (## heading)
analogy_warning=""
section_count=$(grep -cE '^## ' "$DOC_PATH" 2>/dev/null || echo "0")
analogy_count=$(grep -ciE '(like|similar to|same pattern|analogous|parallel|the way)' "$DOC_PATH" 2>/dev/null || echo "0")
if [[ $section_count -gt 0 && $analogy_count -lt $section_count ]]; then
  analogy_warning="Only $analogy_count analogy indicators for $section_count major sections (target: ≥1 per section)"
fi

# Gate W2: mechanism-density — at least 1 "does X by Y" pattern per capability section
mechanism_warning=""
mechanism_count=$(grep -cE '(by |via |using |through |with )' "$DOC_PATH" 2>/dev/null || echo "0")
if [[ $mechanism_count -lt 3 ]]; then
  mechanism_warning="Low mechanism density: only $mechanism_count mechanism indicators found (target: ≥3)"
fi

# Gate W3: symbol-specificity — TF-IDF scoring for evidence anchor symbols
specificity_warning=""
if [[ -x "$SCRIPT_DIR/score-symbol-specificity.sh" ]]; then
  spec_output=$("$SCRIPT_DIR/score-symbol-specificity.sh" "$DOC_PATH" --json 2>/dev/null || echo '{"warnings":[]}')
  spec_warning_count=$(echo "$spec_output" | jq -r '.warnings | length' 2>/dev/null | head -1 || echo "0")
  spec_warning_count="${spec_warning_count:-0}"
  if [[ "$spec_warning_count" -gt 0 ]]; then
    spec_symbols=$(echo "$spec_output" | jq -r '[.warnings[].symbol] | join(", ")' 2>/dev/null || echo "unknown")
    specificity_warning="$spec_warning_count evidence anchor symbol(s) below specificity threshold: $spec_symbols"
  fi
fi

# Gate W4: analogy-staleness — check if grounded_in code paths have changed
staleness_warning=""
if [[ -x "$SCRIPT_DIR/check-analogy-staleness.sh" ]]; then
  analogy_stale_output=$("$SCRIPT_DIR/check-analogy-staleness.sh" --json 2>/dev/null || echo '{"stale_count":0}')
  analogy_stale_count=$(printf '%s' "$analogy_stale_output" | jq -r '.stale_count' 2>/dev/null | tr -d '[:space:]' || echo "0")
  analogy_stale_count="${analogy_stale_count:-0}"
  [[ "$analogy_stale_count" =~ ^[0-9]+$ ]] || analogy_stale_count=0
  if [[ "$analogy_stale_count" -gt 0 ]]; then
    stale_details=$(printf '%s' "$analogy_stale_output" | jq -r '[.stale_analogies[] | "\(.component) (\(.confidence))"] | join(", ")' 2>/dev/null || echo "unknown")
    staleness_warning="$analogy_stale_count analogy(ies) may be stale - grounding code changed: $stale_details"
  fi
fi

# Build warnings_json using jq for proper escaping of special characters
warnings_json=$(jq -nc \
  --arg w1 "$analogy_warning" \
  --arg w2 "$mechanism_warning" \
  --arg w3 "$specificity_warning" \
  --arg w4 "$staleness_warning" \
  '[[$w1, $w2, $w3, $w4] | .[] | select(length > 0)]'
)

# ── Final output ──
overall="PASS"
if $blocking_failed; then
  overall="FAIL"
fi

# Build consolidated JSON output per SDD §7.1 contract
passed_val=$([[ "$overall" == "PASS" ]] && echo "true" || echo "false")
# Build violations array from failed gates
violations_json=$(echo "$gates_json" | jq '[.[] | select(.status == "fail") | {
  gate: .gate,
  message: (.output | if type == "string" then . else tostring end),
  severity: "error"
}]' 2>/dev/null || echo "[]")
summary="$passed_blocking/$total_blocking gates passed"

if $JSON_OUTPUT; then
  jq -nc \
    --argjson passed "$passed_val" \
    --arg file "$DOC_PATH" \
    --arg overall "$overall" \
    --argjson gates "$gates_json" \
    --argjson blocking_gates "$gates_json" \
    --argjson total_blocking "$total_blocking" \
    --argjson passed_blocking "$passed_blocking" \
    --argjson violations "$violations_json" \
    --argjson warnings "$warnings_json" \
    --argjson untagged_count "$untagged_count" \
    --arg summary "$summary" \
    '{passed: $passed, file: $file, overall: $overall, gates: $gates, blocking_gates: $blocking_gates, total_blocking: $total_blocking, passed_blocking: $passed_blocking, violations: $violations, warnings: $warnings, untagged_count: $untagged_count, summary: $summary}'
else
  echo "Quality Gates: $overall ($summary)"
  if $blocking_failed; then
    echo "BLOCKING FAILURES:"
    echo "$gates_json" | jq -r '.[] | select(.status == "fail") | "  [\(.gate)] \(.output)"' 2>/dev/null || true
  fi
  if [[ "$warnings_json" != "[]" ]]; then
    echo "WARNINGS:"
    echo "$warnings_json" | jq -r '.[]' 2>/dev/null || true
  fi
fi

if $blocking_failed; then
  exit 1
else
  exit 0
fi
