# Output Schema: Product Requirements Document

## Expected Format

```markdown
# PRD: [Feature/Project Name]

## Executive Summary

[2-3 sentences: what problem is being solved and for whom]

## Problem Statement

[Detailed description of the problem, who it affects, and current pain points]

## Goals & Non-Goals

**Goals**:
- [What this project WILL accomplish]

**Non-Goals**:
- [What this project explicitly WILL NOT do]

## User Stories

- As a [role], I want to [action] so that [benefit]

## Functional Requirements

| ID | Requirement | Priority | Acceptance Criteria |
|----|-------------|----------|-------------------|
| FR-1 | [Description] | Must/Should/Could | [Testable criteria] |

## Non-Functional Requirements

| ID | Category | Requirement | Target |
|----|----------|-------------|--------|
| NFR-1 | Performance | [Description] | [Measurable target] |

## Success Metrics

- [Metric 1: how we measure success]
- [Metric 2: how we measure success]

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| [Description] | Low/Medium/High | Low/Medium/High | [Strategy] |
```

## Constraints

- All functional requirements must have a priority level
- Acceptance criteria must be testable/verifiable
- Non-Goals section is mandatory to prevent scope creep
- Risks table is required even if risks are low
