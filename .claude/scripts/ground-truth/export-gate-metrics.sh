#!/usr/bin/env bash
# export-gate-metrics.sh — Append per-document gate results to gate-metrics.jsonl
# Called last in the gate pipeline by quality-gates.sh. Receives gate results
# as input and appends a JSONL line per SDD §5.4 schema.
#
# Two modes:
#   1. Pipeline mode (preferred): --gates-json receives results from quality-gates.sh
#   2. Standalone mode (legacy): re-runs quality-gates.sh to collect results
#
# Usage: export-gate-metrics.sh <document-path> [--gates-json <json>] [--model <model>] [--repairs <N>] [--json]
#
# Exit codes:
#   0 = Metrics exported successfully
#   1 = Error (missing document, jq failure)
#   2 = Invalid arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOC_PATH="${1:-}"
MODEL="unknown"
GENERATOR_MODEL=""
REPAIRS=0
JSON_OUTPUT=false
GATES_JSON=""
START_TIME="${GATE_START_TIME:-}"

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUTPUT=true; shift ;;
    --model) MODEL="${2:-unknown}"; shift 2 ;;
    --repairs) REPAIRS="${2:-0}"; shift 2 ;;
    --gates-json) GATES_JSON="$2"; shift 2 ;;
    --start-time) START_TIME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

GENERATOR_MODEL="${MODEL}"

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  echo '{"error":"Document path required and must exist"}' >&2
  exit 2
fi

METRICS_FILE="grimoires/loa/ground-truth/gate-metrics.jsonl"
mkdir -p "$(dirname "$METRICS_FILE")"

# ── Collect gate results ──
if [[ -n "$GATES_JSON" ]]; then
  # Pipeline mode: use provided gate results
  gate_output="$GATES_JSON"
else
  # Standalone mode: re-run quality-gates.sh
  gate_output=$("$SCRIPT_DIR/quality-gates.sh" "$DOC_PATH" --json 2>/dev/null) || true
fi

# Parse gate results
overall=$(echo "$gate_output" | jq -r '.overall // "unknown"' 2>/dev/null || echo "unknown")
total_blocking=$(echo "$gate_output" | jq -r '.total_blocking // 0' 2>/dev/null || echo "0")
passed_blocking=$(echo "$gate_output" | jq -r '.passed_blocking // 0' 2>/dev/null || echo "0")
warnings=$(echo "$gate_output" | jq -r '.warnings | length // 0' 2>/dev/null || echo "0")
untagged_count=$(echo "$gate_output" | jq -r '.untagged_count // 0' 2>/dev/null || echo "0")

# Extract per-gate pass/fail for legacy format
gate_results=$(echo "$gate_output" | jq '[.blocking_gates[]? | {gate: .gate, status: .status}]' 2>/dev/null || echo "[]")

# Build §5.4 details map: {"gate-name": "pass/fail", ...}
details=$(echo "$gate_output" | jq 'reduce (.blocking_gates[]? // empty) as $g ({}; . + {($g.gate): $g.status})' 2>/dev/null || echo "{}")

# Count gates for §5.4 schema
gates_passed=$(echo "$gate_output" | jq '[.blocking_gates[]? | select(.status == "pass")] | length' 2>/dev/null || echo "$passed_blocking")
gates_failed=$(echo "$gate_output" | jq '[.blocking_gates[]? | select(.status == "fail")] | length' 2>/dev/null || echo "0")
gates_total=$(echo "$gate_output" | jq '[.blocking_gates[]?] | length' 2>/dev/null || echo "$total_blocking")

# Citation count
citations_verified=0
cite_output=$(echo "$gate_output" | jq -r '.blocking_gates[]? | select(.gate == "verify-citations") | .output' 2>/dev/null || echo "")
if [[ -n "$cite_output" ]]; then
  citations_verified=$(echo "$cite_output" | jq -r '.verified // 0' 2>/dev/null || echo "0")
fi

# ── Mean citation age (commits since each cited line was last modified) ──
mean_citation_age=-1  # -1 = not computed
if [[ -f "$DOC_PATH" ]] && git rev-parse --git-dir &>/dev/null; then
  declare -A blame_cache  # (file,line) → commit_sha
  total_age=0
  cite_count=0

  while IFS= read -r line; do
    tmpline="$line"
    while [[ "$tmpline" =~ \`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+):([0-9]+)(-[0-9]+)?\` ]]; do
      cf="${BASH_REMATCH[1]}"
      cl="${BASH_REMATCH[2]}"
      tmpline="${tmpline#*"${BASH_REMATCH[0]}"}"

      [[ ! -f "$cf" ]] && continue

      cache_key="${cf}:${cl}"
      if [[ -n "${blame_cache[$cache_key]:-}" ]]; then
        blame_sha="${blame_cache[$cache_key]}"
      else
        # Get the commit that last modified this specific line
        blame_sha=$(git blame -L "${cl},${cl}" --porcelain "$cf" 2>/dev/null | head -1 | awk '{print $1}' || echo "")
        blame_cache["$cache_key"]="$blame_sha"
      fi

      if [[ -n "$blame_sha" && "$blame_sha" != "0000000000000000000000000000000000000000" ]]; then
        age=$(git rev-list --count "${blame_sha}..HEAD" 2>/dev/null || echo "0")
        total_age=$((total_age + age))
        ((cite_count++)) || true
      fi
    done
  done < "$DOC_PATH"

  if [[ $cite_count -gt 0 ]]; then
    mean_citation_age=$((total_age / cite_count))
  else
    mean_citation_age=0
  fi
fi

# Duration calculation
duration_ms=0
if [[ -n "$START_TIME" ]]; then
  end_epoch=$(date +%s 2>/dev/null || echo "0")
  start_epoch=$(echo "$START_TIME" | sed 's/[^0-9]//g' | head -c 10)
  if [[ -n "$start_epoch" && "$start_epoch" -gt 0 ]] 2>/dev/null; then
    duration_ms=$(( (end_epoch - start_epoch) * 1000 ))
  fi
fi

# Document type from path
doc_type="unknown"
case "$DOC_PATH" in
  *capability-brief*) doc_type="capability-brief" ;;
  *architecture-overview*|*architecture*) doc_type="architecture-overview" ;;
  *modules/*) doc_type="module-doc" ;;
  *operations*) doc_type="operations-guide" ;;
  *api-reference*) doc_type="api-reference" ;;
  *SECURITY*|*security*) doc_type="security-doc" ;;
  *CONTRIBUTING*|*contributing*) doc_type="contributing" ;;
  *CHANGELOG*|*changelog*) doc_type="changelog" ;;
  *index*) doc_type="index" ;;
  *README*|*readme*) doc_type="readme" ;;
  *) doc_type=$(basename "$DOC_PATH" .md) ;;
esac

# Build metrics entry (SDD §5.4 schema + legacy fields)
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
commit=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
head_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

metrics_entry=$(jq -nc \
  --arg document "$DOC_PATH" \
  --arg timestamp "$timestamp" \
  --arg commit "$commit" \
  --argjson gates_passed "$gates_passed" \
  --argjson gates_failed "$gates_failed" \
  --argjson gates_total "$gates_total" \
  --argjson details "$details" \
  --argjson duration_ms "$duration_ms" \
  --arg doc_type "$doc_type" \
  --arg model "$MODEL" \
  --arg generator_model "$GENERATOR_MODEL" \
  --arg overall "$overall" \
  --argjson repairs "$REPAIRS" \
  --argjson citations_verified "$citations_verified" \
  --arg head_sha "$head_sha" \
  --argjson untagged_count "$untagged_count" \
  --argjson mean_citation_age "$mean_citation_age" \
  '{
    document: $document,
    timestamp: $timestamp,
    commit: $commit,
    gates_passed: $gates_passed,
    gates_failed: $gates_failed,
    gates_total: $gates_total,
    details: $details,
    duration_ms: $duration_ms,
    doc_type: $doc_type,
    model: $model,
    generator_model: $generator_model,
    overall: $overall,
    repair_iterations: $repairs,
    citations_verified: $citations_verified,
    head_sha: $head_sha,
    untagged_count: $untagged_count,
    mean_citation_age_commits: $mean_citation_age
  }')

echo "$metrics_entry" >> "$METRICS_FILE"

if $JSON_OUTPUT; then
  echo "$metrics_entry"
else
  echo "PASS: Metrics exported to $METRICS_FILE ($gates_passed/$gates_total gates passed)"
fi

exit 0
