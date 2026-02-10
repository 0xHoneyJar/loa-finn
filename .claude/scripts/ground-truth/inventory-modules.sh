#!/usr/bin/env bash
# inventory-modules.sh — Enumerate src/ modules and cross-reference with registries
#
# Usage: inventory-modules.sh [--src <dir>] [--features <file>] [--limitations <file>] [--json]
#        inventory-modules.sh --list-modules
#
# Exit codes:
#   0 = Success

set -euo pipefail

SRC_DIR="src"
FEATURES="grimoires/loa/ground-truth/features.yaml"
LIMITATIONS="grimoires/loa/ground-truth/limitations.yaml"
JSON_OUTPUT=false
LIST_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC_DIR="$2"; shift 2 ;;
    --features) FEATURES="$2"; shift 2 ;;
    --limitations) LIMITATIONS="$2"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    --list-modules) LIST_ONLY=true; shift ;;
    *) shift ;;
  esac
done

if [[ ! -d "$SRC_DIR" ]]; then
  echo "ERROR: Source directory not found: $SRC_DIR" >&2
  exit 1
fi

# ── List top-level modules ──
modules=()
while IFS= read -r dir; do
  [[ -z "$dir" ]] && continue
  modules+=("$dir")
done < <(find "$SRC_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

if $LIST_ONLY; then
  for mod in "${modules[@]}"; do
    echo "$mod"
  done
  exit 0
fi

# ── Build feature lookup from features.yaml ──
# Maps module_path → feature_id(s)
declare -A module_to_features
declare -A feature_status
declare -A feature_category

if [[ -f "$FEATURES" ]]; then
  feat_count=$(yq '.features | length' "$FEATURES" 2>/dev/null || echo "0")
  for ((i=0; i<feat_count; i++)); do
    fid=$(yq ".features[$i].id" "$FEATURES" 2>/dev/null)
    fstatus=$(yq ".features[$i].status" "$FEATURES" 2>/dev/null)
    fcategory=$(yq ".features[$i].category" "$FEATURES" 2>/dev/null)
    feature_status["$fid"]="$fstatus"
    feature_category["$fid"]="$fcategory"

    mod_count=$(yq ".features[$i].modules | length" "$FEATURES" 2>/dev/null || echo "0")
    for ((j=0; j<mod_count; j++)); do
      mod_path=$(yq ".features[$i].modules[$j]" "$FEATURES" 2>/dev/null)
      # Map both the exact path and its parent directory
      if [[ -n "${module_to_features[$mod_path]:-}" ]]; then
        module_to_features["$mod_path"]="${module_to_features[$mod_path]},$fid"
      else
        module_to_features["$mod_path"]="$fid"
      fi
    done
  done
fi

# ── Build inventory ──
inventory_json="["
first=true

for mod_dir in "${modules[@]}"; do
  mod_name=$(basename "$mod_dir")

  # Find primary entry point
  entry_point=""
  for candidate in "$mod_dir/index.ts" "$mod_dir/index.js" "$mod_dir/entry.ts" "$mod_dir/main.ts"; do
    if [[ -f "$candidate" ]]; then
      entry_point="$candidate"
      break
    fi
  done

  # Extract imports from entry point
  deps="[]"
  if [[ -n "$entry_point" && -f "$entry_point" ]]; then
    dep_list=$(grep -oE "from ['\"]([^'\"]+)['\"]" "$entry_point" 2>/dev/null | sed "s/from ['\"]//;s/['\"]//" | sort -u | head -20)
    deps="["
    dep_first=true
    while IFS= read -r dep; do
      [[ -z "$dep" ]] && continue
      if ! $dep_first; then deps+=","; fi
      dep_first=false
      deps+="\"$dep\""
    done <<< "$dep_list"
    deps+="]"
  fi

  # Cross-reference with features.yaml
  matched_features="[]"
  matched_status="unknown"
  matched_category="unknown"

  # Check module directory path and common patterns
  for check_path in "$mod_dir" "$mod_dir/index.ts" "$mod_dir/entry.ts"; do
    if [[ -n "${module_to_features[$check_path]:-}" ]]; then
      IFS=',' read -ra fids <<< "${module_to_features[$check_path]}"
      matched_features="["
      mf_first=true
      for fid in "${fids[@]}"; do
        if ! $mf_first; then matched_features+=","; fi
        mf_first=false
        matched_features+="\"$fid\""
        matched_status="${feature_status[$fid]:-unknown}"
        matched_category="${feature_category[$fid]:-unknown}"
      done
      matched_features+="]"
      break
    fi
  done

  # Emit warning for unmatched modules
  if [[ "$matched_features" == "[]" ]]; then
    echo "WARNING: Module $mod_dir not found in features.yaml" >&2
  fi

  if ! $first; then inventory_json+=","; fi
  first=false
  inventory_json+='{"module_path":"'"$mod_dir"'","module_name":"'"$mod_name"'","entry_point":"'"${entry_point:-none}"'","feature_ids":'"$matched_features"',"status":"'"$matched_status"'","category":"'"$matched_category"'","dependencies":'"$deps"'}'
done

inventory_json+="]"

if $JSON_OUTPUT; then
  echo '{"modules":'"$inventory_json"',"total":'"${#modules[@]}"'}'
else
  echo "Inventory: ${#modules[@]} modules found"
  echo "$inventory_json" | jq -r '.[] | "  \(.module_path) → \(.feature_ids | join(", ")) [\(.status)]"' 2>/dev/null || echo "$inventory_json"
fi

exit 0
