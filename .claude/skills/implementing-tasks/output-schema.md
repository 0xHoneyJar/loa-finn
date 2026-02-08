# Output Schema: Implementation Report

## Expected Format

```markdown
# Implementation Report: [Sprint Title]

## Summary

[2-3 sentences: what was implemented, key decisions made, overall status]

## Test Suite Overview

| Category | Count | Pass | Fail |
|----------|-------|------|------|
| Unit Tests | N | N | 0 |
| Integration Tests | N | N | 0 |
| Total | N | N | 0 |

## Task-by-Task Implementation

### Task [ID]: [Task Title]

**Status**: Complete | Partial | Blocked

**What was done**:
- [Bullet points of implementation details]

**Acceptance Criteria**:
- [x] [Criterion met]
- [ ] [Criterion not met — reason]

**Tests Added**:
- `tests/file.test.ts` — [description of test cases]

[Repeat for each task]

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/file.ts` | Modified | [What changed and why] |
| `tests/file.test.ts` | Created | [Test coverage added] |

## Known Limitations

- [Any limitations, deferred work, or edge cases not covered]
```

## Constraints

- Every task must have a clear status
- All acceptance criteria must be checked off or explained
- Files Changed table must be exhaustive
- Known Limitations section is required even if empty ("None identified")
