# Sprint Plan — Agent Memory Runtime + Storage Commitments (Finn Layer 3)

**Status:** Draft only. Do not implement before @deep-name review.
**Slug:** `agent-memory-runtime-storage-commitments`
**Parent:** `0xHoneyJar/loa-dixie#89` · **Hounfour:** `0xHoneyJar/loa-hounfour#57` · **Finn:** `0xHoneyJar/loa-finn#155`

> No sprint past Sprint 0 begins without (a) explicit @deep-name approval of this plan and (b) `loa-hounfour#57` reaching one of the two accepted terminal states defined in Sprint 1 Acceptance: **(a) ratified Hounfour schemas, or (b) Hounfour-published shadow types under an explicit stability window and versioning rule**. "Deferred-to-consumer-local" is NOT an accepted terminal state for this RFC — even minimal types must come from Hounfour so that Finn never defines wire types locally. Sprint sizing is **directional only** — to be re-confirmed during planning approval.

## Overview

```
Sprint 0  — Jani boundary review (this RFC; planning only)
Sprint 1  — Hounfour protocol decision sync (gating)
Sprint 2  — Runtime design finalization (interfaces frozen, no code)
Sprint 3  — Disabled/shadow runtime: write path, internal RPC only
Sprint 4  — Crash-injection + idempotency test suite
Sprint 5  — Real chain commitment for one internal tenant under hard cap
Sprint 6  — Freeside / Dixie consumer integration (after Hounfour ratifies)
Sprint 7  — Review / audit / eval / Bridgebuilder gate
```

Sprints are gated: each must complete before the next opens. Circuit-break at any sprint if the rollout posture, budget posture, or schema posture changes.

---

## Sprint 0 — Jani boundary review (this RFC)

**Goal:** lock the runtime/protocol/product boundary; align on rollout posture; identify Hounfour blockers.

**Tasks:**

- [ ] @deep-name reviews `prd.md`, `sdd.md`, `sprint-plan.md`, `issue-map.md`, `draft-guardrails.md`.
- [ ] Confirm Finn / Hounfour / Freeside / Dixie ownership boundary.
- [ ] Confirm default rollout posture (recommended: disabled-by-default behind tenant flag).
- [ ] Confirm budget posture (recommended: distinct cost bucket, deny-on-exceed, reserve-then-submit, orphan GC).
- [ ] Identify the open questions in `prd.md §13` and `sdd.md §15` that require Hounfour input vs. require Finn-internal decision.
- [ ] Decide whether `ReputationAdapter` slot ships in Sprint 3 as a reserved interface or is fully deferred.

**Acceptance:**

- [ ] `[DRAFT][PROPOSAL]` PR has explicit @deep-name approval comment.
- [ ] Hounfour follow-ups captured in `loa-hounfour#57`.
- [ ] No code, no schemas, no migrations, no deploy, no `.claude/` edits in this sprint. Confirmed by `git diff` showing only artifacts under `docs/rfcs/agent-memory-runtime-storage-commitments/`.

**Out of scope:** any implementation, any schema definition, any flag flip.

---

## Sprint 1 — Hounfour protocol decision sync (gating)

**Goal:** unblock Finn implementation by resolving wire-format ownership in `loa-hounfour#57`. **Driven from Hounfour, not Finn.** Finn's role is consumer review, not authorship.

**Tasks (Finn-side only):**

- [ ] Review `loa-hounfour#57` schema proposals against `sdd.md §3.1` adapter slot expectations.
- [ ] File feedback issues if any proposed schema constrains Finn runtime invariants (idempotency, tenant scoping, audit redaction, reservation lifecycle).
- [ ] Confirm `MemoryArtifact`, `MemoryCommitment` / `ChainCommitment`, `AgentIdentity`, `AccessPolicy`, `StoragePointer` are ratified (or explicitly deferred to consumer-local for first runtime cut).
- [ ] Confirm `ReputationEvent` / `ValidationRecord` posture (in scope for now, or deferred).

**Acceptance:**

- [ ] `loa-hounfour#57` is in one of two accepted terminal states:
  - **(a) Ratified:** schemas finalized in Hounfour, semver pinned, consumer-ready.
  - **(b) Hounfour-published shadow types with explicit stability window:** Hounfour ships a minimal shadow type set under a published version (e.g., `0.x.shadow`) and commits to a stability window (no breaking changes within the window) plus a versioning rule for promotion. Finn consumes the shadow types as if they were ratified.
- [ ] **"Deferred-to-consumer-local" is NOT an accepted terminal state for this RFC.** Even minimal types must come from Hounfour so that Finn never defines wire types locally and Sprint 2 has something to freeze interfaces against.
- [ ] No Finn-side schema definitions exist in this repo.

**Out of scope:** any Finn implementation, any runtime flag changes.

---

## Sprint 2 — Runtime design finalization (interfaces frozen, no code)

**Goal:** translate `sdd.md` adapter slots and the commitment state machine into final interface signatures, ready for Sprint 3 to scaffold against. **No source code is written; the artifact is design.**

**Tasks:**

- [ ] Finalize `MemoryDistiller`, `StorageAdapter`, `ChainCommitmentAdapter`, `IdentityAdapter`, `AccessPolicyAdapter`, `ReputationAdapter` (or deferred) interface signatures referenced — not defined — against the Hounfour types from Sprint 1.
- [ ] Finalize `MemoryCommitCoordinator` lifecycle: `reservation_pending → prepared → submitted → confirmed | failed | needs_manual_review` plus operator transitions.
- [ ] Finalize `BudgetEnforcer` API shape extensions: `reserve(commitment_id, …) → ReservationId` (idempotent), reservation release paths, lease/orphan-GC contract.
- [ ] Finalize WAL record types (`ReservationPending`, `CommitmentTransition`, `ReservationLifecycle`) as Finn-internal records — not shared protocol types.
- [ ] Finalize audit event shapes and redaction rules per visibility tag. Decide whether to extend existing `src/safety/` records in place or wrap into a Hounfour-ratified envelope (open Q from `sdd.md §15`).
- [ ] Finalize circuit-breaker boundaries per adapter.
- [ ] **Chain-selection + `get_status` strategy decision artifact.** Decide:
  - The chain class (or constraints) for the first concrete `ChainCommitmentAdapter`. Decision can be a single chain pick or a constraint set ("any EVM L2 testnet with sub-cent commit cost and per-key receipt query") that Sprint 5 will satisfy.
  - The `get_status(commitment_id)` strategy: native chain query vs. adapter-local durable index. If adapter-local, name the persistence layer (existing Finn store vs. new) and describe the indexing scheme keyed by `CommitmentId`.
  - The signing-key custody plan referencing the existing secret store (no co-location with model output paths).
  - Document this decision under `docs/rfcs/agent-memory-runtime-storage-commitments/chain-strategy.md` (planning artifact, no code).
- [ ] Document the final interfaces under `docs/rfcs/agent-memory-runtime-storage-commitments/interfaces.md` (additional planning artifact, no code).

**Acceptance:**

- [ ] Interface signatures complete; @deep-name signs off.
- [ ] No `src/`, `schemas/`, `drizzle/`, `deploy/`, package, or `.claude/` changes.
- [ ] Open questions from Sprint 0 either resolved or explicitly carried to Sprint 3 with rationale.

**Out of scope:** any implementation code, any runtime flag changes, any consumer integration.

---

## Sprint 3 — Disabled/shadow runtime: write path, internal RPC only

**First sprint that touches `src/`. Implementation only after @deep-name re-approval at Sprint 2 close.**

**Goal:** land the smallest possible **shadow-mode write path**: distillation + storage write happen, audit is real, **commitment is dry-run** (no chain tx), reads are stubbed, no consumer integration. Default disabled per-tenant; no tenant enrolled.

**Scope clarification:** All work in this sprint is Finn-repo-local. Gateway changes here mean changes to `src/gateway/` **inside `loa-finn`** — this repo already owns gateway HTTP/WS, JWT, rate limiting, and dashboard routes per the existing module map. The "internal RPC entry" is an internal route on the existing Finn gateway, **not** a new public HTTP/REST endpoint and **not** cross-repo work in `loa-freeside` or `loa-dixie`.

**Tasks (planning-level — concrete tasks defined post-Sprint 2):**

- [ ] **Sprint setup:** confirm or introduce the test scripts referenced in acceptance below; wire any new ones into the Finn CI workflow. Acceptance below depends on the **CI workflow** passing, not on a hard-coded script list.
- [ ] Scaffold the adapter slot module in Finn (location decided in Sprint 2: `src/persistence/` vs `src/memory/`).
- [ ] Implement `MemoryCommitCoordinator` with the full state machine including `reservation_pending` and `needs_manual_review`.
- [ ] Implement WAL records for the new lifecycle, integrated with existing WAL invariants.
- [ ] Implement `BudgetEnforcer` extensions: idempotent `reserve()`, reservation lease/orphan GC.
- [ ] Implement audit-trail integration: write-ahead audit before every side effect, redaction per visibility.
- [ ] Implement adapter slots with **stub backends**:
  - `MemoryDistiller` — runs inside existing tool sandbox, returns typed artifact.
  - `StorageAdapter` — writes to a private encrypted blob store only (no IPFS/Arweave/decentralized backend in this sprint).
  - `ChainCommitmentAdapter` — **dry-run only**: produces a deterministic mock receipt; no real chain tx. Implements the full `submit` + `get_status` contract from Sprint 2's chain-strategy artifact, returning mock-but-deterministic values.
  - `IdentityAdapter`, `AccessPolicyAdapter` — composed with existing JWT/tenant capability; no parallel auth.
- [ ] Internal RPC entry on the existing Finn gateway (`src/gateway/`), gated by per-tenant flag (default off). **No public HTTP/REST endpoint, no Freeside/Dixie route exposure.**
- [ ] Feature flag plumbing; default disabled in all tenants.

**Acceptance (objective and CI-bound):**

- [ ] The Finn CI workflow on the PR is green — including typecheck, build, and the test suites covering Finn runtime, gateway, WAL/persistence, audit fixtures, and sandbox. Specific `npm run …` targets are an implementation detail of the CI workflow; the acceptance is "CI green," not "this list of scripts." If a needed test target does not yet exist, the sprint setup task above adds it and wires it into CI.
- [ ] Default disabled; no tenant flag flipped on in any environment.
- [ ] No public API surface added; no Hounfour-owned wire types redefined locally; no Finn-side schema definitions.
- [ ] No migrations; no deploy/infra changes; no `.claude/` edits.
- [ ] `MemoryCommitCoordinator` correctly persists `reservation_pending` (WAL + audit) before any `reserve()` call in unit tests.
- [ ] Dry-run `ChainCommitmentAdapter` implements both `submit` idempotency and `get_status` reconciliation per the Sprint 2 chain-strategy artifact.

**Out of scope:** real chain commitment, real decentralized storage, consumer integration, public API.

---

## Sprint 4 — Crash-injection + idempotency test suite

**Goal:** prove the commitment lifecycle is crash-safe and idempotent under every failure mode the SDD names.

**Tasks:**

- [ ] Property test: `CommitmentId` is deterministic for a given `(tenant_id, environment, artifact_identity, intent)` and varies across tenants.
- [ ] Crash injection: kill before `reservation_pending` WAL durable → no reservation created, no spend.
- [ ] Crash injection: kill after `reservation_pending` WAL durable but before `reserve()` returns → recovery rehydrates via idempotent `reserve()`, transitions to `prepared` (or `failed` on cap denial, or `needs_manual_review` on indeterminate error).
- [ ] Crash injection: kill after `reserve()` but before `prepared` WAL durable → recovery rehydrates by `CommitmentId`, idempotent `reserve()` returns same `ReservationId`, transition to `prepared`.
- [ ] Crash injection: kill mid-`submit` → `get_status(commitment_id)` reconciles; no double-submission regardless of tx-hash visibility.
- [ ] Crash injection: kill after `submit` accepted, before `submitted` WAL transition → recovery sees `submitted` via `get_status`, transitions WAL to match.
- [ ] Crash injection: corrupt WAL reservation → transitions to `needs_manual_review`; no submission, no fresh authorization.
- [ ] Crash injection: adapter `get_status` indeterminate → transitions to `needs_manual_review`; no blind re-submit.
- [ ] Crash injection: client abandonment / gateway timeout → `BudgetEnforcer` GC reclaims orphan reservation within lease window; audit event emitted.
- [ ] Reservation release tests: `failed` releases full reservation; `confirmed` reconciles delta; `needs_manual_review` TTL expiry releases.
- [ ] Audit write-ahead property: every side effect has a preceding durable WAL+audit pair.
- [ ] Circuit-breaker test: failing `StorageAdapter` and failing `ChainCommitmentAdapter` do not cascade into model routing.
- [ ] **Concurrency / race-condition coverage** (deterministic, not flake-prone):
  - Concurrent `reserve(commitment_id)` calls from N coordinators must return the same `ReservationId`; only one durable reservation must exist at the end.
  - Concurrent end-to-end commit attempts for the same `(tenant_id, environment, artifact_identity, intent)` must produce **at-most-one** `submit` side effect at the adapter, regardless of which coordinator wins the race.
  - WAL transition atomicity / serialization under contention: two coordinators racing through `reservation_pending → prepared → submitted` produce a totally-ordered WAL trace with no interleaving that could orphan a reservation or skip an audit event.
  - Concurrent crash + recovery: kill one coordinator mid-flight while another is still running; recovery must converge to a single, consistent terminal state without doubling submissions or reservations.
  - Idempotent re-entry from `reservation_pending` under concurrency: parallel recovery scans never produce a second reservation or a second `prepared` record for the same `CommitmentId`.

**Acceptance:**

- [ ] All crash-injection scenarios pass deterministically.
- [ ] All concurrency scenarios above pass deterministically (no `sleep`-based timing; use barriers or scheduler hooks).
- [ ] No test bypasses idempotency by relying on tx hash.
- [ ] Default still disabled in production.

**Out of scope:** real chain backend, decentralized storage, consumer integration.

---

## Sprint 5 — Real chain commitment for one internal tenant under hard cap

**Goal:** flip the dry-run adapter to a real chain backend for a single internal test tenant under a hard per-tenant cap. Storage backend is still private/encrypted only (no decentralized backend yet).

**Tasks:**

- [ ] Implement one concrete `ChainCommitmentAdapter` against the chain class chosen in the **Sprint 2 chain-strategy artifact**. Adapter must implement `submit(commitment_id, payload)` idempotency and `get_status(commitment_id)` reconciliation per that artifact.
- [ ] If the Sprint 2 strategy specified an adapter-local durable status store, implement and integrate it now (per the documented persistence layer and indexing scheme keyed by `CommitmentId`).
- [ ] Per-tenant hard cap on the commitment cost bucket. Deny-on-exceed.
- [ ] Signing key custody: keys live in the existing secret store per the Sprint 2 plan; not co-located with model output paths.
- [ ] Enable for one internal tenant only; document the enrollment in `grimoires/loa/NOTES.md`.
- [ ] Soak test: drive sustained low-rate commitments; confirm budget accounting, audit trail, and recovery behave under real chain confirmation latency.
- [ ] **Cross-restart reconciliation test:** kill the runtime mid-flight (after `submit` but before `submitted` WAL durable); on restart, `get_status(commitment_id)` must reconcile to the existing on-chain state without re-submitting and without relying on any in-memory tx-hash cache. This test exercises the durable status store (if any) end-to-end across process restart, not just within a process.
- [ ] CI: same Finn workflow as Sprint 3 must remain green; the Sprint 4 crash-injection + concurrency suite must remain green.

**Acceptance:**

- [ ] Real chain commitment confirmed end-to-end for a single internal tenant.
- [ ] Hard cap enforced; deny-on-exceed verified.
- [ ] Audit trail shows write-ahead at every side-effect boundary; redaction matches visibility tag.
- [ ] Cross-restart `get_status` reconciliation test passes deterministically.
- [ ] No production tenant enrolled.
- [ ] No public API exposure; no consumer integration yet.

**Out of scope:** production tenancy, public API, decentralized storage, Freeside/Dixie integration.

---

## Sprint 6 — Freeside / Dixie consumer integration (after Hounfour ratifies)

**Goal:** expose the runtime to Freeside (product surface) and Dixie (Oracle/product BFF) through Hounfour-ratified types **only**. Driven from Freeside/Dixie, not Finn.

**Tasks (Finn-side):**

- [ ] Confirm Hounfour types from Sprint 1 are stable and consumer-ready.
- [ ] Implement the read path (Sprint 3 stubbed reads become real).
- [ ] Add a second concrete `StorageAdapter` if decentralized storage is in scope (decision deferred to Sprint 6 kick-off).
- [ ] Coordinate with Freeside on provenance-UI requirements (Freeside-owned).
- [ ] Coordinate with Dixie on memory/oracle product semantics (Dixie-owned).
- [ ] Maintain disabled-by-default in production; opt-in per tenant.

**Acceptance:**

- [ ] Read path live for the internal tenant; consumer integrations compile against Hounfour types only.
- [ ] No Finn-defined wire types in this repo.
- [ ] Per-tenant cap and audit posture unchanged from Sprint 5.

**Out of scope:** Freeside UI work (their sprint), Dixie product semantics (their sprint).

---

## Sprint 7 — Review / audit / eval / Bridgebuilder gate

**Goal:** final-gate the implementation through Loa's review/audit/eval pipeline before any production rollout discussion.

**Tasks:**

- [ ] `/review-sprint sprint-3` through `/review-sprint sprint-6` (each sprint already reviewed individually; this is the rollup).
- [ ] `/audit-sprint sprint-3` through `/audit-sprint sprint-6` rollup.
- [ ] `/eval --suite framework` plus targeted memory-recall and commitment-integrity eval suites (to be defined in `loa-main` if not already present).
- [ ] `/bridgebuilder --dry-run` against the integrated PR; address findings before production rollout discussion.
- [ ] Update `grimoires/loa/NOTES.md` with cross-session memory of the rollout posture.

**Acceptance:**

- [ ] All review/audit/eval/Bridgebuilder gates green.
- [ ] No production tenancy enabled without an additional explicit @deep-name decision and a separate rollout RFC.

**Out of scope:** production rollout. That requires a separate RFC tracking enrollment criteria, alerting, and on-call posture.

---

## Risk register (carried across all sprints)

| Risk | Sprint to address | Mitigation |
|---|---|---|
| Hounfour schema not ratified by Sprint 3 | Sprint 1 | Block Sprint 3 until `loa-hounfour#57` reaches a terminal state. |
| Idempotency keying drifts back toward tx hash | Sprint 4 | Property test asserts `CommitmentId` is the only idempotency key. |
| Orphan reservations leak budget | Sprint 4 | Crash-injection scenario explicitly covers client abandonment + GC. |
| `needs_manual_review` becomes a silent bucket | Sprint 4 | TTL expiry alarm; audit event on entry; operator runbook in Sprint 5. |
| Distillation prompt-injection amplifies across sessions | Sprint 3 | Sandbox boundary; reflective-memory max-depth. |
| Signing key co-locates with model output | Sprint 5 | Adapter signs only audited, policy-approved payloads; keys in existing secret store. |
| Public API surface accidentally accreted on Finn | Sprint 3 | Internal RPC only; no public HTTP/REST routes; PR-time review check. |
| Default flips to enabled in production prematurely | All sprints | Default-disabled invariant; production rollout requires a separate RFC. |

## Cross-repo coordination (carried)

| Repo | Owner | Coordination point |
|---|---|---|
| `loa-hounfour` | Hounfour maintainers | Sprint 1 gating, Sprint 6 consumer freeze. |
| `loa-dixie` | Dixie maintainers | Sprint 6 consumer integration; ongoing product semantics alignment. |
| `loa-freeside` | Freeside maintainers | Sprint 6 consumer integration; provenance UI in their own sprint plan. |
| `loa-main` | Loa-main maintainers | Sprint 7 eval suite definition if not pre-existing. |

## Stop conditions (across all sprints)

Stop and re-confirm with @deep-name if any of these occur:

- A sprint introduces a wire-format type definition in this repo.
- A sprint flips a tenant flag in production without a separate rollout RFC.
- A sprint adds a public HTTP/REST endpoint owned by Finn.
- A sprint adds a `.claude/` edit, a deploy/infra change, a migration outside Sprint 3+, or a lockfile change unrelated to dependency hygiene.
- Crash-injection coverage drops below the Sprint 4 baseline at any later sprint.
