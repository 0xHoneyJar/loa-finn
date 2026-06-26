# PRD — Agent Memory Runtime + Storage Commitments (Finn Layer 3)

**Status:** Draft only. Do not implement before @deep-name review.
**Slug:** `agent-memory-runtime-storage-commitments`
**Parent:** `0xHoneyJar/loa-dixie#89` · **Hounfour:** `0xHoneyJar/loa-hounfour#57` · **Finn:** `0xHoneyJar/loa-finn#155`

## 1. Runtime problem

Agents in the Loa stack today have no first-class, runtime-owned way to:

1. Distill raw runtime events (model calls, tool calls, audit records, agent observations) into structured memory.
2. Persist that memory through pluggable storage backends with explicit visibility/encryption posture.
3. Anchor memory artifacts on a chain-agnostic commitment layer (CIDs, hashes, Merkle roots) without putting raw memory on chain.
4. Account for memory-related cost (storage I/O, embedding compute, commitment tx fees) through the existing Finn budget path.
5. Audit and recover memory mutations through existing WAL / R2 / Git sync paths.

In the absence of this, every consumer (Dixie product surface, Freeside community surface, future dNFT runtimes) will solve memory ad-hoc, and Finn will accumulate de-facto protocol leakage through internal types that escape into shared use without `loa-hounfour` ratification.

## 2. Goal (Finn-scoped)

Define the **runtime contract** by which Finn ingests, distills, persists, commits, and replays agent memory artifacts — entirely behind interface boundaries, with all wire-format types deferred to `loa-hounfour#57`.

## 3. Subsystems affected

| Finn subsystem | Affected? | How |
|---|:-:|---|
| `src/gateway/` | Possible (internal wiring only) | Internal runtime interface for memory submission/retrieval, routed through existing JWT / tenant-capability checks. No new auth path. **Finn does not define public HTTP/REST shape here** — public API surface is owned by Freeside/Dixie and any wire type is owned by `loa-hounfour#57`. |
| `src/hounfour/` (router/budget/JWT/tools) | Yes | Memory ops must flow through `BudgetEnforcer` and tenant capability checks. |
| `src/agent/` (tool sandbox / worker pool) | Yes | Distillation jobs run inside the existing sandbox; reflective memory loops may not bypass the sandbox boundary. |
| `src/persistence/` (WAL / R2 / Git sync / recovery / pruning) | **Yes — primary** | Memory writes and pending commitments must use WAL semantics; recovery must replay pending commitments idempotently. |
| `src/cron/` and `src/scheduler/` | Yes | Distillation cadence + commitment batching are scheduler concerns; circuit breakers must isolate failures. |
| `src/safety/` (audit / firewall / redaction) | Yes | Every memory mutation and every commitment is an audit event; redaction rules must apply to private artifacts. |
| `src/billing/`, `src/x402/` | Yes | Per-tenant cost attribution for memory ops; commitment txs as a distinct cost bucket. |
| `src/bridgebuilder/` | No | Out of scope for this RFC. |
| `src/nft/` | Possible | Identity hooks may interoperate with NFT/persona runtime, but identity issuance is out of scope. |
| `src/learning/` | Possible | Distilled memory may feed compound learning loops in a later sprint. |
| `schemas/` | **No** | Wire-format types belong in `loa-hounfour` (`#57`), never here. |

## 4. Inputs and outputs (boundary view, schemas owned by `loa-hounfour#57`)

| Direction | Counterparty | Operation (conceptual) | Wire-format owner |
|---|---|---|---|
| In | Freeside / API / bot surface | "store memory artifact for agent X with visibility V and policy P" | `loa-hounfour#57` |
| In | Dixie product BFF | "fetch latest committed memory pointer for agent X" / "list agent reputation events" | `loa-hounfour#57` |
| In | Internal Finn observers | distillation triggers from existing audit/tool/model events | Finn-internal (no shared schema) |
| Out | Storage backend (decentralized or private) | encrypted/unencrypted blob upload, returns pointer | `loa-hounfour#57` (`StoragePointer`) |
| Out | Chain commitment layer | tx with compact reference (CID/hash/root) | `loa-hounfour#57` (`ChainCommitment`) |
| Out | Audit trail | mutation/commitment event | Existing Finn audit format; Hounfour ratification recommended |
| Out | Reputation surface | reputation/validation record | `loa-hounfour#57` (`ReputationEvent`, `ValidationRecord`) |

Finn implements interfaces; **Hounfour ratifies the wire shape.** This PRD does not pin field names.

## 5. Proposed runtime behavior

Finn must support the following capabilities behind interface boundaries, **disabled-by-default** until @deep-name approves rollout:

1. **Memory ingestion** — accept distillation triggers from runtime observers; place jobs on the existing scheduler/worker-pool, with circuit-breaker isolation per tenant.
2. **Memory distillation** — run distillation prompts inside the existing tool sandbox; produce typed artifacts (episode summary, reflection, skill, policy) whose **schema is defined in `loa-hounfour#57`**.
3. **Memory persistence** — route artifacts through a `StorageAdapter` slot; choice of concrete backend (hot DB, vector, encrypted blob, decentralized) is a configuration concern, not a code-path concern.
4. **Memory commitment** — when an artifact is policy-marked commitment-eligible, emit a compact reference through a `ChainCommitmentAdapter` slot; the adapter abstracts EVM and non-EVM chains. Each commitment is identified by a **stable, deterministic `CommitmentId`** (derived from artifact identity + commitment intent), assigned and WAL-persisted **before any submission**. A commitment moves through an explicit state machine `prepared → submitted → confirmed | failed`. The adapter contract is `submit(commitment_id, payload)` and MUST be safe to retry: dedupe by `CommitmentId` (via nonce reservation, adapter-side idempotency store, or on-chain uniqueness guard). Replay MUST NEVER cause a second on-chain submission for the same `CommitmentId`, even if the prior submission's tx hash is unknown.
5. **Identity and access** — every memory op is gated by an `IdentityAdapter` + `AccessPolicyAdapter` slot, which compose with existing JWT/tenant capability checks; this RFC does not introduce a parallel auth path.
6. **Cost accounting** — every storage write, embedding, and commitment tx flows through `BudgetEnforcer`; commitment txs are a distinct cost bucket from model spend, with per-tenant caps. **Reserve-then-submit semantics**: budget is reserved/escrowed at the `prepared` state (before any submission) and the reservation is persisted in WAL alongside the `CommitmentId`. Submission and replay consume the existing reservation rather than re-authorizing fresh spend. If the reservation is missing or corrupt at replay time, the job MUST fail closed (mark `needs_manual_review`, do not submit) rather than re-authorize or bypass the cap.
7. **Audit and recovery** — every memory mutation and every commitment is an append-only audit event subject to existing redaction rules; pending commitments are WAL-backed and replayed idempotently after crash.

All adapter slot types and event payload types are **referenced**, not defined, in this RFC.

## 6. Cross-repo impact

| Repo | Impact | Why |
|---|---|---|
| `loa-main` | Possible | Future eval suites for memory-recall fidelity and commitment integrity. Out of scope for first Finn sprint. |
| `loa-hounfour` | **Required first** | Schema/contract ownership: `MemoryArtifact`, `MemoryCommitment`, `AgentIdentity`, `AccessPolicy`, `ReputationEvent`, `ValidationRecord`, `StoragePointer`. Tracked in `loa-hounfour#57`. |
| `loa-finn` | **Required** | This RFC. Runtime distillation, adapter slots, cost accounting, audit, recovery. |
| `loa-freeside` | Possible | Provenance UI, holder-gated decryption UX, transparency panels. After Hounfour ratifies. |
| `loa-dixie` | Required (parent) | Product narrative, oracle/knowledge integration, agent reputation product semantics. Tracked in `loa-dixie#89`. |

## 7. Hounfour protocol question

This PRD **does not** define wire-format schemas. Open questions for `loa-hounfour#57`:

1. Is `MemoryArtifact` a single canonical type with a discriminator (`episode_summary` / `reflection` / `skill` / `policy`), or one type per memory class?
2. Are storage pointers consumer-local or canonical? (Recommendation: canonical, because Dixie and Freeside both consume them.)
3. Does `ChainCommitment` enumerate chains, or is it chain-opaque with an adapter-supplied identifier?
4. Are `ReputationEvent` and `ValidationRecord` in scope for the first Hounfour cut, or deferred until memory + commitment is stable?
5. Compatibility posture: additive optional fields only (minor bump) for the first cut?

If Hounfour chooses consumer-local types for any of the above, this PRD will be revised before Finn implementation begins.

## 8. Cost / budget risks

- **Chain commitment fees** are an unbounded cost surface if not capped. Default policy MUST be deny-on-exceed per tenant, not soft warn.
- **Embedding / distillation cost** scales with raw event volume. Default cadence MUST be batched and rate-limited; per-tenant caps apply.
- **Decentralized storage pin/upload fees** are real for IPFS pinning services and Arweave. The runtime MUST surface estimated cost before commit and account actuals to the audit trail.
- **Recovery cost** — replay of pending commitments after crash MUST be idempotent on the stable `CommitmentId` (no double-submission on chain) and MUST consume the WAL-persisted budget reservation rather than re-authorizing fresh spend; if the reservation is missing/corrupt, fail closed (no submission, mark `needs_manual_review`).
- **Default posture:** every memory feature ships **disabled-by-default**, behind a tenant flag, until @deep-name approves rollout.

## 9. Security / sandbox risks

- **Distillation prompt injection.** Distillation prompts consume tool output and raw events; both are untrusted. Distillation MUST run inside the existing sandbox and MUST sanitize inputs through existing redaction rules.
- **Reflective memory loops.** Reflections derived from prior reflections can amplify injected instructions across sessions. Mitigation: sandboxed distillation, rate limits, audit, and a configurable max-depth.
- **Signing key separation.** Keys used by `ChainCommitmentAdapter` MUST NOT co-locate with model output paths; the adapter signs only audited, policy-approved payloads.
- **Private memory leakage.** "Public pointer / private content" is the safe default for any user-derived memory; encryption-at-rest with key custody outside Finn for any artifact tagged `private`. CIDs and metadata are public-by-default on IPFS — this MUST be documented in audit output.
- **Replay / idempotency.** Idempotency is keyed on a stable, deterministic `CommitmentId` written to WAL **before** submission, not on tx hash. A crashed-after-sign / before-confirmation case can legitimately produce a different tx hash on replay; the adapter MUST dedupe by `CommitmentId` (nonce reservation, adapter-side idempotency store, or on-chain uniqueness guard) so replay never causes a second on-chain submission. State machine: `prepared → submitted → confirmed | failed`, persisted in WAL at every transition.
- **Persistence corruption.** Memory writes MUST NOT compromise existing WAL invariants; recovery tests MUST cover crash mid-distillation, mid-write, and mid-commit.
- **Circuit breaker behavior.** A failing storage or commitment backend MUST NOT cascade into model routing or tool execution; failures isolate per adapter.

## 10. Non-goals

- No on-chain LLM / on-chain inference.
- No wire-format schema definitions in this repo (owned by `loa-hounfour#57`).
- No new public product API (owned by Freeside / Dixie).
- No identity issuance — DID/VC issuance lives elsewhere.
- No reputation scoring algorithm choice — runtime enforces records; scoring policy is product-level.
- No specific chain selection — adapter slot only.
- No specific decentralized storage provider lock-in.
- No `.claude/` edits, no migrations, no deploy/infra, no package/lockfile changes.
- No Bridgebuilder / run-bridge / `/run` for this RFC.

## 11. Acceptance criteria — planning phase

- [ ] @deep-name reviews this PRD and the accompanying SDD + sprint plan.
- [ ] `loa-hounfour#57` ratifies (or explicitly defers) the relevant wire-format types.
- [ ] Cross-repo ownership in `issue-map.md` is confirmed.
- [ ] Default rollout posture is agreed (disabled / shadow / parallel / enforce-later).
- [ ] Budget/audit/recovery contracts agreed at interface level before any implementation sprint opens.

## 12. Acceptance criteria — implementation phase (deferred, not for this PR)

To be re-confirmed after planning approval:

- [ ] Memory distillation runs inside existing tool sandbox; recovery tests pass for crash mid-distillation, mid-write, mid-commit, and mid-confirmation.
- [ ] Every commitment has a stable `CommitmentId` written to WAL before submission; the state machine `prepared → submitted → confirmed | failed` is enforced and persisted at every transition.
- [ ] Replay never causes a second on-chain submission for the same `CommitmentId`, regardless of whether the prior tx hash is known.
- [ ] All memory ops flow through `BudgetEnforcer` with per-tenant caps; commitment cost is a distinct bucket; budget is reserved at `prepared` and replay consumes the existing reservation.
- [ ] If a budget reservation is missing/corrupt at replay, the job fails closed (`needs_manual_review`) — never re-authorizes, never bypasses the cap.
- [ ] All memory mutations and commitments appear in the audit trail with redaction applied to private artifacts.
- [ ] Adapter slots are pluggable; no concrete chain or storage provider is wired into the runtime by default.
- [ ] Disabled-by-default in production until explicit enablement.

## 13. Open questions for @deep-name

1. Should distillation live in Finn, or split across Finn (storage/commitment) and Dixie (memory product)?
2. Wait for `loa-hounfour#57` to fully resolve before opening Finn Sprint 1, or run in parallel with placeholder types?
3. First-rollout posture — disabled-by-default, shadow, or parallel?
4. Commitment-cost budget shape — distinct bucket with hard cap and deny-on-exceed?
5. Existing patterns Finn MUST extend (WAL contract, audit format) rather than parallel?
6. Is reputation in scope for the first sprint, or deferred?
