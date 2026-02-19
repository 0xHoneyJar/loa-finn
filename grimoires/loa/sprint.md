# Sprint Plan: Full Stack Launch — Build Everything, Then Ship

> **Version**: 1.1.0 (GPT-5.2 APPROVED iter 2, Flatline APPROVED: 5 HIGH_CONSENSUS + 5 BLOCKERS integrated)
> **Date**: 2026-02-19
> **Cycle**: cycle-027
> **PRD**: `grimoires/loa/prd.md` v1.2.0 (GPT-5.2 APPROVED iter 3, Flatline APPROVED)
> **SDD**: `grimoires/loa/sdd.md` v2.0.0 (GPT-5.2 APPROVED iter 3, Flatline APPROVED)
> **Global Sprint IDs**: 68–77
> **Developer**: Claude Opus 4.6 (autonomous via `/run sprint-plan`)

---

## Sprint Overview

| Sprint | Global ID | Label | Goal | Tasks |
|--------|-----------|-------|------|-------|
| sprint-1 | 68 | E2E Billing Loop + Conservation Hardening | Billing state machine live with arrakis, conservation guard hardened, WAL replay engine | 11 |
| sprint-2 | 69 | Credit Denomination + Purchase Flow | CreditUnit/MicroUSDC types + USDC-verified credit purchase + minimal SIWE/EIP-1271 server | 7 |
| sprint-3 | 70 | Credit Deduction + BYOK | Inference deducts credits atomically, BYOK entitlement gated | 5 |
| sprint-4 | 71 | NFT Personality Authoring | Per-NFT BEAUVOIR.md personality CRUD with routing | 4 |
| sprint-5 | 72 | Agent Homepage + Web Chat | Static HTML chat with WebSocket streaming + conversation persistence | 6 |
| sprint-6 | 73 | Onboarding + Invite System | Allowlist guard, feature flags, 6-step onboarding flow | 5 |
| sprint-7 | 74 | Production Deployment + Monitoring | Terraform ECS, ALB, ElastiCache, Prometheus, treasury, WAL single-writer guardrail | 7 |
| sprint-8 | 75 | x402 Middleware + Payment Verification | 402 quote response, EIP-3009 verification, nonce replay protection | 5 |
| sprint-9 | 76 | x402 Denomination + Guard Integration | MicroUSDC conversion, credit notes, X-Receipt header | 4 |
| sprint-10 | 77 | Integration Testing + Staged Rollout | Cross-system E2E, Gates 0-4 validation, load test, runbooks | 5 |

**Total**: 59 tasks across 10 sprints

**Dependencies**: Sprint 1 → Sprint 2 → Sprint 3 (strictly sequential billing foundation). Sprints 4-6 depend on Sprint 3 (credit deduction). Sprint 7 can run in parallel with 4-6. Sprints 8-9 depend on Sprint 1 (billing SM). Sprint 10 depends on all prior sprints.

**Test Baseline**: 2101 tests passing. Zero regression allowed.

**Staged Rollout**: PRD Gates 0-4. Each sprint maps to gate readiness:
- Gate 0 (Smoke): After Sprint 1
- Gate 1 (Ignition): After Sprint 3
- Gate 2 (Warmup): After Sprint 6
- Gate 3 (Idle): After Sprint 6 (BYOK in Sprint 3)
- Gate 4 (Launch): After Sprint 10

---

## Sprint 1: E2E Billing Loop + Conservation Hardening (Global ID: 68)

**Objective**: Wire the complete billing state machine (RESERVE/COMMIT/RELEASE/VOID) with arrakis finalize as async side-effect. Harden the conservation guard with remaining PR #79 suggestions. Full stack Docker Compose E2E test.

**Gate**: Billing state machine passes all 8 test scenarios (SDD §7.2). Conservation guard hardened. Docker Compose E2E test passes.

**Rollback**: Revert PR. Billing endpoints return 503 (feature flag OFF). Existing inference unchanged.

### Task 1.1: Billing State Machine — Core Types + State Transitions

**Description**: Create `src/billing/types.ts` and `src/billing/state-machine.ts` implementing the 4-state billing SM (RESERVE/COMMIT/RELEASE/VOID) with WAL-authoritative commit model (SDD §6.3). The state machine transitions are: IDLE → RESERVE_HELD → COMMITTED → FINALIZE_PENDING → FINALIZE_ACKED. Finn WAL is the authoritative commit record; arrakis finalize is async.

**Files created**:
- `src/billing/types.ts` — BillingState enum, BillingEntry interface, BillingEntryId branded type
- `src/billing/state-machine.ts` — BillingStateMachine class with transition methods

**Acceptance criteria**:
- [ ] BillingState enum: `IDLE`, `RESERVE_HELD`, `COMMITTED`, `FINALIZE_PENDING`, `FINALIZE_ACKED`, `FINALIZE_FAILED`, `RELEASED`, `VOIDED`
- [ ] Each transition validates preconditions (e.g., COMMIT only from RESERVE_HELD)
- [ ] COMMIT writes to WAL first (authoritative), then updates Redis (derived), then enqueues finalize (async)
- [ ] `billing_entry_id` (ULID) generated at RESERVE, used as idempotency key throughout
- [ ] `correlation_id` links RESERVE→COMMIT→RELEASE for same request
- [ ] Invalid transitions throw `BillingStateError` with current state and attempted transition
- [ ] **WAL envelope versioning** (Flatline IMP-002): every WAL record wrapped in `{ schema_version: number, event_type: string, payload: {...} }` — replay engine uses strict parsing for known versions, lenient skip for unknown event types (forward compat)
- [ ] **WAL durability guarantees** (Flatline SKP-001): atomic append via `fs.appendFileSync` with `O_APPEND|O_SYNC` flags, CRC32 checksum per record, fail-closed on read corruption (reject entry, alert, stop replay)

---

### Task 1.2: Double-Entry Ledger — Journal Entries + Posting Rules

**Description**: Create `src/billing/ledger.ts` implementing the journal entry model (SDD §3.2). Each WAL event contains a `postings[]` array that sums to zero (balanced double-entry). Posting rules per event type as defined in the SDD.

**Files created**:
- `src/billing/ledger.ts` — Ledger class with `appendEntry()`, `deriveBalance()`, `validatePostings()`

**Acceptance criteria**:
- [ ] `JournalEntry` interface with `billing_entry_id`, `event_type`, `correlation_id`, `postings[]`, `exchange_rate`, `rounding_direction`, `wal_offset`
- [ ] `Posting` interface with `account`, `delta`, `denom`, optional `metadata`
- [ ] Zero-sum invariant enforced at write time: `SUM(all postings) === 0n` (BigInt). Violation is hard error, entry rejected
- [ ] Canonical accounts: `user:{id}:available`, `user:{id}:held`, `system:revenue`, `system:reserves`, `treasury:usdc_received`, `system:credit_notes`
- [ ] Posting rules match SDD §3.2 table for all event types: `credit_mint`, `billing_reserve`, `billing_commit`, `billing_release`, `billing_void`, `x402_credit_note`
- [ ] `deriveBalance(account)` computes `SUM(posting.delta WHERE posting.account = account)` across all WAL entries
- [ ] Idempotency: replayed entries with same `billing_entry_id` produce no additional ledger effect

---

### Task 1.3: DLQ Processor — Redis Streams + Consumer Group

**Description**: Create `src/billing/dlq.ts` implementing the Dead Letter Queue for async arrakis finalize calls (SDD §3.3, PRD NFR-6). Uses Redis Streams (`billing:dlq`) with consumer group per service instance. Exponential backoff retry. Poison message handling. Three distinct hold/timer concepts are explicitly separated.

**Files created**:
- `src/billing/dlq.ts` — DLQProcessor class

**Acceptance criteria**:
- [ ] Redis Stream `billing:dlq` with `XADD` on finalize enqueue, `XREADGROUP` for consumption
- [ ] Consumer group: `billing_finalize_group`, consumer per ECS task ID
- [ ] Retry policy: exponential backoff (1s, 2s, 4s, 8s, 16s), max 5 retries
- [ ] After max retries: move to `billing:dlq:poison` stream, fire alert, write `billing_finalize_fail` WAL entry
- [ ] `FINALIZE_FAILED` state — does NOT auto-ACK, stays pending for admin manual replay
- [ ] `billing:pending_count` Redis key tracks pending reconciliation count
- [ ] **Three distinct hold concepts** (explicitly separated):
  - (a) **RESERVE hold** (pre-commit): TTL 5min via `RESERVE_TTL_SECONDS`; expired reserves auto-released with `billing_reserve_expired` WAL entry — funds return to user (safe, not yet committed)
  - (b) **COMMITTED-but-not-finalized** (FINALIZE_PENDING): NEVER auto-release user funds (already spent); user account blocked for new requests until DLQ resolves; admin manual replay or reconciliation required
  - (c) **Pending reconciliation** (FINALIZE_FAILED): 24h admin action window; after 24h fire escalation alert but do NOT auto-release (committed funds are irrevocable); requires explicit admin resolution
- [ ] **Automated bulk replay** (Flatline SKP-003): `POST /api/v1/admin/billing/bulk-replay` endpoint — replays all FINALIZE_FAILED entries in batch with configurable concurrency (default 5). Admin CLI + API for outage recovery.
- [ ] **Capped risk unblocking** (Flatline SKP-003): accounts in FINALIZE_PENDING/FAILED may still create new reserves up to `MAX_PENDING_RISK_LIMIT` (default 500 CU) to avoid complete user lockout during arrakis outages. Exceeding limit → blocked.
- [ ] **Outage simulation test** (Flatline SKP-003): 1-hour simulated arrakis outage → verify DLQ growth, user blocking at risk limit, bulk replay recovery, and all accounts unblocked post-recovery
- [ ] Idempotent finalize: `billing_entry_id` prevents double-commit at arrakis

---

### Task 1.4: Circuit Breaker — Finalize Health Check

**Description**: Create `src/billing/circuit-breaker.ts` implementing the 3-state circuit breaker (CLOSED/OPEN/HALF_OPEN) for the arrakis finalize endpoint (SDD §6.4). Preflight health check rejects requests at gateway when breaker is open.

**Files created**:
- `src/billing/circuit-breaker.ts` — CircuitBreaker class

**Acceptance criteria**:
- [ ] 3-state machine: CLOSED → OPEN (5 failures in 60s) → HALF_OPEN (30s cooldown) → CLOSED (probe success) or OPEN (probe fail)
- [ ] Preflight check: `GET /api/internal/billing/health` on arrakis before RESERVE
- [ ] OPEN state: all billing requests rejected at preflight with 503 `{ "error": "billing_service_unavailable", "retry_after": 30 }`
- [ ] HALF_OPEN: one probe request per cooldown, rest rejected
- [ ] Prometheus metric `billing_circuit_breaker_state` gauge
- [ ] Max concurrent PENDING_RECONCILIATION: 50 (configurable). Exceeded → deny new requests
- [ ] Prometheus alert: `billing_pending_reconciliation_count > 10` triggers PagerDuty

---

### Task 1.5: WAL Replay Engine + Redis State Rebuild

**Description**: Implement WAL scan/replay procedure that deterministically rebuilds all Redis-derived state from WAL on startup and after crashes (SDD §6.3). WAL is authoritative; Redis is a derived cache. This is the foundation for crash recovery, idempotency, and fail-closed behavior across the entire billing system.

**Files created**:
- `src/billing/wal-replay.ts` — WAL replay engine with deterministic reducers
- `tests/finn/wal-replay.test.ts` — Replay correctness and crash recovery tests

**Acceptance criteria**:
- [ ] WAL scan/replay procedure: iterate all WAL entries in offset order, apply deterministic reducers
- [ ] Deterministic reducers rebuild: (a) account balances (`balance:{account}:value`), (b) held reserves (`reserve:{billing_entry_id}`), (c) billing state machine state per `billing_entry_id`, (d) `billing:pending_count`, (e) idempotency cache (`request:{request_id}` → cached response), (f) x402 used payment IDs (`x402:payment:{payment_id}`)
- [ ] Startup ordering: WAL replay completes BEFORE server begins accepting traffic (health endpoint returns `starting` until replay done)
- [ ] Idempotent replay: replaying same WAL entries produces identical Redis state (deterministic)
- [ ] Crash recovery test: simulate Redis flush + restart → WAL replay → verify all balances, reserves, pending counts, and idempotency keys match pre-crash state
- [ ] Partial replay: track `last_replayed_offset` in Redis — incremental replay on reconnect (not full scan every time)
- [ ] Replay duration metric: `wal_replay_duration_ms` histogram for operational visibility
- [ ] **WAL operational limits** (Flatline IMP-004): max WAL file size 1GB, rotation to new file at threshold, compaction via periodic snapshot (daily) + WAL truncation after snapshot, backup to R2 before truncation
- [ ] **WAL restore procedure** (Flatline SKP-001): documented recovery path — load latest R2 snapshot → replay WAL entries after snapshot offset → rebuild Redis. Tested in crash recovery suite.
- [ ] **Torn write handling** (Flatline SKP-001): CRC32 mismatch on last record → truncate last incomplete record, log warning, continue replay from previous valid record (fail-safe for power loss)

---

### Task 1.6: Billing Module Integration — WAL + Redis + Guard Wiring

**Description**: Wire the billing state machine into the existing inference pipeline. Create `src/billing/index.ts` module exports. Integrate with BillingConservationGuard (existing), WAL (existing), and Redis (existing). Register billing routes. Reserve Lua script operates in MicroUSD only (CreditUnit conversion deferred to Sprint 3).

**Files created/modified**:
- `src/billing/index.ts` — Module exports
- `src/billing/reserve-lua.ts` — Redis Lua script for atomic balance check + hold (MicroUSD only)
- Existing route registration — billing guard middleware

**Acceptance criteria**:
- [ ] Billing state machine injected into inference request handler
- [ ] RESERVE: Lua script atomically checks `balance >= estimated_cost` and holds reserve (all amounts in MicroUSD)
- [ ] COMMIT: WAL append first (authoritative), Redis update second (idempotent on `billing_entry_id`), finalize enqueue third (async)
- [ ] RELEASE: WAL append + Redis reserve return (on pre-stream failure)
- [ ] Conservation guard `budget_conservation` invariant checked at RESERVE and COMMIT
- [ ] Feature flag gate: `feature:billing:enabled` in Redis — when OFF, inference proceeds without billing (backward compat)
- [ ] Sprint 1 reserve semantics: MicroUSD only — CreditUnit conversion layered in Sprint 3.1 without rewriting Lua script

---

### Task 1.7: Conservation Guard — Remaining PR #79 Suggestions

**Description**: Address non-blocking items from PR #79 bridge review (PRD FR-7.2): recoveryStopped flag, MAX_MICRO_USD_LENGTH shared constant, ensemble-untraced constant, trace_id fix, full backoff sequence test.

**Files modified**:
- `src/hounfour/billing-conservation-guard.ts`
- `src/hounfour/wire-boundary.ts`
- `src/hounfour/native-runtime-adapter.ts`
- `tests/finn/billing-conservation-guard.test.ts`

**Acceptance criteria**:
- [ ] BB-026-iter2-002: `recoveryStopped` flag — state-based recovery (no repeated retry after explicit stop)
- [ ] BB-026-iter2-003: `MAX_MICRO_USD_LENGTH` shared constant in wire-boundary.ts (symmetric DoS bounds with MicroUSD and CreditUnit)
- [ ] BB-026-iter2-004: `"ensemble-untraced"` extracted to named constant
- [ ] BB-026-iter2-005: `native-runtime-adapter.ts:416` trace_id fixed
- [ ] BB-026-iter2-007: Full backoff sequence test (1s, 2s, 4s all covered)

---

### Task 1.8: End-to-End Request Idempotency

**Description**: Implement the E2E request idempotency protocol (SDD §1.10). Single `request_id` (= `billing_entry_id`) governs the entire lifecycle from gateway to billing settlement. `X-Idempotency-Key` header support for client retries. Crash recovery relies on Task 1.5 WAL replay engine.

**Files modified**:
- `src/gateway/` — Idempotency key extraction/generation
- `src/billing/state-machine.ts` — Request ID binding

**Acceptance criteria**:
- [ ] Gateway generates `request_id` (ULID) on first receipt; client `X-Idempotency-Key` header overrides
- [ ] `request_id` persisted in WAL as `request_start` entry BEFORE streaming begins
- [ ] `billing_entry_id = request_id` — RESERVE, COMMIT, RELEASE, FINALIZE all keyed on same ID
- [ ] Duplicate request (same idempotency key): return cached response, no re-invocation
- [ ] Client disconnect mid-stream: model continues, COMMIT proceeds, response cached 5min for reconnect
- [ ] **Streaming idempotency contract** (Flatline SKP-005): canonical response = full transcript (all `text_delta` concatenated) + metadata (`cost_micro_usd`, `model`, `token_counts`); stored in WAL `request_complete` entry; Redis cache key `response:{request_id}` with 5min TTL points to WAL offset for retrieval
- [ ] **Retry during stream** (Flatline SKP-005): if `request_id` already in-flight (RESERVE_HELD state), return 409 `{ error: "request_in_progress" }` — do NOT start second inference
- [ ] **Retry after stream but before finalize** (Flatline SKP-005): if COMMITTED state, return cached response from WAL — no re-invocation
- [ ] Server crash after COMMIT WAL but before Redis: Task 1.5 WAL replay engine replays COMMIT, Redis updated idempotently (tested in 1.5 crash recovery suite)

---

### Task 1.9: Docker Compose Full Stack E2E

**Description**: Create Docker Compose config for arrakis + loa-finn + Redis. Write E2E test that exercises the full billing flow: inference request → billing reserve → model response → commit → finalize.

**Files created**:
- `docker-compose.e2e.yml` — Full stack config
- `tests/e2e/billing-flow.test.ts` — E2E test suite

**Acceptance criteria**:
- [ ] `docker compose -f docker-compose.e2e.yml up` starts arrakis + loa-finn + Redis
- [ ] Real ES256 keypair shared via Docker volume (generated by `e2e-keygen.sh`)
- [ ] E2E test: send inference request → verify RESERVE → model responds → verify COMMIT in WAL → verify finalize at arrakis
- [ ] E2E test: simulate finalize failure → verify DLQ entry created → verify account enters PENDING_RECONCILIATION → replay succeeds

---

### Task 1.10: Billing State Machine Test Suite

**Description**: Comprehensive tests for all 8 billing SM scenarios from SDD §7.2.

**Files created**:
- `tests/finn/billing-state-machine.test.ts`

**Acceptance criteria**:
- [ ] Happy path: RESERVE→COMMIT→FINALIZE_ACK — balance decremented, arrakis acked
- [ ] Reserve release: RESERVE→model fails (pre-stream) — balance unchanged
- [ ] Local commit, finalize fails: RESERVE→stream→COMMIT(WAL)→FINALIZE_PENDING — balance committed locally, finalize retried via DLQ
- [ ] DLQ replay succeeds: FINALIZE_PENDING + replay → FINALIZE_ACKED
- [ ] DLQ max retries: 5 failures → FINALIZE_FAILED, alert fires, funds already committed
- [ ] Admin manual finalize: FINALIZE_FAILED + admin replay → FINALIZE_ACKED
- [ ] Concurrent reserve: 2 parallel requests → Lua script prevents overdraft
- [ ] Reserve TTL expiry: RESERVE held >5min (pre-commit) → auto-released, funds returned (safe)
- [ ] COMMITTED-but-not-finalized: FINALIZE_PENDING account blocked for new requests, funds NOT auto-released (irrevocable)
- [ ] Pending reconciliation escalation: FINALIZE_FAILED >24h → escalation alert fires, admin required

---

### Task 1.11: Billing Observability — Metrics + Structured Logging

**Description**: Prometheus metrics and structured logging for the billing pipeline.

**Files created/modified**:
- `src/billing/metrics.ts` — Billing metrics definitions
- Health endpoint handler — Add billing subsystem

**Acceptance criteria**:
- [ ] `billing_state_transitions_total` counter by `from_state` and `to_state`
- [ ] `billing_reserve_duration_ms` histogram — time to acquire reserve
- [ ] `billing_commit_duration_ms` histogram — WAL write + Redis update
- [ ] `billing_finalize_duration_ms` histogram — arrakis call
- [ ] `billing_pending_reconciliation_count` gauge — live pending count
- [ ] `billing_circuit_breaker_state` gauge — 0=CLOSED, 1=OPEN, 2=HALF_OPEN
- [ ] `/health` response includes `billing` subsystem: `{ state, pending_count, circuit_breaker }`
- [ ] Structured logs: every state transition logs `{ billing_entry_id, from_state, to_state, cost_micro_usd }`

---

## Sprint 2: Credit Denomination + Purchase Flow (Global ID: 69)

**Objective**: Introduce CreditUnit and MicroUSDC branded types. Implement credit pack purchase with on-chain USDC verification on Base L2. Double-entry ledger fully operational.

**Gate**: Credit purchase E2E passes (USDC transfer → verification → credit mint → balance reflected). All branded type round-trip tests pass.

**Rollback**: Feature flag `feature:credits:enabled` OFF → credit endpoints return 503.

### Task 2.1: CreditUnit + MicroUSDC Branded Types

**Description**: Extend `wire-boundary.ts` with two new branded types: `CreditUnit` (user-facing balance, 100 CU = $1) and `MicroUSDC` (on-chain settlement, 6-decimal USDC precision). Follow existing `parseMicroUSD` pattern with 3-layer enforcement.

**Files modified**:
- `src/hounfour/wire-boundary.ts` — Add CreditUnit, MicroUSDC types + parse/serialize
- `tests/finn/wire-boundary.test.ts` — Add branded type tests

**Acceptance criteria**:
- [ ] `CreditUnit` branded type: `parseCreditUnit()`, `serializeCreditUnit()` with 3-layer enforcement (type, lint, runtime)
- [ ] `MicroUSDC` branded type: `parseMicroUSDC()`, `serializeMicroUSDC()` with 3-layer enforcement
- [ ] `MAX_CREDIT_UNIT_LENGTH` constant shared with `MAX_MICRO_USD_LENGTH` (symmetric DoS bounds)
- [ ] `convertMicroUSDtoCreditUnit(amount, rate): CreditUnit` — explicit rate parameter
- [ ] `convertMicroUSDtoMicroUSDC(amount, rate): MicroUSDC` — explicit rate parameter
- [ ] Round-trip property: `parse(serialize(x)) === x` for both types
- [ ] ESLint rule: `as CreditUnit` and `as MicroUSDC` banned outside wire-boundary.ts and tests

---

### Task 2.2: Pricing Table + Cost Estimation

**Description**: Create `src/billing/pricing.ts` implementing the pricing table (SDD §3.4). Model pricing in MicroUSD/token, reserve estimation formula, actual cost formula, and x402 quote formula.

**Files created**:
- `src/billing/pricing.ts` — Pricing table + estimation functions
- `tests/finn/pricing.test.ts` — Pricing calculation tests

**Acceptance criteria**:
- [ ] Model pricing table: `claude-sonnet-4` (3/15), `claude-haiku-4` (1/5), `gpt-4.1` (2/8), `gpt-4.1-mini` (0.4/1.6) MicroUSD/token
- [ ] `estimateReserveCost(model, input_tokens, max_tokens): MicroUSD` — `ceil()` rounding
- [ ] `computeActualCost(model, input_tokens, output_tokens): MicroUSD` — `floor()` rounding
- [ ] `computeX402Quote(model, max_input_tokens, max_tokens, markup_factor): MicroUSDC`
- [ ] Rate freeze: `freezeRates()` captures current pricing + CREDIT_UNITS_PER_USD + USD_USDC_RATE at RESERVE time
- [ ] Frozen rates stored in WAL entry, used for COMMIT and RELEASE
- [ ] Config: `FINN_MODEL_PRICING_JSON` env var overrides static table

---

### Task 2.3: Minimal SIWE Verify + EIP-1271 Signature Validation (Server-Side)

**Description**: Create `src/gateway/wallet-auth.ts` with minimal server-side SIWE signature verification and EIP-1271 smart wallet validation. This is a prerequisite for Task 2.4 (credit purchase smart wallet support) and Sprint 5.5 (full wallet connect UI). Only the server-side verify logic is implemented here — the client-side WalletConnect UI is deferred to Sprint 5.5.

**Files created**:
- `src/gateway/wallet-auth.ts` — SIWE nonce + verify endpoints, EIP-1271 on-chain call

**Acceptance criteria**:
- [ ] `GET /api/v1/auth/nonce` — returns random nonce, stored in Redis with 5min TTL
- [ ] `POST /api/v1/auth/verify` — validates SIWE message, verifies signature
- [ ] EOA verification: `ecrecover` recovers signer address from signature
- [ ] Smart wallet verification: if `ecrecover` fails, call `EIP-1271 isValidSignature(hash, signature)` on `from` contract via viem
- [ ] Checks: domain match, chain-id (8453), nonce valid + unused, expiration not passed
- [ ] **JWT with refresh token** (Flatline IMP-003): access JWT (ES256, 15min TTL, claims: `sub`, `chain_id`, `wallet_type`, `session_id`); refresh token (opaque, 24h TTL, stored in Redis `session:{session_id}`); `POST /api/v1/auth/refresh` endpoint
- [ ] **Session revocation** (Flatline IMP-003): `POST /api/v1/auth/logout` deletes `session:{session_id}` from Redis; refresh rejected for revoked sessions; access JWT still valid until 15min expiry (acceptable tradeoff for beta)
- [ ] **Rate limit on nonce** (Flatline IMP-007): 10 req/min per IP on `/api/v1/auth/nonce` to prevent nonce exhaustion
- [ ] This is server-only — no client-side WalletConnect UI (deferred to Sprint 5.5)

---

### Task 2.4: Credit Purchase — On-Chain USDC Verification

**Description**: Create `src/credits/purchase.ts` implementing credit pack purchase with on-chain Base USDC transfer verification via `viem` (SDD §5.2, PRD FR-2.2). Smart wallet support uses Task 2.3 EIP-1271 validation.

**Files created**:
- `src/credits/purchase.ts` — Credit purchase handler
- `src/credits/types.ts` — CreditPurchaseRequest, pack definitions

**Acceptance criteria**:
- [ ] `POST /api/v1/credits/purchase` with `CreditPurchaseRequest` schema (pack_size, payment_proof, idempotency_key)
- [ ] Pack sizes: 500, 1000, 2500 CreditUnit ($5, $10, $25)
- [ ] On-chain verification via viem: `getTransactionReceipt(tx_hash)` → parse USDC `Transfer` event logs
- [ ] Verify: `log.address == USDC_CONTRACT`, `log.topics[2] == TREASURY_ADDRESS`, `log.data == expected_amount`
- [ ] Require 12+ L2 confirmations: `eth_blockNumber() - tx.blockNumber >= 12`
- [ ] Idempotency: `(tx_hash, log_index)` as unique key — replayed purchase returns original result
- [ ] Smart wallet support: if `from != auth_wallet`, use Task 2.3 `isValidSignature()` to verify payer binding (GPT-IMP-006)
- [ ] Double-entry ledger: `treasury:usdc_received -N, user:{id}:available +N` journal entry
- [ ] Fail-closed error responses per SDD §5.2: 400 INVALID_PROOF, 402 PAYMENT_NOT_CONFIRMED, 409 PAYMENT_MISMATCH, 409 ALREADY_MINTED, 503 VERIFICATION_UNAVAILABLE
- [ ] **Rate limit on purchase** (Flatline IMP-007): 5 req/min per wallet on `/api/v1/credits/purchase` to prevent verification amplification attacks

---

### Task 2.5: On-Chain Reorg Detection

**Description**: Background job to re-verify recent credit mints against chain reorganizations (Flatline SKP-004, SDD §7.2).

**Files created**:
- `src/credits/reorg-detector.ts` — Background reorg verification job

**Acceptance criteria**:
- [ ] Store verification binding in WAL: `(tx_hash, log_index, block_number, block_hash)`
- [ ] Background job runs every 5 minutes, checks mints < 1 hour old
- [ ] Fetch `eth_getBlockByNumber(stored_block_number)`, compare `block.hash` against stored `block_hash`
- [ ] If mismatch (reorg): re-fetch receipt, re-verify transfer log
- [ ] If tx no longer valid: freeze minted credits, alert admin, create `credit_mint_reverted` WAL entry
- [ ] Multi-RPC: primary (Alchemy) + fallback (public Base RPC). Disagree → reject until consistent

---

### Task 2.6: Daily Reconciliation Job

**Description**: Create `src/billing/reconciliation.ts` — daily job that derives balances from WAL entries and compares against Redis cached balances. Alert on divergence.

**Files created**:
- `src/billing/reconciliation.ts` — Reconciliation job
- `tests/finn/reconciliation.test.ts` — Reconciliation tests

**Acceptance criteria**:
- [ ] Daily cron via `croner`: derive all account balances from WAL by replaying journal entries
- [ ] Compare derived balance against Redis `balance:{account}:value`
- [ ] If divergence: overwrite Redis from derived values, fire alert with diff details
- [ ] Rounding drift report: sum rounding deltas by denomination, alert if cumulative drift > 1000 MicroUSD
- [ ] Reconciliation result logged to WAL as `reconciliation` entry

---

### Task 2.7: Credit Purchase Test Suite

**Description**: Comprehensive tests for credit purchase flow including on-chain verification edge cases.

**Files created**:
- `tests/finn/credit-purchase.test.ts`

**Acceptance criteria**:
- [ ] Valid USDC transfer: correct tx, 12+ confirmations → credit minted
- [ ] Wrong recipient: Transfer to wrong address → rejected (PAYMENT_MISMATCH)
- [ ] Insufficient confirmations: < 12 → rejected (PAYMENT_NOT_CONFIRMED)
- [ ] Smart wallet: contract wallet sent USDC, user auth via SIWE → verified via EIP-1271
- [ ] Replay: same `(tx_hash, log_index)` → returns original result (ALREADY_MINTED)
- [ ] RPC down: Base RPC unreachable → 503 VERIFICATION_UNAVAILABLE
- [ ] Conservation guard `budget_conservation` verified post-mint

---

## Sprint 3: Credit Deduction + BYOK (Global ID: 70)

**Objective**: Inference requests deduct credits via atomic Redis Lua script with rate freeze per `billing_entry_id`. BYOK entitlement state machine gates BYOK users.

**Gate**: Reserve→Commit→Release cycle works with CreditUnit. BYOK entitlement denies GRACE_EXPIRED users. Rate freeze verified.

**Rollback**: Feature flag OFF → inference proceeds without credit deduction (free mode).

### Task 3.1: Credit Denomination Layer on Reserve Lua Script

**Description**: Layer CreditUnit conversion onto the existing Sprint 1 reserve Lua script (Task 1.6). The Lua script already handles atomic balance check + hold in MicroUSD. This task adds the CreditUnit conversion wrapper with rate freeze per `billing_entry_id` (SDD §3.3, PRD FR-2.3). The core Lua atomics are NOT rewritten — only the TypeScript caller converts denominations before/after Lua invocation.

**Files modified**:
- `src/billing/state-machine.ts` — Credit deduction integration (wraps existing Lua)
- `src/credits/conversion.ts` — Rate-frozen CreditUnit ↔ MicroUSD conversion

**Acceptance criteria**:
- [ ] Existing Lua script (Task 1.6) unchanged — still operates in MicroUSD atomically
- [ ] TypeScript wrapper: estimate cost in MicroUSD → convert to CreditUnit via `ceil()` for user display → Lua reserves in MicroUSD
- [ ] COMMIT: actual cost in MicroUSD → convert to CreditUnit via `floor()` for user display → Lua deducts in MicroUSD, release excess
- [ ] Rate freeze: `CREDIT_UNITS_PER_USD` exchange rate at RESERVE time persisted in WAL `billing_reserve` entry, used for COMMIT/RELEASE
- [ ] Canonical rounding: RESERVE `ceil()`, COMMIT `floor()` — user never overpays by more than 1 CU
- [ ] Insufficient credits at RESERVE → HTTP 402 with `{ balance_cu, estimated_cost_cu, deficit_cu }` (CreditUnit display, MicroUSD enforcement)
- [ ] Reserve TTL: 5 minutes via `RESERVE_TTL_SECONDS` env var; expired reserves auto-released via Redis TTL callback + `billing_reserve_expired` WAL entry

---

### Task 3.2: BYOK Entitlement State Machine

**Description**: Create `src/credits/entitlement.ts` implementing the 4-state BYOK entitlement machine (SDD §3.3, PRD FR-2.4): ACTIVE → PAST_DUE → GRACE_EXPIRED → requires reactivation. CANCELLED state on explicit cancel.

**Files created**:
- `src/credits/entitlement.ts` — Entitlement state machine
- `tests/finn/entitlement.test.ts` — State machine tests

**Acceptance criteria**:
- [ ] 4 states: ACTIVE, PAST_DUE (72h grace), GRACE_EXPIRED, CANCELLED
- [ ] Per-request check: if not ACTIVE or PAST_DUE → deny with "BYOK subscription inactive"
- [ ] Rate limit: 1000 req/day per BYOK account (`BYOK_DAILY_RATE_LIMIT` env), HTTP 429 when exceeded
- [ ] Redis key `entitlement:{account_id}` stores state, expires_at, grace_until
- [ ] Redis key `rate:{account_id}:daily` with midnight reset tracks daily count
- [ ] BYOK requests metered (token count, model, cost-equivalent) but NOT charged per-request
- [ ] WAL audit entry for every entitlement state transition
- [ ] Proration: mid-month activation charges `(remaining_days / 30) * monthly_fee`

---

### Task 3.3: Conservation Guard — Entitlement + Credit Invariants

**Description**: Extend BillingConservationGuard with `entitlement_valid` invariant for BYOK users and credit-specific invariants (SDD §7.2 extended table).

**Files modified**:
- `src/hounfour/billing-conservation-guard.ts` — New invariants

**Acceptance criteria**:
- [ ] `entitlement_valid` invariant: checks BYOK entitlement state is ACTIVE or PAST_DUE
- [ ] `rate_consistency` invariant: verifies COMMIT uses frozen rate from RESERVE (not current env var)
- [ ] `micro_usd_format` invariant: verifies ceil/floor rounding direction matches operation type
- [ ] Dual-path lattice: evaluator + ad-hoc for each new invariant
- [ ] Divergence monitoring emits metrics on disagreement

---

### Task 3.4: WebSocket Protocol Extension — Cost + Balance

**Description**: Extend the existing WebSocket protocol with billing-related messages (SDD §4.5).

**Files modified**:
- WebSocket handler — Add `turn_end`, `credit_warning`, `billing_blocked` messages

**Acceptance criteria**:
- [ ] `turn_end` message sent after each response: `{ cost_cu, balance_cu }` — cost of this message + remaining balance
- [ ] `credit_warning` sent when balance drops below threshold (configurable, default 50 CU)
- [ ] `billing_blocked` sent when account in PENDING_RECONCILIATION with reason
- [ ] Existing `text_delta` and `prompt` messages unchanged (backward compat)

---

### Task 3.5: Credit Deduction Test Suite

**Description**: Tests for credit deduction flow, rate freeze, concurrent reserves, and BYOK path.

**Files created**:
- `tests/finn/credit-deduction.test.ts`

**Acceptance criteria**:
- [ ] Reserve 100 CU, inference costs 80 CU → 20 CU released, balance reduced by 80 CU
- [ ] Reserve 100 CU, finalize fails → balance still shows 100 CU held, account blocked until DLQ replay
- [ ] Rate freeze: rate changes between RESERVE and COMMIT → COMMIT uses frozen rate
- [ ] Concurrent reserves: 2 parallel requests → Lua prevents overdraft, second gets 402
- [ ] BYOK ACTIVE → inference succeeds, metered but not charged
- [ ] BYOK GRACE_EXPIRED → inference denied with reactivation message
- [ ] BYOK rate limit exceeded → HTTP 429 with reset time

---

## Sprint 4: NFT Personality Authoring (Global ID: 71)

**Objective**: Each finnNFT gets a unique BEAUVOIR.md personality file. CRUD endpoints for personality authoring with WAL + R2 persistence.

**Gate**: Personality created, retrieved, updated, and integrated into inference routing. WAL durability verified.

**Rollback**: Feature flag `feature:nft:enabled` OFF → personality endpoints return 503, default BEAUVOIR.md used.

### Task 4.1: NFT Personality CRUD + Storage

**Description**: Create `src/nft/personality.ts` implementing personality authoring and persistence (SDD §3.2, PRD FR-4.1). Personalities stored as WAL entries with R2 backup.

**Files created**:
- `src/nft/personality.ts` — Personality CRUD handler
- `src/nft/types.ts` — NFTPersonality, voice types

**Acceptance criteria**:
- [ ] `POST /api/v1/nft/:tokenId/personality` — create personality from preferences
- [ ] `GET /api/v1/nft/:tokenId/personality` — retrieve personality config
- [ ] `PUT /api/v1/nft/:tokenId/personality` — update preferences
- [ ] Preferences: name, voice (analytical/creative/witty/sage), expertise domains (up to 5), custom instructions (max 2000 chars)
- [ ] Personality keyed by `collection:tokenId`
- [ ] WAL `personality_create` / `personality_update` entries
- [ ] R2 storage for generated BEAUVOIR.md file

---

### Task 4.2: BEAUVOIR.md Template Generation

**Description**: Generate agent personality documents from user preferences. Template system that produces structured BEAUVOIR.md files.

**Files created**:
- `src/nft/beauvoir-template.ts` — Template engine for BEAUVOIR.md

**Acceptance criteria**:
- [ ] Template includes: agent name, voice description, expertise domains, custom instructions, behavioral guidelines
- [ ] Voice templates produce distinct personalities: analytical (precise, data-driven), creative (exploratory, imaginative), witty (humorous, sharp), sage (wise, philosophical)
- [ ] Output is valid Markdown, max 4KB
- [ ] Default BEAUVOIR.md used when personality is missing (not blank)

---

### Task 4.3: NFTRoutingConfig Integration

**Description**: Wire personality into the existing NFTRoutingConfig so that inference requests for a specific NFT use its personality as the system prompt.

**Files modified**:
- `src/hounfour/nft-routing-config.ts` — Personality-aware routing
- Existing inference pipeline — Inject personality system prompt

**Acceptance criteria**:
- [ ] NFTRoutingConfig resolves `nft_id` → personality BEAUVOIR.md content
- [ ] Personality injected as system prompt prefix before user message
- [ ] **Prompt boundary enforcement** (Flatline IMP-005): personality content wrapped in explicit `<system-personality>...</system-personality>` delimiters; user input NEVER interpolated into system prompt template; personality content sanitized (strip markdown code fences that could confuse delimiters)
- [ ] Missing personality → default BEAUVOIR.md (fail-safe, not error)
- [ ] Personality hot-reload: config update reflects on next request (no restart required)

---

### Task 4.4: NFT Personality Test Suite

**Description**: Tests for personality CRUD, template generation, and routing integration.

**Files created**:
- `tests/finn/nft-personality.test.ts`

**Acceptance criteria**:
- [ ] Create personality → retrieve matches input preferences
- [ ] Update personality → next inference uses updated system prompt
- [ ] Invalid voice → 400 validation error
- [ ] Missing personality → default BEAUVOIR.md, no error
- [ ] WAL entries created for create and update operations
- [ ] R2 persistence: personality survives simulated restart

---

## Sprint 5: Agent Homepage + Web Chat (Global ID: 72)

**Objective**: Each NFT gets a URL serving a chat interface. Static HTML + Vanilla JS with WebSocket streaming. Conversation persistence with wallet-bound access control.

**Gate**: Chat sends message → streams response → credit deducted → balance updated in UI. Conversation persists across sessions.

**Rollback**: Feature flag OFF → agent homepage returns 404, chat unavailable.

### Task 5.1: On-Chain NFT Ownership Verification

**Description**: Create `src/nft/ownership.ts` implementing on-chain NFT ownership checks via Base RPC (viem). Used at conversation creation to verify the wallet holds the NFT.

**Files created**:
- `src/nft/ownership.ts` — On-chain ownership check

**Acceptance criteria**:
- [ ] `verifyNFTOwnership(collection, tokenId, walletAddress): boolean` via `ownerOf(tokenId)` ERC-721 call on Base
- [ ] 1 confirmation required for ownership check
- [ ] Cache ownership result for 5 minutes (avoid repeated RPC calls)
- [ ] RPC failure → deny with 503 (fail-closed)
- [ ] Supports multiple NFT collections via `NFT_COLLECTIONS` env var (JSON array of contract addresses)

---

### Task 5.2: Conversation Manager — Wallet-Bound Access + Persistence

**Description**: Create `src/nft/conversation.ts` implementing wallet-bound conversation persistence (SDD §3.2, PRD FR-4.3). Conversations bound to wallet address at creation time, not transferable with NFT. Three-tier storage: Redis (hot) → WAL (warm) → R2 (cold) with explicit WAL event types, message size limits, pagination, and snapshot/compaction.

**Files created**:
- `src/nft/conversation.ts` — Conversation CRUD + access control
- `src/nft/conversation-archive.ts` — R2 archive write/read + snapshot/compaction

**Acceptance criteria**:
- [ ] `conversation_id` (ULID), `nft_id`, `owner_address`, `messages[]`, `created_at`, `updated_at`
- [ ] `owner_address` set at creation time from authenticated wallet
- [ ] Access check: `request.wallet_address === conversation.owner_address` (constant-time comparison)
- [ ] NFT ownership verified on-chain only at NEW conversation creation
- [ ] New NFT owner (post-transfer) can create new conversations but NOT access previous owner's
- [ ] `GET /api/v1/nft/:tokenId/conversations` — filtered by authenticated wallet, paginated (cursor-based, 20 per page)
- [ ] `GET /api/v1/nft/:tokenId/conversations/:id` — access-checked
- [ ] `GET /api/v1/nft/:tokenId/conversations/:id/messages?cursor=X&limit=50` — paginated message retrieval
- [ ] **WAL event types**: `conversation_create`, `conversation_message_append` (per user/assistant message), `conversation_snapshot` (periodic compaction)
- [ ] **Message size limits**: max 8KB per message content, max 200 messages per conversation before snapshot trigger
- [ ] **Three-tier storage**: Redis cache (hot, 24h TTL) → WAL entries (warm, individual message appends) → R2 archive (cold, JSON snapshot)
- [ ] **Snapshot/compaction**: every 200 messages (or 1MB WAL size per conversation), write full conversation snapshot to R2, record `conversation_snapshot` WAL entry with R2 key, prune individual `conversation_message_append` WAL entries older than snapshot
- [ ] **R2 archive format**: `conversations/{conversation_id}/snapshot-{offset}.json` — full message array + metadata, gzipped
- [ ] **R2 retrieval path**: on Redis miss, check WAL for recent messages → if WAL gap, load from R2 snapshot + replay WAL entries after snapshot offset
- [ ] **Restart recovery test**: simulate Redis flush → verify conversation restored from WAL/R2 when accessed

---

### Task 5.3: Static HTML Agent Homepage

**Description**: Create the agent homepage served by Hono at `/agent/:collection/:tokenId` (SDD §4.2-4.4). Static HTML with embedded Vanilla JS modules.

**Files created**:
- `src/nft/homepage.ts` — Static HTML generation + Hono route
- `public/agent/` — Static assets (CSS, JS modules)

**Acceptance criteria**:
- [ ] `GET /agent/:collection/:tokenId` serves agent homepage with personality info + chat widget
- [ ] HTML structure per SDD §4.4: header (name, avatar), main (chat + sidebar), footer
- [ ] Sidebar: personality card, usage stats (credits remaining, messages sent), model indicator
- [ ] No build step — vanilla JS modules loaded directly
- [ ] Tailwind CSS via CDN (no build step)
- [ ] **XSS prevention** (Flatline IMP-005): all user-generated content (chat messages, personality names) HTML-entity-encoded before DOM insertion; CSP header: `default-src 'self'; script-src 'self'; style-src 'self' https://cdn.tailwindcss.com; connect-src 'self' wss:`; no `innerHTML` for user content — use `textContent` or DOMPurify
- [ ] **Markdown rendering policy** (Flatline IMP-005): assistant messages rendered as sanitized Markdown (allowlist: bold, italic, code, links with `rel=noopener`); user messages rendered as plain text only

---

### Task 5.4: WebSocket Chat Client (Vanilla JS)

**Description**: Implement the client-side WebSocket chat widget using Vanilla JS. Handles streaming responses, reconnection, and credit display updates.

**Files created**:
- `public/agent/ws-client.js` — WebSocket connection + reconnect
- `public/agent/chat.js` — Message rendering + streaming

**Acceptance criteria**:
- [ ] WebSocket connects to `/ws/:sessionId` (existing protocol)
- [ ] Sends `prompt` message with `text` and `nft_id`
- [ ] Renders `text_delta` streaming tokens incrementally
- [ ] Handles `turn_end`: updates credit balance display, shows per-message cost
- [ ] Handles `credit_warning`: shows low balance alert
- [ ] Handles `billing_blocked`: shows pending reconciliation message
- [ ] Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- [ ] Session resume across page reloads

---

### Task 5.5: Wallet Connect Client UI (SIWE)

**Description**: Implement client-side WalletConnect Web3Modal integration for the agent homepage (SDD §1.9, Flatline SKP-006). Server-side SIWE verify + EIP-1271 already implemented in Task 2.3. This task adds the browser-side wallet UI + cookie/header handling.

**Files created**:
- `public/agent/wallet.js` — Client-side WalletConnect + SIWE signing

**Files modified**:
- `src/gateway/wallet-auth.ts` — Add cookie issuance (`HttpOnly`, `Secure`, `SameSite=Strict`) and origin validation to existing verify endpoint from Task 2.3

**Acceptance criteria**:
- [ ] Reuses Task 2.3 `GET /api/v1/auth/nonce` and `POST /api/v1/auth/verify` endpoints (no duplication)
- [ ] Cookie: `HttpOnly`, `Secure`, `SameSite=Strict` + `Authorization: Bearer` header support added to existing verify response
- [ ] Origin validation: `ALLOWED_ORIGINS` env var checked on all wallet-authed routes
- [ ] Client-side: Web3Modal wallet selector → sign SIWE → POST verify → store JWT in cookie
- [ ] Smart wallet support: client detects contract wallet, server uses Task 2.3 EIP-1271 path automatically
- [ ] Graceful degradation: if WalletConnect unavailable, show manual signature input option

---

### Task 5.6: Agent Homepage Test Suite

**Description**: Tests for conversation access control, WebSocket protocol, and wallet auth.

**Files created**:
- `tests/finn/conversation.test.ts`
- `tests/finn/wallet-auth.test.ts`

**Acceptance criteria**:
- [ ] Wallet A creates conversation → wallet B cannot read (access denied)
- [ ] NFT transfers to wallet B → B creates new conversation (succeeds), cannot read A's
- [ ] SIWE verify: valid signature → JWT issued
- [ ] SIWE verify: wrong domain, expired nonce, replayed nonce → all rejected
- [ ] EIP-1271: smart wallet signature → validated via on-chain call
- [ ] WebSocket `turn_end` message includes correct `cost_cu` and `balance_cu`

---

## Sprint 6: Onboarding + Invite System (Global ID: 73)

**Objective**: Closed beta access control via wallet allowlist. Feature flags per track. 6-step onboarding flow from wallet connect to first agent message.

**Gate**: Non-allowlisted wallet gets 403. Allowlisted wallet completes full onboarding. Feature flags toggle tracks independently.

**Rollback**: Remove allowlist middleware → all authenticated users pass (emergency bypass).

### Task 6.1: Allowlist Guard — Redis SISMEMBER

**Description**: Create `src/gateway/allowlist.ts` implementing the Redis set-based allowlist guard (SDD §1.9, PRD FR-5.1). Plaintext normalized addresses for beta.

**Files created**:
- `src/gateway/allowlist.ts` — Allowlist middleware

**Acceptance criteria**:
- [ ] Redis set `beta:allowlist` with plaintext lowercase addresses
- [ ] Address normalization: strip optional `0x`, lowercase, validate 40 hex chars, re-add `0x`
- [ ] `SISMEMBER beta:allowlist <lowercase_address>` — O(1) lookup on every authenticated request
- [ ] Non-allowlisted → HTTP 403 `{ "error": "beta_access_required", "waitlist_url": "..." }`
- [ ] `BETA_BYPASS_ADDRESSES` env var: comma-separated addresses that always pass (internal testing)
- [ ] Rate limiting: 10 req/min per IP on allowlist-gated endpoints (prevent enumeration)

---

### Task 6.2: Admin API — Allowlist + Feature Flags

**Description**: Admin endpoints for managing the allowlist and feature flags. Protected by admin JWT with `role: "admin"` claim.

**Files created**:
- `src/gateway/feature-flags.ts` — Feature flag middleware
- Admin route registration

**Acceptance criteria**:
- [ ] `POST /api/v1/admin/allowlist` — add/remove wallet addresses (body: `{ action: "add"|"remove", addresses: string[] }`)
- [ ] `POST /api/v1/admin/feature-flags` — toggle feature flags (body: `{ flag: string, enabled: boolean }`)
- [ ] `GET /api/v1/admin/pending-reconciliations` — list pending accounts
- [ ] Admin JWT requires `role: "admin"` claim (not just any valid JWT)
- [ ] **Admin rate limiting** (Flatline IMP-007): 30 req/min per admin JWT on all `/api/v1/admin/*` endpoints; failed admin auth attempts: 5/min per IP then 15min lockout
- [ ] WAL audit entry for every allowlist add/remove and feature flag toggle
- [ ] Feature flags: `feature:{track_name}:enabled` in Redis, checked per-request via middleware
- [ ] Default flags for staged rollout: `billing`, `credits`, `nft`, `onboarding`, `x402`

---

### Task 6.3: Onboarding Flow — 6-Step Wizard

**Description**: Create `src/nft/onboarding.ts` implementing the 6-step onboarding flow (PRD FR-5.2): wallet connect → NFT detection → NFT selection → personality config → credit purchase → agent live.

**Files created**:
- `src/nft/onboarding.ts` — Onboarding flow orchestration
- `public/onboard/` — Onboarding page static assets

**Acceptance criteria**:
- [ ] Step 1: Connect wallet → SIWE auth (reuses Task 5.5)
- [ ] Step 2: Detect NFTs via on-chain read (reuses Task 5.1)
- [ ] Step 3: Select NFT → show as agent avatar
- [ ] Step 4: Configure personality (reuses Task 4.1)
- [ ] Step 5: Purchase credits (or activate BYOK) — redirect to credits page
- [ ] Step 6: Agent goes live → redirect to `/agent/:collection/:tokenId`
- [ ] Complete flow works end-to-end with real value

---

### Task 6.4: Waitlist Page

**Description**: Static page for non-allowlisted users with "Coming Soon" message and optional email signup.

**Files created**:
- `public/waitlist/` — Waitlist page

**Acceptance criteria**:
- [ ] `GET /waitlist` serves static page with "Coming Soon" message
- [ ] Displays: project name, brief description, "request access" indication
- [ ] 403 redirect: non-allowlisted users redirected here from any gated endpoint

---

### Task 6.5: Onboarding + Allowlist Test Suite

**Description**: Tests for allowlist guard, feature flags, and onboarding flow.

**Files created**:
- `tests/finn/allowlist.test.ts`
- `tests/finn/feature-flags.test.ts`

**Acceptance criteria**:
- [ ] Allowlisted address → access granted
- [ ] Non-allowlisted address → 403 with waitlist URL
- [ ] Mixed-case address matches lowercase entry
- [ ] Admin add/remove reflected immediately
- [ ] Feature flag OFF → gated endpoints return 503
- [ ] Feature flag ON → endpoints serve normally
- [ ] Bypass addresses always pass regardless of allowlist state

---

## Sprint 7: Production Deployment + Monitoring (Global ID: 74)

**Objective**: Deploy loa-finn to AWS ECS Fargate with shared VPC. Dedicated ElastiCache, Prometheus metrics, CloudWatch alarms, treasury multisig configuration.

**Gate**: `terraform plan` clean. ECS task healthy. Health endpoint reports all subsystems. Prometheus scraping.

**Rollback**: `terraform destroy` for loa-finn resources. arrakis unaffected (shared VPC).

### Task 7.1: Terraform — ECS Fargate Task Definition

**Description**: Create Terraform modules for loa-finn ECS deployment on shared AWS VPC with arrakis.

**Files created**:
- `infrastructure/terraform/loa-finn-ecs.tf` — Task definition, service, security group
- `infrastructure/terraform/loa-finn-env.tf` — SSM Parameter Store for env vars

**Acceptance criteria**:
- [ ] ECS Fargate task: 1 vCPU, 2GB RAM, `desiredCount: 1` (single-writer for WAL)
- [ ] Security group: inbound from ALB only, outbound to ElastiCache + arrakis + internet (RPC calls)
- [ ] SSM Parameter Store for all env vars: `ARRAKIS_URL`, `FINN_S2S_*`, `BASE_RPC_URL`, `TREASURY_ADDRESS`, etc.
- [ ] IAM role: ECS task execution + R2 access + KMS + SSM read
- [ ] Health check: `GET /health` with 30s interval, 3 retries

---

### Task 7.2: Terraform — ALB + DNS + ElastiCache

**Description**: ALB configuration with WebSocket support, Route53 DNS, dedicated ElastiCache Redis for loa-finn (Flatline SKP-002).

**Files created**:
- `infrastructure/terraform/loa-finn-alb.tf` — Target group, listener rules
- `infrastructure/terraform/loa-finn-redis.tf` — Dedicated ElastiCache

**Acceptance criteria**:
- [ ] ALB target group with WebSocket support (stickiness enabled)
- [ ] Listener rule: `loa-finn.honeyjar.xyz` → loa-finn target group
- [ ] Route53 A record: `loa-finn.honeyjar.xyz` → ALB
- [ ] Dedicated ElastiCache: `cache.t4g.small`, Redis 7.x, `maxmemory-policy: noeviction` (Flatline SKP-002)
- [ ] **Redis HA + persistence** (Flatline SKP-004): Multi-AZ replication enabled (1 replica), AOF persistence with `everysec` fsync, automated backups daily with 7-day retention
- [ ] **Redis memory sizing** (Flatline SKP-004): `maxmemory` set to 80% of instance RAM; CloudWatch alarm on `DatabaseMemoryUsagePercentage > 70%` (early warning before OOM)
- [ ] **Redis OOM handling** (Flatline SKP-004): billing module detects Redis write rejection → circuit-break billing (deny new reserves with 503), fire alert, continue serving read-only cached data
- [ ] **Redis key separation** (Flatline SKP-004): namespace prefixes — `billing:*` (critical: reserves, balances, idempotency), `conv:*` (conversation cache, less critical), `x402:*` (nonce/payment), `session:*` (auth). Monitor per-prefix memory via `MEMORY USAGE` sampling.
- [ ] ElastiCache in private subnet, security group allows inbound from ECS only
- [ ] TLS in transit (ALB termination)

---

### Task 7.3: Monitoring — Prometheus + CloudWatch

**Description**: Prometheus metrics endpoint and CloudWatch alarms for operational visibility.

**Files created**:
- `infrastructure/terraform/loa-finn-monitoring.tf` — CloudWatch log group, metric alarms
- `src/gateway/metrics-endpoint.ts` — Prometheus `/metrics` endpoint (if not existing)

**Acceptance criteria**:
- [ ] `/metrics` endpoint serves Prometheus-format metrics
- [ ] CloudWatch log group for ECS container logs
- [ ] CloudWatch alarms: CPU > 80%, memory > 80%, 5xx rate > 1%, billing_pending > 10
- [ ] Grafana dashboard config: request rate, latency, error rate, credit balance distribution, conservation guard results
- [ ] `billing_pending_reconciliation_count > 10` → PagerDuty alert

---

### Task 7.4: CI/CD — GitHub Actions ECS Deploy

**Description**: Extend existing GitHub Actions workflow with ECS deployment step.

**Files modified**:
- `.github/workflows/deploy.yml` — Add ECS deploy job

**Acceptance criteria**:
- [ ] On merge to main: build Docker image → push to ECR → update ECS service
- [ ] `npm ci` (not `npm install`) in CI
- [ ] ECS rolling update: new task starts, health check passes, old task drains
- [ ] Rollback: previous task definition revision auto-reverts on health check failure

---

### Task 7.5: JWKS Key Rotation + Treasury Config

**Description**: Production JWT key management via KMS. Treasury multisig documentation.

**Files created/modified**:
- `src/gateway/jwks.ts` — KMS-backed JWKS endpoint (extend existing)
- Documentation for treasury setup

**Acceptance criteria**:
- [ ] JWT signing keys stored in AWS KMS
- [ ] `/.well-known/jwks.json` serves public keys (existing, verify KMS integration)
- [ ] Key rotation: new key added to JWKS, old key valid for 48h overlap
- [ ] `TREASURY_ADDRESS` configured via SSM Parameter Store
- [ ] Treasury monitoring: documented alert for unexpected transfers

---

### Task 7.6: Production Deploy Test Suite

**Description**: Smoke tests that run against the deployed ECS task.

**Files created**:
- `tests/e2e/production-smoke.test.ts`

**Acceptance criteria**:
- [ ] Health endpoint returns all subsystems healthy
- [ ] JWKS endpoint returns valid JWK set
- [ ] Prometheus metrics endpoint returns valid exposition format
- [ ] Feature flags respond to Redis state
- [ ] Allowlist guard rejects non-allowlisted addresses

---

### Task 7.7: Single-Writer WAL Guardrail — Enforcement + Runtime Lock

**Description**: Enforce `desiredCount=1` for beta to protect WAL single-writer invariant. Add Terraform guardrails, CloudWatch alarms on service count drift, and a runtime Redis-based leader lock that fail-closes if a second writer starts (SDD §6.3 single-writer enforcement).

**Files created/modified**:
- `infrastructure/terraform/loa-finn-ecs.tf` — desiredCount constraint + alarm
- `src/billing/wal-writer-lock.ts` — Redis SETNX leader lock

**Acceptance criteria**:
- [ ] Terraform: `desiredCount = 1` enforced in ECS service definition with `lifecycle { prevent_destroy = true }` on the service resource
- [ ] CloudWatch alarm: `ECSServiceDesiredCount != 1` → PagerDuty alert (catches manual scaling or autoscaling policy drift)
- [ ] Runtime leader lock: `SETNX wal:writer:lock {ecs_task_id}` with 30s TTL, refreshed every 10s via keepalive
- [ ] **Fencing token** (Flatline SKP-002): lock acquisition returns monotonic `fencing_token` (Redis INCR `wal:writer:fence`); every WAL append includes `fencing_token` in record header; replay rejects records with stale/out-of-order tokens
- [ ] If lock acquisition fails (another writer exists): new task logs CRITICAL error, returns 503 on all billing endpoints, fires alert — fail-closed, does NOT write to WAL
- [ ] Lock release: on graceful shutdown, `DEL wal:writer:lock` before ECS SIGTERM handler exits
- [ ] Stale lock recovery: if lock holder crashes without releasing, 30s TTL expires, next task acquires with new fencing token (old writer's WAL appends rejected by token check)
- [ ] Runbook entry: "Do not scale ECS desiredCount above 1 — WAL single-writer invariant. Future scaling requires leader election or WAL partitioning (not in scope for beta)"
- [ ] Test: start two instances → second instance detects lock conflict → returns 503

---

## Sprint 8: x402 Middleware + Payment Verification (Global ID: 75)

**Objective**: Hono middleware returns 402 with fixed price quote. EIP-3009 payment verification. Nonce replay protection. Dedicated `/api/v1/x402/invoke` endpoint.

**Gate**: x402 flow: unauthenticated request → 402 with quote → payment header → inference → receipt. Nonce replay prevented.

**Rollback**: Feature flag `feature:x402:enabled` OFF → x402 endpoint returns 503.

### Task 8.1: x402 Middleware — 402 Response + Quote

**Description**: Create `src/x402/middleware.ts` implementing the 402 Payment Required response with fixed price quote (SDD §5.2, PRD FR-3.1).

**Files created**:
- `src/x402/middleware.ts` — 402 response middleware
- `src/x402/types.ts` — X402Quote, PaymentProof types

**Acceptance criteria**:
- [ ] Unauthenticated `POST /api/v1/x402/invoke` returns 402 with `X-Payment-Required` header
- [ ] Header includes: `max_cost` (MicroUSDC), `max_tokens`, `model`, `payment_address`, `chain_id: 8453`, `valid_until` (5min TTL)
- [ ] `max_cost` is deterministic upper bound from `max_tokens × rate × markup_factor`
- [ ] Quote cached per `(model, max_tokens)` tuple for 60s in Redis
- [ ] `max_tokens` capped at model default if not specified in request
- [ ] Authenticated requests (JWT or credit balance) bypass x402 flow entirely

---

### Task 8.2: EIP-3009 Payment Verification + Settlement

**Description**: Create `src/x402/verify.ts` implementing EIP-3009 `transferWithAuthorization` verification from `X-Payment` header (PRD FR-3.2). Concrete settlement model: openx402.ai facilitator executes on-chain `transferWithAuthorization` and returns `tx_hash` + receipt; finn verifies the receipt on Base to confirm funds moved to `TREASURY_ADDRESS`.

**Files created**:
- `src/x402/verify.ts` — Payment verification + settlement
- `src/x402/settlement.ts` — Settlement orchestration (facilitator primary, direct fallback)

**Acceptance criteria**:
- [ ] Parse EIP-3009 `transferWithAuthorization` data from `X-Payment` header
- [ ] Verify: signature valid (ecrecover for EOA, EIP-1271 for contract wallets via Task 2.3)
- [ ] Verify: `amount >= quoted_max_cost` (payment invariant)
- [ ] Verify: `validBefore >= now` (not expired)
- [ ] Verify: nonce unused (Redis check + WAL authoritative per Task 8.3)
- [ ] Enforce `max_tokens` from quote — request cannot exceed token bound
- [ ] **Settlement Model A (primary)**: Submit signed authorization to openx402.ai facilitator → facilitator executes `transferWithAuthorization` on-chain → returns `tx_hash` + block confirmation
- [ ] **Settlement Model B (fallback)**: If facilitator unavailable (circuit breaker OPEN after 3 failures in 60s), finn submits `transferWithAuthorization` tx directly via viem → wait for 3+ confirmations on Base
- [ ] **Settlement verification**: After either path, finn verifies `getTransactionReceipt(tx_hash)` → parse USDC Transfer event → confirm `to == TREASURY_ADDRESS` and `amount >= quoted_max_cost`
- [ ] Settlement result (tx_hash, block_number, confirmation_count) persisted in WAL `x402_settlement` entry
- [ ] If settlement fails (tx reverted, insufficient balance): deny inference, return 402 with `{ error: "settlement_failed", reason }` — NO free inference
- [ ] Rounding: all MicroUSDC amounts ceil to nearest 1 MicroUSDC
- [ ] Facilitator circuit breaker: CLOSED → OPEN (3 failures/60s) → HALF_OPEN (30s) → CLOSED (probe success)

---

### Task 8.3: Nonce Replay Protection

**Description**: Store used EIP-3009 nonces in Redis with TTL matching `validBefore` to prevent replay attacks.

**Files modified**:
- `src/x402/verify.ts` — Nonce storage

**Acceptance criteria**:
- [ ] `x402:payment:{payment_id}` stored in Redis after successful verification
- [ ] `payment_id = keccak256(chainId, token, from, nonce, recipient, amount, validBefore)` — canonical binding
- [ ] TTL matches `validBefore` timestamp
- [ ] Authoritative record in WAL (`x402_payment` entry) — Redis is cache
- [ ] On Redis loss: deny x402 until WAL replay restores used payment IDs
- [ ] Idempotent replay: same `payment_id` returns original receipt (no re-invocation)

---

### Task 8.4: x402 Route Registration

**Description**: Register dedicated `/api/v1/x402/invoke` endpoint with x402-only middleware stack (GPT-IMP-007). During closed beta, x402 is ALSO allowlist-gated to prevent unauthenticated public access. A separate `feature:x402:public` flag controls future public access.

**Files created**:
- `src/gateway/x402-routes.ts` — x402 route registration

**Acceptance criteria**:
- [ ] `POST /api/v1/x402/invoke` — dedicated endpoint, NOT `/api/v1/invoke`
- [ ] Middleware stack: `allowlistGuard → x402Verify → rateLimiter` — allowlist check FIRST during closed beta
- [ ] `feature:x402:public` feature flag (default OFF during beta): when ON, skip allowlist check on x402 route only
- [ ] Rate limiting on x402: 100 req/hour per wallet address (prevents abuse even when public)
- [ ] x402 route MUST NOT accept `nft_id` parameter — generic system prompt only
- [ ] No wallet/NFT side effects: no conversation persistence, no personality access
- [ ] Separate from authenticated `/api/v1/invoke` (prevents confused-deputy)
- [ ] Gate 4 validation: x402 tested with allowlist ON (beta) and with `feature:x402:public` ON (future)

---

### Task 8.5: x402 Test Suite

**Description**: Tests for x402 quote, verification, settlement, nonce protection, allowlist gating, and capability scoping.

**Files created**:
- `tests/finn/x402.test.ts`

**Acceptance criteria**:
- [ ] Unauthenticated request → 402 with valid quote
- [ ] Payment of exact `max_cost` → settlement executes → funds verified at TREASURY_ADDRESS → inference succeeds
- [ ] Payment less than `max_cost` → rejected with "insufficient payment" and required amount
- [ ] Expired `validBefore` → rejected
- [ ] Replayed nonce → rejected (Redis + WAL verified)
- [ ] x402 with `nft_id` parameter → rejected (capability scoping)
- [ ] Smart wallet (EIP-1271) payment → verified via on-chain call (Task 2.3 path)
- [ ] Settlement failure (tx reverted) → 402 error, no free inference
- [ ] Facilitator unavailable → fallback to direct on-chain submission → success
- [ ] Allowlist-gated during beta: non-allowlisted wallet → 403 on x402 endpoint
- [ ] `feature:x402:public` ON → allowlist bypassed on x402 only
- [ ] WAL replay after Redis flush: used payment IDs restored, replayed nonce still rejected

---

## Sprint 9: x402 Denomination + Guard Integration (Global ID: 76)

**Objective**: MicroUSD ↔ MicroUSDC conversion with frozen rate. Credit-note refund for overpayment. X-Receipt response header. Conservation guard wired for x402 path.

**Gate**: x402 request → inference → receipt shows `quoted`, `actual`, `credit_note`. Rounding drift within threshold.

**Rollback**: Disable x402 credit notes → charge full quoted amount (simpler but user-hostile).

### Task 9.1: Denomination Conversion with Frozen Rate

**Description**: Create `src/credits/conversion.ts` (or extend) implementing MicroUSD ↔ MicroUSDC conversion with rate freeze per `billing_entry_id` (SDD §3.4).

**Files created/modified**:
- `src/credits/conversion.ts` — Rate-frozen conversion functions

**Acceptance criteria**:
- [ ] `convertMicroUSDtoMicroUSDC(amount, frozenRate): MicroUSDC` — `Math.ceil()` rounding
- [ ] Rate frozen at quote time, persisted in WAL, used for settlement regardless of env var changes
- [ ] `USD_USDC_EXCHANGE_RATE` env var (initially 1.0) for rate config
- [ ] Rate and rounding logged in WAL for audit trail

---

### Task 9.2: Credit-Note Refund System

**Description**: Create `src/x402/credit-note.ts` implementing off-chain credit notes for x402 overpayment delta (PRD FR-3.1).

**Files created**:
- `src/x402/credit-note.ts` — Credit note management

**Acceptance criteria**:
- [ ] If `actual_cost < quoted_max_cost`, delta issued as credit note to wallet-bound x402 balance
- [ ] Credit notes stored in Redis `x402:credit:{wallet}` with 7-day TTL
- [ ] Credit notes reduce required payment amount on future x402 requests
- [ ] WAL `x402_credit_note` entry for each credit note issued
- [ ] Double-entry: `system:revenue -delta`, `system:credit_notes +delta`

---

### Task 9.3: X-Receipt Response Header

**Description**: Add `X-Receipt` header to every x402 response with payment details (SDD §5.2).

**Files modified**:
- `src/x402/middleware.ts` — Add receipt header

**Acceptance criteria**:
- [ ] `X-Receipt: {"quoted":"5000","actual":"3200","credit_note":"1800","credit_balance":"1800"}`
- [ ] All amounts in MicroUSDC
- [ ] Receipt logged in WAL for audit trail
- [ ] Receipt matches conservation guard verification

---

### Task 9.4: x402 Denomination + Rounding Test Suite

**Description**: Tests for denomination conversion, credit notes, and rounding drift.

**Files created**:
- `tests/finn/x402-denomination.test.ts`

**Acceptance criteria**:
- [ ] Conversion round-trip: MicroUSD → MicroUSDC → back preserves value within 1 unit
- [ ] Rate freeze: rate changes between quote and settlement → settlement uses frozen rate
- [ ] Credit note: overpayment → credit note → next request reduced by credit
- [ ] Rounding drift: 1000 requests → cumulative drift < 1000 MicroUSD threshold
- [ ] X-Receipt header present and accurate on every x402 response

---

## Sprint 10: Integration Testing + Staged Rollout (Global ID: 77)

**Objective**: Cross-system E2E testing. Validate Gates 0-4 staged rollout. Load testing for beta scale. Documentation and runbooks.

**Gate**: All Gates 0-3 validated. Load test passes at 50 concurrent users. All runbooks documented. Zero regression.

**Rollback**: N/A (testing sprint, no new production code).

### Task 10.1: Cross-System E2E Test Suite

**Description**: Full stack tests exercising every track: billing → credits → NFT → onboarding → x402.

**Files created**:
- `tests/e2e/full-stack.test.ts`

**Acceptance criteria**:
- [ ] E2E: wallet connect → allowlist check → NFT detection → personality config → credit purchase → first chat message → credit deducted
- [ ] E2E: x402 request → 402 quote → payment → inference → receipt → credit note
- [ ] E2E: BYOK activation → inference → metered but not charged → rate limit hit at 1000/day
- [ ] E2E: DLQ failure → PENDING_RECONCILIATION → admin manual resolution → account unblocked
- [ ] All tests run against Docker Compose full stack

---

### Task 10.2: Staged Rollout Gate Validation

**Description**: Validate each gate's feature flag configuration (PRD §1 Gates 0-4).

**Files created**:
- `tests/e2e/staged-rollout.test.ts`

**Acceptance criteria**:
- [ ] Gate 0 (Smoke): billing enabled, all else OFF → E2E billing loop works, credit endpoints 503
- [ ] Gate 1 (Ignition): + credits enabled → credit purchase + deduction works
- [ ] Gate 2 (Warmup): + nft + onboarding enabled → personality + chat + onboarding works
- [ ] Gate 3 (Idle): same as Gate 2 (BYOK already in credits track)
- [ ] Gate 4 (Launch): + x402 enabled → x402 flow works
- [ ] Each gate: feature flags for subsequent gates are OFF
- [ ] Each gate: conservation guard verified with test value flow

---

### Task 10.3: Load Testing — 50 Concurrent Users

**Description**: Load test the deployed system at beta scale (50 concurrent users).

**Files created**:
- `tests/load/beta-load.ts` — Load test script

**Acceptance criteria**:
- [ ] 50 concurrent WebSocket connections with chat messages
- [ ] p95 inference latency < 200ms overhead (excluding model response)
- [ ] Credit check < 5ms (Redis lookup)
- [ ] Zero 5xx errors under normal load
- [ ] Reserve Lua script handles 50 concurrent reserves without deadlock
- [ ] Memory stable over 1-hour sustained load (no leaks)

---

### Task 10.4: Operational Runbooks

**Description**: Document operational procedures for beta operations.

**Files created**:
- `docs/runbooks/` — Operational runbook documents

**Acceptance criteria**:
- [ ] Treasury compromise runbook: freeze mints → rotate address → audit recent mints
- [ ] DLQ overflow runbook: circuit breaker → admin resolution → drain queue
- [ ] Conservation guard failure runbook: bypass procedure → escalation → recovery
- [ ] Rollback runbook per gate: disable feature flag → verify previous gate behavior
- [ ] Redis failure runbook: WAL rebuild procedure → balance verification

---

### Task 10.5: Final Regression + Test Baseline

**Description**: Final test suite run. Verify zero regression. Document test baseline for post-beta maintenance.

**Acceptance criteria**:
- [ ] All 2101+ existing tests pass (zero regression)
- [ ] All new tests pass (estimated 200+ new tests across sprints 1-10)
- [ ] Full E2E suite passes against Docker Compose
- [ ] Test baseline documented: total count, per-module count, pre-existing failures
- [ ] CI green on feature branch before merge

---

## Risk Register

| Risk | Sprint | Mitigation | Status |
|------|--------|------------|--------|
| Base RPC unreliability for USDC verification | 2 | Multi-RPC (Alchemy + public), retry with backoff | Open |
| Redis data loss | 1 | WAL is source of truth; Redis rebuilt from WAL | Open |
| DLQ queue growth under arrakis outage | 1 | 24h auto-release, circuit breaker, max 50 pending | Open |
| EIP-1271 smart wallet compatibility | 2,5 | Graceful fallback with clear error | Open |
| openx402.ai facilitator downtime | 8 | Direct on-chain verification fallback | Open |
| Terraform state drift | 7 | State locking, plan-before-apply, PR review | Open |
| WebSocket session limits at beta scale | 5 | ECS auto-scaling, session eviction (30min idle) | Open |
| WAL single-writer scaling beyond beta | 7 | Task 7.7 guardrails + runbook; future: leader election/partitioning | Open |
| x402 public access during beta | 8 | Allowlist-gated (Task 8.4), `feature:x402:public` flag for future | Open |
| On-chain reorg after credit mint | 2 | 12+ confirmations + background reorg detector | Open |
| Rate changes mid-request | 3 | Rate freeze per billing_entry_id | Open |
| Conservation guard performance with new invariants | 3 | Microbenchmark < 1ms per invariant | Open |

---

## Success Criteria (Cycle Complete)

- [ ] E2E billing loop: reserve → inference → commit → finalize (arrakis acked)
- [ ] Credit purchase: USDC transfer → on-chain verification → credit mint → balance reflected
- [ ] Credit deduction: inference → MicroUSD cost → CreditUnit conversion → balance decremented
- [ ] BYOK: entitlement check → inference → metered but not charged → rate limited
- [ ] NFT personality: create → retrieve → used in inference system prompt
- [ ] Agent homepage: chat widget → WebSocket streaming → credit display
- [ ] Onboarding: wallet connect → NFT detect → personality → credits → first message
- [ ] x402: 402 quote → payment → inference → receipt → credit note
- [ ] Allowlist: non-allowlisted → 403, allowlisted → access
- [ ] Feature flags: staged rollout Gates 0-4 validated
- [ ] Conservation guard: all invariants pass with real value flow
- [ ] Production deploy: ECS healthy, Prometheus scraping, CloudWatch alarms
- [ ] Zero regression: all 2101+ existing tests pass
- [ ] Beta-ready: internal team using real credits on deployed system
