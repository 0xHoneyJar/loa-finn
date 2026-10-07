#!/usr/bin/env bash
# pre-compact-marker.sh - Write marker with context for post-compact recovery
#
# This hook runs before context compaction and creates a marker file
# that the post-compact-reminder hook will detect to inject recovery
# instructions into Claude's context.
#
# Usage: Called automatically via Claude Code hooks
#
# Exit code is always 0 to never block compaction

set -uo pipefail

# Global marker location (fallback)
MARKER_DIR="${HOME}/.local/state/loa-compact"
GLOBAL_MARKER="${MARKER_DIR}/compact-pending"

# Project-local marker (preferred)
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
PROJECT_MARKER="${PROJECT_ROOT}/.run/compact-pending"

# Ensure directories exist
mkdir -p "$MARKER_DIR" 2>/dev/null || true
mkdir -p "$(dirname "$PROJECT_MARKER")" 2>/dev/null || true

# Detect active run mode
run_mode_active="false"
run_mode_state=""
if [[ -f "${PROJECT_ROOT}/.run/sprint-plan-state.json" ]]; then
    run_mode_active="true"
    run_mode_state=$(jq -r '.state // "unknown"' "${PROJECT_ROOT}/.run/sprint-plan-state.json" 2>/dev/null) || run_mode_state="unknown"
fi

# Detect active simstim
simstim_active="false"
simstim_phase=""
if [[ -f "${PROJECT_ROOT}/.run/simstim-state.json" ]]; then
    simstim_active="true"
    simstim_phase=$(jq -r '.phase // "unknown"' "${PROJECT_ROOT}/.run/simstim-state.json" 2>/dev/null) || simstim_phase="unknown"
fi

# Detect active bridge
bridge_active="false"
bridge_state=""
if [[ -f "${PROJECT_ROOT}/.run/bridge-state.json" ]]; then
    bridge_active="true"
    bridge_state=$(jq -r '.state // "unknown"' "${PROJECT_ROOT}/.run/bridge-state.json" 2>/dev/null) || bridge_state="unknown"
fi

# cycle-122: derive the ACTIVE skill doc so post-compact recovery re-reads the
# skill contract that was mid-flight (point-of-use constraints survive
# compaction; CLAUDE.md alone was the only re-read before).
# Terminal sets mirror run-mode-stop-guard's gates (case-folded): a state is
# ACTIVE iff it is non-empty and not terminal. Bridge/simstim intermediate
# phases (PREFLIGHT, JACK_IN, iterating, etc.) all count as active.
_pcm_is_active() {  # $1=value  $2=space-separated terminal set (lowercase)
    local v="${1,,}" t
    [[ -n "$v" && "$v" != "unknown" ]] || return 1
    for t in $2; do [[ "$v" == "$t" ]] && return 1; done
    return 0
}
active_skill_doc=""
if [[ "$simstim_active" == "true" ]] && _pcm_is_active "$simstim_phase" "completed complete awaiting_hitl halted jacked_out"; then
    active_skill_doc=".claude/skills/simstim-workflow/SKILL.md"
elif [[ "$bridge_active" == "true" ]] && _pcm_is_active "$bridge_state" "jacked_out halted complete completed"; then
    active_skill_doc=".claude/skills/run-bridge/SKILL.md"
elif _pcm_is_active "$run_mode_state" "jacked_out halted complete completed ready_for_hitl"; then
    active_skill_doc=".claude/skills/run-mode/SKILL.md"
fi

# CI-013: Use jq for safe JSON construction instead of unquoted heredoc
CONTEXT=$(jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg project_root "$PROJECT_ROOT" \
  --argjson run_active "$run_mode_active" \
  --arg run_state "$run_mode_state" \
  --argjson sim_active "$simstim_active" \
  --arg sim_phase "$simstim_phase" \
  --argjson bridge_active "$bridge_active" \
  --arg bridge_state "$bridge_state" \
  --arg active_skill_doc "$active_skill_doc" \
  --arg skill "${LOA_CURRENT_SKILL:-unknown}" \
  --arg phase "${LOA_CURRENT_PHASE:-unknown}" \
  --arg task "${LOA_CURRENT_TASK:-unknown}" \
  '{
    timestamp: $ts,
    project_root: $project_root,
    run_mode: { active: $run_active, state: $run_state },
    simstim: { active: $sim_active, phase: $sim_phase },
    bridge: { active: $bridge_active, state: $bridge_state },
    active_skill_doc: $active_skill_doc,
    current_skill: $skill,
    current_phase: $phase,
    current_task: $task
  }' 2>/dev/null) || CONTEXT="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"error\":\"jq_unavailable\"}"

# Write markers (both locations for reliability)
echo "$CONTEXT" > "$GLOBAL_MARKER" 2>/dev/null || true
echo "$CONTEXT" > "$PROJECT_MARKER" 2>/dev/null || true

# Always exit 0 - never block compaction
exit 0
