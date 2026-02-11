# Output Schema: Sprint Plan

## Expected Format

```markdown
# Sprint Plan: [Feature/Project Name]

## Sprint Overview

| Sprint | Theme | Tasks | Estimated Complexity |
|--------|-------|-------|---------------------|
| Sprint 1 | [Theme] | N | Small/Medium/Large |
| Sprint 2 | [Theme] | N | Small/Medium/Large |

## Sprint 1: [Theme]

### S1-T1: [Task Title]

**Complexity**: Small | Medium | Large
**Dependencies**: None | [Task IDs]
**Assigned to**: AI Engineer

**Acceptance Criteria**:
- [ ] [Testable criterion 1]
- [ ] [Testable criterion 2]
- [ ] [Testable criterion 3]

[Repeat for each task]

### Risk Mitigation

- **Risk**: [Description] — **Mitigation**: [Strategy]

[Repeat for each sprint]

## Sprint Dependencies

Sprint 1 --> Sprint 2 --> Sprint 3
```

## Constraints

- Task IDs must be unique and follow `S{sprint}-T{task}` format
- Every task must have at least 2 acceptance criteria
- Dependencies must reference valid task IDs
- Each sprint should have a Risk Mitigation section
- Sprint Overview table is required as the first section
