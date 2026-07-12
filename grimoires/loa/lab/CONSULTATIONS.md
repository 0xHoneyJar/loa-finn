# CONSULTATIONS — the protocol (FR-4, bd-1vp7)

> A consultation is a settle-shaped act: pre-registered questions → corpus
> retrieval → cited verdicts → deterministic validity. The JANI-v0 shape
> (`grimoires/loa/lab/roster/jani.md` + its first testimony) codified for any
> subject: a person's record, a repo's lineage, a decision's history.

## The epistemic boundary (testable — SDD 2.3)

| Side | Who | Allowed |
|---|---|---|
| RETRIEVE / DRAFT | LLM (miners, weaver) | search, read, assemble candidate evidence, draft verdict prose |
| SETTLE | deterministic code | citation resolution (`src/lab/shop/cite-check.ts`), confidence derivation (rules below), ABSTAIN when citations fail, testimony validity |

A testimony is **VALID** iff every citation resolves mechanically AND each
verdict's confidence re-derives from the rules below. The check is runnable:
`npx tsx src/lab/shop/cite-check.ts <testimony.md>`.

## Confidence derivation (v1 — deterministic)

Citations are **independent** iff they differ in BOTH source artifact and
provenance tier-origin (two captures of one Discord message = one source).

| Confidence | Rule |
|---|---|
| HIGH | ≥2 independent citations, ≥1 at git-verbatim/account-verbatim tier |
| MEDIUM | 1 primary citation, OR ≥2 captured-tier |
| LOW | captured/claimed tiers only |
| ABSTAIN | citations fail to resolve, OR conflicting evidence (both sides cited, never averaged), OR the record is silent |

## The steps

1. **Pre-register** the questions (before mining — the anti-cherry-pick).
2. **Mine** the corpus (LLM side): each claim candidate carries its citation +
   provenance tier (`grimoires/loa/lab/corpus/INTAKE.md` tiers; misattribution
   `guards[]` travel with their source).
3. **Verdict** per question: verdict text + confidence per the rules + the
   citations. Honest ABSTAIN is a first-class outcome.
4. **Persist** the testimony: `grimoires/loa/context/<date>-<subject>-testimony.md`
   with frontmatter `{subject, questions[], verdicts[], corpus_map}`.
5. **Settle**: run cite-check over the testimony; VALID iff green + confidences
   re-derive. Record the run in the testimony footer.

## Ethics header (person subjects — MANDATORY)

A consultation whose subject is a person requires an ethics header in the
subject's roster brief before mining begins (`grimoires/loa/lab/roster/jani.md`
is the template): internal-only · never-as-them · words-supersede ·
retire-on-objection. No header → the consultation is refused (the finn-cli
`consult` verb mechanizes this refusal).

## Precedent

- Consultation #1: `grimoires/loa/context/2026-07-12-jani-construct-testimony.md`
  (person subject; 4 settled, 2 ABSTAIN — the abstentions are the proof the
  discipline works).
