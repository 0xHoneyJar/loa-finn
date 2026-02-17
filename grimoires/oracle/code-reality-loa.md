---
id: code-reality-loa
type: knowledge-source
format: markdown
tags: [technical, architectural]
priority: 11
provenance:
  source_repo: 0xHoneyJar/loa
  generated_date: "2026-02-17"
  description: "Loa framework code reality — agent-driven development CLI"
max_age_days: 30
---

# Code Reality: Loa Framework

## Overview

Loa is an agent-driven development framework built as a Claude Code extension. It provides structured workflows for planning, implementing, reviewing, and deploying software through AI agents.

## Key Components

### Skill System (`skills/`)

Skills are the primary abstraction — each skill is a self-contained workflow with its own `SKILL.md` instruction file:

- **plan-and-analyze** → PRD creation with codebase grounding
- **architect** → SDD creation from PRD
- **sprint-plan** → Task breakdown with acceptance criteria
- **implement** → Code generation with test-first approach
- **review-sprint** → Code review against acceptance criteria
- **audit-sprint** → Security audit (final gate)

### Three-Zone Model

| Zone | Path | Permission |
|------|------|------------|
| System | `.claude/` | NEVER edit (framework-managed) |
| State | `grimoires/`, `.beads/`, `.run/` | Read/Write |
| App | `src/`, `lib/`, `app/` | Confirm writes |

### Sprint Ledger (`grimoires/loa/ledger.json`)

Global sprint numbering across development cycles. Each cycle has:
- `local_id`: Sprint number within cycle (sprint-1, sprint-2, ...)
- `global_id`: Monotonically increasing across all cycles
- `status`: pending → in_progress → completed | superseded

### Run Mode (`.run/`)

Autonomous execution engine:
- `sprint-plan-state.json` — tracks multi-sprint execution
- `simstim-state.json` — HITL workflow state
- `bridge-state.json` — iterative improvement loop

### Flatline Protocol

Multi-model adversarial review (Opus + GPT-5.2):
- HIGH_CONSENSUS findings auto-integrate
- DISPUTED findings logged for human review
- BLOCKER findings halt autonomous workflows

### Hooks System (`.claude/hooks/`)

Pre/PostToolUse event handlers for safety:
- `block-destructive-bash.sh` — prevents rm -rf, force-push
- `mutation-logger.sh` — audit trail for file changes
- `run-mode-stop-guard.sh` — prevents premature exit

## Framework Architecture

```
.claude/
├── loa/           # Framework instructions (CLAUDE.loa.md)
├── hooks/         # Safety hooks
├── protocols/     # Behavioral protocols
├── scripts/       # Utility scripts
├── skills/        # Skill definitions (SKILL.md per skill)
├── data/          # Constraints, templates
└── lib/           # Shared TypeScript libraries
```

## Key Interfaces

### Configuration (`.loa.config.yaml`)

```yaml
run_mode:
  enabled: true
  defaults:
    max_cycles: 20
    timeout_hours: 8

flatline_protocol:
  enabled: true
  auto_trigger: true

gpt_review:
  enabled: true
```

### Beads Integration

Task lifecycle management via `beads_rust` CLI:
- `br sync --import-only` — import state
- `br ready` — find unblocked tasks
- `br update <id> --status in_progress` — claim task
- `br close <id>` — complete task
