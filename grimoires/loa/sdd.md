# SDD: Launch Readiness — Product Integration & Live Testing

**Status:** Draft
**Author:** Jani (via Loa)
**Date:** 2026-02-25
**Cycle:** cycle-035
**PRD:** `grimoires/loa/prd.md` (GPT-5.2 APPROVED, iteration 2)

---

## 1. Executive Summary

Cycle-035 is an **integration and composition cycle**, not a greenfield build. The codebase already contains:

- Multi-stage Dockerfile (`deploy/Dockerfile`) — Node.js 22-slim, corepack/pnpm, non-root user, healthcheck
- Five Docker Compose configs (dev, prod, e2e, gpu, test)
- Full x402 stack (`src/x402/` — 14 files: middleware, settlement, receipt-verifier, verify, atomic-verify, credit-note, challenge-issuer, failure-recorder, pricing, rpc-pool, types, hmac, lua scripts)
- Feature flag service (`src/gateway/feature-flags.ts`) with 5 Redis-backed flags + admin API
- OpenAPI 3.1 spec (`src/gateway/openapi-spec.ts`) served at `GET /openapi.json`
- E2E test infrastructure (`tests/e2e/` — 10+ test files, compose, smoke-test)
- ES256 JWT validation via JWKS discovery (`src/hounfour/jwt-auth.ts` + `jose` v6)
- S2S JWT signer with JWKS endpoint at `/.well-known/jwks.json` (`src/hounfour/s2s-jwt.ts`)

**The work is connecting, hardening, and proving these subsystems compose correctly.** The SDD focuses on: (1) upgrading the E2E compose topology from arrakis/HS256 to freeside/ES256/JWKS-sidecar, (2) writing the full-loop E2E test, (3) augmenting the existing OpenAPI spec, (4) aligning x402 endpoint naming with the PRD's auth/payment precedence table, and (5) validating feature flag promotion.

### PRD/Code Reconciliation

The following divergences exist between the PRD and the current codebase. This SDD resolves each:

| PRD States | Code Reality | SDD Resolution |
|------------|-------------|----------------|
| 6 feature flags from PR #104 | 5 `DEFAULT_FLAGS` + dynamic `x402:public` | Document 6 flags: 5 defaults + `x402:public` (already used in `x402-routes.ts:119`) |
| `/api/v1/pay/chat` x402 endpoint | `/api/v1/x402/invoke` exists with full middleware | Keep `/api/v1/x402/invoke` as canonical. Add `/api/v1/pay/chat` as alias route (§3.4) |
| E2E uses freeside + ES256 | E2E compose uses arrakis + HS256 | New compose profile `docker-compose.e2e-v2.yml` with freeside + JWKS sidecar (§3.1) |
| JWKS sidecar container | Finn already serves `/.well-known/jwks.json` | Use finn's own JWKS endpoint for E2E — no sidecar needed (§3.2) |
| Docker Compose starts freeside | Dev compose has no freeside | Add freeside service to E2E compose (§3.1) |
| OpenAPI covers all `/api/v1/*` | Spec missing x402, admin, identity routes | Augment existing `buildOpenApiSpec()` (§3.5) |

---

## 2. System Architecture

### 2.1 High-Level Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Docker Compose Network                     │
│                                                              │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────┐   │
│  │   Redis 7   │   │  loa-finn   │   │  loa-freeside   │   │
│  │  (shared)   │◄──┤  port:3001  │──►│   port:3002     │   │
│  │             │   │             │   │                 │   │
│  │ feature:*   │   │ JWT(ES256)  │   │ conservation    │   │
│  │ x402:*      │   │ x402 stack  │   │ credit lots     │   │
│  │ sessions    │   │ WebSocket   │   │ reconciliation  │   │
│  │ rate-limits │   │ OpenAPI     │   │ sweeps          │   │
│  └─────────────┘   └──────┬──────┘   └─────────────────┘   │
│                           │                                  │
│                    ┌──────┴──────┐                           │
│                    │  E2E Test   │                           │
│                    │  Harness    │                           │
│                    │  (host)     │                           │
│                    └─────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Composition Topology Change

**Current** (`tests/e2e/docker-compose.e2e.yml`):
```
redis-e2e → arrakis-e2e → loa-finn-e2e
              (HS256)
```

**Target** (`tests/e2e/docker-compose.e2e-v2.yml`):
```
redis-e2e → loa-freeside-e2e → loa-finn-e2e
               (shared Redis)     (ES256 JWKS self-serve)
```

**Key changes:**
1. Replace `arrakis-e2e` with `loa-freeside-e2e` — freeside is the economic boundary, arrakis is deferred
2. Upgrade from HS256 shared secret to ES256 with JWKS discovery — finn already serves `/.well-known/jwks.json` via `S2SJwtSigner`
3. Add `FINN_JWT_ENABLED=true` and `FINN_JWKS_URL=http://loa-finn-e2e:3000/.well-known/jwks.json` (self-referencing JWKS via Docker service DNS — **not** `localhost`, which resolves to the container's loopback only)
4. Preserve existing E2E compose as legacy fallback (no deletion)

**JWKS bootstrap safety:** The `jose` library's `createRemoteJWKSet()` fetches JWKS lazily on the first JWT validation request, not at server startup. The `/.well-known/jwks.json` endpoint is a public route (no JWT middleware). This means there is no startup dependency loop: finn starts → healthcheck passes → E2E sends request with JWT → `jwtVerify()` triggers first JWKS fetch → `/.well-known/jwks.json` responds (already serving). The JWKS cache TTL is 5 minutes with automatic refetch on `kid` miss.

---

## 3. Component Design

### 3.1 E2E Compose Stack (FR-1, FR-2)

**File:** `tests/e2e/docker-compose.e2e-v2.yml`

```yaml
services:
  redis-e2e:
    image: redis:7-alpine
    ports: ["6380:6379"]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, timeout: 3s, retries: 5 }

  loa-freeside-e2e:
    image: ghcr.io/0xhoneyjar/loa-freeside:v7.11.0  # pinned to protocol-compatible version (Flatline IMP-002/SKP-004)
    environment:
      NODE_ENV: test
      REDIS_URL: redis://redis-e2e:6379
      FREESIDE_MODE: test
    depends_on:
      redis-e2e: { condition: service_healthy }
    healthcheck: { test: [...], interval: 5s, timeout: 5s, start_period: 15s, retries: 5 }

  loa-finn-e2e:
    build: { context: ../.. , dockerfile: deploy/Dockerfile }
    ports: ["3001:3000"]
    environment:
      NODE_ENV: test
      REDIS_URL: redis://redis-e2e:6379
      CHEVAL_MODE: mock
      FINN_JWT_ENABLED: "true"
      FINN_JWKS_URL: http://loa-finn-e2e:3000/.well-known/jwks.json  # self-referencing via Docker DNS
      FINN_JWT_ISSUER: e2e-harness
      FINN_JWT_AUDIENCE: loa-finn
      FINN_S2S_PRIVATE_KEY: ${E2E_ES256_PRIVATE_KEY}  # generated by test harness
      FINN_S2S_KID: e2e-v1
      FINN_S2S_ISSUER: e2e-harness
      FREESIDE_URL: http://loa-freeside-e2e:3002
      PORT: "3000"
    depends_on:
      redis-e2e: { condition: service_healthy }
      loa-freeside-e2e: { condition: service_healthy }
    healthcheck: { test: [...], interval: 5s, timeout: 5s, start_period: 15s, retries: 5 }
```

**JWKS Strategy:** Finn already exposes `GET /.well-known/jwks.json` via `S2SJwtSigner` (see `reality/routes.md`). In E2E mode, the test harness generates an ES256 keypair, passes the private key to finn via `FINN_S2S_PRIVATE_KEY`, and finn self-serves the public key at its JWKS endpoint. The test harness signs JWTs using the same private key. This means **no separate JWKS sidecar is needed** — finn is both the JWKS provider and consumer in E2E, which simplifies the compose topology while still exercising real JWKS discovery + ES256 validation.

**JWKS fetch resilience** (Flatline IMP-001): The `jose` `createRemoteJWKSet()` is configured with:
- **Timeout:** 5s per fetch attempt (default; configurable via `FINN_JWKS_TIMEOUT_MS`)
- **Cache TTL:** 5 minutes with stale-while-revalidate — on cache miss or `kid` mismatch, refetch; on transient failure, serve stale cached JWKS for up to 10 minutes
- **Retry:** Single retry with 1s backoff on network error before returning 503
- **Rotation:** New `kid` values trigger immediate JWKS refetch; E2E tests include a negative test for unknown `kid` → 401

**E2E JWKS limitation** (Flatline SKP-001, overridden): Self-referential JWKS proves the ES256+JWKS machinery works end-to-end but does not exercise TLS, remote host resolution, or multi-key rotation across services. A true external JWKS provider (sidecar or separate service) is deferred to the production staging cycle (Fly.io deployment). This is acceptable because: (a) the `jose` JWKS client is battle-tested for remote fetching, (b) the E2E proves the configuration wiring and claim validation, (c) production will use arrakis or a dedicated auth service as the JWKS issuer.

**Freeside Integration:** Freeside connects to the same Redis instance. Billing debit events from finn's budget engine are correlated with freeside's lot entries via shared Redis keys. The E2E test asserts both sides.

### 3.2 E2E Test Harness (FR-2)

**File:** `tests/e2e/full-loop.test.ts`

**Test flow:**

```
1. Generate ES256 keypair (P-256)
2. Wait for all compose services healthy
3. Sign JWT: { iss: "e2e-harness", aud: "loa-finn", tenant_id: "e2e-tenant", tier: "pro", req_hash: sha256(body) }
4. POST /api/v1/agent/chat with JWT → assert 200 or WebSocket connect
5. Connect WebSocket /ws/:sessionId with bearer token
6. Send { type: "prompt", text: "Hello" }
7. Assert receipt of text_delta + turn_end messages
8. Query finn /health → assert billing.spent_usd > 0
9. Query freeside → assert lot entry created for e2e-tenant
10. Send request exceeding budget → assert 429 with evaluation_gap
```

**Key implementation details:**

- **JWT signing:** Use `jose` library (`new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "e2e-v1" }).sign(privateKey)`)
- **WebSocket client:** Native `WebSocket` (Node.js 22 has built-in WebSocket) or `ws` package. Auth via query param: `ws://localhost:3001/ws/{sessionId}?token={bearer}`. Alternative: send `{ token: "..." }` as first message (both supported by `src/gateway/ws.ts`). Connection limit: 5 per IP. Idle timeout: 5 minutes (send `{ type: "ping" }` to keep alive). On token expiry mid-session: server sends `{ type: "error", message: "Token expired", recoverable: false }` and closes. E2E test mints short-lived tokens (60s) to avoid expiry during test, and includes a negative test for expired-token rejection.
- **Budget assertion:** The existing health endpoint already reports billing state. Freeside assertion uses freeside's API endpoint.
- **Test runner:** Vitest with JUnit XML reporter for CI (`--reporter=junit --outputFile=test-results/e2e.xml`)
- **Timeout:** 5-minute test suite budget (NFR-1)

**Existing infrastructure leveraged:**
- `tests/e2e/smoke-test.sh` — existing test script, used as reference
- `src/hounfour/jwt-auth.ts` — already validates ES256 via JWKS, already extracts `tenant_id`/`tier`/`req_hash`
- `src/gateway/ws.ts` — WebSocket protocol already defined with `prompt`, `text_delta`, `turn_end` message types

### 3.3 Feature Flag Promotion (FR-3)

**Existing infrastructure:** `src/gateway/feature-flags.ts` — `FeatureFlagService` class with Redis-backed `feature:{name}:enabled` keys, admin API at `POST /api/v1/admin/feature-flags`.

**Flag inventory (6 flags):**

| # | Flag Name | Redis Key | Default | ON Behavior | OFF Behavior |
|---|-----------|-----------|---------|-------------|--------------|
| 1 | `billing` | `feature:billing:enabled` | OFF | Budget enforcement active, costs recorded | Free tier, no cost tracking |
| 2 | `credits` | `feature:credits:enabled` | OFF | Credit balance system active | Credits ignored |
| 3 | `nft` | `feature:nft:enabled` | OFF | NFT-routed personality conditioning | Generic system prompt |
| 4 | `onboarding` | `feature:onboarding:enabled` | OFF | Guided onboarding flow active | Skip onboarding |
| 5 | `x402` | `feature:x402:enabled` | OFF | x402 payment endpoint active | 503 on `/api/v1/x402/invoke` |
| 6 | `x402:public` | `feature:x402:public:enabled` | OFF | x402 open to all wallets | Allowlist-gated beta |

**Promotion test strategy:**

1. **Individual validation:** For each flag, toggle ON via admin API → run full test suite → toggle OFF → verify no side effects
2. **All-on validation:** Enable all 6 flags → run full test suite
3. **Rollback:** Disable all flags → verify clean state
4. **Automation:** `tests/e2e/flag-promotion.test.ts` — Vitest suite that exercises all combinations via admin API

**Design decision:** Flags are toggled via the admin API (`POST /api/v1/admin/feature-flags`) during E2E tests, not via environment variables. This matches production behavior (Redis-backed runtime toggle) and is more representative than compose `.env` restarts. The promotion runbook for future cloud staging will document the admin API toggle sequence.

**Admin auth contract for E2E:**

The admin API (`/api/v1/admin/*`) uses a separate auth middleware (`validateAdminToken` in `feature-flags.ts:89`) that checks for `role: "admin"` in the JWT claims. In E2E:

1. **Same JWKS:** Admin JWTs are validated against the same JWKS endpoint (`/.well-known/jwks.json`) as user JWTs — no separate keypair needed.
2. **Same ES256 key:** The E2E harness mints admin tokens using the same ephemeral ES256 private key used for user tokens.
3. **Admin claims:** `{ iss: "e2e-harness", aud: "loa-finn-admin", role: "admin", tenant_id: "e2e-admin" }` — note the `aud: "loa-finn-admin"` matches `AUDIENCE_MAP.admin` from `jwt-auth.ts:71`.
4. **User claims:** `{ iss: "e2e-harness", aud: "loa-finn", tenant_id: "e2e-tenant", tier: "pro", req_hash: "sha256:..." }` — note `aud: "loa-finn"` matches `AUDIENCE_MAP.invoke`.

The E2E test harness exports a `mintToken(claims, privateKey)` helper that accepts arbitrary claims, allowing both user and admin tokens from a single keypair. The `kid` header is `e2e-v1` for both.

### 3.4 x402 Endpoint Alignment (FR-4)

**Current state:** The x402 endpoint is `POST /api/v1/x402/invoke` (in `src/gateway/x402-routes.ts`). The PRD defines the auth/payment precedence table as:

| Endpoint | Auth Mode |
|----------|-----------|
| `/api/v1/chat` | JWT only (401 if missing) |
| `/api/v1/pay/chat` | x402 only (402 if missing) |

**Resolution:** Add `/api/v1/pay/chat` as a **single explicit alias** in `server.ts` that delegates to the existing x402 invoke handler. The existing `/api/v1/x402/invoke` remains unchanged. The x402 router is NOT re-mounted — only the handler function is reused.

**Implementation — extract handler, register alias in `server.ts`:**

```typescript
// In x402-routes.ts: extract the handler as a named export
export function createX402InvokeHandler(deps: X402RouteDeps) {
  return async (c: Context) => { /* existing POST /invoke body */ }
}

export function x402Routes(deps: X402RouteDeps): Hono {
  const app = new Hono()
  // Canonical endpoint (existing, unchanged)
  app.post("/invoke", createX402InvokeHandler(deps))
  return app
}
```

```typescript
// In server.ts: mount canonical + register single alias
app.route("/api/v1/x402", x402Routes(deps))            // → POST /api/v1/x402/invoke
app.post("/api/v1/pay/chat", createX402InvokeHandler(deps))  // → single alias, no extra routes
```

This approach avoids the route duplication problem: mounting the full `x402Routes` router at `/api/v1/pay` would create unintended endpoints (`/api/v1/pay/invoke`). Instead, only the handler function is reused for the single alias path.

**Auth/payment precedence (no code change needed):** The existing middleware stack already enforces this:
- `/api/v1/*` routes pass through `jwtAuthMiddleware` which checks `FINN_JWT_ENABLED`
- x402 routes are mounted separately and do NOT pass through JWT middleware
- The x402 handler already returns 402 when no `X-Payment` header is present (line 91-107 of `x402-routes.ts`)
- The alias route (`/api/v1/pay/chat`) is registered outside the JWT middleware scope, matching the same middleware-free treatment as `/api/v1/x402/*`

The x402 middleware stack (feature flag check → parse → allowlist → rate limit → quote → verify → settle → inference) is already complete.

**x402 failure modes and error schemas** (Flatline IMP-003):

| Failure | Status | Error Code | Behavior |
|---------|--------|------------|----------|
| Feature flag `x402` OFF | 503 | `FEATURE_DISABLED` | No quote issued |
| Missing `X-Payment` header | 402 | `PAYMENT_REQUIRED` | Returns quote in `X-Payment-Required` header |
| Invalid payment JSON | 400 | `INVALID_PAYMENT` | Rejects before verification |
| Quote expired (>5min TTL) | 402 | `QUOTE_NOT_FOUND` | Client must re-request quote |
| Quote expiry mid-inference | N/A | N/A | Quote is consumed at settlement time (before inference starts). If inference is slow, quote TTL is irrelevant — the payment is already settled. |
| Nonce replay | 409 | `NONCE_REPLAY` | Idempotent replay returns original result if `idempotent_replay=true`; otherwise rejects |
| Payment amount < estimated cost | 402 | `INSUFFICIENT_PAYMENT` | Conservation guard rejects |
| Wallet not on allowlist (beta) | 403 | `NOT_ALLOWLISTED` | During closed beta only |
| Rate limit exceeded | 429 | `RATE_LIMITED` | 100 req/hour per wallet |
| Inference fails after settlement | 502 | `INFERENCE_FAILED` | Credit note issued for full `max_cost`; `credit_note.id` returned in response |
| Credit note issuance fails | 502 | `INFERENCE_FAILED` | Best-effort; `credit_note: null` in response. Logged for manual reconciliation. |
| Partial settlement (on-chain only) | N/A | N/A | Out of scope — E2E uses off-chain verification only. On-chain settlement is atomic (tx succeeds or fails). |

### 3.5 OpenAPI Spec Augmentation (FR-5)

**Current state:** `src/gateway/openapi-spec.ts` covers `/api/v1/agent/chat`, `/api/v1/keys`, `/api/v1/auth/*`, `/health`, `/metrics`, `/llms.txt`, `/agents.md`, `/agent/{tokenId}`. Missing: x402 endpoints, admin API, identity endpoints, WebSocket documentation.

**Additions to `buildOpenApiSpec()`:**

1. **x402 endpoints:**
   - `POST /api/v1/x402/invoke` — with 402 response schema (existing `X402Challenge`)
   - `POST /api/v1/pay/chat` — alias, same schema

2. **Admin endpoints:**
   - `POST /api/v1/admin/feature-flags` — toggle flags
   - `GET /api/v1/admin/feature-flags` — list flag states
   - `POST /api/v1/admin/allowlist` — manage wallet allowlist

3. **Identity endpoints (FR-6):**
   - `GET /api/identity/wallet/{wallet}/nfts` — multi-NFT resolution

4. **WebSocket documentation:**
   - `x-websocket` extension on `/ws/{sessionId}` describing message envelope types
   - Reference to `reality/routes.md` for full protocol spec

5. **Corpus version header (FR-6.3):**
   - `x-corpus-version` response header on `/api/knowledge/*` paths

**Implementation approach:** Extend the existing `buildOpenApiSpec()` function in-place. No new files needed. The spec is already programmatically built, so adding paths is straightforward.

### 3.6 TypeScript SDK (FR-5.2)

**Package:** `packages/sdk/` (new directory — monorepo package)

**Scope for this cycle:**
- REST client wrapping `/api/v1/agent/chat` and `/api/v1/x402/invoke`
- WebSocket client wrapping `/ws/:sessionId` with typed message handlers
- JWT auth helper (sign with ES256 key)
- Published as `@0xhoneyjar/loa-finn-sdk` (npm)

**Generation strategy:** Manual TypeScript client (not auto-generated from OpenAPI). The WebSocket protocol cannot be generated from OpenAPI, and the authentication flow (SIWE → JWT → API key) requires custom logic. The SDK uses the OpenAPI spec as documentation source, not as code generator input.

**SDK structure:**

```
packages/sdk/
├── src/
│   ├── client.ts        # FinnClient class (REST + auth)
│   ├── ws.ts            # FinnWebSocket class (streaming)
│   ├── x402.ts          # X402Client (payment flow)
│   ├── types.ts         # Shared types (from OpenAPI schemas)
│   └── index.ts         # Re-exports
├── package.json
├── tsconfig.json
└── README.md
```

### 3.7 Dixie Contract Alignment (FR-6)

**FR-6.1 — Multi-NFT resolution:** Existing endpoint `/api/identity/wallet/:wallet/nfts` currently returns the first NFT only. Change to return array of all NFTs.

**Backward compatibility** (Flatline IMP-010): Changing from single-object to array is a breaking change for any existing consumers. Mitigation:
- The current endpoint has no external consumers yet (dixie integration is this cycle's work)
- Response schema: `{ nfts: NFTInfo[], total: number }` — always an array, even for single results
- No pagination needed for MVP (wallets typically hold <10 NFTs in this collection)
- If a legacy single-NFT endpoint is needed, preserve `GET /api/identity/wallet/:wallet/nft` (singular) as deprecated alias returning the first result

**FR-6.2 — Contract documentation:** Documented as part of OpenAPI augmentation (§3.5).

**FR-6.3 — Corpus version header:** Add `x-corpus-version` header middleware to all `/api/knowledge/*` routes. Version sourced from the deployed dixie corpus manifest (`grimoires/oracle-dixie/manifest.json` or `DIXIE_REF` build arg).

---

## 4. Data Architecture

### 4.1 No Schema Changes

This cycle introduces **no new database tables or schema migrations.** All data flows use existing structures:

| Data | Storage | Existing |
|------|---------|----------|
| Feature flags | Redis (`feature:{name}:enabled`) | `FeatureFlagService` |
| x402 quotes | Redis (`x402:quote_id:{id}`) | `QuoteService` |
| x402 rate limits | Redis (`x402:rate:{wallet}`) | `x402-routes.ts` |
| JWT replay guard | Redis (`jti:{hash}`) | `JtiReplayGuard` |
| Budget state | In-memory `BudgetSnapshot` + WAL | Budget engine |
| Sessions | File-based WAL + R2 sync | Session manager |

### 4.2 Freeside Data Correlation

The E2E test needs to assert that finn's budget debit is mirrored in freeside's ledger.

**Finn side (observable):**
- After inference, `BudgetSnapshot.spent_usd` increases
- Observable via `GET /health` → `response.billing.spent_usd` (existing health endpoint)
- Budget engine writes cost events to WAL namespace `budget` with key pattern `budget:{tenant_id}`

**Freeside side (observable via Redis):**
- Freeside records lot entries in Redis with key pattern `freeside:lot:{tenant_id}:{lot_id}`
- Each lot entry is a JSON object: `{ tenant_id, lot_id, amount_micro, direction: "debit"|"credit", timestamp, source_service }`
- The E2E test queries Redis directly using the shared Redis connection: `SCAN 0 MATCH freeside:lot:e2e-tenant:* COUNT 100` (using `SCAN` instead of `KEYS` to avoid O(N) performance issues per Flatline SKP-004), then verifies at least one entry with `direction: "debit"` and `amount_micro > 0`

**Freeside health API (fallback):**
- `GET /v1/health` on freeside returns `{ status, ledger: { total_lots, last_entry_at } }`
- If freeside exposes a tenant query endpoint (e.g., `GET /v1/ledger/{tenant_id}`), the E2E test uses it as the primary assertion. If not, direct Redis key query is the primary path.

**Correlation identifiers:**
- Primary: `tenant_id` (from JWT claim, set to `e2e-tenant` in test harness)
- Secondary: `quote_id` (for x402 flow correlation)

**Implementation note:** If freeside's Redis key schema differs from the above at implementation time, the E2E test adapts to freeside's actual schema. The sprint implementation task must verify freeside's key patterns before writing assertions. The shared Redis instance (`redis-e2e:6379`) is accessible from the test harness via the mapped port `localhost:6380`.

---

## 5. API Design

### 5.1 Endpoint Summary (After Changes)

| Endpoint | Auth | Status | Change |
|----------|------|--------|--------|
| `POST /api/v1/agent/chat` | JWT (ES256) | Existing | No change |
| `POST /api/v1/x402/invoke` | x402 payment | Existing | No change |
| `POST /api/v1/pay/chat` | x402 payment | **New** | Alias to x402/invoke (§3.4) |
| `GET /api/v1/admin/feature-flags` | Admin JWT | Existing | No change |
| `POST /api/v1/admin/feature-flags` | Admin JWT | Existing | No change |
| `GET /api/identity/wallet/:wallet/nfts` | Bearer | Existing | Fix: return array (§3.7) |
| `GET /openapi.json` | None | Existing | Augmented (§3.5) |
| `WS /ws/:sessionId` | Bearer query/msg | Existing | No change |
| `GET /.well-known/jwks.json` | None | Existing | No change |
| `GET /health` | None | Existing | No change |

### 5.2 Auth/Payment Precedence (PRD Decision Table)

```
Request to /api/v1/agent/chat:
  ├── Has valid JWT? → Process inference (billing via budget engine)
  ├── Has invalid JWT? → 401 Unauthorized
  └── No auth header? → 401 Unauthorized (no x402 fallback)

Request to /api/v1/pay/chat (or /api/v1/x402/invoke):
  ├── Has X-Payment header? → Verify payment → Process inference
  ├── No X-Payment? → 402 with quote (X-Payment-Required header)
  └── Feature flag x402 OFF? → 503 Service Unavailable
```

No code change required for precedence enforcement — the existing route registration already separates JWT-gated and x402-gated paths.

---

## 6. Security Architecture

### 6.1 Auth Changes

| Component | Current | After |
|-----------|---------|-------|
| E2E JWT algorithm | HS256 (shared secret) | **ES256 (JWKS discovery)** |
| E2E JWKS source | N/A | Finn self-serves at `/.well-known/jwks.json` |
| E2E key management | Hardcoded `FINN_S2S_JWT_SECRET` | **Generated ES256 keypair per test run** |
| x402 nonce replay | Redis-based `atomic-verify.ts` | No change |
| Request hash | SHA-256 body hash in JWT `req_hash` | No change |

### 6.2 JWT Claim Contract (Flatline SKP-002)

All JWTs are validated by `src/hounfour/jwt-auth.ts` with the following enforced contract:

| Claim | Required | Validation | User Token | Admin Token |
|-------|----------|------------|------------|-------------|
| `iss` | Yes | Must match `FINN_JWT_ISSUER` | `e2e-harness` | `e2e-harness` |
| `aud` | Yes | Must match endpoint audience map | `loa-finn` | `loa-finn-admin` |
| `exp` | Yes | Must be in future (+ clock skew) | Required | Required |
| `iat` | Yes | Must be in past | Required | Required |
| `nbf` | Optional | If present, must be in past (+ skew) | Optional | Optional |
| `jti` | Conditional | Required for invoke/admin per `EFFECTIVE_JTI_POLICY` | Required | Required |
| `tenant_id` | Yes | Non-empty string | `e2e-tenant` | `e2e-admin` |
| `tier` | Yes (user) | `free\|pro\|enterprise` | `pro` | N/A |
| `role` | Yes (admin) | Must be `admin` for admin endpoints | N/A | `admin` |
| `req_hash` | Conditional | `sha256:<hex>` of request body for POST/PUT/PATCH | Required for POST | N/A |

**Clock skew:** `FINN_JWT_CLOCK_SKEW` (default 30s). **Max lifetime:** `FINN_JWT_MAX_LIFETIME` (default 3600s — tokens older than this are rejected regardless of `exp`).

**Negative E2E tests** (in `tests/e2e/auth-negative.test.ts`):
- Wrong `aud` (user token hitting admin endpoint) → 403
- Missing `exp` → 401
- Expired token → 401
- Future `nbf` → 401
- Missing `role` on admin endpoint → 403
- `role=user` on admin endpoint → 403
- Unknown `kid` → 401
- Replayed `jti` → 401

### 6.3 Admin Auth Production Hardening (Flatline SKP-003, Deferred)

**This cycle (E2E compose):** Admin and user tokens share the same JWKS trust root and ES256 keypair. This is acceptable for local/CI testing where the keypair is ephemeral and the compose network is isolated.

**Future production hardening (Fly.io cycle):** The following controls must be added before exposing admin endpoints to non-local networks:
- Separate JWKS issuer for admin tokens (dedicated auth service or separate keypair)
- IP allowlist or mTLS for `/api/v1/admin/*` routes
- Rate limiting on admin endpoints (lower than user endpoints)
- Audit logging: all flag changes logged with `who` (JWT `sub`/`tenant_id`), `when` (timestamp), `what` (flag name, old→new value) — already partially implemented via `writeAudit()` in `feature-flags.ts:68`
- Consider network segmentation (admin endpoints on internal port only)

### 6.5 E2E Key Generation

The test harness generates a fresh ES256 keypair before each test run:

```typescript
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose"

const { privateKey, publicKey } = await generateKeyPair("ES256")
const privatePem = await exportPKCS8(privateKey)
// Pass to compose via E2E_ES256_PRIVATE_KEY env var
```

This key is ephemeral — generated, used, discarded. No key material persists beyond the test run.

### 6.6 x402 Security (Unchanged)

The existing x402 stack provides:
- **Nonce atomicity:** `atomic-verify.ts` + Redis Lua scripts ensure single-use nonces
- **Quote binding:** Quote ID links payment proof to specific inference parameters
- **Rate limiting:** 100 requests/hour per wallet (`x402-routes.ts:38-48`)
- **Allowlist gating:** `x402:public` flag controls open vs beta access
- **Credit notes:** `credit-note.ts` handles over-payment refunds (off-chain)

No changes to x402 security model.

---

## 7. Technology Stack

### 7.1 No New Dependencies (Runtime)

All runtime dependencies already exist in `package.json`:
- `hono` v4 — HTTP framework
- `jose` v6 — JWT/JWKS
- `ioredis` — Redis client (via `@0xhoneyjar/loa-hounfour`)
- `zod` — Schema validation

### 7.2 New Dev Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| `vitest` | E2E test runner (already in devDeps) | Existing |
| `@vitest/reporter-junit` | JUnit XML output for CI | ^1.0 |

### 7.3 New Package (SDK)

| Package | Purpose |
|---------|---------|
| `@0xhoneyjar/loa-finn-sdk` | TypeScript SDK (`packages/sdk/`) |

---

## 8. Deployment Architecture

### 8.1 CI Pipeline Changes

**Current:** GitHub Actions runs `pnpm test` and `pnpm build`. E2E tests are skipped (require `ARRAKIS_CHECKOUT_TOKEN` secret not configured).

**Target:** Add E2E workflow step:

```yaml
# .github/workflows/e2e.yml
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Generate ES256 keypair
        run: node tests/e2e/generate-keys.js
      - name: Start compose stack
        run: docker compose -f tests/e2e/docker-compose.e2e-v2.yml up -d --build
      - name: Wait for healthy
        run: tests/e2e/wait-healthy.sh
      - name: Run E2E tests
        run: pnpm vitest run tests/e2e/full-loop.test.ts --reporter=junit --outputFile=test-results/e2e.xml
      - name: Tear down
        if: always()
        run: docker compose -f tests/e2e/docker-compose.e2e-v2.yml down -v
```

**Freeside image:** In CI, use `ghcr.io/0xhoneyjar/loa-freeside:latest` (pre-built). For local development, build from sibling directory `../loa-freeside` if available.

### 8.2 Docker Image (No Changes)

The existing `deploy/Dockerfile` already meets all PRD requirements:
- Multi-stage build ✅
- Node.js 22 LTS ✅
- Non-root user (`finn`) ✅
- Health check instruction ✅
- No secrets baked in (runtime env vars) ✅
- Under 500MB (estimated ~350MB based on slim base) ✅

No Dockerfile changes needed.

---

## 9. Scalability & Performance

No scalability changes in this cycle. The E2E harness runs in CI with `CHEVAL_MODE=mock` (no real LLM calls), keeping test suite runtime under 5 minutes (NFR-1).

**x402 payment verification:** Off-chain signature verification only (no RPC calls in E2E). Target: <500ms per verification (NFR-1). The existing `verify.ts` already performs off-chain ECDSA recovery — no optimization needed.

---

## 10. Testing Strategy

### 10.1 Test Pyramid

| Level | Existing | This Cycle |
|-------|----------|------------|
| Unit | 200+ tests (`pnpm test`) | No additions |
| Integration | 22 BATS tests (`tests/integration/`) | No additions |
| E2E | `tests/e2e/smoke-test.sh` (arrakis/HS256) | **New:** `full-loop.test.ts` (freeside/ES256) |
| E2E | — | **New:** `flag-promotion.test.ts` |
| E2E | — | **New:** `x402-flow.test.ts` |

### 10.2 E2E Test Matrix

| Test | Asserts | Priority |
|------|---------|----------|
| `full-loop.test.ts` | JWT → inference → billing debit → WebSocket stream | P0 |
| `flag-promotion.test.ts` | Each flag individually → all-on → rollback | P0 |
| `x402-flow.test.ts` | 402 response → payment → inference → credit-back | P1 |
| `budget-conservation.test.ts` | Budget exhaustion → 429 → evaluation_gap | P0 |

### 10.3 Mock Strategy

| Component | E2E Behavior | Production Behavior |
|-----------|-------------|-------------------|
| LLM inference | `CHEVAL_MODE=mock` (deterministic responses) | Real model calls |
| x402 settlement | Off-chain signature verification only | On-chain via Base (future) |
| Redis | Real Redis (compose service) | Real Redis |
| JWT | Real ES256 + JWKS discovery | Real ES256 + JWKS discovery |
| Freeside | Real freeside service (compose) | Real freeside service |

---

## 11. Development Workflow

### 11.1 Sprint Scope

Based on PRD priority ordering:

| Sprint | Focus | PRD Section | Priority |
|--------|-------|-------------|----------|
| Sprint 1 | E2E Compose + Full Loop Test | FR-1, FR-2 | P0 |
| Sprint 2 | Feature Flag Promotion + x402 Alignment | FR-3, FR-4 | P0/P1 |
| Sprint 3 | OpenAPI Augmentation + SDK + Dixie Contracts | FR-5, FR-6 | P1/P2 |

### 11.2 File Change Map

| File | Change Type | Sprint |
|------|-------------|--------|
| `tests/e2e/docker-compose.e2e-v2.yml` | New | 1 |
| `tests/e2e/generate-keys.ts` | New | 1 |
| `tests/e2e/full-loop.test.ts` | New | 1 |
| `tests/e2e/wait-healthy.sh` | New | 1 |
| `tests/e2e/budget-conservation.test.ts` | New | 1 |
| `tests/e2e/auth-negative.test.ts` | New | 1 |
| `tests/e2e/flag-promotion.test.ts` | New | 2 |
| `tests/e2e/x402-flow.test.ts` | New | 2 |
| `src/gateway/x402-routes.ts` | Modify (add alias) | 2 |
| `src/gateway/server.ts` | Modify (mount alias) | 2 |
| `src/gateway/openapi-spec.ts` | Modify (augment) | 3 |
| `packages/sdk/` | New directory | 3 |
| `src/gateway/identity-routes.ts` | Modify (multi-NFT) | 3 |
| `.github/workflows/e2e.yml` | New | 1 |

---

## 12. Technical Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Freeside Docker image unavailable in CI | Medium | High | Fallback to building from source if GHCR image missing |
| JWKS self-referencing causes timing issue (finn serves JWKS but also consumes it during startup) | Low | Medium | JWKS cache with retry; finn's JWKS endpoint is available before JWT middleware activates |
| E2E tests flaky due to compose startup timing | Medium | Medium | `wait-healthy.sh` with exponential backoff + service health checks |
| x402 alias route conflicts with existing route tree | Low | Low | Mount at `/api/v1/pay` — no collision with `/api/v1/x402` |
| Feature flag interactions (2^6 = 64 combinations) | Medium | Medium | Test individually + all-on only; don't test every combination |

---

## 13. Appendix: Existing Infrastructure Inventory

Files that already exist and are leveraged (not created) by this cycle:

| File | Purpose | Lines |
|------|---------|-------|
| `deploy/Dockerfile` | Multi-stage build | 91 |
| `docker-compose.dev.yml` | Dev stack (finn+pg+redis) | 100 |
| `tests/e2e/docker-compose.e2e.yml` | Legacy E2E (arrakis/HS256) | 64 |
| `src/gateway/feature-flags.ts` | Flag service + admin API | 151 |
| `src/x402/middleware.ts` | Quote service | 125 |
| `src/x402/types.ts` | x402 types + constants | 135 |
| `src/gateway/x402-routes.ts` | x402 endpoint handler | 206 |
| `src/x402/verify.ts` | Payment verification | ~150 |
| `src/x402/settlement.ts` | Settlement service | ~200 |
| `src/x402/credit-note.ts` | Credit-back service | ~100 |
| `src/x402/atomic-verify.ts` | Nonce atomicity (Lua) | ~100 |
| `src/gateway/openapi-spec.ts` | OpenAPI 3.1 spec builder | 534 |
| `src/hounfour/jwt-auth.ts` | ES256 JWT validation + JWKS | ~300 |
| `src/hounfour/s2s-jwt.ts` | S2S JWT signer + JWKS serve | ~150 |
| `src/gateway/ws.ts` | WebSocket protocol | ~200 |
| `src/gateway/server.ts` | Route registration | ~400 |
