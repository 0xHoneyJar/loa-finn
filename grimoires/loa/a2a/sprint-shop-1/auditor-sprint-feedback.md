# Audit — Shop Sprint 1 (bd-1vp7) · 2026-07-12

Scope: src/lab/shop/{types,cite-check,ledger-check}(.test).ts + grimoire docs.

- Injection surface: CLOSED — git via execFileSync argv arrays (no shell), ledger
  runner is a closed enum + argv list (free-string cmd rejected + tested).
- Path containment: home/target resolved against repo root, out-of-root rejected
  + tested; symlinks not followed (cite + enumeration).
- Writes: ledger-check writes ONLY the ledger file on explicit --render; cite-check
  and probe path write nothing. No network. No secrets touched. No auth paths.
- Egress: reports carry citations/statuses only (refOnly asserted in test).
- Review gate: adversarial pass (gpt-5.6-sol) found 5 real issues (2 critical);
  all fixed with regression tests same-cycle. Suite 32/32 green.
- Verdict: APPROVED for sprint-1 scope. No blocking findings.
