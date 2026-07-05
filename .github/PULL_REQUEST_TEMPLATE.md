## Summary

Brief description of what this PR does.

## Related Issues

Closes #(issue number)

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] CI/Infrastructure change

## Changes Made

- Change 1
- Change 2
- Change 3

## Testing

Describe how you tested these changes:

- [ ] Tested with Claude Code locally
- [ ] Ran relevant commands (`/setup`, `/plan-and-analyze`, etc.)
- [ ] Added/updated tests
- [ ] All existing tests pass

## Checklist

- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have made corresponding changes to documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix/feature works
- [ ] New and existing tests pass locally

## Admin / status route changes (if applicable)

If this PR touches `src/gateway/routes/admin.ts` or gateway health/status routes, include the evidence below (#209, #212):

- [ ] Test output for admin auth, rate limiting, audit-first behavior, and invalid-input bounds (`npx vitest run tests/finn/gateway/admin-routes.test.ts`)
- [ ] Test output for health/status route status codes and response shapes (`npx vitest run tests/finn/gateway/health.test.ts`)
- [ ] `docs/gateway-health.md` / `docs/gateway-admin-seed-credits-policy.md` updated if behavior changed

## Documentation

- [ ] README.md updated (if applicable)
- [ ] CLAUDE.md updated (if applicable)
- [ ] PROCESS.md updated (if applicable)
- [ ] CHANGELOG.md updated (maintainers will review)

## Screenshots (if applicable)

Add screenshots to help explain your changes.

## Additional Notes

Any additional information reviewers should know.
