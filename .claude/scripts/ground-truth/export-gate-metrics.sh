#!/usr/bin/env bash
# export-gate-metrics.sh — Append quality gate metrics to JSONL for Hounfour routing
# After each quality gate run, records: timestamp, document type, model used,
# gate results, repair iterations, total citations verified.
#
# Usage: export-gate-metrics.sh <document-path> [--model <model>] [--repairs <N>] [--json]
#
# Exit codes:
#   0 = Metrics exported successfully
#   1 = Error (missing document, jq failure)
#   2 = Invalid arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOC_PATH="${1:-}"
MODEL="unknown"
REPAIRS=0
JSON_OUTPUT=false

shift || true
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    --model|--repairs) : ;;  # next arg handled below
    *)
      if [[ "${prev_arg:-}" == "--model" ]]; then
        MODEL="$arg"
      elif [[ "${prev_arg:-}" == "--repairs" ]]; then
        REPAIRS="$arg"
      fi
      ;;
  esac
  prev_arg="$arg"
done

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  echo '{"error":"Document path required and must exist"}' >&2
  exit 2
fi

METRICS_FILE="grimoires/loa/ground-truth/gate-metrics.jsonl"

# Ensure directory exists
mkdir -p "$(dirname "$METRICS_FILE")"

# ── Run quality gates to get current results ──
gate_exit=0
gate_output=$("$SCRIPT_DIR/quality-gates.sh" "$DOC_PATH" --json 2>/dev/null) || gate_exit=$?

# Parse gate results
overall=$(echo "$gate_output" | jq -r '.overall // "unknown"' 2>/dev/null || echo "unknown")
total_blocking=$(echo "$gate_output" | jq -r '.total_blocking // 0' 2>/dev/null || echo "0")
passed_blocking=$(echo "$gate_output" | jq -r '.passed_blocking // 0' 2>/dev/null || echo "0")
warnings=$(echo "$gate_output" | jq -r '.warnings | length // 0' 2>/dev/null || echo "0")

# Extract per-gate pass/fail
gate_results=$(echo "$gate_output" | jq '[.blocking_gates[] | {gate: .gate, status: .status}]' 2>/dev/null || echo "[]")

# Get citation count from verify-citations gate output
citations_verified=0
cite_output=$(echo "$gate_output" | jq -r '.blocking_gates[] | select(.gate == "verify-citations") | .output' 2>/dev/null || echo "")
if [[ -n "$cite_output" ]]; then
  citations_verified=$(echo "$cite_output" | jq -r '.verified // 0' 2>/dev/null || echo "0")
fi

# Determine document type from path
doc_type="unknown"
case "$DOC_PATH" in
  *capability-brief*) doc_type="capability-brief" ;;
  *architecture-overview*) doc_type="architecture-overview" ;;
  *) doc_type=$(basename "$DOC_PATH" .md) ;;
esac

# Build metrics entry
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
head_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

metrics_entry=$(jq -n \
  --arg timestamp "$timestamp" \
  --arg doc_type "$doc_type" \
  --arg doc_path "$DOC_PATH" \
  --arg model "$MODEL" \
  --arg overall "$overall" \
  --argjson total_blocking "$total_blocking" \
  --argjson passed_blocking "$passed_blocking" \
  --argjson warnings "$warnings" \
  --argjson repairs "$REPAIRS" \
  --argjson citations_verified "$citations_verified" \
  --argjson gate_results "$gate_results" \
  --arg head_sha "$head_sha" \
  '{
    timestamp: $timestamp,
    doc_type: $doc_type,
    doc_path: $doc_path,
    model: $model,
    overall: $overall,
    total_blocking: $total_blocking,
    passed_blocking: $passed_blocking,
    warnings: $warnings,
    repair_iterations: $repairs,
    citations_verified: $citations_verified,
    gate_results: $gate_results,
    head_sha: $head_sha
  }')

# Append to JSONL (one JSON object per line)
echo "$metrics_entry" | jq -c '.' >> "$METRICS_FILE"

if $JSON_OUTPUT; then
  echo "$metrics_entry"
else
  echo "Metrics exported to $METRICS_FILE"
  echo "  doc_type=$doc_type model=$MODEL overall=$overall citations=$citations_verified repairs=$REPAIRS"
fi

exit 0
