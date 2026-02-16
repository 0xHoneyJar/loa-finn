# Sprint Plan: Sprint B — E2E Smoke Test: Billing Wire Verification

> **Cycle**: 022
> **PRD**: `grimoires/loa/prd.md` (v2.0.0, GPT-5.2 APPROVED)
> **SDD**: `grimoires/loa/sdd.md` (v2.0.0, GPT-5.2 APPROVED)
> **Issue**: [#69](https://github.com/0xHoneyJar/loa-finn/issues/69)
> **Branch**: `feature/hounfour-phase5-implementation` (continuing from Sprint A)

---

## Sprint 1: Integration Fix + E2E Verification

**Goal**: Fix all 5 integration mismatches and prove the billing wire works via E2E smoke test.

**Tasks**: 7 tasks, single sprint (all work is tightly coupled — mismatches must be fixed before E2E can pass).

---

### T1: S2S JWT Signer — Add HS256 Support

**SDD Reference**: §3.1
**Priority**: P0 (blocks T2, T3, T5)
**Estimated Lines**: ~45

**Description**: Extend `S2SJwtSigner` in `src/hounfour/s2s-jwt.ts` to support HS256 signing via a discriminated union config type. Add `Uint8Array`-based symmetric key support alongside existing ES256 asymmetric key.

**Implementation**:
- Replace `S2SConfig` interface with discriminated union: `S2SConfigES256 | S2SConfigHS256`
- Add `private signingKey: Uint8Array | null` field
- Branch `init()` on `config.alg`: ES256 → existing PKCS8 import, HS256 → `TextEncoder.encode(secret)`
- Update `signJWT()`: use `config.alg` in `setProtectedHeader()`, omit `kid` for HS256
- Change default TTL from 60s to 300s
- `signJWS()`/`signPayload()`: throw for HS256 (not applicable for billing)
- `getJWKS()`: return `{ keys: [] }` for HS256
- `isReady`: check `signingKey` for HS256, `privateKey` for ES256

**Acceptance Criteria**:
- [ ] `S2SConfig` is a discriminated union with `alg` field
- [ ] HS256 signing produces valid JWT verifiable with shared secret
- [ ] ES256 signing unchanged (existing tests pass)
- [ ] `kid` omitted from HS256 JWT headers
- [ ] Default TTL is 300s
- [ ] `signJWS()` throws for HS256 config
- [ ] `getJWKS()` returns empty keys array for HS256
- [ ] Algorithm hardcoded from config, never from untrusted input

**Tests** (in `s2s-jwt.test.ts`):
- [ ] HS256 init + signJWT + verify round-trip
- [ ] ES256 init + signJWT (existing, still passes)
- [ ] Algorithm from config, not header
- [ ] HS256 token has no `kid` header
- [ ] signJWS throws for HS256
- [ ] Default TTL is 300s

---

### T2: Billing Finalize Client — Wire Contract Fix

**SDD Reference**: §3.2
**Priority**: P0 (blocks T5)
**Depends On**: T1 (signer must support HS256)
**Estimated Lines**: ~10

**Description**: Fix the wire contract in `src/hounfour/billing-finalize-client.ts` — URL path, field naming, identity mapping, response handling.

**Implementation**:
- URL: Change `billingUrl` semantics to base URL; append `/api/internal/finalize` in `sendFinalize()`
- Request body: Transform snake_case → camelCase at wire boundary (`reservationId`, `actualCostMicro`, `accountId`, `traceId`)
- Identity: Map `req.tenant_id` → `accountId` in wire body
- Response: Defensive parsing for both `billing_entry` and `billingEntry` response fields
- Remove `?format=loh` query parameter (arrakis doesn't use it)

**Acceptance Criteria**:
- [ ] `sendFinalize()` calls `${billingUrl}/api/internal/finalize` (no `/billing/` segment)
- [ ] Request body uses camelCase: `reservationId`, `actualCostMicro`, `accountId`, `traceId`
- [ ] No extra fields sent beyond the wire contract
- [ ] `tenant_id` maps to `accountId` with inline comment
- [ ] Response handles both `billing_entry` and `billingEntry`
- [ ] No `?format=loh` query parameter
- [ ] Internal interfaces (`FinalizeRequest`, `DLQEntry`) unchanged (still snake_case)

**Tests** (in `billing-finalize-client.test.ts`):
- [ ] Wire body is camelCase (JSON.parse captured request body)
- [ ] URL path is `/api/internal/finalize`
- [ ] `accountId` present in wire body (mapped from tenant_id)
- [ ] No `?format=loh` in URL
- [ ] Response parsing handles both field name variants
- [ ] Existing tests updated for correct wire format

---

### T3: Index.ts — Algorithm Selection & Init Update

**SDD Reference**: §3.3
**Priority**: P0 (blocks T5)
**Depends On**: T1 (new S2SConfig type)
**Estimated Lines**: ~30

**Description**: Update the S2S init block in `src/index.ts` (lines 256-286) to support dual-mode algorithm selection with ambiguity guard.

**Implementation**:
- Read `FINN_S2S_JWT_SECRET`, `FINN_S2S_PRIVATE_KEY`, `FINN_S2S_JWT_ALG` from env
- Explicit `FINN_S2S_JWT_ALG` → validate matching key material exists
- Both keys set without explicit alg → startup error
- Single key set → auto-detect algorithm
- Neither set → warn and skip (existing behavior)
- Construct `S2SConfigHS256` or `S2SConfigES256` accordingly
- Pass base URL (not full endpoint) to `BillingFinalizeClient`

**Acceptance Criteria**:
- [ ] `FINN_S2S_JWT_ALG=HS256` + `FINN_S2S_JWT_SECRET` → HS256 config
- [ ] `FINN_S2S_JWT_ALG=ES256` + `FINN_S2S_PRIVATE_KEY` → ES256 config
- [ ] `FINN_S2S_JWT_ALG=HS256` without `FINN_S2S_JWT_SECRET` → startup error
- [ ] Both keys set without `FINN_S2S_JWT_ALG` → startup error
- [ ] Only `FINN_S2S_JWT_SECRET` → auto-detect HS256
- [ ] Only `FINN_S2S_PRIVATE_KEY` → auto-detect ES256 (backward compatible)
- [ ] `ARRAKIS_BILLING_URL` passed as base URL to client

**Tests**:
- [ ] Algorithm selection logic tested via unit tests or integration test

---

### T4: Response Header for E2E Verification

**SDD Reference**: §3.5.2
**Priority**: P0 (blocks T6)
**Depends On**: T2 (finalize client must return result)
**Estimated Lines**: ~10

**Description**: Add `x-billing-finalize-status` and `x-billing-trace-id` response headers to the inference response in the router. These headers provide deterministic E2E verification without introspecting arrakis internals.

**Implementation**:
- In `src/hounfour/router.ts`, after `billingFinalizeClient.finalize()`:
  - Set `res.setHeader("x-billing-finalize-status", result.ok ? result.status : "dlq")`
  - Set `res.setHeader("x-billing-trace-id", req.trace_id)`
- Only set headers when finalize was attempted (reservation_id present)
- The `FinalizeResult.status` is a strict enum: `"finalized" | "idempotent"` (ok=true) or `"dlq"` (ok=false). No other values are possible — the type system enforces this.

**Acceptance Criteria**:
- [ ] `x-billing-finalize-status` header set on inference responses when finalize runs
- [ ] Value is exactly one of: `finalized`, `idempotent`, or `dlq` (strict enum from `FinalizeResult`)
- [ ] `x-billing-trace-id` echoes the trace_id
- [ ] Headers not set when finalize is skipped (no reservation_id)
- [ ] Unit test covers all 3 status values (`finalized`, `idempotent`, `dlq`)
- [ ] Integration test: router with reservation_id present → headers set; reservation_id absent → headers not set

**Tests**:
- [ ] Unit test: response headers set correctly for `finalized` result
- [ ] Unit test: response headers set correctly for `idempotent` result (409 from arrakis)
- [ ] Unit test: response headers set correctly for `dlq` result (failure/timeout)
- [ ] Unit test: headers NOT set when reservation_id absent

---

### T5: Docker Compose E2E Stack

**SDD Reference**: §3.4
**Priority**: P0 (blocks T6)
**Depends On**: T1, T2, T3 (code fixes must work before E2E)
**Estimated Lines**: ~55

**Description**: Create `tests/e2e/docker-compose.e2e.yml` with 3 services: redis-e2e, arrakis-e2e, loa-finn-e2e.

**Implementation**:
- `redis-e2e`: `redis:7-alpine`, port 6380→6379, healthcheck `redis-cli ping`
- `arrakis-e2e`: build from `../../arrakis`, port 3000→3000, `BILLING_INTERNAL_JWT_SECRET`
- `loa-finn-e2e`: build from `../..` via `deploy/Dockerfile`, port 3001→3000, `FINN_S2S_JWT_SECRET`, `FINN_S2S_JWT_ALG=HS256`, `ARRAKIS_BILLING_URL=http://arrakis-e2e:3000`, `CHEVAL_MODE=mock`
- Health checks per container:
  - `redis-e2e`: `redis-cli ping` (available in redis image)
  - `loa-finn-e2e`: `node -e "fetch('http://localhost:3000/health')..."` (Node 22 built-in fetch, guaranteed in our Dockerfile)
  - `arrakis-e2e`: `node -e "fetch('http://localhost:3000/v1/health')..."` (Node-based image, verify node exists in arrakis Dockerfile before implementing)
  - **Fallback**: If arrakis image lacks Node in PATH, use `wget -qO- http://localhost:3000/v1/health || exit 1` or remove container healthcheck and rely on host-side readiness polling in T6
- `depends_on` with `condition: service_healthy` (only for services with valid healthchecks)

**Build context path validation**: The compose file at `tests/e2e/docker-compose.e2e.yml` uses relative paths:
- `context: ../..` → loa-finn project root
- `context: ../../arrakis` → arrakis sibling directory
- **CI layout**: loa-finn at `$GITHUB_WORKSPACE/`, arrakis at `$GITHUB_WORKSPACE/arrakis/`
- **Local dev**: arrakis must be cloned as a sibling (or symlinked) at `../arrakis` relative to loa-finn root

**Acceptance Criteria**:
- [ ] `docker compose -f tests/e2e/docker-compose.e2e.yml config` validates without errors (path resolution check)
- [ ] `docker compose -f tests/e2e/docker-compose.e2e.yml up -d --build` starts all 3 services
- [ ] All services pass health checks within 30 seconds
- [ ] loa-finn uses `deploy/Dockerfile` build context
- [ ] Both services share same JWT secret value
- [ ] loa-finn can reach arrakis at `http://arrakis-e2e:3000`
- [ ] `CHEVAL_MODE=mock` enables mock inference (no GPU)
- [ ] Build contexts resolve correctly in both CI and local dev layouts
- [ ] Each container's healthcheck uses a binary guaranteed to exist in that image

---

### T6: E2E Smoke Test Script

**SDD Reference**: §3.5
**Priority**: P0
**Depends On**: T4, T5 (response headers + compose stack)
**Estimated Lines**: ~80

**Description**: Create `tests/e2e/smoke-test.sh` — executable smoke test that runs on the host and verifies the full billing wire via response headers.

**Implementation**:
- Configure URLs: `FINN_URL=http://localhost:3001`, `ARRAKIS_URL=http://localhost:3000`
- Generate unique `TRACE_ID` per run
- Step 1: Poll health endpoints (30s timeout)
- Step 2: `POST /api/v1/chat/completions` to loa-finn with `x-trace-id` header and `x-reservation-id` header (test reservation ID to ensure finalize is triggered — in E2E, arrakis billing guard would normally set this, but for the smoke test we set it directly to guarantee the finalize path runs)
- Step 3: Assert `x-billing-finalize-status` response header is `finalized` or `idempotent` (both indicate arrakis accepted the request). `dlq` or missing header = FAIL.
- Step 4: Assert `x-billing-trace-id` matches sent traceId
- Step 5: Optional arrakis log check (non-blocking)
- Report: JSON output `{ "tests": [...], "passed": N, "failed": N }`

**reservation_id propagation in E2E**: The smoke test explicitly sets `x-reservation-id: e2e-res-{TRACE_ID}` on the inference request. loa-finn's gateway extracts this header and passes it to the router, which triggers the finalize path. This simulates arrakis's billing guard behavior (which sets `x-reservation-id` before forwarding to loa-finn) without requiring the full reserve flow in E2E.

**Acceptance Criteria**:
- [ ] Script is executable (`chmod +x`)
- [ ] Uses `localhost` with mapped ports (runs on host, not in container)
- [ ] Unique traceId and reservationId per run (no test pollution)
- [ ] Request includes `x-reservation-id` header (ensures finalize path runs)
- [ ] Primary verification: `x-billing-finalize-status` is `finalized` or `idempotent`
- [ ] Correlation: `x-billing-trace-id` matches sent traceId
- [ ] Clear failure message if finalize was skipped (header missing) vs failed (header = `dlq`)
- [ ] Exits 0 on success, non-zero on failure
- [ ] 30s health check timeout, 10s per request, 60s total
- [ ] Structured JSON output for CI parsing
- [ ] `curl` only dependency (available on CI runners)

---

### T7: CI Workflow

**SDD Reference**: §3.6
**Priority**: P1
**Depends On**: T5, T6 (compose + smoke test must exist)
**Estimated Lines**: ~50

**Description**: Create `.github/workflows/e2e-smoke.yml` — GitHub Actions workflow that runs the E2E smoke test on every PR and push to main.

**Implementation**:
- Trigger: `pull_request` and `push` to `main`
- Checkout loa-finn (default) + arrakis (`path: arrakis`, `token: ARRAKIS_CHECKOUT_TOKEN`)
- **Secret guard**: Before `docker compose up`, check `ARRAKIS_CHECKOUT_TOKEN` is set. If missing, fail fast with clear error: `"ARRAKIS_CHECKOUT_TOKEN secret not configured. See repo Settings → Secrets. Required for cross-repo arrakis checkout."`
- `docker compose -f tests/e2e/docker-compose.e2e.yml up -d --build`
- Wait for services healthy (explicit curl loop as safety net)
- Run `./tests/e2e/smoke-test.sh`
- On failure: collect logs, upload as artifact
- Always: tear down with `docker compose down -v`
- Timeout: 5 minutes

**Secret dependency**: `ARRAKIS_CHECKOUT_TOKEN` is required (arrakis is a private repo). The workflow uses conditional logic to handle two cases:
- **Same-repo PRs / push to main**: `ARRAKIS_CHECKOUT_TOKEN` must be available. Pre-flight step checks token and fails fast with actionable error: `"ARRAKIS_CHECKOUT_TOKEN secret not configured. See repo Settings → Secrets."` No silent skip — E2E is meaningless without the real arrakis image.
- **Forked PRs**: `github.event.pull_request.head.repo.fork == true` — E2E job is skipped entirely via `if:` condition on the job. Fork PRs cannot access repo secrets, so this avoids false failures.

**Implementation detail**: Use `if: github.event_name == 'push' || github.event.pull_request.head.repo.fork != true` on the E2E job to gate fork PRs. Within the job, the pre-flight step validates the token is non-empty before proceeding.

**Acceptance Criteria**:
- [ ] Workflow triggers on PR to main and push to main
- [ ] Checks out both repos with correct paths
- [ ] Build contexts resolve correctly (loa-finn root + arrakis sibling)
- [ ] Logs uploaded as artifact on failure
- [ ] `docker compose down -v` runs in `always` step
- [ ] 5-minute job timeout
- [ ] No production secrets required (test-only values in compose)
- [ ] Same-repo PRs: missing `ARRAKIS_CHECKOUT_TOKEN` → fast fail with actionable error message
- [ ] Forked PRs: E2E job skipped via `if:` condition (not failed)

---

## Task Dependency Graph

```
T1 (JWT HS256) ──┬──→ T2 (Wire Fix) ──→ T4 (Response Headers) ──┐
                 │                                                │
                 └──→ T3 (Index Init) ──────────────────────────→ T5 (Compose) ──→ T6 (Smoke Test) ──→ T7 (CI)
```

**Critical path**: T1 → T2 → T4 → T5 → T6 → T7

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| arrakis Docker image fails to build | Verify arrakis Dockerfile exists on `main` before starting T5 |
| Mock inference mode doesn't trigger finalize | Verify router path in `CHEVAL_MODE=mock` still calls finalize |
| Cross-repo CI checkout fails | `ARRAKIS_CHECKOUT_TOKEN` secret must be configured in repo settings |
| Response headers stripped by gateway | Verify gateway doesn't strip `x-billing-*` headers |

---

## Success Criteria

Sprint complete when:
1. All 7 tasks pass acceptance criteria
2. `docker compose up` + `smoke-test.sh` exits 0 locally
3. CI workflow passes on a test PR
4. All existing unit tests pass (57 from Sprint A, updated)
5. ~16 new tests pass (12 unit + 4 E2E assertions)
