#!/usr/bin/env bash
# check-agent-context.sh — Validate AGENT-CONTEXT blocks in Ground Truth documents
# Parses HTML comment AGENT-CONTEXT blocks and validates all 7 fields per SDD §4.2.
#
# Usage: check-agent-context.sh <document-path> [--json]
#
# Exit codes:
#   0 = Valid AGENT-CONTEXT block
#   1 = Validation failures found
#   2 = Input file not found or no AGENT-CONTEXT block

set -euo pipefail

DOC_PATH="${1:-}"
JSON_OUTPUT=false

for arg in "$@"; do
  if [[ "$arg" == "--json" ]]; then
    JSON_OUTPUT=true
  fi
done

if [[ -z "$DOC_PATH" || ! -f "$DOC_PATH" ]]; then
  if $JSON_OUTPUT; then
    jq -nc --arg file "${DOC_PATH:-}" '{"error":"Document not found","file":$file}'
  else
    echo "ERROR: Document path required and must exist: ${DOC_PATH:-<none>}" >&2
  fi
  exit 2
fi

# ── Extract AGENT-CONTEXT block ──
# Format: <!-- AGENT-CONTEXT: name=..., type=..., purpose=..., key_files=..., ... -->
context_block=$(grep -oP '<!--\s*AGENT-CONTEXT:.*?-->' "$DOC_PATH" 2>/dev/null | head -1 || true)

if [[ -z "$context_block" ]]; then
  # Try multiline extraction
  context_block=$(awk '/<!--\s*AGENT-CONTEXT:/,/-->/' "$DOC_PATH" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' || true)
fi

if [[ -z "$context_block" ]]; then
  if $JSON_OUTPUT; then
    jq -nc --arg file "$DOC_PATH" '{"file":$file,"valid":false,"violations":[{"field":"AGENT-CONTEXT","message":"No AGENT-CONTEXT block found","severity":"error"}]}'
  else
    echo "FAIL: No AGENT-CONTEXT block found in $DOC_PATH" >&2
  fi
  exit 1
fi

# ── Parse fields ──
# Known field names for boundary detection (v1 + v2 optional fields)
KNOWN_FIELDS="name|type|purpose|key_files|interfaces|dependencies|version|priority_files|trust_level|model_hints"

extract_field() {
  local field="$1"
  # Match field=VALUE, stopping at the next known field assignment or -->
  echo "$context_block" | grep -oP "${field}=\K[^,]*?(?=,\s*(?:${KNOWN_FIELDS})=|-->)" | head -1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

extract_list_field() {
  local field="$1"
  # Match field=[values] or field=values, stopping at next known field or -->
  local raw
  raw=$(echo "$context_block" | grep -oP "${field}=\[?\K.*?(?=\]\s*,\s*(?:${KNOWN_FIELDS})=|\]\s*-->|,\s*(?:${KNOWN_FIELDS})=|-->)" | head -1 || true)
  echo "$raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

name=$(extract_field "name")
type=$(extract_field "type")
purpose=$(extract_field "purpose")
key_files=$(extract_list_field "key_files")
interfaces=$(extract_list_field "interfaces")
dependencies=$(extract_list_field "dependencies")
version=$(extract_field "version")

# v2 optional fields
priority_files=$(extract_list_field "priority_files")
trust_level=$(extract_field "trust_level")
model_hints=$(extract_list_field "model_hints")

# ── Validate fields ──
violations="["
first=true
add_violation() {
  local field="$1" message="$2" severity="${3:-error}"
  if ! $first; then violations+=","; fi
  first=false
  violations+='{"field":"'"$field"'","message":'"$(echo "$message" | jq -Rs .)"',"severity":"'"$severity"'"}'
}

# Required: name (non-empty, matches document subject)
if [[ -z "$name" ]]; then
  add_violation "name" "Required field 'name' is missing or empty"
fi

# Required: type (one of: overview, module, api, operations, security)
valid_types="overview module api operations security"
if [[ -z "$type" ]]; then
  add_violation "type" "Required field 'type' is missing or empty"
elif ! echo "$valid_types" | grep -qw "$type"; then
  add_violation "type" "Invalid type '$type' — must be one of: $valid_types"
fi

# Required: purpose (single sentence, ≤30 words)
if [[ -z "$purpose" ]]; then
  add_violation "purpose" "Required field 'purpose' is missing or empty"
else
  word_count=$(echo "$purpose" | wc -w)
  if [[ $word_count -gt 30 ]]; then
    add_violation "purpose" "Purpose exceeds 30-word limit (has $word_count words)" "warning"
  fi
fi

# Required: key_files (each must exist in repo)
if [[ -z "$key_files" ]]; then
  add_violation "key_files" "Required field 'key_files' is missing or empty"
else
  IFS=',' read -ra files <<< "$key_files"
  for file in "${files[@]}"; do
    file=$(echo "$file" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$file" ]] && continue
    if ! git ls-files --error-unmatch "$file" &>/dev/null; then
      add_violation "key_files" "File not found in repo: $file"
    fi
  done
fi

# Optional: interfaces (grep-based validation against key_files)
if [[ -n "$interfaces" ]]; then
  IFS=',' read -ra ifaces <<< "$interfaces"
  IFS=',' read -ra files <<< "$key_files"
  for iface in "${ifaces[@]}"; do
    iface=$(echo "$iface" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$iface" ]] && continue
    found=false
    for file in "${files[@]}"; do
      file=$(echo "$file" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      [[ -z "$file" || ! -f "$file" ]] && continue
      if grep -qw "$iface" "$file" 2>/dev/null; then
        found=true
        break
      fi
    done
    if ! $found; then
      add_violation "interfaces" "Interface '$iface' not found (grep -w) in any key_files entry" "warning"
    fi
  done
fi

# Optional: dependencies (informational, no hard validation)

# Required: version (40 hex chars — git commit hash)
if [[ -z "$version" ]]; then
  add_violation "version" "Required field 'version' is missing or empty"
elif ! echo "$version" | grep -qE '^[0-9a-f]{40}$'; then
  add_violation "version" "Version '$version' is not a valid 40-char git commit hash"
fi

# ── v2 Optional fields (non-breaking: missing fields produce no error) ──

# Optional v2: priority_files (must be subset of key_files)
if [[ -n "$priority_files" && -n "$key_files" ]]; then
  IFS=',' read -ra pf_arr <<< "$priority_files"
  for pf in "${pf_arr[@]}"; do
    pf=$(echo "$pf" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$pf" ]] && continue
    if ! echo ",$key_files," | grep -qF ",$pf,"; then
      # Try with spaces trimmed
      found_in_kf=false
      IFS=',' read -ra kf_check <<< "$key_files"
      for kfc in "${kf_check[@]}"; do
        kfc=$(echo "$kfc" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        if [[ "$kfc" == "$pf" ]]; then
          found_in_kf=true
          break
        fi
      done
      if ! $found_in_kf; then
        add_violation "priority_files" "priority_files entry '$pf' not found in key_files" "warning"
      fi
    fi
  done
fi

# Optional v2: trust_level (must be high, medium, or low)
if [[ -n "$trust_level" ]]; then
  valid_levels="high medium low"
  if ! echo "$valid_levels" | grep -qw "$trust_level"; then
    add_violation "trust_level" "Invalid trust_level '$trust_level' — must be one of: $valid_levels" "warning"
  fi
fi

# Optional v2: model_hints (entries from known set)
if [[ -n "$model_hints" ]]; then
  valid_hints="reasoning code review fast summary"
  IFS=',' read -ra hint_arr <<< "$model_hints"
  for hint in "${hint_arr[@]}"; do
    hint=$(echo "$hint" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$hint" ]] && continue
    if ! echo "$valid_hints" | grep -qw "$hint"; then
      add_violation "model_hints" "Unknown model_hint '$hint' — known values: $valid_hints" "warning"
    fi
  done
fi

violations+="]"

# ── Token count check (≤200 tokens, approximate as word count) ──
token_estimate=$(echo "$context_block" | wc -w)
if [[ $token_estimate -gt 200 ]]; then
  # Re-open violations array to add
  violations="${violations%]}"
  if [[ "$violations" != "[" ]]; then violations+=","; fi
  violations+='{"field":"token_count","message":"AGENT-CONTEXT block exceeds 200-token estimate (approx '"$token_estimate"' words)","severity":"warning"}'
  violations+="]"
fi

# ── Count errors vs warnings ──
error_count=$(echo "$violations" | jq '[.[] | select(.severity == "error")] | length' 2>/dev/null || echo "0")
warning_count=$(echo "$violations" | jq '[.[] | select(.severity == "warning")] | length' 2>/dev/null || echo "0")
valid=true
if [[ "$error_count" -gt 0 ]]; then
  valid=false
fi

# ── Output ──
if $JSON_OUTPUT; then
  jq -nc \
    --arg file "$DOC_PATH" \
    --argjson valid "$valid" \
    --argjson errors "$error_count" \
    --argjson warnings "$warning_count" \
    --argjson violations "$violations" \
    --arg name "$name" \
    --arg type "$type" \
    --arg purpose "$purpose" \
    --arg key_files "$key_files" \
    --arg version "$version" \
    '{file: $file, valid: $valid, errors: $errors, warnings: $warnings, violations: $violations, fields: {name: $name, type: $type, purpose: $purpose, key_files: $key_files, version: $version}}'
else
  if $valid; then
    echo "PASS: AGENT-CONTEXT block valid ($warning_count warnings)"
  else
    echo "FAIL: AGENT-CONTEXT block has $error_count error(s), $warning_count warning(s)"
    echo "$violations" | jq -r '.[] | "  [\(.severity)] \(.field): \(.message)"' 2>/dev/null || echo "  $violations"
  fi
fi

if $valid; then
  exit 0
else
  exit 1
fi
