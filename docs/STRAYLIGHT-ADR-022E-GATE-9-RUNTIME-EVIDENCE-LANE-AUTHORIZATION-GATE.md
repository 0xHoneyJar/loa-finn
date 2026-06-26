# loa-finn Authorization & Decomposition Gate — Loa-Straylight ADR-022E Gate #9 Runtime Evidence Lane

**Status**: Authorization/decomposition gate (docs-only) — authorizes a *future* candidate evidence lane only
**Date**: 2026-06-26
**Owner repo**: `loa-finn`
**Counterparty**: `loa-straylight`
**Upstream phase**: Loa-Straylight Phase 48L (merged)
**Predecessor**: [`docs/STRAYLIGHT-ADR-022E-GATE-9-OWNER-RESPONSE-ACCEPTANCE.md`](STRAYLIGHT-ADR-022E-GATE-9-OWNER-RESPONSE-ACCEPTANCE.md)

---

## 1. What This Document Is

This is the `loa-finn` **authorization and decomposition gate** for the future candidate **ADR-022E gate #9 runtime evidence lane**.

It is a narrow, hand-authored governance record. It is the sole artifact produced for this gate. It **authorizes and decomposes** a *future, separate* evidence-lane proof; it does **not** implement that proof, and it does **not** assert that any such evidence already exists or already passes.

It is the follow-up gate that the predecessor owner-response acceptance record anticipated in its §7 ("a future, separate `loa-finn` docs-only authorization gate may open the candidate gate-#9 runtime evidence lane, under teammate review … that later authorization lane must define evidence scope and non-goals before any implementation"). This document is that scope-and-non-goals definition.

## 2. Status & Scope

- **docs-only** — this change creates exactly one Markdown document and nothing else.
- **authorization + decomposition only** — it authorizes a *future* evidence-lane proof and decomposes what that proof must answer. It is not a design, not an implementation, and not an authorization of any code, runtime, storage, or integration work.
- **scope is gate #9 only** — this document is the `loa-finn` runtime evidence-lane gate. The sibling `loa-dixie` gate #10 boundary evidence-lane authorization is a separate, independent artifact in a different repo and is out of scope here.
- **No** source, test, runtime, config, package, lockfile, CI, generated, hidden-workflow, schema, migration, SQL, memory, `.claude`/`.loa`/`.run`/grimoire, or sibling-repo changes are made by this document.

## 3. Background (Phase 48L)

Loa-Straylight **Phase 48L** has merged. Phase 48L:

- Intook the sibling owner responses:
  - `loa-finn` PR #194 recorded `OWNER_RESPONSE: ACCEPT` for ADR-022E gate #9 owner-response only.
  - `loa-dixie` PR #202 recorded `OWNER_RESPONSE: ACCEPT` for ADR-022E gate #10 owner-response only.
- Classified:
  - gate #9 owner response: `ACCEPT_RECORDED`
  - gate #10 owner response: `ACCEPT_RECORDED`
  - #9 / #10 owner-response routing completion: `RECORDED`
- Selected, as the next work, two sibling-local docs-only authorization/decomposition gates:
  1. `loa-finn`: gate #9 **runtime** evidence-lane authorization/decomposition gate — **this document**.
  2. `loa-dixie`: gate #10 **boundary** evidence-lane authorization/decomposition gate — separate, not handled here.

The `loa-finn` `ACCEPT_RECORDED` classification means only that `loa-finn` is the willing owner of the *future* candidate gate-#9 runtime evidence lane, under teammate review. It did not produce evidence, satisfy any gate, or authorize any implementation.

## 4. The Evidence Question

This gate authorizes a future evidence lane to answer one **evidence question**:

> Can `loa-finn` provide evidence, under teammate review, for the ADR-022E gate #9 runtime/enforcement responsibility that Loa-Straylight needs before the broader MVP-2 Admission Wedge D.1 / gate #8 chain can advance?

This document does **not** answer that question. It authorizes a *later, separate* `loa-finn` evidence PR to attempt to answer it, under teammate review, and decomposes what that PR must prove (§7).

## 5. Authorization (Narrow)

This gate authorizes exactly one thing:

- The opening of a **future, separate** `loa-finn` **evidence PR** whose purpose is to assemble and present evidence for the gate #9 runtime/enforcement responsibility described by the evidence question (§4), **under teammate review**.

That later evidence PR **may inspect and cite** existing `loa-finn` runtime surfaces, docs, tests, and workflows in order to build its argument. It **must not** implement, modify, or wire behavior unless a still-later, explicit implementation authorization gate authorizes it.

That is the entirety of what is authorized.

## 6. Boundaries & Non-Authorizations (Preserved)

For the avoidance of doubt, this authorization/decomposition gate authorizes **only** a future evidence-lane proof/decomposition. It does **not** implement the proof. In particular, this gate:

- does **not** satisfy ADR-022E:58.
- does **not** satisfy gate #9.
- does **not** discharge gate #8.
- does **not** satisfy D.1.
- does **not** start D.2.
- does **not** close MVP-2.
- does **not** select a canonical-store physical host.
- does **not** propose a production adapter.
- does **not** make `loa-finn` the canonical semantic owner of any Loa-Straylight estate semantics.
- does **not** assert that gate #9 evidence already exists.
- does **not** assert that any gate #9 evidence already passes.
- does **not** authorize source, test, runtime, config, package, CI, schema, migration, or SQL changes.
- does **not** authorize production wiring.
- does **not** authorize route/API, storage, DB, auth, consent, signer, Freeside, Dixie, or Straylight integration work.

The blocked state is preserved: gate #9 remains held, gate #8 remains undischarged, D.1 remains unsatisfied, D.2 is not started, and MVP-2 remains open. Nothing in this document changes any of those postures.

## 7. Decomposition — What the Later Evidence PR Must Prove

This section defines, evidence-scoped (not implementation-scoped), what a *future, separate* `loa-finn` gate-#9 evidence PR must prove. Listing a question here does not answer it; the later PR carries the burden of proof, under teammate review.

At minimum, the later evidence PR must answer:

1. **Implicated surface.** What exact `loa-finn` runtime/enforcement surface is implicated by ADR-022E gate #9? The PR must name the specific runtime responsibility at issue, in `loa-finn`'s own terms.
2. **Relevant existing artifacts.** What existing `loa-finn` files, docs, tests, workflows, or runtime boundaries are relevant to that responsibility? The PR must enumerate them by path and explain their relevance.
3. **Hosting/enforcement without ownership creep.** What evidence would show `loa-finn` can host or enforce the required runtime responsibility **without becoming Loa-Straylight's canonical semantic owner**?
4. **Emit/enforce, not redefine.** What evidence would show `loa-finn` **emits/enforces what Straylight defines**, rather than redefining Loa-Straylight estate semantics? (`Finn emits` and enforces; `Straylight defines`.)
5. **Pass criteria for intake.** What pass criteria would allow `loa-straylight` to later intake gate #9 evidence? (See §9 for the criteria this gate fixes; the PR must demonstrate it meets them.)
6. **Fail-closed criteria.** What fail-closed criteria would keep gate #9 held? (See §10; the PR must show which, if any, apply.)
7. **Allowed files/surfaces.** What files/surfaces are allowed in the later evidence PR? (See §11.)
8. **Forbidden files/surfaces.** What files/surfaces remain forbidden until a later implementation authorization? (See §12.)
9. **Return artifact.** What result artifact should return to `loa-straylight`? (See §13.)

### Candidate surfaces (inspect-only; not evidence)

To orient the later evidence PR, the following `loa-finn` runtime surfaces are **candidate** inspection targets. Listing them here is **not** evidence, **not** an assertion of relevance, and **not** a scoping decision — the later PR must justify which (if any) actually bear on gate #9:

- `src/hounfour/` — multi-model routing, billing invariants, audit.
- `src/persistence/` — WAL persistence and recovery boundaries.
- `src/cron/` — scheduler circuit breaker, kill-switch, sandbox policies.
- `src/gateway/` — auth, allowlist, API-key, and request-surface boundaries.
- `src/safety/`, `src/cost/`, `src/score/` — enforcement, cost-metering, and deterministic verdict boundaries.
- `tests/` and `docs/` — existing tests and documentation that describe those boundaries.

The later PR may cite these surfaces read-only; it must not modify them under this gate.

## 8. Required Proof Shape

The later evidence PR's proof must be:

- **Evidence-scoped, not implementation-scoped** — it argues from existing surfaces, docs, tests, and workflows; it does not add or change behavior.
- **Cited** — every claim about a `loa-finn` surface must cite a concrete `file` or `file:line` reference, not an assertion.
- **Bounded by emit/enforce semantics** — it must show `loa-finn` would emit/enforce what `Straylight defines`, never redefine Straylight estate semantics, and never assume canonical semantic ownership.
- **Honest about gaps** — where evidence is insufficient, the PR must say so and leave gate #9 held, rather than overclaim.
- **Reviewable** — structured so a teammate reviewer can check each claim against its cited source.

## 9. Pass Criteria (for later loa-straylight intake)

`loa-straylight` could later intake gate #9 evidence only if the future evidence PR demonstrates **all** of the following, each under teammate review:

- It identifies the exact implicated runtime/enforcement surface (decomposition §7.1) with cited references.
- It shows `loa-finn` can host/enforce the responsibility **without** becoming the canonical semantic owner (§7.3).
- It shows `loa-finn` emits/enforces what `Straylight defines` and does **not** redefine Loa-Straylight estate semantics (§7.4).
- It stays within the allowed files/surfaces (§11) and touches none of the forbidden surfaces (§12).
- It produces a return artifact suitable for `loa-straylight` intake (§13).
- It does **not** overclaim: it does not assert that gate #9, gate #8, D.1, D.2, MVP-2, or ADR-022E:58 are advanced beyond evidence.

Meeting these **pass criteria** is necessary for later intake; it is not, by itself, intake. `loa-straylight` remains responsible for its own posture transitions.

## 10. Fail-Closed Criteria (keep gate #9 held)

Gate #9 remains **fail-closed** (held) if any of the following is true of the later evidence PR:

- It cannot cite a concrete implicated surface, or its citations do not support the claim.
- It would require `loa-finn` to become the canonical semantic owner, or to redefine Loa-Straylight estate semantics, to satisfy the responsibility.
- It touches any forbidden surface (§12), implements behavior, or wires production.
- It selects a canonical-store physical host or proposes a production adapter.
- Its evidence is insufficient, ambiguous, or unreviewable.
- It attempts to discharge gate #8, satisfy D.1, start D.2, or close MVP-2.

Under any fail-closed condition, the correct outcome is to keep gate #9 held and return the held status to `loa-straylight`, not to advance the chain.

## 11. Allowed Files/Surfaces (in the later evidence PR)

The future evidence PR is expected to be docs-first and read-only with respect to behavior. Allowed:

- A new evidence/result Markdown document under `docs/` (the evidence artifact and its citations).
- **Read-only inspection and citation** of existing `loa-finn` source, tests, docs, workflows, and runtime boundaries (cited by `file` / `file:line`, not modified).

## 12. Forbidden Files/Surfaces (until a later implementation authorization)

The following remain **forbidden** in the later evidence PR, and remain forbidden until a still-later, explicit implementation authorization gate is opened and itself passes teammate review:

- Source, test, runtime, config, package, lockfile, CI, generated, schema, migration, and SQL changes.
- Production wiring; route/API, storage, DB, auth, consent, signer changes.
- Freeside, Dixie, or Straylight integration work.
- Selection of a canonical-store physical host; proposal or design of a production adapter.
- Edits to `.claude`, `.loa`, `.run`, grimoires, hidden workflow files, memory files, or any sibling repo.

## 13. Return Path to loa-straylight

- The **return path** for this gate is informational: this authorization/decomposition gate may be intaken by `loa-straylight` as the recorded `loa-finn` authorization that the gate-#9 runtime evidence lane is scoped, decomposed, and bounded — building on the prior `ACCEPT_RECORDED` for the #9 owner-response.
- The **return artifact** of the *later* evidence PR (if and when accepted) should be a single `loa-finn` evidence/result Markdown document that `loa-straylight` can intake when deciding whether to advance gate #9. That artifact must carry its own pass/fail determination (§9, §10) and must not assert advancement beyond what its cited evidence supports.
- `loa-straylight` remains responsible for its own posture transitions; this gate and any later evidence artifact are inputs to that process, not substitutes for it.

## 14. Selected Next Step

- The next step after this gate, **if accepted**, is a **separate `loa-finn` evidence PR** for gate #9 runtime evidence.
- That later evidence PR **may inspect and cite** existing runtime surfaces, docs, tests, and workflows.
- It **must not** implement behavior unless a still-later implementation gate explicitly authorizes it.
- This gate does **not** pre-authorize implementation; it authorizes only the evidence-lane proof/decomposition described above.

---

### Summary

| Field | Value |
|-------|-------|
| Owner repo | `loa-finn` |
| Counterparty | `loa-straylight` |
| Gate | ADR-022E sibling gate #9 — runtime evidence-lane **authorization/decomposition** gate |
| Upstream | Phase 48L (merged); #9 owner-response `ACCEPT_RECORDED`; routing `RECORDED` |
| Authorizes | A *future, separate* `loa-finn` evidence PR to prove the gate-#9 runtime responsibility, under teammate review |
| Evidence question | Can `loa-finn` provide evidence, under teammate review, for the gate #9 runtime/enforcement responsibility Loa-Straylight needs before the MVP-2 Admission Wedge D.1 / gate #8 chain can advance? |
| Pass criteria | Cited implicated surface; host/enforce without canonical semantic ownership; `Finn emits` what `Straylight defines`; stays in allowed surfaces; produces an intakeable return artifact; no overclaim |
| Fail-closed | No cited surface; ownership/redefinition creep; touches forbidden surfaces; selects canonical-store physical host or proposes production adapter; insufficient/unreviewable evidence → gate #9 stays held |
| Does **not** | satisfy ADR-022E:58, gate #9, or D.1; discharge gate #8; start D.2; close MVP-2; select a canonical-store physical host; propose a production adapter; authorize implementation or production wiring |
| Next step | Separate `loa-finn` gate-#9 runtime **evidence PR** (inspect/cite only; no behavior) |
| Return path | Informational intake by `loa-straylight`; later evidence PR returns a single intakeable result doc |
