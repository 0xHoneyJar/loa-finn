# Sprint Plan: Hounfour Phase 5 — Integration Hardening & Multi-Model Orchestration

> **Version**: 1.0.0
> **Date**: 2026-02-09
> **PRD**: `grimoires/loa/prd-hounfour-phase5.md`
> **SDD**: `grimoires/loa/sdd-hounfour-phase5.md`
> **Cycle**: cycle-009
> **Branch**: `feature/hounfour-phase5`
> **Base Branch**: `feature/hounfour-phase3` (Phase 3 code required)

---

## Overview

| Parameter | Value |
|-----------|-------|
| Team size | 1 developer (operator + Loa agent pair) |
| Sprint duration | ~1 session each |
| Total sprints | 3 (A, B, C) |
| Sprint D deferred | Scaffolding — separate cycle after integration proven |
| Beads tracking | Required (beads-first) |
| Multi-repo | PRD here (loa-finn). Arrakis tasks (A.4, C.1, C.3) executed in arrakis repo. |

### Sprint Dependency Graph

```
Sprint A (Integration Debt — P0)
├──► Sprint B (NativeRuntimeAdapter + Ensemble — P1)
└──► Sprint C (finnNFT Routing + BYOK — P1)
```

Sprint B and Sprint C are independent — can execute in either order after Sprint A.

### Scope Decision

Sprint D (Scaffolding + Polish) is deferred to a separate cycle. Its tasks (loa config templates, persona updates, cross-NFT prototype, cost-report updates, documentation) are low-risk and don't affect the integration contract. This keeps the current cycle focused on the critical path: integration correctness → model orchestration → user-facing features.

---

## Sprint A: Integration Debt

> **Goal**: loa-finn validates arrakis JWTs, routes by tier/pool, tracks budget in integer micro-USD, reports usage, and handles abort/LRU correctly.
> **Exit Criteria**: JWT roundtrip with real ES256 keys (including req_hash). Budget: deterministic test vectors produce 0 drift (exact match); randomized 10k-request test produces drift ≤ max(1 micro-USD, 0.1% of total spend) due to remainder carry timing. No orphaned orchestrators after abort. All 10 tasks pass.
> **Depends on**: Phase 3 code (`feature/hounfour-phase3` merged or rebased)
> **Global Sprint ID**: 22

### Tasks

#### T-A.1: JWT Validation Middleware

**Description**: Create `src/hounfour/jwt-auth.ts` — Hono middleware that validates ES256 JWTs per PRD §6.1 verification profile. Uses `jose` npm package for JWKS resolution and JWT verification.

**Acceptance Criteria**:
- [ ] `jwtAuthMiddleware` validates ES256 JWTs on `/api/v1/*` routes
- [ ] JWKS client fetches from `{ARRAKIS_BASE_URL}/.well-known/jwks.json` with 5min TTL LRU cache
- [ ] On `kid` cache miss: refetch once, then 401
- [ ] Dual-key window: accepts current + previous rotation key
- [ ] Strict header checks: `alg` must be ES256, `typ` must be JWT, `kid` required
- [ ] Required claims validated: `iss`, `aud`, `sub`, `tenant_id`, `tier`, `req_hash`, `iat`, `exp`
- [ ] Clock skew tolerance: 30s (configurable via `FINN_JWT_CLOCK_SKEW`)
- [ ] Max token lifetime: 1 hour (configurable via `FINN_JWT_MAX_LIFETIME`)
- [ ] `TenantContext` extracted and set on Hono context (`c.set("tenant", tenantContext)`)
- [ ] Config: `jwt.enabled`, `jwt.issuer`, `jwt.audience`, `jwt.jwksUrl`, `jwt.clockSkewSeconds`, `jwt.maxTokenLifetimeSeconds`

**Files**: `src/hounfour/jwt-auth.ts` (new), `src/config.ts` (modify)
**Effort**: Medium (3-4h)

#### T-A.2: Route-Based Dual Auth

**Description**: Wire dual-auth in `src/gateway/server.ts` — route separation between JWT auth (`/api/v1/*`) and existing bearer auth (`/api/*`). WebSocket uses JWT from query param with nonce challenge.

**Acceptance Criteria**:
- [ ] `/api/v1/*` routes use `jwtAuthMiddleware` exclusively — rejects non-JWT tokens
- [ ] `/api/*` routes use existing `bearerAuthMiddleware` — unchanged behavior
- [ ] Structural pre-check before JWT validation: 3 segments, header decodes to `alg:ES256`+`typ:JWT`
- [ ] Failed structural check → 401 (not fallback to bearer)
- [ ] Passed structural check but failed validation → 401 (not fallback)
- [ ] WebSocket (`/ws/v1/*`): JWT from `token` query param, validated on HTTP upgrade (full ES256 verification)
- [ ] WS replay protection: `jti` claim required for WS connections; stored in Redis with TTL=`exp-now`; duplicate `jti` → reject upgrade with 401
- [ ] Short JWT lifetime for WS: recommend ≤5min `exp` for upgrade tokens (enforced by existing `maxTokenLifetimeSeconds` config)

**Files**: `src/gateway/server.ts` (modify), `src/gateway/ws.ts` (modify)
**Effort**: Medium (2-3h)

#### T-A.3: req_hash Verification

**Description**: Verify `req_hash` claim by hashing raw request body bytes and comparing to JWT claim. Scoped to JSON REST requests only (not WS/SSE).

**Acceptance Criteria**:
- [ ] `req_hash` verified only on POST/PUT/PATCH with `Content-Type: application/json`
- [ ] Implementation: buffer raw body into `Uint8Array` (up to 1MB), compute SHA-256 over buffer, then parse JSON from same buffer. Single read, no tee stream complexity.
- [ ] Raw body capture: use `c.req.raw.arrayBuffer()` before any Hono body parsing middleware runs (middleware ordering critical)
- [ ] Hard cap: 1MB max body size for hashed requests; `Content-Length` > 1MB or buffered bytes > 1MB → 413
- [ ] `Content-Encoding`: only `identity` (uncompressed) accepted for req_hash requests. `Content-Encoding: gzip` or other → 415 with `{"error": "req_hash_requires_identity_encoding"}`. This avoids ambiguity about whether to hash compressed vs decompressed bytes.
- [ ] Empty body: verify against SHA-256 of empty string (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`)
- [ ] Hash mismatch → 400 with `{"error": "req_hash_mismatch"}`
- [ ] WebSocket/SSE paths skip req_hash entirely (WS auth via JWT-on-upgrade + jti replay protection)

**Files**: `src/hounfour/jwt-auth.ts` (extend)
**Effort**: Medium (2-3h)

#### T-A.4: Model Pool Registry

**Description**: Create `src/hounfour/pool-registry.ts` — canonical mapping from pool IDs to provider/model configurations. All routing uses pool IDs, never raw model names in JWT claims.

**Acceptance Criteria**:
- [ ] `PoolRegistry` class with `resolve()`, `authorize()`, `resolveForTier()`, `validatePreferences()`
- [ ] 5 default pools configured: `cheap`, `fast-code`, `reviewer`, `reasoning`, `architect`
- [ ] Tier access enforced: free → `cheap` only; pro → `cheap`+`fast-code`+`reviewer`; enterprise → all
- [ ] Unknown pool ID → `null` from `resolve()`, 400 from HTTP handler
- [ ] Pool→provider mapping configurable via config (not hardcoded)
- [ ] `validatePreferences()` checks all values in `model_preferences` are valid pool IDs
- [ ] Integration with `HounfourRouter`: resolves from (1) NFT preferences → (2) tier default → (3) global fallback
- [ ] Fallback chain: if pool's provider is unhealthy (circuit open), follows `fallback` pointer

**Files**: `src/hounfour/pool-registry.ts` (new), `src/hounfour/router.ts` (modify), `src/config.ts` (modify)
**Effort**: Medium (3-4h)

#### T-A.5: Integer Micro-USD Budget Migration

**Description**: Replace all floating-point USD with integer micro-USD in Redis budget, JSONL ledger, and in-memory mirror. Float-free cost path using integer division/modulo.

**Acceptance Criteria**:
- [ ] Pricing table in `src/hounfour/pricing.ts` stores `price_micro_per_million_input` and `price_micro_per_million_output` as plain integers (JS `number`, safe up to `Number.MAX_SAFE_INTEGER` = 9,007,199,254,740,991 micro ≈ $9B)
- [ ] Cost computation uses `Number` (not BigInt) for hot-path performance: `cost_micro = Math.floor((tokens * price_micro_per_million) / 1_000_000)`. Safe because max realistic product is ~10^12 (well within 2^53).
- [ ] Guardrail: assert `tokens * price_micro_per_million < Number.MAX_SAFE_INTEGER` before arithmetic; throw `BUDGET_OVERFLOW` error if exceeded
- [ ] Cross-language test vectors use `BigInt` (JS) and `int` (Python) as reference oracle to verify `Number`-based implementation produces identical results for all 50+ test cases
- [ ] Remainder tracking: `remainder_micro = (tokens * price_micro_per_million) % 1_000_000` per `(tenant_id, model)`
- [ ] Remainder carry: when `accumulated_remainder >= 1_000_000`, add 1 to cost_micro, subtract 1_000_000
- [ ] Redis: `INCRBY` replaces `INCRBYFLOAT`. Keys: `finn:hounfour:budget:{tenant}:spent_micro`, `...:remainder_micro`
- [ ] JSONL ledger: new `cost_micro` field alongside deprecated `total_cost_usd` (1 rotation cycle compat)
- [ ] In-memory mirror: `Map<string, { spent_micro: number; remainder_micro: number }>`
- [ ] No floating-point multiplication anywhere in the cost path (all inputs are integers, division is integer via `Math.floor`)
- [ ] Cross-language test vectors: `tests/fixtures/budget-test-vectors.json` with 50+ cases, all integer inputs

**Files**: `src/hounfour/budget.ts` (modify), `src/hounfour/redis/budget.ts` (modify), `src/hounfour/pricing.ts` (new or modify), `tests/fixtures/budget-test-vectors.json` (new)
**Effort**: Large (4-6h)

#### T-A.6: S2S JWT Signing

**Description**: Create `src/hounfour/s2s-jwt.ts` — loa-finn's ES256 keypair for signing S2S JWTs and JWS payloads when communicating with arrakis.

**Acceptance Criteria**:
- [ ] `S2SJwtSigner` class: signs JWTs with `iss=loa-finn`, `aud=arrakis`
- [ ] ES256 keypair loaded from config (`FINN_S2S_PRIVATE_KEY` or key file path)
- [ ] New JWKS endpoint at `{FINN_BASE_URL}/.well-known/jwks.json` serving loa-finn's public key
- [ ] JWS signing for usage report payloads (compact serialization over canonical JSON)
- [ ] Key rotation: `kid` includes version suffix

**Files**: `src/hounfour/s2s-jwt.ts` (new), `src/gateway/server.ts` (modify — add JWKS endpoint)
**Effort**: Medium (2-3h)

#### T-A.7: Usage Report Pipeline

**Description**: Create `src/hounfour/usage-reporter.ts` — posts cost data from loa-finn to arrakis after each inference. Durable delivery with JWS-signed payloads.

**Acceptance Criteria**:
- [ ] `UsageReporter` class with `report(usage: UsageReport)` method
- [ ] POST to `{ARRAKIS_BASE_URL}/internal/usage-reports` with S2S JWT auth
- [ ] Payload signed as JWS (compact serialization) over canonical JSON
- [ ] `report_id` (ULID) as idempotency key — arrakis deduplicates
- [ ] Retry: 3x exponential backoff (1s, 2s, 4s)
- [ ] Failed reports → Redis ZSET dead-letter queue (`finn:hounfour:usage-reports:dead-letter`, scored by timestamp). No new npm deps required — uses existing ioredis client.
- [ ] If Redis unavailable during dead-letter write: fall back to local JSONL file (`data/dead-letter-usage-reports.jsonl`) as last resort
- [ ] Background replay job: every 5 minutes, `ZPOPMIN` up to 10 items from dead-letter ZSET, retry POST to arrakis
- [ ] R2/S3 durable dead-letter is an optional future upgrade (not required for this sprint)
- [ ] Integration point: called by orchestrator after each model invocation completes
- [ ] `original_jti` field included for cross-referencing user JWT
- [ ] Required env vars documented: `ARRAKIS_BASE_URL`, `FINN_S2S_PRIVATE_KEY` (or key file path)

**Files**: `src/hounfour/usage-reporter.ts` (new), `src/hounfour/orchestrator.ts` (modify)
**Effort**: Large (4-5h)

#### T-A.8: Stream Bridge Abort Fix

**Description**: Wire AbortController through the full chain: WS disconnect → stream-bridge → orchestrator → sidecar-client → cheval.

**Acceptance Criteria**:
- [ ] WS `close` event triggers `abortController.abort()` in stream-bridge
- [ ] Orchestrator constructor receives `AbortSignal`; checks `signal.aborted` before each iteration
- [ ] Sidecar-client passes signal through to `undici` request (or fetch abort)
- [ ] On abort: flush pending tool results, clean up session state, log to audit trail with `trace_id`
- [ ] No orphaned orchestrator processes after client disconnect
- [ ] Test: start orchestrator → close WS → verify cleanup within 5s

**Files**: `src/gateway/stream-bridge.ts` (modify), `src/hounfour/orchestrator.ts` (modify), `src/hounfour/sidecar-client.ts` (modify)
**Effort**: Medium (2-3h)

#### T-A.9: Idempotency Cache LRU

**Description**: Replace unbounded `Map<string, ToolResult>` in idempotency cache with LRU cache.

**Acceptance Criteria**:
- [ ] LRU cache with configurable max entries (default 10,000 via `FINN_IDEMPOTENCY_CACHE_MAX`)
- [ ] Eviction: least recently used entry removed on insert when full
- [ ] Implementation: doubly-linked list + Map (~50 lines, no npm dependency)
- [ ] TTL per entry preserved (existing `max_wall_time_ms` behavior)
- [ ] Test: insert 10,001 entries → verify size = 10,000, oldest evicted
- [ ] Redis-backed idempotency unchanged (already uses TTL eviction)

**Files**: `src/hounfour/idempotency.ts` (modify)
**Effort**: Small (1-2h)

#### T-A.10: Sprint A Integration Tests

**Description**: E2E test suite covering the full JWT → routing → budget → abort → usage report flow.

**Acceptance Criteria**:
- [ ] JWT roundtrip: generate ES256 keypair → sign JWT → validate → extract claims → route to pool
- [ ] req_hash verification: hash body → embed in JWT → verify on receive (JSON, gzip, empty)
- [ ] Tier→pool authorization: free → `cheap` only; pro → 3 pools; enterprise → all
- [ ] Unknown pool rejection: JWT with `model_preferences: { chat: "nonexistent" }` → 400
- [ ] Budget deterministic vectors: all 50+ cases produce exact match (0 drift) between JS `Number` and Python `int` implementations, verified against `BigInt` oracle
- [ ] Budget randomized test: 10,000 random requests → drift ≤ max(1 micro-USD, 0.1% of total spend)
- [ ] Abort completeness: start orchestrator → close WS → verify no orphan after 5s
- [ ] LRU eviction: insert 10,001 entries → verify size = 10,000
- [ ] Usage report: mock arrakis `/internal/usage-reports` → verify S2S JWT auth, JWS payload signature, correct schema, idempotency (duplicate `report_id` → 200)
- [ ] Dead-letter replay: simulate arrakis down → verify reports queued in Redis ZSET → arrakis back up → replay job delivers
- [ ] Route separation: JWT on `/api/v1/*` works, bearer on `/api/*` works, mixing → 401
- [ ] WS replay protection: duplicate `jti` on second WS upgrade → 401 rejection
- [ ] Mock arrakis server (`tests/fixtures/mock-arrakis-server.ts`): lightweight Hono app implementing JWKS, usage-reports, budget, and BYOK proxy endpoints per PRD §6.1-6.4

**Files**: `tests/finn/jwt-integration.test.ts` (new), `tests/finn/budget-vectors.test.ts` (new)
**Effort**: Large (4-6h)

---

## Sprint B: NativeRuntimeAdapter + Ensemble

> **Goal**: Anthropic Messages API wrapped as ModelPort. At least `first_complete` ensemble strategy works E2E. Qwen3-Coder-Next validated for tool-calling.
> **Exit Criteria**: AnthropicAdapter passes health check, completes streaming request, handles tool use. EnsembleOrchestrator runs `first_complete` with 2 models. Budget attributed per-model with shared `ensemble_id`.
> **Depends on**: Sprint A (JWT + pools + budget must work)
> **Global Sprint ID**: 23

### Tasks

#### T-B.1: Anthropic Messages API Spike

**Description**: Prove Anthropic Messages API is accessible from loa-finn process and meets adapter requirements. This is a spike — output is a written report + proof-of-concept, not production code.

**Acceptance Criteria**:
- [x] API key available and authenticated from loa-finn process
- [x] Streaming works (SSE from Anthropic → parseable events)
- [x] Tool use roundtrip: `tool_use` → `tool_result` → continuation message
- [x] Token usage available in response `usage` field for ledger
- [x] Abort via stream close terminates the request
- [x] Written spike report documenting findings, latency characteristics, edge cases
- [x] Decision: proceed with Messages API adapter (expected) or fall back

**Files**: `docs/spikes/anthropic-adapter-spike.md` (new), throwaway script
**Effort**: Medium (2-3h)

#### T-B.2: AnthropicAdapter Implementation

**Description**: Create `src/hounfour/native-adapter.ts` — wraps Anthropic Messages API as `ModelPort` with `complete()` and `stream()`. Registered as provider `anthropic-direct`.

**Acceptance Criteria**:
- [x] `AnthropicAdapter` implements `ModelPortBase` and `ModelPortStreaming`
- [x] `complete()`: sends Messages API request, returns `CompletionResult` with usage
- [x] `stream()`: returns `AsyncGenerator<StreamChunk>` from SSE events
- [x] Mapping: `CompletionRequest` ↔ Anthropic Messages format (role, tools, thinking)
- [x] Token usage extracted from `usage` field in response for ledger entry
- [x] `healthCheck()`: lightweight API call to verify key validity
- [x] Abort: `AbortSignal` passed to fetch, closes stream on abort
- [x] Registered in `ProviderRegistry` as `anthropic-direct`
- [x] Pools `reviewer` and `architect` can route here as alternative to cheval sidecar

**Files**: `src/hounfour/native-adapter.ts` (new), `src/hounfour/registry.ts` (modify), `tests/finn/native-adapter.test.ts` (new)
**Effort**: Large (4-6h)

#### T-B.3: Ensemble Orchestrator

**Description**: Create `src/hounfour/ensemble.ts` — runs same prompt against N models in parallel with configurable merge strategies. Two-level budget enforcement with parent/child AbortController hierarchy.

**Acceptance Criteria**:
- [x] `EnsembleOrchestrator` class with `run(request, config, context)` method
- [x] `first_complete` strategy: race N models, return first non-error, cancel others
- [x] `best_of_n` strategy: run all in parallel, score results, return highest
- [x] `consensus` strategy: structured JSON output, majority vote per field
- [x] Per-model cap: each model has independent `max_tokens` from `budget_per_model_micro / price_per_token_micro`; hitting cap aborts only that model
- [x] Total ensemble cap: sum of costs checked after each completion; exceeding aborts parent AbortController (cascades to all children)
- [x] Streaming token accounting for providers supporting usage deltas (Anthropic)
- [x] Conservative `max_tokens` pre-calculation for providers without streaming usage
- [x] Abort hierarchy: parent AbortController → child AbortControllers per model
- [x] `EnsembleResult` with `ensemble_id`, `selected`, `all_results`, `total_cost_micro`

**Files**: `src/hounfour/ensemble.ts` (new), `tests/finn/ensemble.test.ts` (new)
**Effort**: Large (5-7h)

#### T-B.4: Ensemble Cost Attribution

**Description**: Each model invocation in an ensemble gets its own ledger entry with shared `trace_id` and `ensemble_id`. Aggregate cost per ensemble run.

**Acceptance Criteria**:
- [x] Each model in ensemble creates separate JSONL ledger entry
- [x] All entries share `trace_id` and `ensemble_id` (ULID)
- [x] Each entry has individual `cost_micro`, `input_tokens`, `output_tokens`, `latency_ms`
- [x] Usage reports sent per-model (not aggregated) to arrakis
- [x] `ensemble_id` field in `UsageReport` links related entries
- [x] Cost aggregation query: sum `cost_micro` where `ensemble_id = X`

**Files**: `src/hounfour/ensemble.ts` (extend), `src/hounfour/usage-reporter.ts` (extend)
**Effort**: Small (1-2h)

#### T-B.5: Qwen3-Coder-Next Tool-Calling Validation

**Description**: Validate tool-call loop with Qwen3-Coder-Next via cheval sidecar orchestrator. Document capability gaps vs Claude. Establish which agents can run on it.

**Acceptance Criteria**:
- [x] Multi-step tool-calling task completes (read file → edit → verify)
- [x] Tool call format compatibility verified (function_call vs tool_use differences)
- [x] Streaming tool call assembly works with Qwen3 output format
- [x] Capability gaps documented: context window, reasoning quality, tool format quirks
- [x] Agent compatibility matrix: which of the 8 Loa agents can run on Qwen3 vs require Claude
- [x] Written validation report

**Files**: `docs/spikes/qwen3-coder-validation.md` (new)
**Effort**: Medium (2-3h)

#### T-B.6: Sprint B Integration Tests

**Description**: E2E tests for AnthropicAdapter and ensemble orchestrator.

**Acceptance Criteria**:
- [x] AnthropicAdapter: streaming completion with tool use roundtrip (mock API)
- [x] Ensemble `first_complete`: 2 models race, first response returned, other cancelled
- [x] Ensemble `best_of_n`: 2 models complete, higher-scored selected
- [x] Ensemble budget: per-model cap aborts single model, total cap aborts all
- [x] Ensemble cost attribution: separate ledger entries with shared ensemble_id
- [x] Abort propagation: parent abort cascades to all child models

**Files**: `tests/finn/ensemble.test.ts` (extend), `tests/finn/native-adapter.test.ts` (extend)
**Effort**: Medium (2-3h)

---

## Sprint C: finnNFT Routing + BYOK

> **Goal**: NFT personality routes to preferred model pools. BYOK user's inference routes through arrakis proxy — loa-finn never sees plaintext key. E2E demo works.
> **Exit Criteria**: One NFT personality routes chat to `fast-code` and analysis to `reasoning`. BYOK inference through arrakis proxy works with streaming. Discord NFT holder → arrakis JWT → loa-finn routing → streamed response.
> **Depends on**: Sprint A (JWT + pools must work). Sprint B NOT required.
> **Global Sprint ID**: 24

### Tasks

#### T-C.1: Per-NFT Model Routing

**Description**: Extract `model_preferences` from JWT. Override default tier→pool mapping with NFT-specific preferences. Fall back to tier default if preference unavailable.

**Acceptance Criteria**:
- [ ] HounfourRouter reads `model_preferences` from `TenantContext` when `nft_id` is present
- [ ] Resolution order: (1) NFT preferences per task type → (2) tier default → (3) global fallback
- [ ] Pool IDs validated against PoolRegistry at resolution time
- [ ] Tier authorization checked for each resolved pool (NFT can't bypass tier limits)
- [ ] Provider health checked via circuit breaker; follows fallback chain if primary unhealthy
- [ ] If BYOK flag set: delegates to BYOKProxyClient instead of direct provider
- [ ] Test: JWT with `nft_id: "mibera:4269"` and `model_preferences: { chat: "fast-code", analysis: "reasoning" }` routes correctly

**Files**: `src/hounfour/router.ts` (modify)
**Effort**: Medium (2-3h)

#### T-C.2: BYOK Proxy Client

**Description**: Create `src/hounfour/byok-proxy-client.ts` — `ModelPort` adapter that delegates inference to arrakis BYOK proxy endpoint. loa-finn never sees plaintext keys.

**Acceptance Criteria**:
- [ ] `BYOKProxyClient` implements `ModelPortBase` and `ModelPortStreaming`
- [ ] Sends `ProxyInferenceRequest` to `{arrakisBaseUrl}/internal/byok-proxy` with S2S JWT auth
- [ ] Request includes `trace_id`, `tenant_id`, `user_id`, `provider`, `model`, `messages`, `tools`, `stream`, `max_tokens`
- [ ] Streaming: consumes SSE from arrakis proxy (same SSE consumer as cheval sidecar)
- [ ] Non-streaming: returns `CompletionResult` from JSON response
- [ ] Error handling: 404 with `no_byok_key` → graceful fallback to tier default pool
- [ ] No plaintext key material ever touches loa-finn process memory

**Files**: `src/hounfour/byok-proxy-client.ts` (new), `tests/finn/byok-proxy.test.ts` (new)
**Effort**: Medium (3-4h)

#### T-C.3: BYOK Integration in Router

**Description**: Wire BYOK detection into HounfourRouter — when JWT contains `byok: true`, route through BYOKProxyClient instead of direct provider.

**Acceptance Criteria**:
- [ ] Router checks `TenantContext.isBYOK` flag
- [ ] If BYOK: resolve pool as normal, but delegate to BYOKProxyClient instead of direct provider
- [ ] Pool ID still used for cost attribution (BYOK doesn't change the pool, just the execution path)
- [ ] Streaming works through BYOK proxy path
- [ ] If arrakis proxy returns 404 (no key): fall back to tier default pool with warning log

**Files**: `src/hounfour/router.ts` (modify)
**Effort**: Small (1-2h)

#### T-C.4: finnNFT E2E Demo Test

**Description**: End-to-end test simulating the full Discord NFT holder flow: arrakis signs JWT with NFT claims → loa-finn routes to personality-preferred model → response streams back.

**Acceptance Criteria**:
- [ ] Test generates JWT with NFT claims: `nft_id: "mibera:4269"`, `model_preferences: { chat: "fast-code", analysis: "reasoning" }`
- [ ] Send chat message → routes to `fast-code` pool → response via cheval sidecar
- [ ] Send analysis message → routes to `reasoning` pool → response via appropriate adapter
- [ ] Verify pool routing via ledger entry `pool_id` field
- [ ] Verify cost attributed to correct tenant + NFT
- [ ] Usage report sent to mock arrakis endpoint with correct `nft_id`
- [ ] BYOK path tested: `byok: true` → request to mock arrakis proxy → response returned

**Files**: `tests/finn/finnNFT-e2e.test.ts` (new)
**Effort**: Medium (3-4h)

#### T-C.5: Sprint C Integration Tests

**Description**: Additional integration tests for NFT routing edge cases and BYOK proxy.

**Acceptance Criteria**:
- [ ] NFT with invalid pool preference → falls back to tier default
- [ ] NFT requesting pool above tier level → 403 with clear error
- [ ] BYOK proxy streaming: large response streams correctly through proxy
- [ ] BYOK proxy timeout: arrakis proxy slow → timeout handled gracefully
- [ ] Multiple NFTs in same tenant: each routes to own preferences independently
- [ ] No-NFT JWT: routes via tier defaults (existing behavior preserved)

**Files**: `tests/finn/finnNFT-e2e.test.ts` (extend), `tests/finn/byok-proxy.test.ts` (extend)
**Effort**: Small (1-2h)

---

## Summary

| Sprint | Tasks | Estimated Total Effort | Global Sprint ID |
|--------|-------|----------------------|------------------|
| A: Integration Debt | 10 tasks (T-A.1 to T-A.10) | ~28-39h | 22 |
| B: NativeRuntimeAdapter + Ensemble | 6 tasks (T-B.1 to T-B.6) | ~16-24h | 23 |
| C: finnNFT Routing + BYOK | 5 tasks (T-C.1 to T-C.5) | ~11-15h | 24 |
| **Total** | **21 tasks** | **~55-78h** | 22-24 |

### Risk Register

| Risk | Sprint | Mitigation |
|------|--------|-----------|
| `jose` npm package incompatibility with Hono's ESM setup | A | Pin version, test import before wiring. Fallback: `@panva/hkdf` + manual JWT verification. |
| BigInt performance in hot path (budget per-request) | A | Profile. If slow, use regular `Number` with explicit bounds check (safe up to 2^53 micro ≈ $9B). |
| Anthropic Messages API rate limits during spike | B | Use test tier with lower limits. Cache responses for replay in tests. |
| Ensemble abort race conditions | B | Comprehensive test with `Promise.race` + `AbortController`. Log all abort paths. |
| arrakis BYOK proxy not ready when Sprint C starts | C | Mock arrakis proxy for all loa-finn tests. Arrakis implementation tracked separately. |
| req_hash tee stream memory under large payloads | A | Hard 1MB cap. Reject larger bodies with 413. |

### Cross-Repo Coordination

**Arrakis-side tasks** (executed in arrakis repo, NOT in this sprint plan):

| PRD Task | Repo | Blocker for loa-finn? | Notes |
|----------|------|----------------------|-------|
| A.4 (budget reconciliation endpoint) | arrakis | No — mocked | `GET /internal/budget/:tenant_id` with S2S JWT auth |
| C.1 (NFT personality→model mapping) | arrakis | No — JWT claims mocked | `model_preferences` injected into JWT by arrakis |
| C.3 (BYOK credential storage + proxy) | arrakis | No — proxy endpoint mocked | `POST /internal/byok-proxy` with SSE streaming |

**Mock contract server** (required for loa-finn integration tests):

All loa-finn tests use a mock arrakis server that implements exact request/response shapes per PRD §6.1-6.4:

| Mock Endpoint | Sprint | Verifies |
|--------------|--------|----------|
| `GET /.well-known/jwks.json` | A | JWKS fetch, key rotation, cache TTL behavior |
| `POST /internal/usage-reports` | A | S2S JWT auth header, JWS payload signature verification, `report_id` idempotency (duplicate → 200), correct `UsageReport` schema |
| `GET /internal/budget/:tenant_id` | A | S2S JWT auth, returns `BudgetQuery` response per §6.2 |
| `POST /internal/byok-proxy` | C | S2S JWT auth, `ProxyInferenceRequest` schema, SSE streaming response, 404 for missing BYOK key |

Mock implementation lives in `tests/fixtures/mock-arrakis-server.ts` — a lightweight Hono app started per test suite. Acceptance criteria for mocks are included in T-A.10 and T-C.5.

### NPM Dependencies

| Package | Sprint | Purpose |
|---------|--------|---------|
| `jose` | A | JWT validation, JWKS client, JWS signing |

No other new dependencies. LRU cache (~50 lines) and all other components implemented in-house.

### File Map Summary

| Sprint | New Files | Modified Files |
|--------|-----------|----------------|
| A | 7 (`jwt-auth.ts`, `pool-registry.ts`, `usage-reporter.ts`, `s2s-jwt.ts`, `jwt-integration.test.ts`, `budget-test-vectors.json`, `mock-arrakis-server.ts`) | 9 (`server.ts`, `sessions.ts`, `budget.ts`, `redis/budget.ts`, `idempotency.ts`, `stream-bridge.ts`, `orchestrator.ts`, `config.ts`, `index.ts`) |
| B | 4 (`native-adapter.ts`, `ensemble.ts`, `ensemble.test.ts`, `native-adapter.test.ts`) | 2 (`registry.ts`, `usage-reporter.ts`) |
| C | 2 (`byok-proxy-client.ts`, `byok-proxy.test.ts`) | 1 (`router.ts`) |
| **Total** | **13 new** | **12 modified** |
