#!/usr/bin/env bats
# cycle-122: post-compaction ACTIVE-skill re-surfacing (marker -> reminder).

setup() {
    BATS_TEST_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)"
    PROJECT_ROOT_REAL="$(cd "$BATS_TEST_DIR/../.." && pwd)"
    MARKER="$PROJECT_ROOT_REAL/.claude/hooks/pre-compact-marker.sh"
    REMINDER="$PROJECT_ROOT_REAL/.claude/hooks/post-compact-reminder.sh"
    FIX="$(mktemp -d "$BATS_TMPDIR/pca-XXXXXX")"; mkdir -p "$FIX/.run"
}
teardown() { rm -rf "$FIX"; }

run_pair() {  # writes marker then captures reminder output
    (cd "$FIX" && PROJECT_ROOT="$FIX" bash "$MARKER")
    (cd "$FIX" && PROJECT_ROOT="$FIX" printf '{}' | bash "$REMINDER" 2>&1)
}

@test "active-skill: RUNNING sprint-plan surfaces run-mode SKILL.md" {
    jq -n '{state:"RUNNING"}' > "$FIX/.run/sprint-plan-state.json"
    out="$(run_pair)"
    [[ "$out" == *"Step 1b"* ]]
    [[ "$out" == *".claude/skills/run-mode/SKILL.md"* ]]
}

@test "active-skill: ITERATING bridge surfaces run-bridge SKILL.md" {
    jq -n '{state:"ITERATING"}' > "$FIX/.run/bridge-state.json"
    out="$(run_pair)"
    [[ "$out" == *".claude/skills/run-bridge/SKILL.md"* ]]
}

@test "active-skill: simstim mid-phase wins precedence over run-mode" {
    jq -n '{state:"RUNNING"}' > "$FIX/.run/sprint-plan-state.json"
    jq -n '{phase:"IMPLEMENT"}' > "$FIX/.run/simstim-state.json"
    out="$(run_pair)"
    [[ "$out" == *".claude/skills/simstim-workflow/SKILL.md"* ]]
}

@test "active-skill: no active flow -> no Step 1b (unchanged behavior)" {
    out="$(run_pair)"
    [[ "$out" != *"Step 1b"* ]]
}

@test "active-skill: malformed marker fails open (reminder still renders)" {
    jq -n '{state:"RUNNING"}' > "$FIX/.run/sprint-plan-state.json"
    (cd "$FIX" && PROJECT_ROOT="$FIX" bash "$MARKER")
    echo "NOT-JSON{{" > "$FIX/.run/compact-pending"
    out="$(cd "$FIX" && PROJECT_ROOT="$FIX" printf '{}' | bash "$REMINDER" 2>&1)"
    [[ "$out" == *"RECOVERY REQUIRED"* ]]
    [[ "$out" != *"Step 1b"* ]]
}

@test "active-skill: stale lowercase-complete simstim does NOT shadow an active bridge (dissenter r2)" {
    jq -n '{phase:"complete"}' > "$FIX/.run/simstim-state.json"
    jq -n '{state:"PREFLIGHT"}' > "$FIX/.run/bridge-state.json"
    out="$(run_pair)"
    [[ "$out" == *".claude/skills/run-bridge/SKILL.md"* ]]
}

@test "active-skill: bridge PREFLIGHT counts as active (dissenter r2)" {
    jq -n '{state:"PREFLIGHT"}' > "$FIX/.run/bridge-state.json"
    out="$(run_pair)"
    [[ "$out" == *".claude/skills/run-bridge/SKILL.md"* ]]
}

@test "active-skill: READY_FOR_HITL run-mode is terminal (no Step 1b)" {
    jq -n '{state:"READY_FOR_HITL"}' > "$FIX/.run/sprint-plan-state.json"
    out="$(run_pair)"
    [[ "$out" != *"Step 1b"* ]]
}
