#!/usr/bin/env bash
# extract-doc-deps.sh — Citation-based cross-document dependency extractor
# Parses file:line citations from documents, maps cited files to owning documents
# via generation-manifest.json key_files, and outputs directional dependency graph.
#
# Usage:
#   extract-doc-deps.sh <document-path> [--json]
#   extract-doc-deps.sh --all [--json]
#
# Output (single doc):
#   { "document": "path", "cited_files": [...], "depends_on_docs": [...] }
#
# Output (--all):
#   { "graph": [...per-doc entries...],
#     "rebuild_index": { "src/file.ts": ["docs/that-cite-it.md", ...] } }
#
# Exit codes:
#   0 = Success
#   1 = No manifest found
#   2 = Invalid arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="grimoires/loa/ground-truth/generation-manifest.json"
ALL_MODE=false
DOC_PATH=""
JSON_OUTPUT=false

for arg in "$@"; do
  case "$arg" in
    --all) ALL_MODE=true ;;
    --json) JSON_OUTPUT=true ;;
    *)
      if [[ -z "$DOC_PATH" && "$arg" != --* ]]; then
        DOC_PATH="$arg"
      fi
      ;;
  esac
done

if [[ ! -f "$MANIFEST" ]]; then
  echo '{"error":"generation-manifest.json not found","path":"'"$MANIFEST"'"}' >&2
  exit 1
fi

if ! $ALL_MODE && [[ -z "$DOC_PATH" ]]; then
  echo "Usage: extract-doc-deps.sh <document-path> [--json]" >&2
  echo "       extract-doc-deps.sh --all [--json]" >&2
  exit 2
fi

# ── Build file-to-doc mapping from AGENT-CONTEXT key_files ──
# For each manifest document, parse its AGENT-CONTEXT and extract key_files
declare -A file_to_docs  # "src/file.ts" → "docs/a.md,docs/b.md"

manifest_docs=$(jq -r '.documents[].path' "$MANIFEST" 2>/dev/null)

while IFS= read -r doc; do
  [[ -z "$doc" || ! -f "$doc" ]] && continue
  # Extract key_files from AGENT-CONTEXT
  context_line=$(grep -oP '<!--\s*AGENT-CONTEXT:.*?-->' "$doc" 2>/dev/null | head -1 || true)
  if [[ -z "$context_line" ]]; then
    # Try multiline
    context_line=$(awk '/<!--\s*AGENT-CONTEXT:/,/-->/' "$doc" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' || true)
  fi
  [[ -z "$context_line" ]] && continue

  # Extract key_files list
  kf_raw=$(echo "$context_line" | grep -oP 'key_files=\[\K.*?(?=\])' | head -1 || true)
  [[ -z "$kf_raw" ]] && continue

  IFS=',' read -ra kf_arr <<< "$kf_raw"
  for kf in "${kf_arr[@]}"; do
    kf=$(echo "$kf" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$kf" ]] && continue
    existing="${file_to_docs[$kf]:-}"
    if [[ -z "$existing" ]]; then
      file_to_docs["$kf"]="$doc"
    else
      # Avoid duplicates
      if ! echo "$existing" | grep -qF "$doc"; then
        file_to_docs["$kf"]="$existing,$doc"
      fi
    fi
  done
done <<< "$manifest_docs"

# ── Extract citations from a single document ──
extract_deps() {
  local target_doc="$1"
  [[ ! -f "$target_doc" ]] && echo '{"document":"'"$target_doc"'","cited_files":[],"depends_on_docs":[]}' && return

  # Extract all file:line citations using same regex as verify-citations.sh
  local cited_files=()
  local seen_files=""

  while IFS= read -r line; do
    tmpline="$line"
    while [[ "$tmpline" =~ \`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+):[0-9]+(-[0-9]+)?\` ]]; do
      local cf="${BASH_REMATCH[1]}"
      tmpline="${tmpline#*"${BASH_REMATCH[0]}"}"
      # Deduplicate
      if ! echo "$seen_files" | grep -qxF "$cf" 2>/dev/null; then
        cited_files+=("$cf")
        seen_files+="$cf"$'\n'
      fi
    done
  done < "$target_doc"

  # Map cited files to owning documents
  local dep_docs=()
  local seen_deps=""

  for cf in "${cited_files[@]}"; do
    local owners="${file_to_docs[$cf]:-}"
    [[ -z "$owners" ]] && continue
    IFS=',' read -ra owner_arr <<< "$owners"
    for owner in "${owner_arr[@]}"; do
      # Don't include self-dependency
      [[ "$owner" == "$target_doc" ]] && continue
      if ! echo "$seen_deps" | grep -qxF "$owner" 2>/dev/null; then
        dep_docs+=("$owner")
        seen_deps+="$owner"$'\n'
      fi
    done
  done

  # Build JSON output
  local cf_json
  cf_json=$(printf '%s\n' "${cited_files[@]}" 2>/dev/null | jq -R . | jq -s . 2>/dev/null || echo "[]")
  local dd_json
  dd_json=$(printf '%s\n' "${dep_docs[@]}" 2>/dev/null | jq -R . | jq -s . 2>/dev/null || echo "[]")

  jq -nc \
    --arg doc "$target_doc" \
    --argjson cited_files "$cf_json" \
    --argjson depends_on_docs "$dd_json" \
    '{document: $doc, cited_files: $cited_files, depends_on_docs: $depends_on_docs}'
}

# ── Single document mode ──
if ! $ALL_MODE; then
  result=$(extract_deps "$DOC_PATH")
  if $JSON_OUTPUT; then
    echo "$result"
  else
    echo "Dependencies for: $DOC_PATH"
    echo "$result" | jq -r '"  Cited files: \(.cited_files | length)\n  Depends on docs: \(.depends_on_docs | join(", "))"' 2>/dev/null
  fi
  exit 0
fi

# ── All documents mode ──
graph="["
first=true
# Also build rebuild_index: source_file → [docs that cite it]
declare -A rebuild_idx  # "src/file.ts" → "doc1,doc2"

while IFS= read -r doc; do
  [[ -z "$doc" || ! -f "$doc" ]] && continue
  entry=$(extract_deps "$doc")

  if ! $first; then graph+=","; fi
  first=false
  graph+="$entry"

  # Build rebuild_index from this doc's cited_files
  cited=$(echo "$entry" | jq -r '.cited_files[]' 2>/dev/null)
  while IFS= read -r cf; do
    [[ -z "$cf" ]] && continue
    existing="${rebuild_idx[$cf]:-}"
    if [[ -z "$existing" ]]; then
      rebuild_idx["$cf"]="$doc"
    else
      if ! echo "$existing" | grep -qF "$doc"; then
        rebuild_idx["$cf"]="$existing,$doc"
      fi
    fi
  done <<< "$cited"
done <<< "$manifest_docs"

graph+="]"

# Build rebuild_index JSON
ri_entries=""
ri_first=true
for key in "${!rebuild_idx[@]}"; do
  vals="${rebuild_idx[$key]}"
  vals_json=$(echo "$vals" | tr ',' '\n' | jq -R . | jq -s . 2>/dev/null || echo "[]")
  if ! $ri_first; then ri_entries+=","; fi
  ri_first=false
  escaped_key=$(echo "$key" | jq -Rs . 2>/dev/null)
  ri_entries+="${escaped_key}: ${vals_json}"
done
ri_json="{${ri_entries}}"

# Final output
if $JSON_OUTPUT; then
  jq -nc \
    --argjson graph "$graph" \
    --argjson rebuild_index "$ri_json" \
    '{graph: $graph, rebuild_index: $rebuild_index}'
else
  echo "Cross-Document Dependency Graph"
  echo "==============================="
  echo "$graph" | jq -r '.[] | "  \(.document) → depends on: \(.depends_on_docs | join(", "))"' 2>/dev/null
  echo ""
  echo "Rebuild Index (source file → affected docs):"
  echo "$ri_json" | jq -r 'to_entries[] | "  \(.key) → \(.value | join(", "))"' 2>/dev/null
fi

exit 0
