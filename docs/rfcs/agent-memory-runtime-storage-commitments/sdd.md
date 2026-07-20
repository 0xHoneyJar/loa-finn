# SDD — Agent Memory Runtime + Storage Commitments (Finn Layer 3)

**Status:** Draft only. Do not implement before @deep-name review.
**Slug:** `agent-memory-runtime-storage-commitments`
**Parent:** `0xHoneyJar/loa-dixie#89` · **Hounfour:** `0xHoneyJar/loa-hounfour#57` · **Finn:** `0xHoneyJar/loa-finn#155`

> This SDD describes runtime architecture **at the interface level only**. It does not define wire-format types, file paths under `src/`, or specific technology choices. All wire-format types — including any field-level shape — are owned by `loa-hounfour#57`. Adapter slot type signatures referenced here are placeholders pending Hounfour ratification.

## 1. Current Finn architecture grounding

Existing Finn subsystems this RFC interacts with (read-only summary, not authoritative):

| Subsystem | Existing role | Interaction in this RFC |
|---|---|---|
| `src/gateway/` | HTTP/WS, JWT auth, rate limiting | Internal RPC wiring only; **no public REST/HTTP shape defined here.** |
| `src/hounfour/` | Model routing, `BudgetEnforcer`, JWT/tenant capability, tool orchestration, pool registry | Memory + commitment ops flow through `BudgetEnforcer` and tenant capability checks. No new auth path. |
| `src/agent/` | Tool sandbox, worker pool | Distillation jobs run inside the existing sandbox boundary. |
| `src/persistence/` | WAL, R2 sync, Git sync, recovery, pruning | **Primary integration.** Memory mutations and commitment state-machine transitions are WAL-backed; recovery replays via existing path. |
| `src/cron/`, `src/scheduler/` | Periodic tasks, circuit breakers, health | Distillation cadence and commitment batching live here, with circuit-breaker isolation per adapter. |
| `src/safety/` | Audit trail, firewall, redaction, tool registry | Every memory mutation and every commitment transition is an audit event subject to existing redaction. |
| `src/billing/`, `src/x402/` | Billing finalization, pay-per-call | Commitment txs are a distinct cost bucket; reservations are WAL-persisted alongside `CommitmentId`. |

The runtime additions in this SDD are **interface slots** that compose with the above; they do not replace or fork any existing subsystem.

## 2. Layers affected

- **Gateway:** internal RPC entry only (no public shape).
- **Orchestration (`src/hounfour/`):** capability + budget integration.
- **Scheduling (`src/cron/`, `src/scheduler/`):** distillation cadence + commitment batching with circuit breakers.
- **Persistence (`src/persistence/`):** WAL-backed state machine and reservation records.
- **Safety (`src/safety/`):** audit + redaction.
- **Sandbox (`src/agent/`):** distillation execution boundary.

## 3. Proposed architecture (interface view)

The runtime gains six **adapter slots** and one **internal coordinator**, all behind interface boundaries. All adapter type signatures and event payload types are referenced — not defined — pending `loa-hounfour#57`.

### 3.1 Adapter slots (Hounfour-owned types)

| Slot name | Responsibility | Wire types owned by |
|---|---|---|
| `MemoryDistiller` | Run distillation prompts inside the existing sandbox; produce typed artifacts. Input: raw event stream; output: distilled artifact. | `loa-hounfour#57` |
| `StorageAdapter` | Persist artifact bytes; return a typed pointer. Concrete backends (hot DB / vector / encrypted blob / decentralized) are configuration. | `loa-hounfour#57` (`StoragePointer`) |
| `ChainCommitmentAdapter` | Submit a compact reference (CID/hash/Merkle root) under a stable `CommitmentId`. Must be safe to retry; dedupes by `CommitmentId`. **Must also expose a reconciliation primitive** `get_status(commitment_id) -> { none \| submitted(handle) \| confirmed(receipt) \| failed(reason) }` so recovery can distinguish "already submitted" from "never submitted." If a backend cannot natively query (e.g., a chain with no per-key status), the adapter MUST maintain its own durable idempotency/status store keyed by `CommitmentId` behind the adapter boundary. EVM and non-EVM chains are interchangeable through this contract. | `loa-hounfour#57` (`ChainCommitment`) |
| `IdentityAdapter` | Resolve agent identity for an op (DID / NFT / token-bound account / smart account). Composes with existing JWT/tenant capability — does not replace it. | `loa-hounfour#57` (`AgentIdentity`) |
| `AccessPolicyAdapter` | Decide whether the resolved identity is permitted to read/write a given memory artifact under the given visibility. | `loa-hounfour#57` (`AccessPolicy`) |
| `ReputationAdapter` | Append-only reputation/validation events. Out of scope for first sprint; slot reserved. | `loa-hounfour#57` (`ReputationEvent`, `ValidationRecord`) |

### 3.2 Internal coordinator (Finn-internal, no shared schema)

A `MemoryCommitCoordinator` orchestrates the commitment lifecycle.

**`CommitmentId` derivation is a hard invariant, not an open question.** It is deterministically derived from `(tenant_id, environment, artifact_identity, commitment_intent)`. The tenant component is required: dedupe is **per-tenant (per capability realm)**, never global, even if artifact bytes are identical across tenants. This isolates multi-tenant concerns at the adapter dedupe layer and prevents one tenant's commitment from suppressing another's.

**Reservation is also a first-class WAL-backed transition.** The coordinator obtains a `ReservationId` from `BudgetEnforcer.reserve(commitment_id, tenant, bucket, estimate)`, which MUST be idempotent on `commitment_id` (replay returns the existing `ReservationId` rather than creating a new reservation). The `prepared` WAL record includes both `CommitmentId` and `ReservationId`.

Lifecycle:

1. Compute `CommitmentId` (deterministic, tenant-scoped).
2. WAL-persist `reservation_pending(CommitmentId, tenant, bucket, estimate)` durably **and** emit the corresponding audit event durably. This is the **first durable boundary**, recorded **before** any call to `BudgetEnforcer`. The `reservation_pending` record is what makes orphan reservations recoverable: any reservation that exists in `BudgetEnforcer` without a matching `reservation_pending` (or later) WAL record is, by definition, orphaned and subject to reclamation (see §6 / §8).
3. Call `BudgetEnforcer.reserve(commitment_id, tenant, bucket, estimate)` — idempotent on `commitment_id` — to obtain `ReservationId`.
4. WAL-transition `reservation_pending → prepared(CommitmentId, ReservationId, artifact_ref, target_adapter)` durably **and** emit the corresponding audit event durably **before** any external side effect (see §7).
5. Call `ChainCommitmentAdapter.submit(commitment_id, payload)`.
6. WAL-transition through `prepared → submitted → confirmed | failed | needs_manual_review`, with the WAL transition and audit event durable **before** each external side effect.
7. On replay, the coordinator rehydrates strictly by `(CommitmentId, ReservationId)` — it never creates a new reservation outside the idempotent `reserve()` call, and it queries `ChainCommitmentAdapter.get_status(commitment_id)` to choose between "transition WAL to match adapter" and "re-submit with the existing reservation."

The coordinator is Finn-internal; its persisted record format is **not** a shared protocol type and lives in Finn's existing WAL.

## 4. Commitment state machine

```
                              ┌─────────────────────┐ reserve() ok  ┌──────────┐  submit()   ┌───────────┐  confirm  ┌───────────┐
 trigger ─────────────────►   │ reservation_pending │ ────────────► │ prepared │ ──────────► │ submitted │ ────────► │ confirmed │ (terminal)
                              └──────────┬──────────┘               └────┬─────┘             └─────┬─────┘           └───────────┘
                                         │                                │                         │
                                         │ reserve() denied (cap)         │ adapter rejects         │ adapter / chain reports terminal failure
                                         ▼                                ▼                         ▼
                                     ┌────────┐                       ┌────────┐                ┌────────┐
                                     │ failed │ (terminal)            │ failed │ (terminal)     │ failed │ (terminal)
                                     └────────┘                       └────────┘                └────────┘

                          (any non-terminal state)
                                  │
                                  │ reservation missing/corrupt OR adapter status indeterminate OR reserve() unrecoverable error
                                  ▼
                          ┌──────────────────────┐
                          │ needs_manual_review  │ (terminal until operator action)
                          └──────────┬───────────┘
                                     │
                          ┌──────────┴───────────┐
                          │                      │
                  manual_resolve          manual_cancel
                  (same ReservationId)    (release reservation)
                          │                      │
                          ▼                      ▼
                     ┌──────────┐            ┌────────┐
                     │ prepared │            │ failed │
                     └──────────┘            └────────┘
```

Invariants:

1. `CommitmentId` is deterministically derived from `(tenant_id, environment, artifact_identity, commitment_intent)`. Dedupe is per-tenant; never global.
2. **`reservation_pending` is the first durable Finn-side state** for a commitment. It is persisted in WAL **and** audited durably **before** any call to `BudgetEnforcer.reserve()` is initiated. This makes orphan reservations recoverable: any reservation in `BudgetEnforcer` lacking a matching `reservation_pending`-or-later WAL record is, by definition, orphaned.
3. `BudgetEnforcer.reserve(commitment_id, …)` is **idempotent on `commitment_id`** and returns a stable `ReservationId`. Replay never creates a new reservation, and re-entry from `reservation_pending` calls the same idempotent API.
4. The `prepared` WAL record (including `CommitmentId` and `ReservationId`) and the corresponding audit event are persisted durably **before any external side effect downstream of `prepared`** (e.g., `submit`). For asynchronous side effects, the durable enqueue point is the side-effect boundary. `reserve()` itself is also treated as a side-effect boundary in §7 because it can mutate `BudgetEnforcer` durable state.
5. `submit(commitment_id, payload)` is idempotent — replay never produces a second on-chain submission for the same `CommitmentId`, regardless of whether the prior tx hash is known.
6. Adapter dedupe mechanism is implementation-defined per adapter (nonce reservation, adapter-side idempotency store, or on-chain uniqueness guard) but the runtime contract is fixed: `submit` is idempotent and `get_status(commitment_id)` is queryable.
7. `needs_manual_review` is a **terminal state until operator action**. From it: no automated `submit`. The reservation (if any) is held with an explicit configurable TTL; on TTL expiry the reservation MUST be released with an audit event. Operator transitions:
   - `manual_resolve` → `prepared` (with the same `ReservationId`, no new reservation, no cap re-check beyond reservation already held).
   - `manual_cancel` → `failed` (reservation released with audit event).
8. Reservation release on `failed`: the coordinator releases the reservation back to the budget bucket with an audit event. Reservation release on `confirmed`: actual cost is debited from the reservation; any difference is reconciled against the bucket with an audit event.
9. Missing/corrupt WAL reservation at replay → coordinator transitions to `needs_manual_review` (no submission, no fresh authorization, no cap bypass).
10. **Defense-in-depth orphan GC.** `BudgetEnforcer` MUST also enforce an intrinsic reservation lease: any reservation not bound to a WAL `reservation_pending`-or-later record within a configurable window MUST be reclaimed with an audit event. This protects against client abandonment, gateway timeouts, and one-shot requests where retry never happens.

## 5. Data flow (read and write)

### 5.1 Memory write path

```
caller (Freeside / Dixie / internal observer)
      │
      ▼
gateway internal RPC ─▶ JWT/tenant capability check
      │
      ▼
IdentityAdapter ─▶ resolves agent identity
      │
      ▼
AccessPolicyAdapter ─▶ permits / denies
      │
      ▼
MemoryDistiller (inside sandbox) ─▶ typed artifact
      │
      ▼
StorageAdapter ─▶ pointer
      │
      ▼  (only if artifact is commitment-eligible)
MemoryCommitCoordinator
      │
      ├─▶ derive CommitmentId = f(tenant_id, environment, artifact_identity, intent)
      ├─▶ WAL.write(reservation_pending{CommitmentId, tenant, bucket, estimate})    ┐ both durable
      ├─▶ Audit.write(reservation_pending{CommitmentId, redaction(visibility)})     ┘ BEFORE any reserve() call
      ├─▶ BudgetEnforcer.reserve(CommitmentId, tenant, commitment_bucket, estimate) → ReservationId   (idempotent on CommitmentId; side-effect boundary per §7)
      ├─▶ WAL.transition(prepared{CommitmentId, ReservationId, artifact_ref, target_adapter})  ┐ both durable
      ├─▶ Audit.write(prepared{CommitmentId, ReservationId, redaction(visibility)})            ┘ before submit()
      ├─▶ ChainCommitmentAdapter.submit(CommitmentId, payload)                                        ← side-effect boundary
      ├─▶ WAL.transition(submitted)         + Audit.write(submitted)
      └─▶ on confirmation: WAL.transition(confirmed) + Audit.write(confirmed)
                                                            (reservation reconciled to actual cost)

(audit event emitted before every side effect and at every transition; redaction applied per artifact visibility)
```

### 5.2 Memory read path

```
caller
  │
  ▼
gateway internal RPC ─▶ JWT/tenant capability check
  │
  ▼
IdentityAdapter ─▶ resolves agent identity
  │
  ▼
AccessPolicyAdapter ─▶ permits / denies
  │
  ▼
StorageAdapter ─▶ artifact bytes (decrypted by access-control layer if private)
  │
  ▼
caller
```

## 6. Budget / cost integration

- Commitment cost is a **distinct bucket** in `BudgetEnforcer`, separate from model spend.
- Storage I/O and embedding cost are accounted into existing buckets where applicable.
- Per-tenant caps apply; default policy is **deny-on-exceed**, not soft warn.
- **Idempotent reservation API.** `BudgetEnforcer.reserve(commitment_id, tenant, bucket, estimate)` is idempotent on `commitment_id` and returns a stable `ReservationId`. Replay calls return the existing `ReservationId`; no second reservation is ever created.
- **Pre-reserve durability boundary.** A `reservation_pending(CommitmentId, tenant, bucket, estimate)` WAL record AND its audit event are persisted durably **before** `reserve()` is invoked. Without this pre-state, a crash between `reserve()` and the `prepared` write could leave a budget-deadlocking orphan with no Finn-side trace.
- **Reserve-then-submit, WAL-bound.** Both `CommitmentId` and `ReservationId` are persisted in the `prepared` WAL record durably (along with the corresponding audit event) **before** any external side effect. Submission and replay consume the existing reservation; no fresh authorization on replay.
- **Orphan reservation GC (defense-in-depth).** `BudgetEnforcer` MUST enforce an intrinsic lease on every reservation: any reservation lacking a matching WAL `reservation_pending`-or-later record within a configurable window MUST be reclaimed with an audit event. This protects against gateway timeouts, client abandonment, and one-shot requests that never retry.
- **Reservation release rules.**
  - On `confirmed`: actual cost is debited from the reservation; any delta is reconciled against the bucket with an audit event.
  - On `failed`: the full reservation is released back to the bucket with an audit event.
  - On `needs_manual_review`: the reservation is held under an explicit configurable TTL; on TTL expiry, the reservation MUST be released with an audit event (operator can still resolve manually before TTL). On `manual_resolve`: reuse the same `ReservationId`; no cap re-check beyond what is already held. On `manual_cancel`: release the reservation with an audit event.
- **Fail-closed reservation loss.** If the WAL-persisted reservation is missing or corrupt at replay, the coordinator transitions to `needs_manual_review` — no submission, no fresh authorization, no cap bypass.
- Estimated cost is surfaced before submit; actuals are appended to the audit trail.

## 7. Audit trail integration

Every memory mutation and every commitment state transition is an append-only audit event:

- Existing `src/safety/` audit format is extended (or wrapped) to include the `CommitmentId` and state transition. Any field-level shape required for cross-service audit interop is escalated to `loa-hounfour#57`; Finn-internal fields stay Finn-internal.
- Redaction rules apply per artifact visibility:
  - `public` — full record.
  - `public_pointer_private_content` — pointer + commitment fields visible; payload bytes redacted.
  - `private` — pointer + commitment fields redacted to authorized identities only.
- **Write-ahead audit invariant.** For each external side effect, the corresponding WAL transition AND audit event MUST be persisted durably **before the side effect is initiated** — not merely before it is acknowledged to the caller. Acknowledgment is downstream of durability. For asynchronous side effects, the durable enqueue point is the side-effect boundary; the WAL+audit pair MUST be durable before enqueue. Side-effect boundaries explicitly include:
  - `BudgetEnforcer.reserve()` — preceded by a durable `reservation_pending` WAL record and audit event.
  - `StorageAdapter` write — preceded by a durable WAL transition and audit event.
  - `ChainCommitmentAdapter.submit()` — preceded by a durable `prepared` WAL record and audit event for that `CommitmentId`.
  - Reservation release (any path) — preceded by a durable WAL transition and audit event.

## 8. Persistence / recovery

- WAL records: `MemoryArtifactWrite`, `ReservationPending`, `CommitmentTransition`, `ReservationLifecycle`. (Finn-internal record schemas; not shared protocol types.)
- WAL is the source of truth for in-flight commitments; R2/Git sync follows existing semantics.
- Recovery rules (the adapter's `get_status(commitment_id)` is mandatory and is the reconciliation primitive):
  1. On startup, scan WAL for commitments not in a terminal state.
  2. **`reservation_pending` recovery:** if the latest record is `reservation_pending` (no matching `prepared`), call `BudgetEnforcer.reserve(commitment_id, …)` — idempotent — to obtain or rehydrate the `ReservationId`, then transition WAL to `prepared`. If `reserve()` fails for cap/policy reasons, transition to `failed` (no reservation was created so nothing to release). If `reserve()` is unavailable or returns an indeterminate error, transition to `needs_manual_review`.
  3. For commitments in `prepared` or later, call `ChainCommitmentAdapter.get_status(commitment_id)`.
  4. If `get_status` returns `submitted(handle)` or `confirmed(receipt)`, transition the WAL to match — **never re-submit**.
  5. If `get_status` returns `failed(reason)`, transition WAL to `failed` and release the reservation per §6.
  6. If `get_status` returns `none` and the WAL reservation is intact, re-submit (consuming the existing `ReservationId`).
  7. If `get_status` is unavailable (adapter outage / indeterminate response), transition to `needs_manual_review` — never re-submit blind.
  8. If the WAL reservation is missing/corrupt, transition to `needs_manual_review` — never submit, never authorize fresh spend.
- **Orphan reservation reclamation.** Independently of WAL recovery, `BudgetEnforcer` GC reclaims any reservation lacking a matching WAL `reservation_pending`-or-later record within the configured lease window, with an audit event.
- `needs_manual_review` recovery: the reservation TTL clock is in WAL; on expiry, release the reservation with an audit event and leave the commitment in `needs_manual_review` until operator action.
- Pruning honors retention policy per artifact type and visibility.

## 9. Failure isolation / circuit breakers

- Each adapter slot is wrapped by an existing-pattern circuit breaker. A failing storage or commitment backend MUST NOT cascade into model routing or tool execution.
- Distillation jobs run with bounded concurrency in the existing worker pool.
- Reflective-memory recursion is bounded by a configurable max-depth; default conservative.

## 10. Security boundaries

- **Sandbox:** distillation runs inside the existing tool sandbox. Tool output and raw events are untrusted inputs subject to redaction before being prompted into a distillation model.
- **Signing keys:** keys used by `ChainCommitmentAdapter` MUST NOT co-locate with model output paths. The adapter signs only audited, policy-approved payloads.
- **Encryption-at-rest:** any artifact tagged `private` is encrypted before being handed to `StorageAdapter`; key custody lives outside Finn (existing access-control layer).
- **Public-by-default:** CIDs and metadata published to public networks (e.g., IPFS gossip) are public-by-default; this fact is documented in audit output.
- **Identity composition:** `IdentityAdapter` resolves identity but does **not** replace JWT/tenant capability checks — both gate every op.

## 11. Cross-repo dependency order

1. **`loa-hounfour#57` ratifies** (or explicitly defers to consumer-local) the relevant wire-format types: `MemoryArtifact`, `MemoryCommitment` / `ChainCommitment`, `AgentIdentity`, `AccessPolicy`, `StoragePointer`, plus deferred `ReputationEvent` / `ValidationRecord`.
2. **Finn Sprint 0** — boundary review (this RFC).
3. **Finn Sprint 1** — shadow-mode runtime (writes only, no reads, no consumer integration).
4. **Finn Sprint 2** — recovery + replay tests; commitment dedupe under crash injection.
5. **Freeside / Dixie** — consumer integration after Hounfour ratifies and Finn shadow is stable.
6. **`loa-main`** — eval suites for memory-recall fidelity and commitment integrity.

## 12. Test strategy (specified at interface level only; implementation deferred)

- **Unit-level (sandbox):** distillation prompt sanitization; reflective-memory depth bound.
- **Property-level:** `CommitmentId` is deterministic for a given artifact + intent; replay never produces a second on-chain submission for the same `CommitmentId`.
- **Crash injection:** kill before WAL prepare → no side effect, no spend; kill mid-`submit` → replay does not double-submit; kill after submit, before confirm → replay confirms via adapter lookup, not re-submit; corrupt WAL reservation → fail closed.
- **Budget:** deny-on-exceed honored at `prepared`; replay consumes reservation; cap-exceeded mid-replay does not bypass.
- **Audit:** every transition emits an event; redaction matches visibility tag.
- **Circuit-breaker:** failing `StorageAdapter` or `ChainCommitmentAdapter` does not cascade into model routing.

Concrete test files, test-harness names, and per-adapter conformance suites are not specified here — they will be defined in the implementation sprint after planning approval.

## 13. Rollout mode

- **Default: disabled-by-default**, behind a per-tenant flag. No production tenant is enrolled at first ship.
- **Sprint 1:** shadow-mode write path only — distillation + storage write happen, but reads to consumers are stubbed out and commitment is dry-run (no chain tx).
- **Sprint 2:** add real commitment submission for a single internal tenant under a hard per-tenant cap.
- **Later sprints:** consumer integration, real reads, broadened tenancy — only after explicit @deep-name approval.
- No flag flipping in this RFC.

## 14. What this SDD does NOT specify

- No file paths under `src/` are created.
- No wire-format types are defined; Hounfour owns them via `loa-hounfour#57`.
- No specific chain is selected.
- No specific decentralized storage provider is selected.
- No specific identity issuer (DID/NFT/VC) is selected.
- No public HTTP/REST endpoints are defined.
- No package, lockfile, migration, deploy, or `.claude/` change is implied.
- No skill, slash command, or eval-harness change is implied (would belong to `loa-main`).

## 15. Open design questions for @deep-name

1. Is the `MemoryCommitCoordinator` a new module within `src/persistence/` (since it owns WAL semantics), or a separate top-level under `src/memory/`? Both are viable; prefer the answer that minimizes blast radius on existing WAL invariants.
2. Should `IdentityAdapter` be a single slot or a typed union (one adapter per identity class — DID vs NFT vs token-bound)? Single slot keeps the runtime simple; typed union gives Hounfour cleaner schema slots.
3. Audit format: extend existing `src/safety/` records in place, or wrap into a typed envelope? Wrapping is safer for cross-service interop but requires Hounfour ratification of the envelope.
4. Is `ReputationAdapter` truly out-of-scope for the first runtime cut, or should at least the slot signature land so consumers don't grow parallel reputation paths in Dixie/Freeside?
5. What is the appropriate default reservation TTL for `needs_manual_review`, and where does it live (per-tenant config, global default, or per-bucket)?

> Note: `CommitmentId` tenant-scoping is now an invariant (§3.2 / §4) rather than an open question — dedupe is per-tenant, never global.
