# Research Packet — Agent Memory Runtime + Storage Commitments (Finn-scoped)

**Status:** Draft only. Do not implement before @deep-name review.

## 1. Source links

- Source context (this directory): `source-context.md`
- Parent product/research issue: `0xHoneyJar/loa-dixie#89`
- Hounfour protocol question: `0xHoneyJar/loa-hounfour#57`
- Finn runtime issue: `0xHoneyJar/loa-finn#155`

## 2. Plain-English summary

Agents need memory, but storing every raw log forever (or pushing memory directly on-chain) is expensive, slow, privacy-hostile, and degrades retrieval. The proposed pattern:

- Off-chain agent intelligence (LLM, runtime).
- Tiered memory: working / conversational / semantic / episodic / reflective / procedural / policy.
- Memory distillation pipeline: raw events → episode summaries → reflections → skills → policies → optional commitments.
- Storage placement chosen per memory type (hot DB, vector DB, encrypted private store, IPFS/Arweave/Ceramic/Tableland-class decentralized layers).
- Any suitable chain serves as a **commitment layer** that stores compact pointers (CIDs, hashes, Merkle roots), identity, ownership, permissions, reputation events, and payment/escrow state.

Finn is the **Layer 3 runtime** that executes this pattern: distillation, storage adapters, commitment adapters, identity hooks, permission/audit, cost accounting. Finn does not own the shared schemas, the product narrative, or the community UI.

## 3. Why this matters to Finn

Today, Finn already owns:

- Model routing, budgets, JWT/tenant capability, tool orchestration, pool registry (`src/hounfour/`).
- WAL, R2/Git sync, recovery, pruning (`src/persistence/`).
- Tool sandbox + worker pool (`src/agent/`).
- Cron / scheduler / circuit breakers (`src/cron/`, `src/scheduler/`).
- Audit trail, firewall, redaction (`src/safety/`).
- Gateway HTTP/WS/auth/rate-limit (`src/gateway/`).

Memory + commitment is a natural extension of those subsystems: it touches persistence, audit, budgets, and tool sandbox. Without a deliberate runtime design, the same problem will be solved ad-hoc inside Dixie/Freeside and/or as drive-by additions to Finn's persistence layer, which would (a) create de-facto protocol leaks and (b) bypass budget/audit guardrails.

## 4. Proposed Finn behavior (planning-level only)

Finn should be able to:

1. **Distill** raw runtime events (model calls, tool calls, audit records, agent observations) into typed memory artifacts at runtime, on a configurable cadence and retention policy.
2. **Persist** distilled memory through pluggable storage adapters (hot DB / vector / encrypted blob / decentralized) selected by visibility + memory type, without the runtime knowing which concrete backend is used.
3. **Commit** compact references (CIDs / hashes / Merkle roots) through a chain-agnostic commitment adapter when (and only when) a memory artifact is policy-marked as commitment-eligible.
4. **Authorize** memory reads/writes via identity + access-policy adapters (DID/NFT/token-bound account/VC), routed through existing JWT/tenant capability checks rather than parallel auth.
5. **Account** for memory operations in the existing budget/billing path (storage I/O, embedding cost, commitment tx fee).
6. **Audit** every memory mutation and every commitment in the existing audit trail with redaction rules.
7. **Recover** memory state through existing WAL/R2/Git sync paths, including replay of pending commitments after crash.

All of the above are **interface-level** for this RFC; concrete adapters are out of scope here and will be sequenced later (see `sprint-plan.md`).

## 5. Proposed system inputs/outputs (boundary view)

| Direction | Counterparty | Example payload | Owner of contract |
|---|---|---|---|
| In | Freeside / API / bot surface | "store this memory for agent X, visibility public-pointer-private-content" | Freeside (request) → Hounfour (schema) |
| In | Dixie product BFF | "fetch latest committed memory CID for agent X" | Dixie (request) → Hounfour (schema) |
| Out | Decentralized storage | encrypted blob upload | StorageAdapter contract (Hounfour) |
| Out | Chain commitment layer | tx with CID/hash/Merkle root | ChainCommitmentAdapter contract (Hounfour) |
| Out | Audit trail | mutation event | Existing Finn audit format (may need Hounfour ratification) |

Finn implements; **Hounfour ratifies the wire shape.**

## 6. Repo ownership guess

| Repo | Impact | Why |
|---|---|---|
| `loa-main` | Possible | New eval suites for memory recall + commitment integrity may be desirable. No skill/command changes expected. |
| `loa-hounfour` | **Required first** | Memory artifact schema, commitment record, access-policy contract, identity record, reputation event — all shared. Tracked in `loa-hounfour#57`. |
| `loa-finn` | **Required** | Runtime distillation, storage adapters, commitment adapters, identity hooks, audit, budgets. This RFC. |
| `loa-freeside` | Possible | API/Discord/TG surfaces for "show memory provenance," holder-gated decryption UX, transparency panels. |
| `loa-dixie` | Required (parent) | Product narrative, knowledge/oracle integration, agent reputation product behavior. Already tracked in `loa-dixie#89`. |

## 7. Hounfour / protocol impact

**Yes — Hounfour goes first or alongside.** This RFC explicitly does **not** define schemas in Finn. It references `loa-hounfour#57` for:

- `MemoryArtifact` / `MemorySummary` / `MemoryReflection`
- `MemoryCommitment` / `ChainCommitment`
- `AgentIdentity` / `AgentCredential`
- `AccessPolicy` / `StoragePointer`
- `ReputationEvent` / `ValidationRecord`

If Hounfour decides any of these are consumer-local rather than canonical, this RFC will be revised before implementation.

## 8. Safety / cost / privacy risks

- **Security:** memory mutation API is a high-value injection target; distillation + commitment must run in the existing tool sandbox boundary; signing keys for the chain commitment adapter must never co-locate with model output paths.
- **Cost / budget:** every commitment is a chain tx; every embedding/distillation is a model call; every storage write may be a paid pin/upload. All must flow through `BudgetEnforcer` with per-tenant caps and per-operation accounting. **Default disabled** in production until budget shape is reviewed.
- **Privacy:** "public pointer / private content" is the safe default for any user-derived memory; encryption-at-rest with key custody outside Finn for any artifact tagged `private`. CIDs and metadata are public-by-default on IPFS; this must be documented in audit output.
- **Prompt injection:** distillation prompts must not consume untrusted tool output without sanitization; reflective memory loops can amplify injected instructions across sessions.
- **Cross-repo compatibility:** if Finn ships memory writes before Hounfour ratifies the schema, every consumer (Dixie, Freeside) inherits a de-facto protocol from Finn's internal types. **Must not happen.**
- **Product confusion:** Finn must not gain a "memory product" surface; transparency/UX lives in Freeside/Dixie.

## 9. Non-goals (Finn-scoped)

- No on-chain LLM / on-chain inference.
- No protocol/schema definitions in this repo.
- No new public product API surface.
- No identity issuance (DID/VC issuance lives elsewhere).
- No reputation scoring algorithm choice (Finn enforces records; scoring policy is product-level).
- No specific chain selection — adapter pattern only.
- No deployment/infrastructure changes.
- No `.claude/` edits.
- No migrations, no schema generation, no package/lockfile changes.

## 10. Questions for @deep-name

1. Does the runtime side belong in `loa-finn` at all, or should the distillation pipeline live partly in `loa-dixie` (memory product) with Finn only providing storage/commitment plumbing?
2. Should we wait for `loa-hounfour#57` to resolve before opening any Finn implementation sprint, or run them in parallel with a "shadow types" placeholder?
3. What is the expected default rollout posture — disabled-by-default behind a tenant flag, shadow-mode (write-through but never read), or full-off until first consumer integration?
4. Budget posture: should commitment txs be a separate cost bucket from model spend, and should they have a hard per-tenant cap with deny-on-exceed (vs. soft warn)?
5. Are there existing Finn patterns (e.g. `src/persistence/` WAL contract, `src/safety/` audit trail) that any new memory subsystem MUST extend rather than parallel?
6. Is reputation in scope at all for the **first** Finn sprint, or should it be deferred to a later RFC once memory + commitment is stable?
