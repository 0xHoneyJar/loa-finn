#!/usr/bin/env bash
# write-manifest.sh — Update generation manifest after successful document generation
# Appends or updates per-document entry in generation-manifest.json.
#
# Usage: write-manifest.sh <document-path> [--citations <N>] [--warnings <N>] [--gates pass|fail]
#
# Exit codes:
#   0 = Manifest updated successfully
#   1 = Error (missing document, jq failure)

set -euo pipefail

DOC_PATH="${1:-}"
CITATIONS=0
WARNINGS=0
GATES="pass"

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --citations) CITATIONS="$2"; shift 2 ;;
    --warnings) WARNINGS="$2"; shift 2 ;;
    --gates) GATES="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  echo "ERROR: Document path required and must exist: ${DOC_PATH:-<none>}" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required for manifest management" >&2
  exit 1
fi

MANIFEST="grimoires/loa/ground-truth/generation-manifest.json"
REGISTRY_DIR="grimoires/loa/ground-truth"

# Gather metadata
head_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
generated_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
doc_checksum=$(git hash-object "$DOC_PATH" 2>/dev/null || echo "untracked")
features_sha="none"
limitations_sha="none"
ride_sha="none"

if [[ -f "$REGISTRY_DIR/features.yaml" ]]; then
  features_sha=$(git hash-object "$REGISTRY_DIR/features.yaml" 2>/dev/null || echo "untracked")
fi
if [[ -f "$REGISTRY_DIR/limitations.yaml" ]]; then
  limitations_sha=$(git hash-object "$REGISTRY_DIR/limitations.yaml" 2>/dev/null || echo "untracked")
fi
if [[ -f "grimoires/loa/reality/index.md" ]]; then
  ride_sha=$(git hash-object "grimoires/loa/reality/index.md" 2>/dev/null || echo "untracked")
fi

# Build new entry
new_entry=$(jq -n \
  --arg path "$DOC_PATH" \
  --arg generated "$generated_at" \
  --arg checksum "$doc_checksum" \
  --argjson citations "$CITATIONS" \
  --arg gates "$GATES" \
  --argjson warnings "$WARNINGS" \
  --arg head_sha "$head_sha" \
  --arg features_sha "$features_sha" \
  --arg limitations_sha "$limitations_sha" \
  --arg ride_sha "$ride_sha" \
  '{
    path: $path,
    generated: $generated,
    checksum: $checksum,
    citations_verified: $citations,
    quality_gates: $gates,
    warnings: $warnings,
    head_sha: $head_sha,
    features_sha: $features_sha,
    limitations_sha: $limitations_sha,
    ride_sha: $ride_sha
  }')

# Update or create manifest
if [[ -f "$MANIFEST" ]]; then
  # Remove existing entry for same path, then append new one
  updated=$(jq --arg path "$DOC_PATH" --argjson entry "$new_entry" \
    '.documents = [.documents[] | select(.path != $path)] + [$entry] | .last_updated = (now | todate)' \
    "$MANIFEST" 2>/dev/null)

  if [[ -n "$updated" ]]; then
    echo "$updated" > "$MANIFEST"
  else
    # jq failed — recreate manifest
    jq -n --argjson entry "$new_entry" \
      '{version: "1.0.0", documents: [$entry], last_updated: (now | todate)}' > "$MANIFEST"
  fi
else
  # Create new manifest
  jq -n --argjson entry "$new_entry" \
    '{version: "1.0.0", documents: [$entry], last_updated: (now | todate)}' > "$MANIFEST"
fi

echo '{"status":"ok","path":"'"$DOC_PATH"'","manifest":"'"$MANIFEST"'"}'
