#!/usr/bin/env bash
# extract-limitations.sh — Extract TODO/FIXME tags and merge with limitations.yaml
#
# Usage: extract-limitations.sh [--src <dir>] [--registry <file>] [--json]
#
# Exit codes:
#   0 = Success

set -euo pipefail

SRC_DIR="src"
REGISTRY="grimoires/loa/ground-truth/limitations.yaml"
JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC_DIR="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    *) shift ;;
  esac
done

# ── Extract TODO/FIXME/HACK/XXX tags from source ──
code_tags="["
first=true

if [[ -d "$SRC_DIR" ]]; then
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    file="${match%%:*}"
    rest="${match#*:}"
    line_num="${rest%%:*}"
    content="${rest#*:}"
    content=$(echo "$content" | sed 's/^[[:space:]]*//' | head -c 200)

    # Determine tag type
    tag_type="TODO"
    if echo "$content" | grep -qi "FIXME"; then tag_type="FIXME"; fi
    if echo "$content" | grep -qi "HACK"; then tag_type="HACK"; fi
    if echo "$content" | grep -qi "XXX"; then tag_type="XXX"; fi

    if ! $first; then code_tags+=","; fi
    first=false
    tag_entry=$(jq -nc \
      --arg tag "$tag_type" \
      --arg file "$file" \
      --argjson line "$line_num" \
      --arg content "$content" \
      '{source: "code-tag", tag: $tag, file: $file, line: $line, content: $content}')
    code_tags+="$tag_entry"
  done < <(grep -rnE '(TODO|FIXME|HACK|XXX):?' "$SRC_DIR" 2>/dev/null || true)
fi

code_tags+="]"

# ── Load registry limitations ──
registry_entries="["
first=true

if [[ -f "$REGISTRY" ]]; then
  # Use yq to extract limitations
  count=$(yq '.limitations | length' "$REGISTRY" 2>/dev/null || echo "0")
  for ((i=0; i<count; i++)); do
    feature_id=$(yq ".limitations[$i].feature_id" "$REGISTRY" 2>/dev/null || echo "unknown")
    description=$(yq ".limitations[$i].description" "$REGISTRY" 2>/dev/null || echo "")
    reason=$(yq ".limitations[$i].reason" "$REGISTRY" 2>/dev/null || echo "")

    if ! $first; then registry_entries+=","; fi
    first=false
    reg_entry=$(jq -nc \
      --arg feature_id "$feature_id" \
      --arg description "$description" \
      --arg reason "$reason" \
      '{source: "registry", feature_id: $feature_id, description: $description, reason: $reason}')
    registry_entries+="$reg_entry"
  done
fi

registry_entries+="]"

# ── Output merged result ──
code_count=$(echo "$code_tags" | jq 'length' 2>/dev/null || echo "0")
registry_count=$(echo "$registry_entries" | jq 'length' 2>/dev/null || echo "0")

if $JSON_OUTPUT; then
  echo '{"code_tags":'"$code_tags"',"registry_entries":'"$registry_entries"',"code_count":'"$code_count"',"registry_count":'"$registry_count"'}'
else
  echo "Limitations: $code_count from code tags, $registry_count from registry"
fi

exit 0
