# Output Schema: Code Review

## Expected Format

```markdown
# Code Review: [Sprint/PR Title]

## Review Summary

[1-2 sentences: overall assessment and verdict preview]

## Task-by-Task Verification

### Task [ID]: [Task Title]

**Status**: VERIFIED | ISSUES

**Acceptance Criteria**:
- [x] [Criterion 1] — verified at `src/file.ts:42`
- [ ] [Criterion 2] — ISSUE: [description]

**Issues** (if any):
- **[SEVERITY]** `file.ts:42` — [Description of issue]
  ```diff
  - current code
  + suggested fix
  ```

[Repeat for each task]

## Architecture Quality

- [Observation about patterns, structure, consistency]

## Non-Blocking Observations

- [Style suggestions, minor improvements — not required for merge]

## Verdict

| Category | Status |
|----------|--------|
| Correctness | PASS/FAIL |
| Security | PASS/FAIL |
| Tests | PASS/FAIL |
| Architecture | PASS/FAIL |

**Final Verdict**: All good | Changes required — [summary of blocking issues]
```

## Constraints

- Every ISSUES status must include specific file:line references
- Suggested fixes must be concrete code, not vague descriptions
- Non-blocking observations are clearly separated from blocking issues
