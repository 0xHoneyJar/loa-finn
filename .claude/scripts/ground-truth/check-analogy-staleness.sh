#!/usr/bin/env bash
# check-analogy-staleness.sh — Detect stale analogies in analogy-bank.yaml
# Checks each grounded_in path's current content against a stored hash.
# Flags analogies where the grounding code has changed since last check.
#
# Usage: check-analogy-staleness.sh [--json] [--baseline <sha>]
#        --baseline: Compare against a specific commit SHA (default: reads from manifest)
#
# Exit codes:
#   0 = No stale analogies
#   1 = One or more analogies are stale
#   2 = Analogy bank not found or yq unavailable

set -euo pipefail

JSON_OUTPUT=false
BASELINE_SHA=""

for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    --baseline) : ;;  # next arg handled below
    *)
      if [[ "${prev_arg:-}" == "--baseline" ]]; then
        BASELINE_SHA="$arg"
      fi
      ;;
  esac
  prev_arg="$arg"
done

BANK_PATH=".claude/skills/ground-truth/resources/analogies/analogy-bank.yaml"
MANIFEST="grimoires/loa/ground-truth/generation-manifest.json"

if [[ ! -f "$BANK_PATH" ]]; then
  echo '{"error":"Analogy bank not found","path":"'"$BANK_PATH"'"}' >&2
  exit 2
fi

if ! command -v yq &>/dev/null; then
  echo '{"error":"yq is required for analogy bank parsing"}' >&2
  exit 2
fi

# ── Determine baseline SHA ──
if [[ -z "$BASELINE_SHA" && -f "$MANIFEST" ]]; then
  BASELINE_SHA=$(jq -r '.documents[0].head_sha // ""' "$MANIFEST" 2>/dev/null || echo "")
fi

if [[ -z "$BASELINE_SHA" ]]; then
  # No baseline available — can't determine staleness, report clean
  if $JSON_OUTPUT; then
    echo '{"total_analogies":0,"stale_count":0,"stale_analogies":[],"note":"No baseline SHA available"}'
  else
    echo "No baseline SHA available — cannot check staleness"
  fi
  exit 0
fi

# ── Check each analogy's grounded_in paths ──
total_analogies=$(yq '.analogies | length' "$BANK_PATH" 2>/dev/null || echo "0")
stale_count=0
stale_json="["
first_stale=true

for ((i=0; i<total_analogies; i++)); do
  component=$(yq ".analogies[$i].component" "$BANK_PATH" 2>/dev/null)
  domain=$(yq ".analogies[$i].domain" "$BANK_PATH" 2>/dev/null)
  path_count=$(yq ".analogies[$i].grounded_in | length" "$BANK_PATH" 2>/dev/null || echo "0")

  if [[ "$path_count" -eq 0 ]]; then
    continue
  fi

  analogy_stale=false
  changed_paths="["
  first_changed=true

  for ((p=0; p<path_count; p++)); do
    grounded_path=$(yq ".analogies[$i].grounded_in[$p]" "$BANK_PATH" 2>/dev/null)

    if [[ ! -f "$grounded_path" ]]; then
      # File deleted — analogy is stale
      analogy_stale=true
      if ! $first_changed; then changed_paths+=","; fi
      first_changed=false
      changed_paths+="{\"path\":\"$grounded_path\",\"reason\":\"deleted\"}"
      continue
    fi

    # Compare current content with baseline commit
    baseline_hash=$(git rev-parse "$BASELINE_SHA:$grounded_path" 2>/dev/null || echo "missing")
    current_hash=$(git hash-object "$grounded_path" 2>/dev/null || echo "unknown")

    if [[ "$baseline_hash" != "$current_hash" ]]; then
      analogy_stale=true
      if ! $first_changed; then changed_paths+=","; fi
      first_changed=false
      changed_paths+="{\"path\":\"$grounded_path\",\"reason\":\"modified\"}"
    fi
  done

  changed_paths+="]"

  if $analogy_stale; then
    ((stale_count++)) || true
    if ! $first_stale; then stale_json+=","; fi
    first_stale=false

    escaped_component=$(echo "$component" | sed 's/"/\\"/g')
    escaped_domain=$(echo "$domain" | sed 's/"/\\"/g')
    stale_json+="{\"domain\":\"$escaped_domain\",\"component\":\"$escaped_component\",\"changed_files\":$changed_paths}"
  fi
done

stale_json+="]"

if $JSON_OUTPUT; then
  echo "{\"total_analogies\":$total_analogies,\"stale_count\":$stale_count,\"baseline_sha\":\"$BASELINE_SHA\",\"stale_analogies\":$stale_json}" | jq '.' 2>/dev/null || echo "{\"total_analogies\":$total_analogies,\"stale_count\":$stale_count,\"stale_analogies\":$stale_json}"
else
  if [[ $stale_count -eq 0 ]]; then
    echo "No stale analogies found ($total_analogies checked, baseline=$BASELINE_SHA)"
  else
    echo "STALE: $stale_count of $total_analogies analogies need review"
    echo "$stale_json" | jq -r '.[] | "  [\(.domain)] \(.component): \(.changed_files | map(.path) | join(", "))"' 2>/dev/null || echo "$stale_json"
  fi
fi

if [[ $stale_count -gt 0 ]]; then
  exit 1
else
  exit 0
fi
