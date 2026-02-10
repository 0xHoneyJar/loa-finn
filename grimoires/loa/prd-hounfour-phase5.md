# PRD: Hounfour Phase 5 — Integration Hardening & Multi-Model Orchestration

> **Cycle**: 009 — Hounfour Phase 5
> **Status**: Draft
> **Author**: @janitooor
> **Date**: 2026-02-09
> **Parent PRD**: `grimoires/loa/prd-hounfour.md` (Cycle 006, Phases 0-5)
> **RFC**: [#31 — The Hounfour](https://github.com/0xHoneyJar/loa-finn/issues/31)
> **Prior Coverage**:
>   - Phases 0-2: loa-finn PR #36 (merged)
>   - Phase 3: loa-finn PR #39 (merged)
>   - Phase 4: arrakis PR #40 (merged)
> **Branch**: `feature/hounfour-phase5`

---

## 1. Problem Statement

Phases 0-4 of the Hounfour built the complete stack: multi-model routing (cheval.py), provider adapters, budget enforcement, streaming, Redis state, GPU deployment (loa-finn), and the agent gateway with JWT auth, tier enforcement, rate limiting, and bot integration (arrakis).

But the two systems have never spoken to each other in production. Phase 3 built the loa-finn receiving end. Phase 4 built the arrakis sending end. The integration seam between them remains untested, with known correctness issues:

| Problem | Impact | Root Cause |
|---------|--------|------------|
| **No JWT e2e verification** | loa-finn cannot validate arrakis-signed JWTs or extract tenant claims | JWT validation code exists in isolation but was never wired to the gateway auth middleware |
| **No tier→model bridge** | Arrakis resolves conviction-scored tiers (free/pro/enterprise) but loa-finn doesn't consume them for routing decisions | Tier claims exist in JWT but HounfourRouter doesn't read them |
| **Budget split-brain** | Arrakis tracks committed+reserved counters; loa-finn tracks JSONL+Redis counters; no reconciliation between them | Two independent budget systems designed in parallel |
| **Floating-point budget arithmetic** | Accumulated rounding errors in cost calculations | `INCRBYFLOAT` on Redis + JS floating-point; should be integer-cent |
| **Stream bridge abort race** | AbortController not fully wired; client disconnect may leave orphaned orchestrator | Known from Phase 3 review (PR #39) |
| **Unbounded in-process Map** | Redis idempotency fallback uses `Map<string, ToolResult>` with no eviction | Grows without bound under sustained load when Redis is down |

Additionally, Phase 5 of the RFC defines the flagship features — NativeRuntimeAdapter, ensemble patterns, finnNFT routing, and BYOK — that make the system commercially viable. Without these, the architecture is infrastructure without a product.

### Why This Matters Now

- Phases 3 and 4 merged **today** (2026-02-09). The code is fresh in context.
- Integration debt compounds — fixing it now costs hours; fixing it after building on top costs days.
- finnNFT routing is the first user-visible feature of the Hounfour stack.

### Multi-Repo Scope

This PRD is the **coordination hub** for work spanning three repositories:

| Repo | Role | Work Items |
|------|------|------------|
| **loa-finn** | Runtime — receives requests, routes models, executes agents | JWT validation, tier→model bridge, budget fixes, NativeRuntimeAdapter, ensemble, integration tests |
| **arrakis** | Gateway — authenticates users, signs JWTs, enforces rate limits | Budget reconciliation endpoint, BYOK credential storage, finnNFT routing config |
| **loa** | Framework — templates and scaffolding | Multi-model config templates, updated persona defaults |

Each repo executes its own sprints using this PRD as the contract. Sprint plans reference task IDs here.

---

## 2. Goals & Success Metrics

### Primary Goals

1. **Integration correctness**: loa-finn validates arrakis JWTs, extracts tenant/tier/NFT claims, and routes to the correct model pool
2. **Budget integrity**: Split-authority model with bounded drift — loa-finn is authoritative for inference cost measurement, arrakis is authoritative for gateway budget limits. Usage reports flow from loa-finn → arrakis with idempotency. Drift bounded to < max(1 micro-USD, 0.1% of spend) per reconciliation window.
3. **Production hardening**: Fix all known correctness issues from Phase 3/4 reviews before building new features
4. **finnNFT demo path**: One NFT holder talks to their daemon; model routes intelligently based on task type

### Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| JWT e2e roundtrip | arrakis signs → loa-finn validates → claims extracted → model routed | Integration test with real ES256 keypair |
| Budget drift | < max(1 micro-USD, 0.1% of total spend) after 10,000 simulated requests | Deterministic reconciliation test: loa-finn sends usage_reports, arrakis ingests them, compare final counters |
| Abort completeness | 0 orphaned orchestrators after 100 client disconnects | Load test with random disconnects |
| Idempotency cache size | Bounded at configurable max (default 10,000 entries) | Unit test with LRU eviction |
| finnNFT routing | NFT personality → chat routes to `fast-code`, analysis routes to `reasoning` | E2E test with mock arrakis JWT carrying NFT claims |

---

## 3. Scope & Prioritization

### Sprint A: Integration Debt (loa-finn primary, arrakis contract tests)

**Priority: P0 — must ship before any new features**

| ID | Task | Repo | Description |
|----|------|------|-------------|
| A.1 | JWT validation middleware | loa-finn | Validate ES256 JWTs from arrakis per the JWT Verification Profile (§6.1). Extract `tenant_id`, `nft_id`, `tier`, `model_preferences`, `req_hash`. Wire to gateway auth chain. Verify `req_hash` against raw request body bytes. |
| A.2 | Tier→model bridge | loa-finn | Map tier claims to model pool IDs from the canonical Model Pool Registry (§6.3). Validate all pool IDs against the registry; reject unknown IDs with 400 and fall back to tier default. |
| A.3 | Integer-microcent budget migration | loa-finn | Replace `INCRBYFLOAT` with integer micro-USD (`cost_micro = Math.floor(usd * 1_000_000)`) in Redis budget, JSONL ledger, and in-memory mirror. Rounding mode: floor per-request, remainder carried forward per tenant. Banker's rounding only at settlement (monthly). Migration script for existing ledger files. Cross-language test vector suite (JS + Python produce identical values). |
| A.4 | Budget reconciliation endpoint | arrakis | HTTP endpoint exposing committed+reserved counters per tenant. Authenticated via S2S JWT (ES256, dedicated `iss=arrakis-s2s`/`aud=loa-finn`, separate `kid` namespace on same JWKS). |
| A.5 | Budget reconciliation client + usage reporter | loa-finn | (a) Periodic poll of arrakis budget endpoint; compare with local counters; alert on drift > 0.1% of spend. (b) Post `usage_report` events to arrakis with `trace_id`, `request_id`, `model`, `input_tokens`, `output_tokens`, `cost_micro`, and idempotency key. loa-finn is authoritative for inference cost; arrakis is authoritative for gateway budget limits. |
| A.6 | Stream bridge abort fix | loa-finn | Wire AbortController through orchestrator→sidecar-client→cheval. On WS disconnect: signal abort, await drain, cleanup. |
| A.7 | Idempotency cache LRU | loa-finn | Replace unbounded `Map` with LRU cache (max 10,000 entries, configurable). Evict oldest on insert when full. |
| A.8 | Integration test suite | loa-finn | E2E tests: JWT roundtrip, tier→model routing, budget accounting, abort cleanup. Uses test keypair + mock arrakis responses. |

**Exit criteria**: All 8 tasks pass. JWT roundtrip works with real ES256 keys (including `req_hash` verification). Budget drift < max(1 micro-USD, 0.1% of total spend) after 10k requests with deterministic reconciliation. No orphaned orchestrators after abort.

### Sprint B: NativeRuntimeAdapter + Ensemble (loa-finn only)

**Priority: P1 — unlocks model-agnostic agent execution**

| ID | Task | Repo | Description |
|----|------|------|-------------|
| B.1 | NativeRuntimeAdapter spike + adapter | loa-finn | **Spike first**: prove Claude Code session API is programmatically accessible in containerized/headless environment. Define process model (spawn per request), streaming integration (pipe session events into SSE→WS bridge), abort mapping (SIGTERM → session cancel), and usage measurement (fields from `native-metering.ts`). **Then implement**: wrap as `ModelPort` with `complete()` and `stream()`. If spike proves API inaccessible, downgrade to "Claude via Anthropic HTTP API" adapter (messages API, not Claude Code). |
| B.2 | Native vs remote decision matrix | loa-finn | Implement the 4-variable decision (state continuity, tool fidelity, observation surface, iteration budget) as config-driven routing. Agents declare requirements; router matches. |
| B.3 | Ensemble orchestrator | loa-finn | Run same prompt against N models in parallel. Merge strategies: `first_complete`, `best_of_n` (scoring function), `consensus` (majority vote on structured output). |
| B.4 | Ensemble cost attribution | loa-finn | Each model invocation in an ensemble gets its own ledger entry with shared `trace_id` and `ensemble_id` field. Aggregate cost per ensemble run. |
| B.5 | Qwen3-Coder-Next tool-calling validation | loa-finn | Validate tool-call loop with Qwen3-Coder-Next via orchestrator. Document capability gaps vs Claude. Establish which agents can run on it. |

**Exit criteria**: Claude Code wrapped as ModelPort. At least one ensemble strategy (first_complete) works E2E. Qwen3-Coder-Next completes a multi-step tool-calling task.

### Sprint C: finnNFT Routing + BYOK (arrakis + loa-finn)

**Priority: P1 — flagship user-facing feature**

| ID | Task | Repo | Description |
|----|------|------|-------------|
| C.1 | NFT personality→model mapping | arrakis | Soul metadata carries `model_preferences` (e.g., `chat: fast-code`, `analysis: reasoning`, `code: qwen-coder`). Injected into JWT as claims. |
| C.2 | Per-NFT model routing | loa-finn | Extract `model_preferences` from JWT. Override default tier→model mapping with NFT-specific preferences. Fall back to tier default if preference unavailable. |
| C.3 | BYOK credential storage + proxy | arrakis | Encrypted-at-rest API key storage per user (AES-256-GCM, envelope encryption with KMS). **Proxy model**: arrakis performs provider API calls on behalf of the user — loa-finn sends a `ProxyInferenceRequest` to arrakis, arrakis decrypts the BYOK key in-memory, calls the provider, and returns the response. loa-finn never sees the plaintext key. Never logged, never exposed in responses. |
| C.4 | BYOK proxy client | loa-finn | If JWT contains `byok: true` claim, route inference through arrakis BYOK proxy endpoint instead of direct provider call. Implement as a `ModelPort` adapter that delegates to arrakis. Streaming supported via SSE passthrough. |
| C.5 | finnNFT E2E demo | loa-finn + arrakis | Discord user with NFT → `/agent` command → arrakis signs JWT with NFT claims → loa-finn routes to personality-preferred model → response streams back through bot. |

**Exit criteria**: One NFT personality routes chat to `fast-code` and deep analysis to `reasoning` using pool IDs from §6.3. BYOK user's inference routes through arrakis proxy (§6.4) — loa-finn never sees the plaintext key. E2E demo: Discord NFT holder → arrakis JWT → loa-finn routing → streamed response.

### Sprint D: Scaffolding + Polish (loa + loa-finn)

**Priority: P2 — ecosystem completeness**

| ID | Task | Repo | Description |
|----|------|------|-------------|
| D.1 | Multi-model config templates | loa | Default `.loa.config.yaml` templates for common deployment patterns: single-provider, multi-provider, self-hosted + cloud hybrid. |
| D.2 | Updated persona defaults | loa | Review 8 agent persona.md files. Update model recommendations based on Phase 0-5 learnings. |
| D.3 | Cross-NFT interaction prototype | loa-finn | Two NFT agents in same session. Shared context, separate personalities. Turn-based or parallel invocation. |
| D.4 | `/cost-report` command update | loa | Update cost-report.sh to handle ensemble entries, BYOK attribution, and per-NFT filtering. |
| D.5 | Phase 5 documentation | loa-finn | Update SDD sections for NativeRuntimeAdapter, ensemble, JWT integration. Architecture diagrams. |

**Exit criteria**: `loa` templates work for a fresh project with multi-model config. Cross-NFT prototype demonstrates two personalities in one session.

---

## 4. Technical Constraints

### From Phase 3 (loa-finn)

- Cheval sidecar communicates via HMAC-signed HTTP on localhost
- Redis state layer: circuit breaker (fail-open), budget (fail-closed), rate limiter (fail-open)
- Tool-call orchestrator: max 20 iterations, 120s wall time, 50 total tool calls
- Streaming: SSE from cheval → WebSocket via stream-bridge.ts

### From Phase 4 (arrakis)

- ES256 JWT with `req_hash` binding (SHA-256 of request body)
- JWKS endpoint with key rotation
- 4-dimension sliding window rate limiting via Redis Lua
- Conviction-scoring tier resolution (9 tiers → free/pro/enterprise)
- Two-counter budget model (committed + reserved, atomic Lua scripts)

### Cross-System

- **Auth boundary**: arrakis signs JWTs, loa-finn validates. No shared database.
- **Budget boundary**: arrakis tracks gateway-side spend, loa-finn tracks inference-side spend. Reconciliation via polling, not shared state.
- **Network boundary**: arrakis → loa-finn is HTTP/HTTPS. No direct Redis sharing.

---

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| JWT key rotation during active sessions | Requests fail validation | JWKS cache with 5-minute TTL; accept keys from current + previous rotation |
| Budget reconciliation drift | Over-spend or under-spend | Split-authority: loa-finn measures inference cost (authoritative), sends usage_reports to arrakis. Arrakis enforces gateway limits (authoritative). Reconciliation is deterministic via idempotent usage reports, not advisory polling. |
| NativeRuntimeAdapter token counting inaccuracy | Cost attribution wrong for Claude Code sessions | Use session-level metering (already built in native-metering.ts); accept coarser granularity |
| Ensemble cost explosion | N models × cost per model | Budget check per-model in ensemble; abort remaining models if budget exceeded |
| BYOK key compromise | User's API key exposed | Proxy model: loa-finn never sees plaintext key. Arrakis decrypts in-memory, calls provider directly, returns response. Keys encrypted at rest (AES-256-GCM + KMS envelope), never logged, rotated on schedule. |

---

## 6. Execution Strategy (Multi-Repo)

### Session Plan

| Sprint | Primary Repo | Secondary Repo | Session Strategy |
|--------|-------------|----------------|------------------|
| A | loa-finn | arrakis (A.4 only) | Start in loa-finn: build JWT validation, tier bridge, fixes. Then one arrakis session for budget endpoint. |
| B | loa-finn | — | Pure loa-finn. No cross-repo work. |
| C | arrakis (C.1, C.3) | loa-finn (C.2, C.4, C.5) | Start in arrakis: NFT claims + BYOK storage. Then loa-finn: routing + E2E demo. |
| D | loa (D.1, D.2, D.4) | loa-finn (D.3, D.5) | Start in loa: templates + personas. Then loa-finn: cross-NFT + docs. |

### 6.1 JWT Verification Profile

loa-finn MUST verify arrakis JWTs according to this profile:

**Header requirements**:
- `alg`: MUST be `ES256`. Reject all others.
- `kid`: MUST be present. Used for JWKS key selection.
- `typ`: MUST be `JWT`.

**Required claims**:
| Claim | Type | Validation |
|-------|------|------------|
| `iss` | string | MUST equal `arrakis` (configurable via `FINN_JWT_ISSUER`) |
| `aud` | string | MUST equal `loa-finn` (configurable via `FINN_JWT_AUDIENCE`) |
| `sub` | string | Format: `user:{platform}:{id}` (e.g., `user:discord:123456789`) |
| `iat` | number | MUST be in the past. Max clock skew: 30 seconds. |
| `exp` | number | MUST be in the future. Max token lifetime: 1 hour. |
| `tenant_id` | string | Format: `community:{slug}`. Required. |
| `tier` | string | One of: `free`, `pro`, `enterprise`. Required. |
| `req_hash` | string | Format: `sha256:{hex}`. SHA-256 of raw request body bytes as received (before any parsing/decompression). |

**Optional claims**:
| Claim | Type | Default |
|-------|------|---------|
| `nft_id` | string | `null` — no NFT-specific routing |
| `model_preferences` | object | `null` — use tier defaults |
| `byok` | boolean | `false` |
| `jti` | string | If present, used for replay detection |

**JWKS resolution**:
- Endpoint: `{ARRAKIS_BASE_URL}/.well-known/jwks.json`
- Cache TTL: 5 minutes
- On cache miss or `kid` not found: refetch once, then fail
- Accept keys from current + previous rotation (dual-key window)

**`req_hash` canonicalization**:
- Hash the exact raw bytes of the HTTP request body as received by arrakis before any parsing
- Content-Encoding: if body is gzip'd, hash the compressed bytes (what arrakis received)
- Empty body: hash is `sha256:e3b0c44...` (SHA-256 of empty string)
- loa-finn verifies by hashing the raw body bytes it receives (must match)
- Integration test: verify identical hashing for JSON, gzip, and empty body cases

**JWT Claims example**:
```json
{
  "alg": "ES256",
  "kid": "arrakis-2026-02-v1",
  "typ": "JWT"
}
{
  "iss": "arrakis",
  "aud": "loa-finn",
  "sub": "user:discord:123456789",
  "tenant_id": "community:thj",
  "nft_id": "mibera:4269",
  "tier": "pro",
  "model_preferences": {
    "chat": "fast-code",
    "analysis": "reasoning",
    "code": "qwen-coder"
  },
  "byok": false,
  "req_hash": "sha256:abc123...",
  "iat": 1739123456,
  "exp": 1739127056
}
```

### 6.2 Budget & Usage Report Contracts

**Split-authority model**: loa-finn measures inference cost (authoritative). Arrakis enforces gateway budget limits (authoritative). Usage reports are the reconciliation mechanism.

**Usage Report (loa-finn → arrakis)**:
```json
{
  "report_id": "ur-01JKQM...",
  "trace_id": "tr-01JKQM...",
  "request_id": "req-01JKQM...",
  "tenant_id": "community:thj",
  "nft_id": "mibera:4269",
  "model": "qwen-coder",
  "provider": "qwen-local",
  "input_tokens": 1523,
  "output_tokens": 847,
  "reasoning_tokens": 0,
  "cost_micro": 152,
  "currency": "USD",
  "ensemble_id": null,
  "byok": false,
  "timestamp": "2026-02-09T18:30:00Z"
}
```
- `cost_micro`: integer micro-USD (1 USD = 1,000,000 micro-USD). Floor per-request, remainder carried per tenant.
- `report_id`: idempotency key. Arrakis deduplicates on this field.
- Delivery: HTTP POST to `{ARRAKIS_BASE_URL}/internal/usage-reports` (S2S JWT auth, §6.1 profile with `iss=loa-finn`, `aud=arrakis`).
- Retry: 3x with exponential backoff. Dead-letter to local JSONL on persistent failure.

**Budget Query (loa-finn → arrakis)**:
```json
{
  "tenant_id": "community:thj",
  "period": "2026-02",
  "committed_micro": 4523000,
  "reserved_micro": 100000,
  "limit_micro": 10000000,
  "currency": "USD"
}
```

### 6.3 Model Pool Registry

All model routing uses canonical **pool IDs**, not raw provider model names. JWT claims and tier mappings reference pool IDs only. loa-finn validates all pool IDs against this registry; unknown IDs are rejected with HTTP 400 and fall back to tier default.

| Pool ID | Description | Default Provider | Tier Access |
|---------|-------------|-----------------|-------------|
| `cheap` | Low-cost commodity tasks (summarization, translation) | qwen-local (1.5B) | free, pro, enterprise |
| `fast-code` | Fast code generation and editing | qwen-local (7B) | pro, enterprise |
| `reviewer` | Code review and analysis | claude-sonnet | pro, enterprise |
| `reasoning` | Deep multi-step reasoning | kimi-k2-thinking | enterprise |
| `architect` | Architecture and design decisions | claude-opus | enterprise |
| `ensemble` | Multi-model synthesis (triggers ensemble orchestrator) | N/A (meta-pool) | enterprise |

- Pool→provider mapping is configurable via `.loa.config.yaml`
- Adding a new pool ID requires updating this PRD (contract change)
- JWT `model_preferences` values MUST be valid pool IDs
- Contract version: `routing_schema_version: 1` (included in JWT if preferences present)

### 6.4 BYOK Proxy Contract

**Proxy model**: loa-finn never sees plaintext BYOK keys. Arrakis acts as an inference proxy.

**Proxy Inference Request (loa-finn → arrakis)**:
```json
{
  "trace_id": "tr-01JKQM...",
  "tenant_id": "community:thj",
  "user_id": "user:discord:123456789",
  "provider": "openai",
  "model": "gpt-5.2",
  "messages": [...],
  "tools": [...],
  "stream": true,
  "max_tokens": 4096
}
```
- Endpoint: `{ARRAKIS_BASE_URL}/internal/byok-proxy` (S2S JWT auth)
- Arrakis decrypts BYOK key in-memory, calls provider, returns response
- Streaming: SSE passthrough (arrakis streams from provider → loa-finn consumes SSE)
- Error: if user has no BYOK key for requested provider, return 404 with `{"error": "no_byok_key", "provider": "openai"}`
- Audit: arrakis logs `trace_id` + `provider` + `model` + token counts (never the key or message content)

---

## 7. Out of Scope

- Revenue split governance (x402 payment protocol integration) — Phase 6+
- Multi-region deployment — current architecture is single-region
- Agent marketplace — community-created agents beyond the 8 Loa agents
- On-chain agent registration (ERC-8004) — deferred pending Berachain deployment
- Token Bound Accounts (ERC-6551) — deferred pending Berachain deployment

---

## 8. References

- [RFC #31 — The Hounfour](https://github.com/0xHoneyJar/loa-finn/issues/31)
- [finnNFT #27](https://github.com/0xHoneyJar/loa-finn/issues/27)
- [loa-finn PR #36 — Phases 0-2](https://github.com/0xHoneyJar/loa-finn/pull/36)
- [loa-finn PR #39 — Phase 3](https://github.com/0xHoneyJar/loa-finn/pull/39)
- [arrakis PR #40 — Phase 4](https://github.com/0xHoneyJar/loa-finn/pull/40)
- `grimoires/loa/prd-hounfour.md` — Parent PRD (Phases 0-5)
- `grimoires/loa/prd-hounfour-phase3.md` — Phase 3 PRD
- `grimoires/loa/sdd-hounfour.md` — Phase 0-2 SDD
- `grimoires/loa/sdd-hounfour-phase3.md` — Phase 3 SDD
