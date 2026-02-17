---
id: sprint-patterns
type: knowledge-source
format: markdown
tags: [architectural, philosophical]
priority: 15
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Sprint execution patterns and development methodology"
max_age_days: 90
---

# Sprint Patterns

## The Loa Development Cycle

Each development cycle follows a structured 6-phase workflow:

1. **Discovery** (`/plan-and-analyze`) → PRD with codebase grounding
2. **Architecture** (`/architect`) → SDD with technology decisions
3. **Planning** (`/sprint-plan`) → Task breakdown with acceptance criteria
4. **Implementation** (`/implement sprint-N`) → Code with tests
5. **Review** (`/review-sprint sprint-N`) → Acceptance criteria verification
6. **Audit** (`/audit-sprint sprint-N`) → Security gate

## Cross-Model Quality Gates

Every planning document passes through multiple review layers:

### GPT-5.2 Review
- Iterative review with up to 3 iterations
- APPROVED / CHANGES_REQUIRED / DECISION_NEEDED verdicts
- Domain-specific expertise prompt built from PRD

### Flatline Protocol
- Opus + GPT-5.2 adversarial review in parallel
- HIGH_CONSENSUS (>700 both models) → auto-integrate
- DISPUTED (delta >300) → human decision
- BLOCKER (skeptic >700) → must address

## Sprint Sizing Patterns

From 25 cycles and 64 sprints of data:

| Pattern | Tasks | Duration | Example |
|---------|-------|----------|---------|
| Foundation | 8-15 | 2-3 hours | New subsystem types, interfaces, core logic |
| Integration | 5-10 | 1-2 hours | Wiring components, config, server registration |
| Hardening | 5-8 | 1-2 hours | BridgeBuilder findings, edge cases, error handling |
| Infrastructure | 6-9 | 1-2 hours | Terraform, Docker, CI/CD, scripts |
| Content | 7-10 | 1-2 hours | Knowledge sources, documentation, test fixtures |

## The BridgeBuilder Loop

After implementation, the BridgeBuilder provides iterative review:

1. **Initial Review**: Analyze PR diff, identify findings (HIGH/MEDIUM/LOW)
2. **Fix Cycle**: Implement fixes, commit
3. **Re-Review**: BridgeBuilder checks fixes, may find new issues
4. **Convergence**: Score reaches ≥0.95 (FLATLINE), no new findings

Typical convergence: 2-3 iterations, 10-30 findings per cycle.

## Common Anti-Patterns (Learned)

1. **Over-engineering**: Adding abstractions for one-time operations
2. **Premature optimization**: Designing for hypothetical future requirements
3. **SDD drift**: Implementation diverging from SDD without updating the doc
4. **Test theater**: Tests that pass but don't verify actual behavior
5. **Backward-compatibility hacks**: Keeping dead code "just in case"

## Naming Convention

Commit messages follow conventional commits:
```
feat(sprint-N): <description>     # New feature
fix(sprint-N): <description>      # Bug fix
chore(sprint-N): <description>    # Maintenance
```

Sprint identifiers: `sprint-{N}` (local) → `sprint-{global_id}` (ledger).
