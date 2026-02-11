#!/usr/bin/env bash
# update-generation-manifest.sh — Record per-doc status in generation-manifest.json
# After each /ground-truth run, records document path, status, gate results,
# timestamp, and commit hash.
#
# Usage: update-generation-manifest.sh <document-path> --status <passed|failed> [--gates-json <json>] [--json]
#
# Exit codes:
#   0 = Manifest updated successfully
#   1 = Update failed
#   2 = Invalid arguments

set -euo pipefail

DOC_PATH="${1:-}"
STATUS=""
GATES_JSON=""
JSON_OUTPUT=false
MANIFEST_FILE="grimoires/loa/ground-truth/generation-manifest.json"

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) STATUS="$2"; shift 2 ;;
    --gates-json) GATES_JSON="$2"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    --manifest) MANIFEST_FILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$DOC_PATH" ]]; then
  echo '{"error":"Document path required"}' >&2
  exit 2
fi

if [[ -z "$STATUS" ]]; then
  echo '{"error":"--status required (passed|failed)"}' >&2
  exit 2
fi

# ── Ensure manifest directory exists ──
mkdir -p "$(dirname "$MANIFEST_FILE")"

# ── Initialize manifest if it doesn't exist ──
if [[ ! -f "$MANIFEST_FILE" ]]; then
  echo '{"documents":[],"metadata":{"created":"'"$(date -u +"%Y-%m-%dT%H:%M:%SZ")"'","version":"1.0.0"}}' | jq . > "$MANIFEST_FILE"
fi

# ── Build document entry ──
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
commit=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
commit_short=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Parse gate results if provided
gate_summary="{}"
if [[ -n "$GATES_JSON" ]]; then
  gate_summary=$(echo "$GATES_JSON" | jq '{
    overall: .overall,
    gates_passed: .passed_blocking,
    gates_total: .total_blocking,
    warnings: (.warnings | length)
  }' 2>/dev/null || echo '{}')
fi

doc_entry=$(jq -nc \
  --arg path "$DOC_PATH" \
  --arg status "$STATUS" \
  --arg timestamp "$timestamp" \
  --arg commit "$commit" \
  --arg commit_short "$commit_short" \
  --argjson gates "$gate_summary" \
  '{
    path: $path,
    status: $status,
    timestamp: $timestamp,
    commit: $commit,
    commit_short: $commit_short,
    gates: $gates
  }')

# ── Update manifest (upsert by path) ──
tmp_manifest=$(mktemp "${MANIFEST_FILE}.XXXXXX")
jq --argjson entry "$doc_entry" '
  .documents = [
    (.documents // [] | map(select(.path != $entry.path))),
    [$entry]
  ] | flatten |
  .metadata.updated = ($entry.timestamp)
' "$MANIFEST_FILE" > "$tmp_manifest" && mv "$tmp_manifest" "$MANIFEST_FILE" || { rm -f "$tmp_manifest"; exit 1; }

# ── Output ──
if $JSON_OUTPUT; then
  echo "$doc_entry"
else
  echo "Manifest updated: $DOC_PATH → $STATUS ($commit_short)"
fi

exit 0
