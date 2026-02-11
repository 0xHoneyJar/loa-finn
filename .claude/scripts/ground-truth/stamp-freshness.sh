#!/usr/bin/env bash
# stamp-freshness.sh — Append metadata block to generated Ground Truth documents
# Includes HEAD SHA, generation timestamp, and registry checksums.
#
# Usage: stamp-freshness.sh <document-path>
#
# Exit codes:
#   0 = stamp applied successfully
#   1 = error (missing file, git failure)

set -euo pipefail

DOC_PATH="${1:-}"

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  echo "ERROR: Document path required and must exist: $DOC_PATH" >&2
  exit 1
fi

REGISTRY_DIR="grimoires/loa/ground-truth"

head_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
generated_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
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

META_BLOCK="<!-- ground-truth-meta: head_sha=${head_sha} generated_at=${generated_at} features_sha=${features_sha} limitations_sha=${limitations_sha} ride_sha=${ride_sha} -->"

# Remove existing meta block if present (idempotent)
if grep -q '<!-- ground-truth-meta:' "$DOC_PATH" 2>/dev/null; then
  # Use a temp file for safe in-place edit
  tmp_file=$(mktemp)
  grep -v '<!-- ground-truth-meta:' "$DOC_PATH" > "$tmp_file"
  mv "$tmp_file" "$DOC_PATH"
fi

# Append meta block
echo "" >> "$DOC_PATH"
echo "$META_BLOCK" >> "$DOC_PATH"

echo '{"status":"ok","head_sha":"'"$head_sha"'","generated_at":"'"$generated_at"'"}'
