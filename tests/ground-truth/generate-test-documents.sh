#!/usr/bin/env bash
# generate-test-documents.sh — Property-based test document generator
# Generates random valid and invalid Ground Truth documents for property testing.
#
# Valid documents: correct provenance tags, real citations, matching evidence anchors.
# Invalid documents: one specific defect each, documented in companion manifest.
#
# Usage: generate-test-documents.sh <output-dir> [--count N] [--json]
#
# Exit codes:
#   0 = Documents generated successfully
#   1 = Generation error
#   2 = Invalid arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OUTPUT_DIR="${1:-}"
COUNT=50
JSON_OUTPUT=false

shift || true
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    --count) : ;;  # next arg handled below
    *)
      if [[ "${prev_arg:-}" == "--count" ]]; then
        COUNT="$arg"
      fi
      ;;
  esac
  prev_arg="$arg"
done

if [[ -z "$OUTPUT_DIR" ]]; then
  echo "Usage: generate-test-documents.sh <output-dir> [--count N]" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR/valid" "$OUTPUT_DIR/invalid"
cd "$REPO_ROOT"

# ── Real citations from the codebase for valid documents ──
# These are verified to exist and contain the expected symbols
declare -a REAL_CITATIONS=(
  "src/persistence/index.ts:1-6|WALManager,createWALManager"
  "src/persistence/index.ts:5|WALManager"
  "src/persistence/index.ts:22-26|WALPruner"
  "src/gateway/server.ts:19-30|createApp,AppOptions"
  "src/cron/service.ts:1-8|CronService,CircuitBreaker"
  "src/agent/worker-pool.ts:17-30|PoolErrorCode,PoolError"
  "src/bridgebuilder/entry.ts:1-10|loadFinnConfig,createFinnAdapters"
  "src/learning/compound.ts:1-29|TrajectoryEntry,CandidateLearning"
)

# ── Provenance classes and their templates ──
PROVENANCE_CLASSES=("CODE-FACTUAL" "REPO-DOC-GROUNDED" "ANALOGY" "HYPOTHESIS" "EXTERNAL-REFERENCE")

# ── Analogy templates ──
ANALOGIES=(
  "This follows the same pattern PostgreSQL uses for write-ahead logging — append-only writes ensure crash recovery."
  "Like how Kubernetes separates its control plane from its data plane, each capability area operates independently."
  "The isolation pattern mirrors Chrome's multi-process architecture — each operation runs in a separate worker thread."
  "Similar to how Stripe's documentation-first approach works, mechanisms are described via evidence rather than adjectives."
  "This mirrors Apache Airflow's DAG scheduler — declarative job registration with dependency-aware execution."
)

# ── Hypothesis templates ──
HYPOTHESES=(
  "We hypothesize that horizontal scaling will require a distributed WAL implementation in future iterations."
  "We are exploring CRDTs as a potential coordination mechanism for multi-writer scenarios."
  "We believe the circuit breaker thresholds may need per-tenant tuning as the user base grows."
  "Early evidence suggests that batching WAL writes could reduce I/O overhead by 40-60%."
  "It is plausible that the routing layer could benefit from locality-aware scheduling."
)

# ── Section heading templates ──
HEADINGS=(
  "Persistence Layer"
  "Orchestration"
  "Agent Safety"
  "Job Scheduling"
  "HTTP Gateway"
  "Design Principles"
  "Limitations"
  "What This Means"
)

# ── Banned terms (for invalid documents) ──
BANNED_TERMS=("revolutionary" "blazing" "enterprise-grade" "cutting-edge" "game-changing" "best-in-class" "world-class" "next-generation")

# ── Defect types for invalid documents ──
DEFECT_TYPES=(
  "wrong_path"
  "missing_provenance"
  "banned_term"
  "bad_line_range"
  "wrong_evidence_symbol"
  "hypothesis_no_marker"
  "path_traversal"
  "missing_citation_in_code_factual"
)

# ── Helper: random element from array ──
rand_elem() {
  local -n arr=$1
  echo "${arr[$((RANDOM % ${#arr[@]}))]}"
}

# ── Helper: random integer in range ──
rand_range() {
  echo $(( ($RANDOM % ($2 - $1 + 1)) + $1 ))
}

# ── Generate a valid document ──
generate_valid() {
  local idx=$1
  local num_sections=$(rand_range 3 6)
  local doc=""

  doc+="---\ntitle: Property Test Valid $idx\nversion: 1.0.0\n---\n\n"
  doc+="# Test Document $idx\n\n"

  # Overview section (REPO-DOC-GROUNDED)
  doc+="## Overview\n\n"
  doc+="<!-- provenance: REPO-DOC-GROUNDED -->\n"
  doc+="This project provides durable state management via write-ahead logging. See \`grimoires/loa/prd-ground-truth.md §1\` for the full problem statement.\n\n"

  # Generate sections with real citations
  local used_citations=()
  for ((s=0; s<num_sections && s<${#REAL_CITATIONS[@]}; s++)); do
    local cite_entry="${REAL_CITATIONS[$s]}"
    local citation="${cite_entry%%|*}"
    local symbols="${cite_entry#*|}"
    local heading=$(rand_elem HEADINGS)

    doc+="## $heading\n\n"

    # CODE-FACTUAL paragraph with real citation and evidence
    doc+="<!-- provenance: CODE-FACTUAL -->\n"
    doc+="<!-- evidence: "
    # Build evidence symbols
    local first_sym=true
    IFS=',' read -ra sym_arr <<< "$symbols"
    for sym in "${sym_arr[@]}"; do
      if ! $first_sym; then doc+=", "; fi
      doc+="symbol=$sym"
      first_sym=false
    done
    doc+=" -->\n"
    doc+="The component at \`$citation\` provides core functionality"
    # Include symbol names in text for realism
    for sym in "${sym_arr[@]}"; do
      doc+=" via the \`$sym\` interface"
    done
    doc+=".\n\n"

    # ANALOGY paragraph
    local analogy=$(rand_elem ANALOGIES)
    doc+="<!-- provenance: ANALOGY -->\n"
    doc+="$analogy\n\n"
  done

  # Final section (ANALOGY)
  doc+="## What This Means\n\n"
  doc+="<!-- provenance: ANALOGY -->\n"
  doc+="The mechanism descriptions here let developers form their own conclusions through evidence rather than adjectives.\n\n"

  doc+="<!-- ground-truth-meta: head_sha=test generated_at=2026-02-10T00:00:00Z features_sha=test limitations_sha=test ride_sha=none -->\n"

  echo -e "$doc"
}

# ── Generate an invalid document with exactly one defect ──
generate_invalid() {
  local idx=$1
  local defect_type="${DEFECT_TYPES[$((idx % ${#DEFECT_TYPES[@]}))]}"
  local doc=""
  local defect_detail=""

  doc+="---\ntitle: Property Test Invalid $idx ($defect_type)\n---\n\n"
  doc+="# Test Document $idx\n\n"

  case "$defect_type" in
    wrong_path)
      doc+="## Section\n\n"
      doc+="<!-- provenance: CODE-FACTUAL -->\n"
      doc+="<!-- evidence: symbol=WALManager -->\n"
      doc+="The module at \`src/nonexistent/phantom-${idx}.ts:1-5\` does things.\n\n"
      doc+="## Summary\n\n<!-- provenance: ANALOGY -->\nLike PostgreSQL WAL for crash recovery.\n"
      defect_detail="Citation references non-existent file"
      ;;

    missing_provenance)
      doc+="## Section\n\n"
      doc+="This paragraph has no provenance tag. It makes claims without grounding.\n\n"
      doc+="Another untagged paragraph that also lacks provenance.\n\n"
      doc+="Yet another paragraph without any provenance classification.\n\n"
      doc+="Still missing provenance tags on this content.\n\n"
      doc+="More untagged content here.\n\n"
      doc+="## Tagged\n\n<!-- provenance: ANALOGY -->\nThis one is tagged.\n"
      defect_detail="Multiple paragraphs missing provenance tags (below 95% threshold)"
      ;;

    banned_term)
      doc+="## Section\n\n"
      local term=$(rand_elem BANNED_TERMS)
      doc+="<!-- provenance: ANALOGY -->\n"
      doc+="The system provides a $term approach to state management.\n\n"
      doc+="## Summary\n\n<!-- provenance: ANALOGY -->\nEvidence over adjectives.\n"
      defect_detail="Contains banned term: $term"
      ;;

    bad_line_range)
      doc+="## Section\n\n"
      doc+="<!-- provenance: CODE-FACTUAL -->\n"
      doc+="<!-- evidence: symbol=WALManager -->\n"
      doc+="The persistence at \`src/persistence/index.ts:99999-100000\` does logging.\n\n"
      doc+="## Summary\n\n<!-- provenance: ANALOGY -->\nLike PostgreSQL WAL.\n"
      defect_detail="Citation line range out of bounds"
      ;;

    wrong_evidence_symbol)
      doc+="## Section\n\n"
      doc+="<!-- provenance: CODE-FACTUAL -->\n"
      doc+="<!-- evidence: symbol=TotallyFakeSymbol${idx}XYZ -->\n"
      doc+="The persistence at \`src/persistence/index.ts:1-6\` does logging.\n\n"
      doc+="## Summary\n\n<!-- provenance: ANALOGY -->\nLike PostgreSQL WAL.\n"
      defect_detail="Evidence anchor symbol not found in cited lines"
      ;;

    hypothesis_no_marker)
      doc+="## Section\n\n"
      doc+="<!-- provenance: HYPOTHESIS -->\n"
      doc+="Horizontal scaling will definitely require CRDTs. This is certain and inevitable.\n\n"
      doc+="## Summary\n\n<!-- provenance: ANALOGY -->\nLike PostgreSQL WAL.\n"
      defect_detail="HYPOTHESIS paragraph lacks epistemic marker prefix"
      ;;

    path_traversal)
      doc+="## Section\n\n"
      doc+="<!-- provenance: CODE-FACTUAL -->\n"
      doc+="<!-- evidence: symbol=secret -->\n"
      doc+="The config at \`../../../etc/shadow.conf:1-5\` exposes secrets.\n\n"
      doc+="## Summary\n\n<!-- provenance: ANALOGY -->\nLike PostgreSQL WAL.\n"
      defect_detail="Citation path contains directory traversal"
      ;;

    missing_citation_in_code_factual)
      doc+="## Section\n\n"
      doc+="<!-- provenance: CODE-FACTUAL -->\n"
      doc+="The persistence layer uses write-ahead logging for crash recovery without any specific code reference.\n\n"
      doc+="## Summary\n\n<!-- provenance: ANALOGY -->\nLike PostgreSQL WAL.\n"
      defect_detail="CODE-FACTUAL paragraph missing file:line citation"
      ;;
  esac

  echo -e "$doc" > "$_INVALID_OUTPUT_FILE"
  echo "$defect_type|$defect_detail"
}

# ── Gate mapping for defect types ──
gate_for_defect() {
  case "$1" in
    wrong_path) echo "verify-citations" ;;
    missing_provenance) echo "check-provenance" ;;
    banned_term) echo "scan-banned-terms" ;;
    bad_line_range) echo "verify-citations" ;;
    wrong_evidence_symbol) echo "verify-citations" ;;
    hypothesis_no_marker) echo "check-provenance" ;;
    path_traversal) echo "verify-citations" ;;
    missing_citation_in_code_factual) echo "check-provenance" ;;
  esac
}

# ── Generate valid documents ──
valid_count=0
for ((i=1; i<=COUNT; i++)); do
  generate_valid "$i" > "$OUTPUT_DIR/valid/doc-${i}.md"
  ((valid_count++)) || true
done

# ── Generate invalid documents with manifest ──
invalid_count=0
manifest_json='['
first_manifest=true

for ((i=1; i<=COUNT; i++)); do
  _INVALID_OUTPUT_FILE="$OUTPUT_DIR/invalid/doc-${i}.md"
  defect_info=$(generate_invalid "$i")

  defect_type="${defect_info%%|*}"
  defect_detail="${defect_info#*|}"
  expected_gate=$(gate_for_defect "$defect_type")

  if ! $first_manifest; then manifest_json+=","; fi
  first_manifest=false
  escaped_detail=$(echo "$defect_detail" | sed 's/"/\\"/g')
  manifest_json+="{\"file\":\"doc-${i}.md\",\"defect_type\":\"$defect_type\",\"expected_gate\":\"$expected_gate\",\"detail\":\"$escaped_detail\"}"
  ((invalid_count++)) || true
done

manifest_json+=']'
echo "$manifest_json" | jq '.' > "$OUTPUT_DIR/invalid/manifest.json"

if $JSON_OUTPUT; then
  echo "{\"valid_count\":$valid_count,\"invalid_count\":$invalid_count,\"output_dir\":\"$OUTPUT_DIR\"}"
else
  echo "Generated $valid_count valid + $invalid_count invalid documents in $OUTPUT_DIR"
  echo "Manifest: $OUTPUT_DIR/invalid/manifest.json"
fi

exit 0
