# Output Schema: Security Audit

## Expected Format

```markdown
# Security Audit: [Component/Feature Name]

## Audit Scope

- **Files reviewed**: [list of files]
- **Focus areas**: [what was specifically examined]
- **Commit range**: [if applicable]

## OWASP Top 10 Assessment

| # | Category | Status | Notes |
|---|----------|--------|-------|
| A01 | Broken Access Control | PASS/FAIL/N/A | [Brief justification] |
| A02 | Cryptographic Failures | PASS/FAIL/N/A | [Brief justification] |
| A03 | Injection | PASS/FAIL/N/A | [Brief justification] |
| A04 | Insecure Design | PASS/FAIL/N/A | [Brief justification] |
| A05 | Security Misconfiguration | PASS/FAIL/N/A | [Brief justification] |
| A06 | Vulnerable Components | PASS/FAIL/N/A | [Brief justification] |
| A07 | Auth Failures | PASS/FAIL/N/A | [Brief justification] |
| A08 | Data Integrity Failures | PASS/FAIL/N/A | [Brief justification] |
| A09 | Logging Failures | PASS/FAIL/N/A | [Brief justification] |
| A10 | SSRF | PASS/FAIL/N/A | [Brief justification] |

## Findings

| # | Severity | File | Description | Status |
|---|----------|------|-------------|--------|
| 1 | CRITICAL/HIGH/MEDIUM/LOW | `file:line` | [Description + attack vector] | OPEN/FIXED |

## Verdict Summary

| Severity | Count |
|----------|-------|
| CRITICAL | N |
| HIGH | N |
| MEDIUM | N |
| LOW | N |

**Verdict**: APPROVED - LETS FUCKING GO | CHANGES_REQUIRED — [summary]
```

## Constraints

- All 10 OWASP categories must be assessed, no omissions
- Each finding must include the specific attack vector
- CRITICAL/HIGH findings must include recommended fix code
- Verdict must be one of the two exact phrases
