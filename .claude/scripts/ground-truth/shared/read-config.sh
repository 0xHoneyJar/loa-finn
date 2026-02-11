#!/usr/bin/env bash
# read-config.sh — Shared config reader for Ground Truth scripts
# Reads values from .loa.config.yaml with yq v4+ when available,
# falls back to grep/awk for simple key paths.
#
# Usage: source this file, then call read_config "key.path" "default"
#
# API:
#   read_config "ground_truth.provenance.thresholds.high" "0.90"
#   → Returns the value from config, or the default if unavailable
#
# Detection: Uses yq (mikefarah/yq v4+) when available.
# Fallback: Returns default value silently when:
#   - Config file missing
#   - yq unavailable
#   - Key not found

_READ_CONFIG_FILE="${LOA_CONFIG_FILE:-.loa.config.yaml}"
_READ_CONFIG_YQ_AVAILABLE=""

# Check yq availability once on source
_check_yq() {
  if [[ -n "$_READ_CONFIG_YQ_AVAILABLE" ]]; then
    return
  fi
  if command -v yq >/dev/null 2>&1; then
    if yq --version 2>&1 | grep -q 'v4\|version v4\|version 4'; then
      _READ_CONFIG_YQ_AVAILABLE="yes"
    else
      _READ_CONFIG_YQ_AVAILABLE="no"
    fi
  else
    _READ_CONFIG_YQ_AVAILABLE="no"
  fi
}

# read_config "dotted.key.path" "default_value"
read_config() {
  local key_path="${1:-}"
  local default_value="${2:-}"

  if [[ -z "$key_path" ]]; then
    echo "$default_value"
    return
  fi

  if [[ ! -f "$_READ_CONFIG_FILE" ]]; then
    echo "$default_value"
    return
  fi

  _check_yq

  if [[ "$_READ_CONFIG_YQ_AVAILABLE" == "yes" ]]; then
    # Convert dotted path to yq path: ground_truth.provenance.thresholds.high → .ground_truth.provenance.thresholds.high
    local yq_path=".${key_path}"
    local result
    result=$(yq "$yq_path" "$_READ_CONFIG_FILE" 2>/dev/null || echo "")
    if [[ -n "$result" && "$result" != "null" ]]; then
      echo "$result"
    else
      echo "$default_value"
    fi
  else
    # Fallback: simple grep/awk for flat keys (last segment of dotted path)
    # This only works for simple key: value pairs, not nested structures
    local leaf_key="${key_path##*.}"
    local result
    result=$(grep -E "^[[:space:]]*${leaf_key}:" "$_READ_CONFIG_FILE" 2>/dev/null | head -1 | sed 's/^[^:]*:[[:space:]]*//' | sed 's/[[:space:]]*#.*//' | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/")
    if [[ -n "$result" ]]; then
      echo "$result"
    else
      echo "$default_value"
    fi
  fi
}
