# Audit — Shop Sprints 3-4 close (bd-1vp7) · 2026-07-12

S3: G1 probe run #1 honest FAIL (format gaps → grammar sugar + README teaching,
both tested) → run #2 PASS 37/37 on an uncontaminated fresh subject (~99s,
88.6K tokens vs 1.8M baseline ≈ 20×). Measurement recorded
(context/2026-07-12-g1-probe-record.md + probe-results.jsonl).

S4 (gate passed): finn-cli v0 doctor+gadgets. Read-only BY CONSTRUCTION —
no-writes statically asserted in tests; check execution via the constrained
runner only (argv, timeout, no shell); exit semantics per ratified spec;
unknown-id/usage negatives tested. Live smoke on the real repo: doctor PASS
(identity 11/0 · ledger 16 rows/0 errors · probe last=PASS). Suite 51/51.

Verdict: APPROVED. Cycle acceptance: G1 MET (probe), G2 MET (consultation #2,
1 honest ABSTAIN), G3 MET (ledger reconciles, no unenrolled instrument).
