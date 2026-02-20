# Sprint Plan: Launch Execution — From Built to Operable

> **Version**: 1.0.0
> **Date**: 2026-02-20
> **Cycle**: cycle-029
> **PRD**: `grimoires/loa/prd.md` v1.2.0
> **SDD**: `grimoires/loa/sdd.md` v1.1.0
> **Sprints**: 7 (49 tasks)
> **Global IDs**: 111–117
> **Team**: 1 agent (Claude Opus 4.6)

---

## Sprint Overview

| Sprint | Global ID | Label | Phase | Tracks | Tasks | Dependencies |
|--------|-----------|-------|-------|--------|-------|-------------|
| 1 | 111 | Infrastructure Foundation | P0 MVP | Track 0 | 7 | None |
| 2 | 112 | x402 HMAC + Receipt Verification | P0 MVP | Track 1B (core) | 9 | Sprint 1 |
| 3 | 113 | Payment Decision Tree + API Keys | P0 MVP | Track 1B (integration) | 8 | Sprint 2 |
| 4 | 114 | Static Personality + SIWE Auth | P0 MVP | Track 2a + Auth | 7 | Sprint 1 |
| 5 | 115 | On-Chain Signals + Persistence | P1 Post-MVP | Track 2b + 2c | 6 | Sprint 1, 4 |
| 6 | 116 | Observability + Metrics | P1 Post-MVP | Track 4 | 6 | Sprint 1 |
| 7 | 117 | OpenAPI + SDK + Discovery | P1 Post-MVP | Track 5 + 3 | 6 | Sprint 3, 4 |

### Dependency Graph

```
Sprint 1 (Infra) ──┬── Sprint 2 (x402 Core) ── Sprint 3 (Payment + Keys)
                    │                                      │
                    ├── Sprint 4 (Personality + SIWE) ─────┤
                    │              │                        │
                    │              └── Sprint 5 (Signals)   └── Sprint 7 (SDK + Discovery)
                    │
                    └── Sprint 6 (Observability)
```

### MVP Gate

**Sprints 1–4 are the P0 MVP.** After sprint 4, the system satisfies:
- **L-1**: Container runs, health check passes
- **L-2**: Agent responds with personality-conditioned output
- **L-3**: x402 processes real USDC for a paid request
- **L-8**: Static personality from config

Sprints 5–7 add depth (P1): persistence, on-chain signals, metrics, SDK, discovery.

---

## Sprint 1: Infrastructure Foundation

> **Global ID**: 111 | **Track**: 0 | **Priority**: P0 | **Dependencies**: None
> **Goal**: Container runs, database ready, E2E harness works, CI green.
> **Issue**: [#84](https://github.com/0xHoneyJar/loa-finn/issues/84)

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T1.1 | Docker Compose service definition for loa-finn | `docker compose -f docker-compose.dev.yml up finn` starts loa-finn on :3001. Service depends_on postgres (healthy) and redis (healthy). Uses `.env.docker`. |
| T1.2 | PostgreSQL role provisioning via Docker entrypoint | `docker-entrypoint-initdb.d/01-finn-roles.sql` creates `finn_app` and `finn_migrate` roles. Passwords sourced from `FINN_APP_PASSWORD` / `FINN_MIGRATE_PASSWORD` env vars in `.env.docker`. No literal passwords in any migration file. |
| T1.3 | Drizzle schema + initial migration | `CREATE SCHEMA IF NOT EXISTS finn`. Migration creates tables: `finn_billing_events`, `finn_api_keys`, `finn_verification_failures`. Includes `updated_at` trigger. Runs idempotently. Migration runner uses runtime stage + compiled entrypoint (`dist/drizzle/migrate.js`). |
| T1.4 | Database startup validation gate | On boot (when `FINN_POSTGRES_ENABLED=true`), finn queries for required tables. If any missing, process exits with code 1 and clear error message. Test: remove a table, verify boot fails. |
| T1.5 | Graceful shutdown handler | SIGTERM → stop accepting connections → drain inflight requests (30s timeout) → stop intervals/timers → flush DLQ → close DB pool → close Redis → exit 0. Test: send SIGTERM during request, verify response completes. |
| T1.6 | E2E test harness skeleton | Vitest config for `tests/e2e/`. Uses Docker Compose (postgres + redis + finn-migrate + finn). First test: `GET /health` returns 200 with `{ status: "ok" }`. Testcontainers or Compose-based runner. |
| T1.7 | CI GitHub Actions workflow | `.github/workflows/e2e.yml`: checkout → build → `docker compose up` → run migrations → run E2E tests → cleanup. Runs on push and PR. Reports status. |

### Testing

- `docker compose up` starts all services, health check returns 200
- `docker compose run finn-migrate` exits 0, tables exist in `finn` schema
- E2E test suite passes in CI
- Graceful shutdown test: SIGTERM during inflight request completes gracefully

---

## Sprint 2: x402 HMAC + Receipt Verification

> **Global ID**: 112 | **Track**: 1B (core) | **Priority**: P0 | **Dependencies**: Sprint 1
> **Goal**: x402 challenge issuance and on-chain receipt verification work end-to-end.
> **Issue**: [#85](https://github.com/0xHoneyJar/loa-finn/issues/85)

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T2.1 | X402Challenge interface + HMAC canonicalization | `src/x402/hmac.ts`: X402Challenge type, `canonicalize()` (alphabetical, pipe-delimited), `signChallenge()`, request_binding v1 = SHA-256(token_id \| model \| max_tokens). Unit tests: deterministic output for same inputs. |
| T2.2 | HMAC verification with constant-time comparison | `verifyChallenge()`: validate 64 hex chars, `Buffer.from(hex, 'hex')`, length guard before `timingSafeEqual`. Returns false (never throws) on invalid input. Unit tests: valid HMAC passes, tampered HMAC fails, non-hex input fails. |
| T2.3 | Challenge issuance (402 response) | Paid endpoint without payment headers → 402 with signed X402Challenge JSON body. Challenge stored in Redis with 5-min TTL keyed by nonce. Test: request without headers → 402 + valid challenge JSON with all fields. |
| T2.4 | Receipt verification core with challenge binding | `src/x402/verify.ts`: `verifyReceipt()` — (1) load challenge from Redis by nonce, (2) verify HMAC integrity + expiry + request_binding, (3) viem `getTransactionReceipt`, (4) status check (receipt.status===1), (5) confirmation depth (≥`X402_MIN_CONFIRMATIONS`, default 10), (6) Transfer log parsing (strict: emitter=USDC, to=challenge.recipient, value=challenge.amount, exactly ONE matching Transfer log — payer identity NOT bound to tx.from to support smart contract wallets/relayers), (7) atomic Lua script: consume nonce + set tx_hash replay key. Receipt MUST match the specific challenge: amount, recipient, chain_id, and request_binding enforced. Payer binding: if challenge includes `payer_address`, verify Transfer.from matches; otherwise accept any sender. Test: valid receipt passes; wrong amount/recipient fails; receipt reused for different challenge fails (402); smart contract wallet payment (tx.from ≠ Transfer.from) passes when payer_address not required. |
| T2.5 | RPC pool with multi-provider circuit breaker | `src/x402/rpc-pool.ts`: RpcPool with Alchemy (primary) + public Base RPC (fallback). Per-provider circuit breaker (closed/open/half-open, 5 failures in 30s → open, 15s probe). Test: primary fails → falls to fallback. Both fail → `rpc_unreachable`. |
| T2.6 | Atomic Redis Lua script | `x402_verify_atomic.lua`: single script that checks nonce exists, checks replay, consumes nonce, sets replay key. Returns 0=success, 1=nonce not found, 2=replay, 3=race lost. Integration test with real Redis. |
| T2.7 | Verification failure recording | Failed verifications logged to `finn_verification_failures` table: tx_hash, reason, timestamp, metadata. Test: RPC failure → row in table with reason `rpc_unreachable`. |
| T2.8 | HMAC secret rotation | Accept both current and previous secret during 10-min grace window. Config: `X402_CHALLENGE_SECRET` + `X402_CHALLENGE_SECRET_PREVIOUS`. Test: challenge signed with old secret validates during grace, fails after. |
| T2.9 | Pricing configuration (Flatline IMP-010) | `src/x402/pricing.ts`: Define flat-fee pricing model. `X402_REQUEST_COST_MICRO` env var (integer, micro-USDC units, e.g. 100000 = $0.10). `getRequestCost(tokenId, model, maxTokens)` returns cost in micro-USDC — v1 returns flat fee from env var (model-based pricing deferred to post-MVP). Challenge issuance (T2.3) calls `getRequestCost()` to populate `amount` field. Test: env var read correctly; default value documented; challenge amount matches configured cost. |

### Testing

- Full x402 flow: request → 402 → (mock payment) → receipt → verified → 200
- **Challenge-receipt binding**: receipt from challenge A cannot satisfy challenge B (different nonce/amount/request_binding) → 402
- Replay rejection: same tx_hash twice → second returns 402
- Tampered HMAC → 402
- RPC failure → 503 + verification_failures row
- Lua script atomicity: concurrent verification attempts don't race
- **Dual-mode x402 E2E testing** (Flatline SKP-003):
  - **Hermetic mode** (CI default): Local mock USDC contract deployed to anvil (no fork, no external RPC). Contract emits deterministic Transfer logs. Fast, reliable, zero external dependencies. `ANVIL_MODE=local` in CI env.
  - **Fork mode** (nightly/optional): Anvil forks Base mainnet at pinned block for realistic end-to-end. `ANVIL_MODE=fork` with `BASE_RPC_URL` and `ANVIL_FORK_BLOCK`. Retries on RPC failure (3 attempts).
  - Both modes exercise real `getTransactionReceipt` parsing via viem test client — NOT mocked.

---

## Sprint 3: Payment Decision Tree + API Keys

> **Global ID**: 113 | **Track**: 1B (integration) | **Priority**: P0 | **Dependencies**: Sprint 2
> **Goal**: Full payment middleware stack operational. API keys work. Rate limiting enforced.
> **Issue**: [#85](https://github.com/0xHoneyJar/loa-finn/issues/85)

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T3.1 | PaymentDecisionMiddleware | `src/gateway/payment-decision.ts`: Hono middleware implementing strict decision tree (SDD §4.1). Free endpoints → allow. Both headers → 400. dk_ header → API key path. X-Payment-Receipt → x402 path. No headers → 402 challenge. Attaches PaymentDecision to context. Test: all 5 branches with assertions. |
| T3.2 | Mixed credentials rejection | When BOTH `Authorization: Bearer dk_...` AND `X-Payment-Receipt` are present → 400 with `{ error: "ambiguous_payment", message: "..." }`. Test: request with both headers → 400. |
| T3.3 | API key manager (create + validate) | `src/gateway/api-keys.ts`: `create()` generates `dk_{keyId}.{secret}`, stores bcrypt hash + HMAC lookup hash. `validate()` does O(1) indexed lookup by HMAC, then bcrypt verify. Redis cache (5-min TTL). Test: create key → validate succeeds. Invalid key → null. Revoked key → null. |
| T3.4 | API key revocation | `revoke()` sets `revoked_at`, invalidates Redis cache entry (sets to "revoked"). `DELETE /api/v1/keys/{key_id}` endpoint. Test: revoke → immediate 401 on next use. |
| T3.5 | Multi-tier rate limiter | `src/gateway/rate-limit.ts`: Redis sliding window. Free: 60/min per IP. x402: 30/min per wallet, 120/min per IP for challenge generation. API key: configurable per tier (default 60/min). Returns 429 with `Retry-After`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Test: exceed limit → 429. Under limit → passes. |
| T3.6 | Billing events recording | Every paid request → INSERT into `finn_billing_events`: request_id, payment_method (x402\|api_key\|free), amount_micro, tx_hash (if x402), api_key_id (if key), timestamp, response_status. Test: successful x402 request → row with tx_hash. API key request → row with api_key_id. |
| T3.7 | 401/402 invariant enforcement | 401 ALWAYS means auth failure (bad/missing/revoked key). 402 ALWAYS means payment required. These are never conflated. Test: revoked key → 401 (not 402). Exhausted credits → 402 with x402 challenge + `X-Payment-Upgrade: x402`. No headers → 402. |
| T3.8 | API key credit model + atomic debit | `finn_api_keys.balance_micro` column (bigint, default 0). Atomic debit via SQL `UPDATE finn_api_keys SET balance_micro = balance_micro - $cost WHERE id = $id AND balance_micro >= $cost RETURNING balance_micro`. If 0 rows affected → insufficient credits → 402 with x402 upgrade. Idempotent: debit keyed by `request_id` (idempotency key in `finn_billing_events` with unique constraint). Tests: concurrent requests cannot overspend (run 10 parallel debits against balance=5 → exactly 5 succeed). Retry with same request_id doesn't double-debit. Exhausted key → 402 with `X-Payment-Upgrade: x402`. |

### Testing

- Full API key lifecycle: create → use → debit credits → exhaust → 402 upgrade → revoke → 401
- Rate limiting: exceed each tier → 429 with correct headers
- Decision tree: all branches tested (free, api_key, x402, no-auth, mixed)
- Billing audit trail: every request has a corresponding billing event

---

## Sprint 4: Static Personality + SIWE Auth

> **Global ID**: 114 | **Track**: 2a + Auth | **Priority**: P0 | **Dependencies**: Sprint 1
> **Goal**: Agents have personality from static config. SIWE auth enables key management.
> **Issue**: [#88](https://github.com/0xHoneyJar/loa-finn/issues/88)

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T4.1 | Static personality config schema | `config/personalities.json`: maps token IDs to personality configs. Each entry: `token_id`, `archetype` (Freetekno\|Milady\|Chicago\|Acidhouse), `voice_description`, `behavioral_traits[]`, `expertise_domains[]`, `beauvoir_template` (system prompt). 4 archetype templates minimum. Validated with JSON schema. |
| T4.2 | PersonalityProvider interface | `src/nft/personality-provider.ts`: `interface PersonalityProvider { get(tokenId: string): Promise<PersonalityConfig \| null> }`. Minimal abstraction — static loader is v1 provider, signal engine becomes v2. |
| T4.3 | StaticPersonalityLoader | `src/nft/static-personality-loader.ts`: reads `config/personalities.json` at boot, implements PersonalityProvider. Unknown tokenId → returns null. Config file missing → fail at boot with clear error. Test: valid config → all personalities accessible. Missing file → boot fails. |
| T4.4 | Anti-narration validation at boot | On startup, every personality template is checked against `checkAntiNarration()` (69 forbidden terms from `src/nft/reviewer-adapter.ts`). Any violation → fail at boot with specific term + template identified. Test: inject forbidden term → boot fails. |
| T4.5 | SIWE authentication flow (hardened) | `src/gateway/siwe-auth.ts`: nonce endpoint (`GET /api/v1/auth/nonce` → returns nonce stored in Redis with 5-min TTL, single-use via atomic consume). Verify endpoint (`POST /api/v1/auth/verify` → validates SIWE message: domain, uri, chainId, nonce, issuedAt, expirationTime, recovers wallet address from signature → returns session JWT). JWT: HS256, exp=15min, aud=loa-finn, sub=wallet_address, clock skew tolerance=30s. Middleware rejects missing/invalid/expired JWT with 401. Negative tests: reused nonce → 401; wrong domain/uri/chainId → 401; expired SIWE message → 401; tampered JWT → 401; expired JWT → 401. |
| T4.6 | API key lifecycle endpoints | `POST /api/v1/keys` (requires SIWE session JWT) → creates key, returns plaintext once. `DELETE /api/v1/keys/{key_id}` (requires SIWE session JWT, must own key). `GET /api/v1/keys/{key_id}/balance` → returns credit balance. Test: create key → use key → check balance → revoke key. |
| T4.7 | Agent chat route with personality | `POST /api/v1/agent/chat` → resolves tokenId → loads personality via PersonalityProvider → injects as systemPrompt into HounfourRouter.route() → returns personality-conditioned response. Test: request with valid tokenId → response reflects archetype personality. Unknown tokenId → 404. |

### Testing

- Static config loads 4 archetypes, each accessible by tokenId
- Anti-narration catches forbidden terms at boot
- SIWE: nonce → sign → verify → session JWT → create API key → use key
- Agent chat returns personality-conditioned response (archetype voice visible)
- **MVP gate**: After this sprint, L-1 + L-2 + L-3 + L-8 are all demonstrable

---

## Sprint 5: On-Chain Signals + Persistence ✅ ✅

> **Global ID**: 115 | **Track**: 2b + 2c | **Priority**: P1 | **Dependencies**: Sprint 1, Sprint 4
> **Goal**: Personality survives restarts. On-chain signal reader operational.
> **Issue**: [#86](https://github.com/0xHoneyJar/loa-finn/issues/86), [#87](https://github.com/0xHoneyJar/loa-finn/issues/87)

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T5.1 | On-chain signal reader | `src/nft/on-chain-reader.ts`: viem public client for Base chain. Reads finnNFT contract: `tokenURI(tokenId)`, `ownerOf(tokenId)`, metadata parsing (archetype, ancestor, era, element). Uses RPC pool from Sprint 2 (T2.5). Test: mock contract responses → valid SignalSnapshot. |
| T5.2 | Redis caching layer for signals | Signal snapshots cached in Redis with 24h TTL. Key: `finn:signal:{tokenId}`. On cache miss: call on-chain reader → cache → return. `ownerOf` refresh on miss (ownership verification). Test: first call hits RPC, second call hits cache. TTL expiry → re-fetches. |
| T5.3 | Personality persistence migration | Drizzle migration: `finn_personalities` (id, token_id, archetype, current_version_id, created_at, updated_at) + `finn_personality_versions` (id, personality_id, version_number, beauvoir_template, damp_fingerprint, epoch_number, created_at). Unique constraint on (personality_id, epoch_number). |
| T5.4 | Write-through persistence strategy | PersonalityService writes to both Redis and Postgres. Read path: Redis first → Postgres fallback → on-chain reader fallback. Static config is seed data written to Postgres at first boot. Test: write personality → restart container → personality survives. |
| T5.5 | Background reconciler | Every 5 minutes: check recent `finn_billing_events` (last 1 hour) against on-chain state. Reorged transactions flagged with `status: reorged`. Logs warning. No automatic revocation in v1. Test: mock reorged tx → status updated, warning logged. |
| T5.6 | PersonalityService provider chain | Existing PersonalityService modified: `addProvider(provider)` method. Provider chain: StaticPersonalityLoader → Redis → Postgres. First non-null result wins. Test: provider chain falls through correctly. |

### Testing

- L-4: Stop container → restart → personality data intact in Postgres
- On-chain reader: valid contract interaction → SignalSnapshot populated
- Cache: hit/miss/expiry all work correctly
- Reconciler: detects reorged transactions and flags them

---

## Sprint 6: Observability + Metrics ✅ ✅

> **Global ID**: 116 | **Track**: 4 | **Priority**: P1 | **Dependencies**: Sprint 1
> **Goal**: Prometheus metrics visible. Conservation violations trigger alerts.
> **Issue**: [#90](https://github.com/0xHoneyJar/loa-finn/issues/90)

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T6.1 | Prometheus metrics setup | `src/metrics/prometheus.ts`: prom-client registry. `GET /metrics` endpoint returns Prometheus text format. Requires `Authorization: Bearer {METRICS_BEARER_TOKEN}` in production (SDD §4.7). NOT in FREE_ENDPOINTS. Test: authenticated request → metrics text. Unauthenticated → 401. |
| T6.2 | Conservation guard metrics | Counters/gauges: `finn_conservation_violations_total`, `finn_credits_by_state{state}`, `finn_escrow_balance_total`, `finn_settlement_total{status}`. Wired into existing conservation guard code. Test: trigger violation → counter increments. |
| T6.3 | Payment metrics | `finn_agent_requests_total{archetype, payment_method}`, `finn_x402_verifications_total{result}`, `finn_rpc_requests_total{provider, result}`, `finn_rate_limit_hits_total{tier}`. Label cardinality enforced: no user-controlled values (no wallet, tokenId, tx_hash, request_path in labels). Test: request → metrics increment with correct labels. |
| T6.4 | Request latency histograms | `finn_request_duration_seconds{route, method}` histogram with standard buckets. `finn_x402_verification_duration_seconds` histogram. Test: request → histogram observation recorded. |
| T6.5 | Grafana dashboard JSON | `deploy/grafana/finn-dashboard.json`: importable dashboard showing conservation health panel, credit flow panel, payment method breakdown, agent usage by archetype, x402 verification success rate, RPC health. |
| T6.6 | Alert rules | `deploy/prometheus/alert-rules.yml`: conservation violation rate > 0 for 5 minutes → critical alert. x402 verification failure rate > 50% for 5 minutes → warning. RPC circuit breaker open for 5 minutes → warning. Format compatible with Alertmanager/PagerDuty/Discord webhook. |

### Testing

- L-6: Conservation violation → `finn_conservation_violations_total` increments → alert fires
- `/metrics` requires auth (401 without token)
- Dashboard imports into Grafana without errors
- Label cardinality: no high-cardinality labels in any metric

---

## Sprint 7: OpenAPI + SDK + Discovery

> **Global ID**: 117 | **Track**: 5 + 3 | **Priority**: P1 | **Dependencies**: Sprint 3, Sprint 4
> **Goal**: Developers can discover and integrate with the agent API.
> **Issue**: [#91](https://github.com/0xHoneyJar/loa-finn/issues/91), [#89](https://github.com/0xHoneyJar/loa-finn/issues/89)

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T7.1 | OpenAPI 3.1 specification | Generated from Zod schemas via `@asteasolutions/zod-to-openapi`. Covers: `/api/v1/agent/chat`, `/api/v1/keys`, `/api/v1/auth/nonce`, `/api/v1/auth/verify`, `/health`, `/metrics` (auth required), `/llms.txt`, `/agents.md`. Includes x402 error responses (402 with challenge schema). `GET /openapi.json` serves the spec. Test: spec validates with openapi-schema-validator. |
| T7.2 | TypeScript SDK generation | `packages/finn-sdk/`: generated from OpenAPI spec. Typed request/response objects. Published as `@honeyjar/finn-sdk`. Includes `FinnClient` class with `chat()`, `createKey()`, `revokeKey()`, `getBalance()`. Test: SDK compiles, types match spec. |
| T7.3 | x402 payment helper in SDK | `FinnClient.payAndChat()`: handles full 402 flow — gets challenge, prompts for payment callback, submits receipt. Utility: `parseX402Challenge()`, `formatReceiptHeaders()`. Test: mock flow with payAndChat → successful response. |
| T7.4 | llms.txt endpoint | `GET /llms.txt` returns agent capability manifest per llms.txt convention. Lists: agent name, capabilities, supported models, pricing (x402), contact. Free endpoint (no auth). Test: response matches llms.txt format spec. |
| T7.5 | agents.md endpoint | `GET /agents.md` returns human-readable agent directory in Markdown. Lists all agents from personality config with archetype, capabilities, interaction link. Free endpoint. Test: response is valid Markdown, lists all configured agents. |
| T7.6 | Per-agent homepage | `GET /agent/:tokenId` returns HTML page with personality summary, archetype badge, capabilities, "Chat" CTA, x402 pricing info. Free endpoint. Unknown tokenId → 404. Test: valid tokenId → 200 HTML. Invalid → 404. |

### Testing

- L-5: `curl /llms.txt` returns valid agent manifest
- L-7: `npm install @honeyjar/finn-sdk` → TypeScript compiles → `FinnClient.chat()` works
- OpenAPI spec validates
- Agent homepage renders for valid token IDs

---

## Environment Variables (New)

All new environment variables required by this cycle:

| Variable | Sprint | Required | Description |
|----------|--------|----------|-------------|
| `FINN_POSTGRES_ENABLED` | 1 | Yes | Enable Postgres persistence + startup validation |
| `FINN_APP_PASSWORD` | 1 | Dev only | Password for finn_app DB role (Docker entrypoint) |
| `FINN_MIGRATE_PASSWORD` | 1 | Dev only | Password for finn_migrate DB role (Docker entrypoint) |
| `X402_WALLET_ADDRESS` | 2 | Yes | USDC recipient address on Base |
| `X402_CHALLENGE_SECRET` | 2 | Yes | HMAC secret for challenge signing (32+ bytes) |
| `X402_CHALLENGE_SECRET_PREVIOUS` | 2 | No | Previous secret during rotation (10-min grace) |
| `X402_USDC_ADDRESS` | 2 | Yes | USDC contract address on Base |
| `X402_CHAIN_ID` | 2 | Yes | Chain ID (8453 for Base mainnet) |
| `ALCHEMY_BASE_RPC_URL` | 2 | Prod | Alchemy RPC URL for Base chain |
| `X402_MIN_CONFIRMATIONS` | 2 | No | Confirmation depth (default: 10 prod, 1 dev) |
| `X402_KEY_PEPPER` | 3 | Yes | Server-side pepper for API key lookup hash |
| `SIWE_JWT_SECRET` | 4 | Yes | Secret for SIWE session JWTs |
| `FINN_NFT_CONTRACT` | 5 | Yes | finnNFT contract address on Base |
| `METRICS_BEARER_TOKEN` | 6 | Prod | Bearer token for /metrics authentication |

---

## Operational Addenda

> *Flatline IMP-001 (HIGH_CONSENSUS, avg 720): Release strategy + migration rollback*

### Release & Rollback Strategy

- **Feature flags**: All new subsystems (x402 verification, Postgres persistence, rate limiting) are behind config flags. Disabling a flag reverts to the existing behavior (in-memory/Redis fallbacks).
- **Migration rollback**: Every Drizzle migration has a corresponding `down` migration. Rollback procedure: `npx drizzle-kit migrate rollback` → verify tables dropped → restart. Data-destructive rollbacks (dropping tables with data) require explicit operator confirmation.
- **De-scope triggers**: If a sprint blocks for >1 iteration, the minimum shippable subset is: Sprint 1 (infra) + Sprint 2 (x402 core) + Sprint 4 (personality). Sprint 3 (API keys, rate limiting) can be deferred by disabling the API key code path and shipping x402-only.

> *Flatline IMP-002 (HIGH_CONSENSUS, avg 825): Configurable confirmation depth*

### Confirmation Depth Configuration

Sprint 2 T2.4: confirmation depth (currently hardcoded at 10) MUST be configurable via `X402_MIN_CONFIRMATIONS` env var (default: 10 for production, 1 for development/testing). Rationale: Base L2 has ~2s block time; 10 confirmations ≈ 20s, sufficient for finality. Test environments need lower values for fast iteration. Add test: confirmation depth respected (set to 1 in test, verify acceptance at 1 block).

> *Flatline IMP-003 (HIGH_CONSENSUS, avg 855): DLQ design clarification*

### DLQ Scope

Sprint 1 T1.5 references "flush DLQ" during graceful shutdown. The DLQ is the existing `DLQStore` interface (implemented in cycle-023, `src/hounfour/dlq/`). It stores failed billing finalization attempts. During shutdown, pending DLQ entries are flushed to Redis (via `RedisDLQAdapter`). No new DLQ design is needed — the reference is to the existing infrastructure. Sprint 1 AC updated: graceful shutdown flushes the existing `DLQStore` (if entries exist), not a new subsystem.

> *Flatline IMP-004 (HIGH_CONSENSUS, avg 815): Redis infrastructure expectations*

### Redis Configuration Requirements

Redis is a shared critical dependency across: x402 challenges (TTL), replay prevention, rate limiting, API key cache, SIWE nonces, signal cache.

- **Persistence**: Redis MUST be configured with AOF persistence (`appendonly yes`) in production. RDB snapshots alone risk losing recent nonces/replay keys on crash.
- **Eviction policy**: `noeviction` for production (reject writes when full rather than silently dropping keys). Development: `allkeys-lru` is acceptable.
- **Degradation strategy per feature**:
  - x402 nonces: fail-closed (503) — cannot verify without nonce
  - Rate limiting: degrade to in-memory sliding window (Sprint 3 T3.5)
  - API key cache: degrade to direct DB lookup (Sprint 3 T3.3)
  - SIWE nonces: fail-closed (401) — cannot verify without nonce
  - Signal cache: degrade to direct RPC call (Sprint 5 T5.2)
- **HA**: For MVP, single Redis instance is acceptable. Production: Redis Sentinel or ElastiCache (already available in freeside Terraform).

> *Flatline SKP-004 (BLOCKER, 740): Secrets management playbook*

### Secrets Management

| Secret | Storage (Prod) | Storage (Dev) | Rotation Cadence | Rotation Procedure |
|--------|---------------|--------------|-----------------|-------------------|
| `X402_CHALLENGE_SECRET` | AWS Secrets Manager | `.env` file | Quarterly | Deploy new secret as `_PREVIOUS`, update primary, wait 10-min grace, remove `_PREVIOUS` |
| `X402_CHALLENGE_SECRET_PREVIOUS` | AWS Secrets Manager | `.env` file | N/A (auto-cleared) | Populated during rotation only |
| `X402_KEY_PEPPER` | AWS Secrets Manager | `.env` file | Never (changing invalidates all lookup hashes) | If compromised: re-hash all keys with new pepper (migration task) |
| `SIWE_JWT_SECRET` | AWS Secrets Manager | `.env` file | Quarterly | Deploy new secret; existing sessions expire within 15 minutes (JWT exp). No grace needed. |
| `METRICS_BEARER_TOKEN` | AWS Secrets Manager | `.env` file | Annually | Update Prometheus scrape config, then rotate token. Brief metrics gap acceptable. |
| `S2S_ES256_PRIVATE_KEY` | AWS Secrets Manager / Docker Secrets | `.env` file | Annually | Key rotation procedure in PRD §5.2.1 (kid versioning, 24h grace). |
| `FINN_APP_PASSWORD` | Terraform `aws_db_user` | Docker entrypoint | Annually | Terraform apply with new password; restart services. |
| `FINN_MIGRATE_PASSWORD` | Terraform `aws_db_user` | Docker entrypoint | Annually | Terraform apply; run migration runner with new creds. |

**Emergency revoke/rotate playbook**:
1. Identify compromised secret
2. Generate replacement secret
3. Deploy to AWS Secrets Manager / update .env
4. Restart affected services (ECS force-deploy / `docker compose restart`)
5. For HMAC: old challenges become invalid (clients get new 402 challenges)
6. For JWT: existing sessions expire within 15 minutes
7. For pepper: emergency migration to re-hash all API keys (manual, documented)
8. Post-incident: rotate all secrets that share the same access path

---

## Risk Register

| Risk | Sprint | Probability | Impact | Mitigation |
|------|--------|------------|--------|------------|
| Alchemy API key not available | 2 | Medium | Blocks on-chain verification | Public fallback RPC in pool; aggressive caching |
| SIWE wallet signing complexity | 4 | Low | Blocks key management | Session JWT alternative; per-request SIWE optional |
| Drizzle migration conflicts with freeside | 1 | Low | Blocks deployment | Separate `finn` schema; CI validates isolation |
| Docker Compose port conflicts | 1 | Low | Can't run both services | Fixed ports: freeside=3000, finn=3001 |
| prom-client memory overhead | 6 | Low | OOM in small containers | Default histogram buckets; bounded label sets |
| Redis outage cascading to all features | All | Medium | Payment verification, auth, rate limiting fail | Per-feature degradation strategy (see Redis section above) |
| Single-agent delivery bottleneck | All | Medium | Integration issues cascade | Feature flags enable partial shipping; de-scope triggers defined |

---

## Success Criteria (Cycle-Level)

| Metric | Target | Sprint |
|--------|--------|--------|
| L-1: Container runs | `docker compose up` → health 200 | Sprint 1 |
| L-2: E2E request flow | POST /agent/chat → personality response | Sprint 4 |
| L-3: Payment collection | x402 USDC transfer verified on Base | Sprint 2–3 |
| L-4: Personality persistence | Survives container restart | Sprint 5 |
| L-5: Agent discovery | /llms.txt returns manifest | Sprint 7 |
| L-6: Observability | Conservation violation → alert | Sprint 6 |
| L-7: SDK exists | npm install + TypeScript compiles | Sprint 7 |
| L-8: Static personality | Archetype-appropriate voice | Sprint 4 |
