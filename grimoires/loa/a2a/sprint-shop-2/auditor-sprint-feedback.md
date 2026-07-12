# Audit — Shop Sprint 2 (bd-1vp7) · 2026-07-12

Scope: corpus-scrub.ts + probe.ts (+tests), CONSULTATIONS.md, INTAKE.md,
probe-fixtures.yaml, consultation #2 testimony.

- corpus-scrub: patterns from ONE SoT (flatline config), refuses-blind tested;
  writes only within the given intake dir + manifest; raw hashes retained,
  raw retention policy documented (caller deletes post-verify).
- probe: single write = append to probe-results.jsonl (versioned lines);
  dimension/class scoring mechanical; dangling-citation fail tested; no LLM.
- Egress: results carry names/counts/citations only (refOnly held).
- Protocol integrity: consultation #2 ran the protocol verbatim — pre-registered
  questions, cited verdicts, 1 honest ABSTAIN; settled green by cite-check.
- Review basis: same tool-family + discipline as S1 (adversarially reviewed);
  S2 negatives cover the new surfaces. Suite 41/41.
- Verdict: APPROVED for sprint-2 scope.
