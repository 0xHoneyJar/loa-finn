#!/usr/bin/env bash
# provenance-history.sh — Longitudinal provenance metrics tracking
# Reads corpus from generation-manifest.json, runs provenance-stats.sh on each document,
# and appends a timestamped snapshot to provenance-history.jsonl.
#
# Usage: provenance-history.sh [--cycle CYCLE_ID] [--json] [--strict] [--manifest PATH]
#
# Output: Appends one JSONL record to grimoires/loa/ground-truth/provenance-history.jsonl
#
# Flags:
#   --strict   Exit non-zero if missing_docs is non-empty or unqualified_inferred_count
#              exceeds the configured threshold (for CI use). BridgeBuilder F10.
#   --manifest Override the manifest file path (for testing)
#
# Exit codes:
#   0 = Success
#   1 = Error (missing manifest, etc.)
#   3 = Strict mode violation (missing docs or threshold exceeded)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MANIFEST="$REPO_ROOT/grimoires/loa/ground-truth/generation-manifest.json"
HISTORY_FILE="$REPO_ROOT/grimoires/loa/ground-truth/provenance-history.jsonl"
STATS_SCRIPT="$SCRIPT_DIR/provenance-stats.sh"

CYCLE_ID=""
JSON_ONLY=false
STRICT_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_ONLY=true; shift ;;
    --cycle) CYCLE_ID="${2:-}"; shift 2 ;;
    --strict) STRICT_MODE=true; shift ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Validate manifest ──
if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: generation-manifest.json not found at $MANIFEST" >&2
  exit 1
fi

if [[ ! -x "$STATS_SCRIPT" ]]; then
  echo "ERROR: provenance-stats.sh not found or not executable at $STATS_SCRIPT" >&2
  exit 1
fi

# ── Read corpus from manifest ──
doc_paths=$(jq -r '.documents[].path' "$MANIFEST" 2>/dev/null)
if [[ -z "$doc_paths" ]]; then
  echo "ERROR: No documents found in manifest" >&2
  exit 1
fi

# ── Collect metadata ──
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
commit=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
corpus_size=$(echo "$doc_paths" | wc -l | tr -d ' ')

# ── Run provenance-stats.sh on each document ──
total_blocks=0
total_tagged=0
total_code_factual=0
total_inferred=0
total_derived=0
total_inf_architectural=0
total_inf_upgradeable=0
total_inf_pending_evidence=0
total_inf_unqualified=0
trust_high=0
trust_medium=0
trust_low=0
missing_docs=()
per_doc_json="["
first_doc=true

while IFS= read -r doc_path; do
  [[ -z "$doc_path" ]] && continue

  if [[ ! -f "$doc_path" ]]; then
    missing_docs+=("$doc_path")
    if ! $first_doc; then per_doc_json+=","; fi
    first_doc=false
    per_doc_json+=$(jq -nc --arg path "$doc_path" '{path: $path, status: "missing"}')
    continue
  fi

  # Run stats
  stats_json=$("$STATS_SCRIPT" "$doc_path" --json 2>/dev/null || echo '{"error":"stats_failed"}')

  # Check for error
  if echo "$stats_json" | jq -e '.error' &>/dev/null; then
    missing_docs+=("$doc_path")
    if ! $first_doc; then per_doc_json+=","; fi
    first_doc=false
    per_doc_json+=$(jq -nc --arg path "$doc_path" '{path: $path, status: "error"}')
    continue
  fi

  # Extract values
  doc_blocks=$(echo "$stats_json" | jq -r '.total_blocks' 2>/dev/null || echo "0")
  doc_tagged=$(echo "$stats_json" | jq -r '.tagged_blocks' 2>/dev/null || echo "0")
  doc_cf=$(echo "$stats_json" | jq -r '.counts["CODE-FACTUAL"]' 2>/dev/null || echo "0")
  doc_inf=$(echo "$stats_json" | jq -r '.counts.INFERRED' 2>/dev/null || echo "0")
  doc_dv=$(echo "$stats_json" | jq -r '.counts.DERIVED' 2>/dev/null || echo "0")
  doc_trust=$(echo "$stats_json" | jq -r '.trust_level' 2>/dev/null || echo "unknown")
  doc_inf_arch=$(echo "$stats_json" | jq -r '.INFERRED_BREAKDOWN.architectural' 2>/dev/null || echo "0")
  doc_inf_upg=$(echo "$stats_json" | jq -r '.INFERRED_BREAKDOWN.upgradeable' 2>/dev/null || echo "0")
  doc_inf_pend=$(echo "$stats_json" | jq -r '.INFERRED_BREAKDOWN["pending-evidence"]' 2>/dev/null || echo "0")
  doc_inf_unq=$(echo "$stats_json" | jq -r '.INFERRED_BREAKDOWN.unqualified' 2>/dev/null || echo "0")

  # Accumulate totals
  total_blocks=$((total_blocks + doc_blocks))
  total_tagged=$((total_tagged + doc_tagged))
  total_code_factual=$((total_code_factual + doc_cf))
  total_inferred=$((total_inferred + doc_inf))
  total_derived=$((total_derived + doc_dv))
  total_inf_architectural=$((total_inf_architectural + doc_inf_arch))
  total_inf_upgradeable=$((total_inf_upgradeable + doc_inf_upg))
  total_inf_pending_evidence=$((total_inf_pending_evidence + doc_inf_pend))
  total_inf_unqualified=$((total_inf_unqualified + doc_inf_unq))

  case "$doc_trust" in
    high) ((trust_high++)) || true ;;
    medium) ((trust_medium++)) || true ;;
    low) ((trust_low++)) || true ;;
  esac

  if ! $first_doc; then per_doc_json+=","; fi
  first_doc=false
  per_doc_json+="$stats_json"
done <<< "$doc_paths"

per_doc_json+="]"

# ── Build missing_docs JSON array ──
missing_json="[]"
if [[ ${#missing_docs[@]} -gt 0 ]]; then
  missing_json=$(printf '%s\n' "${missing_docs[@]}" | jq -R . | jq -s .)
fi

# ── Read configurable threshold for unqualified INFERRED (Task 2.2) ──
# shellcheck source=shared/read-config.sh
source "$SCRIPT_DIR/shared/read-config.sh"
MAX_UNQUALIFIED=$(read_config "ground_truth.thresholds.max_unqualified_inferred" "10")

# ── Build snapshot record ──
snapshot=$(jq -nc \
  --arg timestamp "$timestamp" \
  --arg cycle "$CYCLE_ID" \
  --arg commit "$commit" \
  --argjson corpus_size "$corpus_size" \
  --argjson total_blocks "$total_blocks" \
  --argjson total_tagged "$total_tagged" \
  --argjson total_code_factual "$total_code_factual" \
  --argjson total_inferred "$total_inferred" \
  --argjson total_derived "$total_derived" \
  --argjson total_inf_architectural "$total_inf_architectural" \
  --argjson total_inf_upgradeable "$total_inf_upgradeable" \
  --argjson total_inf_pending_evidence "$total_inf_pending_evidence" \
  --argjson total_inf_unqualified "$total_inf_unqualified" \
  --argjson trust_high "$trust_high" \
  --argjson trust_medium "$trust_medium" \
  --argjson trust_low "$trust_low" \
  --argjson missing_docs "$missing_json" \
  --argjson per_document "$per_doc_json" \
  '{
    timestamp: $timestamp,
    cycle: $cycle,
    commit: $commit,
    corpus_size: $corpus_size,
    corpus_stats: {
      total_blocks: $total_blocks,
      total_tagged: $total_tagged,
      total_code_factual: $total_code_factual,
      total_inferred: $total_inferred,
      total_derived: $total_derived,
      inferred_breakdown: {
        architectural: $total_inf_architectural,
        upgradeable: $total_inf_upgradeable,
        "pending-evidence": $total_inf_pending_evidence,
        unqualified: $total_inf_unqualified
      },
      trust_level_distribution: {
        high: $trust_high,
        medium: $trust_medium,
        low: $trust_low
      }
    },
    metrics: {
      unqualified_inferred_count: $total_inf_unqualified
    },
    missing_docs: $missing_docs,
    per_document: $per_document,
    model_attribution: {}
  }')

# ── Output ──
if $JSON_ONLY; then
  echo "$snapshot"
else
  # Append to history file
  echo "$snapshot" >> "$HISTORY_FILE"
  echo "Provenance snapshot recorded:"
  echo "  Timestamp:  $timestamp"
  echo "  Cycle:      ${CYCLE_ID:-<none>}"
  echo "  Commit:     $commit"
  echo "  Corpus:     $corpus_size documents (${#missing_docs[@]} missing)"
  echo "  Blocks:     $total_blocks total, $total_tagged tagged"
  echo "  Trust:      high=$trust_high, medium=$trust_medium, low=$trust_low"
  echo "  INFERRED:   $total_inferred (arch=$total_inf_architectural, upg=$total_inf_upgradeable, pend=$total_inf_pending_evidence, unq=$total_inf_unqualified)"
  echo "  Metrics:    unqualified_inferred_count=$total_inf_unqualified (threshold=$MAX_UNQUALIFIED)"
  # model_attribution: reserved for Hounfour Phase 5+ — will track which model processed each document
  echo "  History:    $HISTORY_FILE"
fi

# ── Strict mode enforcement (BridgeBuilder F10) ──
if $STRICT_MODE; then
  strict_fail=false
  if [[ ${#missing_docs[@]} -gt 0 ]]; then
    echo "STRICT: ${#missing_docs[@]} missing document(s): ${missing_docs[*]}" >&2
    strict_fail=true
  fi
  if [[ $total_inf_unqualified -gt $MAX_UNQUALIFIED ]]; then
    echo "STRICT: unqualified_inferred_count ($total_inf_unqualified) exceeds threshold ($MAX_UNQUALIFIED)" >&2
    strict_fail=true
  fi
  if $strict_fail; then
    exit 3
  fi
fi

exit 0
