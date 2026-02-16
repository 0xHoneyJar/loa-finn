# PRD: Sprint B — E2E Smoke Test: Billing Wire Verification

> **Version**: 2.0.0
> **Date**: 2026-02-17
> **Author**: @janitooor
> **Status**: Draft
> **Cycle**: cycle-022
> **Issue**: [#69](https://github.com/0xHoneyJar/loa-finn/issues/69)
> **Command Center**: [#66](https://github.com/0xHoneyJar/loa-finn/issues/66)
> **Predecessor**: cycle-021 (Sprint A — S2S Billing Finalize Client, PR #68, merged)
> **Grounding**: Codebase exploration of loa-finn `src/hounfour/` and arrakis `tests/e2e/`, cross-repo protocol analysis
> **GPT-5.2 Review**: Iteration 2 — 7 blocking issues from iteration 1 resolved

---

## 1. Problem Statement

### The Problem

Sprint A delivered the S2S Billing Finalize Client (`src/hounfour/billing-finalize-client.ts`, 270 lines, 57 tests). But every test mocks the arrakis endpoint. **No test proves the wire actually works against a real arrakis instance.** Codebase grounding of both repos revealed **5 critical integration mismatches** that unit tests cannot detect:

```
MISMATCH                          LOA-FINN (Sprint A)                    ARRAKIS (billing-routes.ts)
═══════════════════════════════    ═══════════════════════════════════     ══════════════════════════════════
1. JWT Algorithm                  ES256 (asymmetric keypair)             HS256 (symmetric shared secret)
                                  src/hounfour/s2s-jwt.ts:35,57          BILLING_INTERNAL_JWT_SECRET env var

2. Field Naming                   snake_case                             camelCase
                                  billing-finalize-client.ts:185-190     billing-routes.ts request body
                                  reservation_id, actual_cost_micro      reservationId, actualCostMicro

3. Identity Field                 tenant_id                              accountId
                                  billing-finalize-client.ts:187         billing-routes.ts request body

4. URL Path                       /api/internal/billing/finalize         /api/internal/finalize
                                  billing-finalize-client.ts:32          billing-routes.ts route def

5. Docker Config                  deploy/Dockerfile (76 lines)           Dockerfile (root) assumed
                                  deploy/Dockerfile:1                    docker-compose.e2e.yml:73
```

These are **exactly** the kind of bugs E2E testing exists to catch. Sprint A's mocked tests give 100% pass rate but 0% wire-level confidence.

### Why Now

- Sprint A merged (PR #68, 2026-02-16) — the finalize client exists but is untested against real arrakis
- arrakis already has an E2E scaffold (`tests/e2e/docker-compose.e2e.yml`) with loa-finn defined as a service
- This is the **sole remaining P0 blocker** between Sprint A and Shadow Deploy (first revenue)
- The 5 mismatches will cause 100% failure rate in production if deployed without E2E verification

> **Sources**: `src/hounfour/billing-finalize-client.ts:32,185-190`, `src/hounfour/s2s-jwt.ts:35,57`, arrakis `tests/e2e/docker-compose.e2e.yml:54,73,87-88`, arrakis `billing-routes.ts`

### Vision

**Prove the wire works.** After this sprint, a single `docker compose up` command runs a 4-service stack (redis, arrakis, loa-finn, contract-validator) and a smoke test that sends a real inference request through the full billing pipeline: reserve → infer → finalize → verify BillingEntry.

---

## 2. Goals & Success Metrics

| ID | Goal | Priority | Metric |
|----|------|----------|--------|
| G-1 | Fix all 5 integration mismatches so finalize client can talk to real arrakis | P0 | `POST /api/internal/finalize` returns 200 with valid BillingEntry |
| G-2 | Docker Compose stack boots all 4 services and passes health checks | P0 | All services healthy within 30s |
| G-3 | E2E smoke test proves reserve→infer→finalize→verify pipeline with deterministic verification | P0 | Smoke test exits 0 in CI; BillingEntry verified via arrakis read endpoint |
| G-4 | Existing 57 unit tests continue passing after mismatch fixes | P0 | CI green, 0 regressions |
| G-5 | CI pipeline runs E2E on every PR to `main` | P1 | GitHub Actions workflow triggers on PR |

---

## 3. Scope

### In Scope

1. **Fix JWT algorithm mismatch**: Switch S2S signer to HS256 for billing finalize (arrakis uses symmetric shared secret)
2. **Fix field naming mismatch**: Map snake_case → camelCase in finalize request body
3. **Fix identity field mismatch**: Map `tenant_id` → `accountId` in finalize request body
4. **Fix URL path mismatch**: Correct finalize endpoint from `/api/internal/billing/finalize` to `/api/internal/finalize`
5. **Fix Docker config**: Ensure Dockerfile path and health check match compose expectations
6. **E2E Docker Compose stack**: 4-service stack with HS256 shared secret wiring
7. **E2E smoke test script**: Proves the full billing pipeline works with deterministic verification
8. **CI integration**: GitHub Actions workflow for E2E tests

### Out of Scope

- Production deployment / shadow mode (Sprint C)
- arrakis-side code changes (we adapt loa-finn to match arrakis's existing contract)
- JWKS bootstrap / ES256 key exchange (not needed for HS256; future work if ES256 billing is ever required)
- Agent homepage or conversation engine (Phase 1)
- Billing dashboard
- DLQ replay E2E testing (unit tests sufficient)
- GPU/vLLM services in E2E stack (mock inference is sufficient)
- HS256 shared secret rotation mechanism (future work)

### Design Decision: Adapt loa-finn, Not arrakis

arrakis's billing endpoint is already deployed and tested (`billing-routes.ts`, `requireInternalAuth` middleware, HS256 JWT validation). loa-finn adapts to match arrakis's existing wire contract rather than requiring arrakis changes. This is the correct direction because:
- arrakis is the **billing system of record** — its contract is authoritative
- Changing arrakis would require a separate PR cycle and deployment
- The mismatches are in loa-finn's Sprint A code, which assumed a contract that doesn't match reality

---

## 4. Functional Requirements

### FR-1: Fix JWT Algorithm (ES256 → HS256 for Billing)

**Current state** (`src/hounfour/s2s-jwt.ts:35,57`):
```typescript
// Line 35: ES256 key import
this.privateKey = await importPKCS8(this.config.privateKeyPem, "ES256")
// Line 57: ES256 header
.setProtectedHeader({ alg: "ES256", typ: "JWT", kid: this.config.kid })
```

**arrakis expects** (`docker-compose.e2e.yml:54`):
```yaml
BILLING_INTERNAL_JWT_SECRET=${BILLING_INTERNAL_JWT_SECRET:-e2e-s2s-jwt-secret-for-testing-only-32chr}
```
arrakis's `requireInternalAuth` middleware verifies HS256 JWTs using a symmetric shared secret. arrakis is HS256-only for this endpoint — it does not support ES256 verification for billing.

**Solution**: Add HS256 signing mode to the S2S JWT signer with explicit, non-ambiguous algorithm selection:

**Algorithm selection rules (strict precedence, enforced at startup):**

| `FINN_S2S_JWT_ALG` | `FINN_S2S_JWT_SECRET` | `FINN_S2S_PRIVATE_KEY` | Result |
|---------------------|----------------------|----------------------|--------|
| `HS256` | set | any | HS256 (secret used, private key ignored) |
| `ES256` | any | set | ES256 (private key used, secret ignored) |
| not set | set | not set | HS256 (auto-detect) |
| not set | not set | set | ES256 (auto-detect) |
| not set | set | set | **Startup error** — ambiguous config, set `FINN_S2S_JWT_ALG` |
| not set | not set | not set | **Startup error** — no signing key configured |

**Critical safety constraint**: The signer MUST hardcode the algorithm in `setProtectedHeader()` based on config — it MUST NEVER read the algorithm from an incoming JWT header or any untrusted input. This prevents algorithm confusion attacks.

**Secret naming in E2E**: The Docker Compose stack uses `BILLING_INTERNAL_JWT_SECRET` (arrakis's name). loa-finn's compose service maps this to `FINN_S2S_JWT_SECRET`:
```yaml
loa-finn-e2e:
  environment:
    FINN_S2S_JWT_SECRET: ${BILLING_INTERNAL_JWT_SECRET:-e2e-s2s-jwt-secret-for-testing-only-32chr}
    FINN_S2S_JWT_ALG: HS256
```
This ensures both services use the same secret value while each reads its own env var name.

**Acceptance Criteria:**
- [ ] S2S JWT signer supports HS256 via `FINN_S2S_JWT_SECRET` env var
- [ ] Algorithm set from config only — never from JWT header or untrusted input
- [ ] Startup error when both `FINN_S2S_JWT_SECRET` and `FINN_S2S_PRIVATE_KEY` set without explicit `FINN_S2S_JWT_ALG`
- [ ] JWT claims unchanged: `{ sub: "loa-finn", aud: "arrakis-internal", iss: "loa-finn", exp: iat+300 }`
- [ ] arrakis can validate the HS256 JWT with the shared secret
- [ ] Existing ES256 tests still pass
- [ ] New tests: HS256 sign + verify round-trip, algorithm selection logic, ambiguous config rejection, negative test (HS256 config rejects ES256 token and vice versa)

### FR-2: Fix Wire Contract (Field Naming + Identity + Complete Schema)

**Current state** (`src/hounfour/billing-finalize-client.ts:185-190`):
```typescript
const body = JSON.stringify({
  reservation_id: req.reservation_id,
  tenant_id: req.tenant_id,
  actual_cost_micro: req.actual_cost_micro,
  trace_id: req.trace_id,
})
```

**arrakis finalize wire contract** (authoritative, from `billing-routes.ts`):

#### Request: `POST /api/internal/finalize`

| Field | Wire Name | Type | Required | loa-finn Source |
|-------|-----------|------|----------|-----------------|
| Reservation ID | `reservationId` | `string` | Yes | `req.reservation_id` |
| Actual cost | `actualCostMicro` | `string` (BigInt) | Yes | `req.actual_cost_micro` |
| Account ID | `accountId` | `string` | Optional | `req.tenant_id` (mapped) |
| Identity anchor | `identity_anchor` | `string` | Optional | Not sent (future) |
| Trace ID | `traceId` | `string` | Optional | `req.trace_id` |

**Note on `identity_anchor`**: arrakis accepts this field in snake_case (not camelCase) — it's a legacy field name. loa-finn does not send it in Sprint B. If needed in future, it remains snake_case to match arrakis.

#### Response: `200 OK`

| Field | Wire Name | Type | Description |
|-------|-----------|------|-------------|
| Billing entry | `billing_entry` | `BillingEntry` | loa-hounfour wire format |

**Note**: Verify response field naming against arrakis at implementation time — it may be `billingEntry` (camelCase) rather than `billing_entry` (snake_case). The smoke test schema validation will catch this.

#### Error Responses

| Status | Meaning | loa-finn Action |
|--------|---------|-----------------|
| 401 | Invalid/expired JWT | Log error, DLQ |
| 404 | Reservation not found | Log error, DLQ |
| 409 | Already finalized | Log warning (idempotent, no DLQ) |
| 422 | Validation error (missing/invalid fields) | Log error, DLQ |
| 500+ | Server error | Log error, DLQ, retry once |

**Solution**: Transform the request body at the wire boundary:

```typescript
const body = JSON.stringify({
  reservationId: req.reservation_id,
  actualCostMicro: req.actual_cost_micro,
  accountId: req.tenant_id,  // identity field mapping
  traceId: req.trace_id,
})
```

Internal interfaces (`BillingFinalizeRequest`) remain snake_case to match loa-finn's conventions. The transformation happens at the wire boundary only. Unknown fields MUST NOT be sent — arrakis may reject unknown fields.

**Acceptance Criteria:**
- [ ] Finalize client sends exactly the fields in the wire contract table above (no extra, no missing required)
- [ ] `accountId` mapped from internal `tenant_id` with inline comment
- [ ] `identity_anchor` not sent (documented as future)
- [ ] Internal interfaces remain snake_case (no ripple changes)
- [ ] Unit tests verify exact wire format (JSON.parse the request body and assert field names/types)
- [ ] Response parsing handles both `billing_entry` and `billingEntry` response field names (defensive)
- [ ] 409 (already finalized) treated as success (idempotent), not enqueued to DLQ

### FR-3: Fix URL Path

**Current state** (`billing-finalize-client.ts:32`):
```typescript
billingUrl: `${baseUrl}/api/internal/billing/finalize`
```

**arrakis serves**: `POST /api/internal/finalize` (no `/billing/` segment, no query parameters)

**Solution**: Update the URL construction:
```typescript
billingUrl: `${baseUrl}/api/internal/finalize`
```

The `?format=loh` query parameter from Sprint A's PRD is removed — arrakis does not expect or use it.

**Acceptance Criteria:**
- [ ] Finalize URL matches arrakis's actual route: `/api/internal/finalize`
- [ ] No `?format=loh` query parameter
- [ ] `ARRAKIS_BILLING_URL` env var continues to provide the base URL
- [ ] Unit tests updated with correct URL

### FR-4: Docker Compose E2E Stack

**New file**: `tests/e2e/docker-compose.e2e.yml` in loa-finn repo

**Services** (4 total):

| Service | Internal Port | External Port | Health Check |
|---------|--------------|---------------|--------------|
| `redis-e2e` | 6379 | 6380 | `redis-cli ping` |
| `arrakis-e2e` | 3000 | 3000 | `curl http://localhost:3000/v1/health` |
| `loa-finn-e2e` | 3000 | 3001 | `curl http://localhost:3000/health` |
| `contract-validator` | — | — | depends_on arrakis + loa-finn |

**Port clarification**: loa-finn listens on port 3000 inside its container (matching `deploy/Dockerfile:74` health check). Docker Compose maps this to external port 3001 to avoid collision with arrakis on 3000. Health checks run inside the container and use the internal port (3000).

**Build context**: loa-finn uses `build.dockerfile: deploy/Dockerfile` with `build.context: ../..` (project root).

**Secret wiring**:
```yaml
# Single source of truth for shared secret
x-jwt-secret: &jwt-secret
  BILLING_INTERNAL_JWT_SECRET: ${BILLING_INTERNAL_JWT_SECRET:-e2e-s2s-jwt-secret-for-testing-only-32chr}

services:
  arrakis-e2e:
    environment:
      <<: *jwt-secret
  loa-finn-e2e:
    environment:
      FINN_S2S_JWT_SECRET: ${BILLING_INTERNAL_JWT_SECRET:-e2e-s2s-jwt-secret-for-testing-only-32chr}
      FINN_S2S_JWT_ALG: HS256
      ARRAKIS_BILLING_URL: http://arrakis-e2e:3000
```

Both containers receive the same secret value. arrakis reads `BILLING_INTERNAL_JWT_SECRET`, loa-finn reads `FINN_S2S_JWT_SECRET`. The YAML anchor ensures the value is always identical.

**Acceptance Criteria:**
- [ ] `docker compose -f tests/e2e/docker-compose.e2e.yml up -d` boots all 4 services
- [ ] All services pass health checks within 30 seconds
- [ ] loa-finn service uses `deploy/Dockerfile` build context
- [ ] loa-finn health check uses internal port 3000 (`curl http://localhost:3000/health`)
- [ ] Both arrakis and loa-finn share the same JWT secret value (YAML anchor or env var)
- [ ] Services can communicate over Docker network (`loa-finn-e2e` → `arrakis-e2e:3000`)
- [ ] No JWKS volume mounts (not needed for HS256)

### FR-5: E2E Smoke Test Script with Deterministic Verification

**New file**: `tests/e2e/smoke-test.sh`

**Test sequence**:
1. Wait for all services healthy (poll health endpoints, 30s timeout)
2. Send `POST /api/v1/chat/completions` to loa-finn-e2e:3001 with test payload including a unique `traceId`
3. Verify response 200 from loa-finn
4. **Verify BillingEntry was created**: Query arrakis's internal billing read endpoint (`GET /api/internal/billing/entries?traceId={traceId}`) or query Redis directly for the billing entry keyed by `reservationId`
5. Validate BillingEntry fields: `reservationId` matches, `actualCostMicro` is valid non-negative integer string, `accountId` present
6. Report pass/fail with structured JSON output

**Verification mechanism**: The smoke test MUST NOT rely on log-grepping to verify finalize happened. It MUST use one of:
- **Option A (preferred)**: arrakis internal read endpoint that returns BillingEntry by traceId or reservationId
- **Option B**: Direct Redis query from the contract-validator container to verify the billing entry key exists
- **Option C**: arrakis E2E mode exposes a test-only `/api/internal/test/billing-entries` endpoint

The implementation will determine which option arrakis supports. If none exist, a minimal test endpoint must be added to arrakis's E2E config (documented as a Sprint B dependency).

**Correlation**: The smoke test sets a unique `traceId` (UUID) in the request and verifies the same `traceId` appears in the created BillingEntry. This provides deterministic proof that the specific request produced the specific billing entry.

**Acceptance Criteria:**
- [ ] Smoke test script is executable and self-contained
- [ ] Tests the full reserve → infer → finalize → verify pipeline
- [ ] Verification is deterministic (reads BillingEntry by traceId/reservationId, not log-grep)
- [ ] Exits 0 on success, non-zero on failure
- [ ] Timeout handling (30s service wait, 10s per request, 60s total)
- [ ] Structured JSON output for CI parsing: `{ "tests": [...], "passed": N, "failed": N }`
- [ ] Correlation via unique traceId per test run

### FR-6: CI Integration

**New file**: `.github/workflows/e2e-smoke.yml`

**Trigger**: PR to `main`, push to `main`

**CI workspace layout** (explicit, required for cross-repo compose):
```
$GITHUB_WORKSPACE/
├── loa-finn/          # actions/checkout (default)
└── arrakis/           # actions/checkout (path: arrakis, repo: 0xHoneyJar/arrakis)
```

**Compose reference**: `docker compose -f loa-finn/tests/e2e/docker-compose.e2e.yml` with build contexts relative to the compose file location. The compose file uses `context: ../..` for loa-finn and `context: ../../arrakis` for arrakis (relative to compose file at `loa-finn/tests/e2e/`).

**Steps**:
1. Checkout loa-finn (default path)
2. Checkout arrakis into `./arrakis` (using `actions/checkout` with `repository: 0xHoneyJar/arrakis`, `path: arrakis`)
3. Build Docker images (with Docker layer caching via `docker/build-push-action`)
4. Run E2E compose stack (`docker compose up -d`)
5. Execute smoke test (`./loa-finn/tests/e2e/smoke-test.sh`)
6. On failure: collect logs (`docker compose logs > logs.txt`), upload as artifact
7. Tear down (`docker compose down -v`)

**Acceptance Criteria:**
- [ ] GitHub Actions workflow runs on PR and push to main
- [ ] Checks out both loa-finn and arrakis repos with explicit paths
- [ ] Build contexts reference correct relative paths from compose file
- [ ] Collects and uploads logs as artifacts on failure
- [ ] Passes within 5-minute timeout
- [ ] Does not require external secrets for E2E (uses test-only values hardcoded in compose)
- [ ] Works on clean GitHub Actions runner (no local path assumptions)

---

## 5. Technical & Non-Functional Requirements

### NFR-1: No Breaking Changes to Existing APIs

All mismatch fixes are internal to the finalize client wire format. No gateway routes, WebSocket protocols, or public API changes.

### NFR-2: JWT Algorithm Safety

- The signer MUST set algorithm from config, never from JWT header or untrusted input
- Ambiguous config (both HS256 and ES256 keys without explicit `FINN_S2S_JWT_ALG`) is a startup error
- Negative tests: HS256-configured signer rejects ES256 verification attempt and vice versa
- arrakis billing is HS256-only — documented as constraint

### NFR-3: Test Isolation

E2E tests use test-only JWT secrets and mock inference. No real API keys, no real GPU, no real billing charges. The E2E stack is fully self-contained. All secrets are hardcoded test values in the compose file.

### NFR-4: CI Performance

E2E stack should boot and complete smoke test within 3 minutes. Docker layer caching should be leveraged for repeated runs. Total workflow timeout: 5 minutes.

---

## 6. Environment Variables (New/Changed)

| Variable | Purpose | Default | Required |
|----------|---------|---------|----------|
| `FINN_S2S_JWT_SECRET` | HS256 shared secret for S2S billing auth | — | Yes (production) |
| `FINN_S2S_JWT_ALG` | JWT algorithm (`HS256` or `ES256`) | Auto-detect | Required if both secret + private key are set |
| `FINN_S2S_PRIVATE_KEY` | ES256 private key (existing, now optional if HS256 used) | — | No (if HS256) |
| `ARRAKIS_BILLING_URL` | Base URL for arrakis billing API (existing) | — | Yes (production) |

**Algorithm selection (strict, non-ambiguous):**
1. If `FINN_S2S_JWT_ALG` is set → use that algorithm, validate corresponding key exists
2. If only `FINN_S2S_JWT_SECRET` is set → HS256
3. If only `FINN_S2S_PRIVATE_KEY` is set → ES256
4. If both set without `FINN_S2S_JWT_ALG` → **Startup error** (ambiguous)
5. If neither set → **Startup error** (no signing key)

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| arrakis E2E scaffold is stale or broken | Medium | Medium | Verify against arrakis `main` before building; fall back to fresh compose if needed |
| Additional field mismatches beyond the 5 discovered | Low | Medium | Smoke test will catch them; iterate within sprint |
| Docker build failures (Python deps, node-gyp) | Low | Low | Use same base image as deploy/Dockerfile; cache layers |
| arrakis response field naming differs from expected | Medium | High | Smoke test schema validation catches this; defensive parsing handles both cases |
| No arrakis read endpoint for BillingEntry verification | Medium | High | Fall back to Redis query or add minimal E2E test endpoint; documented as potential Sprint B dependency |
| Cross-repo checkout breaks in CI (private repo access) | Medium | Medium | Ensure GitHub Actions token has access to both repos; use PAT or deploy key if needed |
| CI timeout on slow runners | Low | Low | 5-minute timeout; Docker layer caching |

---

## 8. Success Definition

After this sprint:

```
docker compose -f tests/e2e/docker-compose.e2e.yml up -d
./tests/e2e/smoke-test.sh

✓ All services healthy (redis, arrakis, loa-finn)
✓ POST /api/v1/chat/completions → 200 (traceId: abc-123)
✓ Finalize called → POST /api/internal/finalize → 200
✓ BillingEntry retrieved by traceId abc-123
✓ BillingEntry schema valid (reservationId, actualCostMicro, accountId)
✓ Reserve → Infer → Finalize → Verify pipeline PROVEN

SMOKE TEST PASSED — billing wire verified against real containers
```

This unblocks **Shadow Deploy** (Sprint C) — the next step on the P0 critical path to first revenue.

---

## 9. Dependency on Sprint A

This sprint directly modifies code delivered in Sprint A (cycle-021, PR #68):

| File | Sprint A Delivered | Sprint B Modifies |
|------|-------------------|-------------------|
| `src/hounfour/billing-finalize-client.ts` | 270 lines, DLQ, never-throw | Fix field names, URL path, identity field, wire contract |
| `src/hounfour/s2s-jwt.ts` | 102 lines, ES256 signer | Add HS256 mode, algorithm selection, ambiguous config guard |
| `src/index.ts` | Finalize client init | Update env var handling for HS256, algorithm selection |

Sprint A's unit tests (57 tests) will be updated to reflect the corrected wire format. The mocked arrakis responses in tests will match arrakis's actual contract.
