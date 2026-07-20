# [DRAFT][PROPOSAL] Finn: Agent Memory Runtime + Storage Commitments

## Status

Draft planning artifacts only. **Do not merge.** Requesting **@deep-name** review before any implementation.

This PR opens the planning packet for a Layer 3 runtime feature in `loa-finn` covering distillation, persistence, and chain-agnostic commitment of agent memory artifacts. No source code, schemas, migrations, deploy/infra files, package files, or `.claude/` files are touched.

## Parent and related issues

- Parent (Dixie research/product context): `0xHoneyJar/loa-dixie#89`
- Hounfour protocol question (shared schemas/contracts — must resolve before implementation): `0xHoneyJar/loa-hounfour#57`
- Finn runtime issue (this RFC): `0xHoneyJar/loa-finn#155`

## What changed

Planning artifacts only, all under `docs/rfcs/agent-memory-runtime-storage-commitments/`:

- `README.md` — RFC index and status banner.
- `source-context.md` — upstream research/context input.
- `research-packet.md` — Finn-scoped synthesis.
- `issue-map.md` — cross-repo ownership and dependency order.
- `draft-guardrails.md` — what the draft is and is not allowed to touch.
- `prd.md` — runtime PRD (problem, behavior, non-goals, acceptance).
- `sdd.md` — runtime SDD (architecture, interfaces by name, lifecycle, recovery, audit).
- `sprint-plan.md` — sprint plan starting at Sprint 0 (boundary review).
- `pr-body.md` — this PR body and review checklist.

## What did **not** change

- No source implementation (`src/` untouched).
- No schema changes (no `schemas/`, no Hounfour-like wire types defined locally).
- No database migrations (no `drizzle/`).
- No deployment changes (no `deploy/`, no `infrastructure/`, no Dockerfiles).
- No `.claude/` System Zone edits.
- No package/lockfile changes (`package.json`, `package-lock.json`, `pnpm-lock.yaml` untouched).
- No flag flips, no env-default changes.
- No cron, scheduler, or runtime behavior changes.

## Cross-repo ownership proposal

| Repo | Proposed impact | Review needed |
|---|---|---|
| `loa-main` | Possible (eval suites later) | No now; revisit at Sprint 7. |
| `loa-hounfour` | **Required first** — owns wire-format types | **Yes — `loa-hounfour#57` must reach a terminal state before Finn implementation begins.** |
| `loa-finn` | **Required** — runtime implementation | This RFC. |
| `loa-freeside` | Possible (provenance UI / surfaces) | After Hounfour ratifies; tracked separately. |
| `loa-dixie` | Required (parent) — product narrative, oracle/memory product semantics | Already covered by `loa-dixie#89`. |

## Key invariants captured in this packet

The PRD and SDD lock in the following invariants so that implementation cannot drift later:

1. **Idempotency keying.** Every commitment has a stable, deterministic `CommitmentId` derived from `(tenant_id, environment, artifact_identity, commitment_intent)`, persisted in WAL **before** any external side effect. Idempotency is keyed on `CommitmentId` — never on tx hash. Replay never produces a second on-chain submission for the same `CommitmentId`, regardless of whether the prior tx hash is known.
2. **Tenant-scoped dedupe.** `CommitmentId` includes a tenant component; dedupe is per-tenant (per capability realm), never global.
3. **Reserve-then-submit, WAL-bound.** A `reservation_pending` WAL+audit record is durable **before** `BudgetEnforcer.reserve()` is called. `reserve()` is idempotent on `CommitmentId` and returns a stable `ReservationId`. `prepared` records both IDs durably before any submit. Replay consumes the existing reservation; no fresh authorization on replay.
4. **Adapter reconciliation primitive.** `ChainCommitmentAdapter` MUST expose `get_status(commitment_id) → { none | submitted(handle) | confirmed(receipt) | failed(reason) }`. Adapters whose underlying chain cannot natively answer maintain a durable status store keyed by `CommitmentId`.
5. **`needs_manual_review` is an explicit terminal-until-operator state.** TTL-bounded reservation hold; operator-only transitions (`manual_resolve` reuses the same `ReservationId`; `manual_cancel` releases and audits).
6. **Defense-in-depth orphan GC.** `BudgetEnforcer` reclaims any reservation lacking a matching WAL `reservation_pending`-or-later record within a configurable lease window, with an audit event.
7. **Write-ahead audit invariant.** For every external side effect (`reserve`, storage write, `submit`, reservation release), the corresponding WAL transition AND audit event are persisted durably **before** the side effect is initiated.
8. **Schemas live in Hounfour, never in Finn.** Adapter slot types are referenced by name; field shapes are owned exclusively by `loa-hounfour#57`.
9. **Internal RPC only.** Finn does not gain any public HTTP/REST endpoint in this RFC. Public surfaces are owned by `loa-freeside` / `loa-dixie`.
10. **Disabled-by-default rollout.** Every sprint maintains the default-disabled invariant; production rollout requires a separate RFC.

## Sprint sequencing (gated)

```
Sprint 0  — Jani boundary review (this RFC, planning only)
Sprint 1  — Hounfour protocol decision sync (gating; ratified or shadow types only)
Sprint 2  — Runtime design finalization (interfaces frozen, no code)
Sprint 3  — Disabled/shadow runtime: write path, internal RPC only
Sprint 4  — Crash-injection + concurrency/idempotency test suite
Sprint 5  — Real chain commitment for one internal tenant under hard cap
Sprint 6  — Freeside / Dixie consumer integration (after Hounfour ratifies)
Sprint 7  — Review / audit / eval / Bridgebuilder gate
```

No sprint past Sprint 0 begins without explicit @deep-name approval AND `loa-hounfour#57` reaching a terminal state of (a) ratified or (b) Hounfour-published shadow types under an explicit stability window.

## Pre-merge gates this packet has already cleared

- [x] PRD reviewed by GPT-5.2 cross-model review — APPROVED on iteration 2 after fixes to idempotency keying, reserve-then-submit semantics, and Finn/Hounfour/public-API boundary.
- [x] SDD reviewed by GPT-5.2 cross-model review — APPROVED on iteration 3 after fixes adding adapter `get_status` reconciliation, tenant-scoped `CommitmentId` invariant, explicit `needs_manual_review` state machine, write-ahead audit at every side-effect boundary, and the `reservation_pending` pre-state with orphan-GC.
- [x] Sprint plan reviewed by GPT-5.2 cross-model review — APPROVED on iteration 3 after fixes tightening Sprint 1 terminal gates, scoping Sprint 3 gateway work to in-repo, replacing fragile test-script lists with CI-bound acceptance, adding Sprint 4 concurrency coverage, and pulling chain selection + `get_status` durability strategy into Sprint 2.

Findings JSON: `grimoires/loa/a2a/gpt-review/{prd,sdd,sprint}-findings-*.json`.

## Questions for @deep-name

1. **Boundary.** Does the Finn runtime own distillation, or should distillation live partly in Dixie (memory product) with Finn only providing storage + commitment plumbing?
2. **Hounfour gating.** Do we wait for `loa-hounfour#57` to fully ratify before opening Sprint 2, or is the "Hounfour-published shadow types under stability window" path acceptable?
3. **Rollout posture.** Is disabled-by-default behind a per-tenant flag the right Sprint 3 default, or do we want shadow-mode-only (write-through but never read) until later?
4. **Budget posture.** Is "distinct cost bucket, deny-on-exceed, reserve-then-submit, defense-in-depth orphan GC" the right shape, or do we want soft-warn first?
5. **Existing patterns to extend.** Are there Finn patterns (`src/persistence/` WAL contract, `src/safety/` audit format) that any new memory subsystem MUST extend rather than parallel? See `sdd.md §15` open Q on coordinator location.
6. **Reputation scope.** Is `ReputationAdapter` truly out-of-scope for the first runtime cut, or should at least the slot signature land in Sprint 3 so consumers don't grow parallel reputation paths in Dixie/Freeside?
7. **Identity adapter shape.** `IdentityAdapter` as a single slot vs. typed union (DID / NFT / token-bound)? See `sdd.md §15` open Q.
8. **Audit envelope.** Extend existing `src/safety/` records in place, or wrap into a Hounfour-ratified envelope?

## Review checklist

- [ ] Confirm the Finn / Hounfour / Freeside / Dixie ownership boundary in `issue-map.md`.
- [ ] Confirm the runtime invariants 1–10 above are correctly captured (or revise the PRD/SDD).
- [ ] Confirm the gated sprint sequencing in `sprint-plan.md`.
- [ ] Confirm `loa-hounfour#57` is the right place and shape for the wire-format work.
- [ ] Confirm the disabled-by-default rollout posture and the deferral of any production tenancy to a separate RFC.
- [ ] Confirm the open questions in `prd.md §13`, `sdd.md §15`, and the questions above are the right ones to unblock implementation.
- [ ] Approve or revise this draft.

## Implementation gate

Implementation MUST NOT start until:

1. @deep-name approves this draft PR or comments with the desired execution path.
2. `loa-hounfour#57` reaches one of the two accepted terminal states defined in `sprint-plan.md` Sprint 1 Acceptance.
3. The Finn / Hounfour / Freeside / Dixie boundary in `issue-map.md` is confirmed.

After all three are met, Sprint 1 (Hounfour protocol decision sync) opens; Sprint 3 (first sprint to touch `src/`) opens only after Sprint 2 closes with the interface-freeze and chain-strategy artifacts in place.
