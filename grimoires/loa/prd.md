# PRD: Launch Readiness — Product Integration & Live Testing

**Status:** Approved
**Author:** Jani (via Loa)
**Date:** 2026-02-25
**Cycle:** cycle-035
**References:** [Issue #66](https://github.com/0xHoneyJar/loa-finn/issues/66) · [PR #103](https://github.com/0xHoneyJar/loa-finn/pull/103) · [PR #104](https://github.com/0xHoneyJar/loa-finn/pull/104) · [Issue #84](https://github.com/0xHoneyJar/loa-finn/issues/84) · [Issue #85](https://github.com/0xHoneyJar/loa-finn/issues/85)

> Sources: Issue #66 command deck (106 comments), reality/routes.md, reality/interfaces.md, reality/auth.md, reality/env-vars.md, context/hounfour-rfc.md, PR #103 (merged), PR #104 (merged), issues #84-#95

---

## 1. Problem Statement

loa-finn has completed its infrastructure-to-protocol transition. Across 34 development cycles and 131 global sprints, the system has accumulated:

- **Multi-model inference engine** with pool routing, ensemble orchestration, and budget enforcement (Hounfour v7.11.0 — adopted)
- **Product layer** with conversation persistence, agent homepages, chat UI, and WebSocket streaming (PR #103 — merged)
- **Protocol convergence** with branded TaskType, hash chains, native enforcement, and Goodhart protection (PR #104 — merged)
- **Economic boundary** with conservation invariants, credit lots, and reconciliation sweeps (loa-freeside)
- **Knowledge governance** with constitutional architecture and 1,090 tests (loa-dixie v2.0.0)

**The problem is no longer "can we build it?" — it is "does it compose?"**

The individual subsystems are unit-tested and bridge-reviewed. But no E2E test has ever exercised the full flow: `user request → JWT validation → model routing → inference → billing debit → response delivery`. The infrastructure promises are proven in isolation but unproven in composition.

Until the system can be started with `docker compose up` and a test client can complete an authenticated inference request with billing, the product is infrastructure — not a product.

> Source: Issue #66 body ("What's the gap between infrastructure ready and users can use it?"), Issue #84 description, Issue #66 Command Center Feb 24

---

## 2. Vision & Goals

### Vision

Close the gap between infrastructure and product by proving the full economic inference loop works end-to-end in a real deployment environment, then exposing it through a developer-consumable API surface.

### Goals

| ID | Goal | Success Metric | Priority |
|----|------|---------------|----------|
| G1 | **Prove composition** | E2E test passes: JWT auth → inference → billing debit → response | P0 |
| G2 | **Enable deployment** | `docker compose up` starts finn + redis + freeside, health checks green | P0 |
| G3 | **Activate feature flags** | All 6 PR #104 flags promotable in staging without regression | P0 |
| G4 | **Enable revenue** | x402 pay-per-request returns inference for valid USDC payment | P1 |
| G5 | **Enable developer adoption** | OpenAPI spec served at `/openapi.json`, TypeScript SDK installable | P1 |
| G6 | **Enable cross-service contracts** | Dixie can consume finn API with typed client, multi-NFT resolved | P2 |

### Non-Goals (Explicit)

- Production deployment to Fly.io (next cycle)
- Arrakis integration or Discord/Telegram bot work
- NFT personality pipeline (BEAUVOIR.md customization)
- Community governance UI
- Oracle metacognition (#95 — depends on Dixie endpoint not yet available)

> Source: Issue #66 critical path (Feb 25 command deck), issues #84/#85/#91/#93

---

## 3. User & Stakeholder Context

### Primary Personas

| Persona | Description | Needs from This Cycle |
|---------|-------------|----------------------|
| **Internal QA** | The team validating the full loop before external users touch it | E2E harness that exercises real JWT + real inference + real billing |
| **Developer integrator** | Future SDK consumer building on the finn API | OpenAPI spec, TypeScript SDK, auth documentation |
| **x402 payer** | Permissionless user paying per-request with USDC | 402 response with pricing, payment verification, inference delivery |

### Secondary Personas

| Persona | Description | Needs (Deferred) |
|---------|-------------|-------------------|
| **NFT holder** | Community member with personality-routed agent | Agent homepage + chat (PR #103, already merged) |
| **Dixie consumer** | Knowledge governance service calling finn APIs | Typed client, multi-NFT resolution (#93) |

> Source: Issue #66 Section 3 (personas), Issue #85 (x402 user), Issue #91 (developer)

---

## 4. Functional Requirements

### FR-1: Dockerized Deployment (Issue #84)

**What**: Multi-stage Dockerfile + docker-compose for local and CI environments.

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-1.1 | Multi-stage Dockerfile | `docker build .` produces working image under 500MB. Node.js 22 LTS, non-root user, health check instruction. |
| FR-1.2 | Docker Compose | `docker compose up` starts loa-finn + Redis + loa-freeside (billing sidecar). Health endpoints for both services respond within 30s. Freeside connects to the same Redis instance for shared budget state. |
| FR-1.3 | Environment configuration | All env vars from `reality/env-vars.md` configurable via `.env` file or compose environment block. Secrets never baked into image. |
| FR-1.4 | Graceful shutdown | `docker compose down` completes within 15s. WAL flushes, connections drain. |

> Source: Issue #84 acceptance criteria, reality/env-vars.md

### FR-2: Cross-System E2E Test Harness (Issue #84)

**What**: Integration test exercising the full inference loop with real auth, not mocks.

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-2.1 | ES256 JWT exchange | Test generates ES256 keypair, starts a JWKS sidecar container in compose that serves the public key at `/.well-known/jwks.json`. Finn is configured with `FINN_JWKS_URL` pointing to this sidecar. Test signs JWT with valid claims (`tenant_id`, `tier`, `req_hash`), finn validates via the sidecar's JWKS endpoint. No mocked auth — real JWKS discovery and ES256 validation. |
| FR-2.2 | Inference request | Authenticated POST to `/api/v1/chat` returns streamed inference response via **WebSocket** (the existing transport — see `src/gateway/ws.ts`). The E2E test connects to `/ws/:sessionId` with bearer token auth, sends a `prompt` message, and asserts receipt of `text_delta` + `turn_end` messages. SSE is not in scope for this cycle. |
| FR-2.3 | Budget debit flow | Inference request triggers cost recording in finn's budget engine (`BudgetSnapshot.spent_usd` increases) AND a corresponding debit event in freeside's ledger. E2E test asserts both: finn-side cost tracking and freeside-side lot entry creation. |
| FR-2.4 | Conservation check | If budget limit reached, subsequent requests return 429 with `evaluation_gap` diagnostic. |
| FR-2.5 | CI integration | E2E test runnable in GitHub Actions with `docker compose up -d` setup step. Fails CI if any assertion fails. |

> Source: Issue #84 body, reality/auth.md (JWT validation order), reality/interfaces.md (BudgetSnapshot)

### FR-3: Feature Flag Promotion Readiness (PR #104 Activation)

**What**: Validate the 6 feature flags from PR #104 are safe to enable, using the Docker Compose environment as "staging."

**Staging definition**: For this cycle, "staging" means the Docker Compose environment from FR-1.2 with all services running. Flags are toggled via environment variables in the compose `.env` file. Actual cloud staging (Fly.io) is deferred to the production deployment cycle.

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-3.1 | Flag inventory | Document all 6 flags with expected behavior when ON vs OFF, including env var names and default values. |
| FR-3.2 | Flag-by-flag validation | Each flag can be turned ON independently in compose `.env` without regression. Full test suite passes with each flag individually enabled. |
| FR-3.3 | All-flags-on validation | Full test suite passes with all 6 flags enabled simultaneously in compose. |
| FR-3.4 | Rollback verification | Each flag can be turned OFF after enablement without side effects. |
| FR-3.5 | Promotion runbook | Document the recommended promotion order and monitoring checkpoints for future cloud staging deployment. |

> Source: PR #104 summary ("6 new feature flags, all defaulting to OFF")

### FR-4: x402 Pay-Per-Request Middleware (Issue #85)

**What**: HTTP 402 payment flow for permissionless inference access.

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-4.1 | 402 pricing response | Request to `/api/v1/pay/chat` (dedicated x402 endpoint, separate from JWT-gated `/api/v1/chat`) without `X-Payment` header returns HTTP 402 with `X-Price`, `X-Currency`, `X-Payment-Address` headers. |
| FR-4.2 | Payment verification | Valid `X-Payment` header with EIP-3009 `transferWithAuthorization` signature is verified. **E2E/compose**: off-chain signature verification against a mock payment provider (no on-chain call). **Future staging**: on-chain verification against Base testnet. |
| FR-4.3 | Nonce replay protection | Replayed payment nonces are rejected with 409. Nonce is recorded in DB only after payment signature is verified and inference request is accepted (atomicity = DB transaction, not on-chain atomicity). |
| FR-4.4 | Conservation guard | Payment amount verified >= estimated cost before model invocation. Uses `MicroUSDC` branded type from loa-hounfour. Quote is the maximum possible cost (conservative). |
| FR-4.5 | Credit-back | If actual cost < quoted price, difference is credited to an off-chain credit balance (not an on-chain refund). `actualMicro <= quotedMicro` enforced as invariant. On-chain refunds are out of scope for this cycle. |

**Auth/payment precedence for `/api/v1/*` routes:**

| Endpoint | Auth Mode | Behavior |
|----------|-----------|----------|
| `/api/v1/chat` | JWT only | 401 if missing/invalid JWT. No x402 fallback. |
| `/api/v1/pay/chat` | x402 only | 402 if missing payment. No JWT required. Maps to synthetic tenant `x402-anon` with `free` tier. |

> Source: Issue #85 acceptance criteria, PR #104 Bridgebuilder deep review (conservative-quote-settle pattern)

### FR-5: OpenAPI Specification + TypeScript SDK (Issue #91)

**What**: Developer-consumable API surface generated from existing Hono routes + Zod schemas.

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-5.1 | OpenAPI 3.1 spec | `GET /openapi.json` returns valid spec. All `/api/v1/*` REST endpoints documented with auth requirements, request/response schemas, and pool descriptions. WebSocket `/ws/:sessionId` is documented as a separate section (OpenAPI 3.1 `x-websocket` extension or prose description) since OpenAPI cannot natively describe WebSocket protocols. |
| FR-5.2 | TypeScript SDK | `@0xhoneyjar/loa-finn-sdk` installable via npm. Supports JWT auth, REST inference requests, and **WebSocket streaming** (connects to `/ws/:sessionId`, handles `text_delta`/`turn_end` message types). |
| FR-5.3 | Developer docs | Auth flow, pool model, billing, and code examples documented. Served at `/docs` or as static site. |

> Source: Issue #91 body, reality/routes.md (existing route inventory)

### FR-6: Dixie API Contract Alignment (Issue #93)

**What**: Resolve cross-service contract gaps between finn and dixie.

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-6.1 | Multi-NFT resolution | `/api/identity/wallet/:wallet/nfts` (plural) endpoint returns all NFTs for a wallet, not just the first. |
| FR-6.2 | Contract documentation | All 10+ dixie-consumed endpoints documented with request/response types aligned to OpenAPI spec (#91). |
| FR-6.3 | Corpus version header | `x-corpus-version` header added to all `/api/knowledge/*` responses per Issue #94. |

> Source: Issue #93 (single-NFT limitation), Issue #94 (corpus version)

---

## 5. Technical & Non-Functional Requirements

### NFR-1: Performance

| Metric | Target | Rationale |
|--------|--------|-----------|
| Docker build time | < 3 minutes | CI pipeline should not be bottlenecked by build |
| Container startup to healthy | < 30 seconds | E2E tests need fast setup/teardown |
| E2E test suite runtime | < 5 minutes | Must fit in CI time budget |
| x402 payment verification (off-chain) | < 500ms | Signature verification only; on-chain confirmation is async and out of scope |

### NFR-2: Security

| Requirement | Implementation |
|-------------|---------------|
| No secrets in Docker image | Multi-stage build, runtime env vars only |
| ES256 JWT validation | Real key validation in E2E, no mock bypass |
| x402 nonce atomicity | Nonce recorded in DB only after signature verified and request accepted (DB transaction, not on-chain atomicity) |
| CORS restricted | Only configured origins in production |
| Request hash verification | SHA-256 body hash in JWT `req_hash` claim |

> Source: reality/auth.md (JWT validation, CSRF, response redaction)

### NFR-3: Observability

| Requirement | Implementation |
|-------------|---------------|
| Health endpoint | `GET /health` returns subsystem status (already exists) |
| Prometheus metrics | PR #103 added Grafana dashboards + alert rules |
| E2E test reporting | JUnit XML output for CI integration |

### NFR-4: Compatibility

| Constraint | Value |
|-----------|-------|
| Node.js | 22 LTS (ESM-only) |
| loa-hounfour | >= 7.11.0 |
| Docker | 24+ with BuildKit |
| Redis | 7.x |

> Source: reality/index.md (Node.js 22+, Hono v4), reality/dependencies.md

---

## 6. Scope & Prioritization

### MVP (P0) — Must Ship This Cycle

| Track | Issues | What | Why |
|-------|--------|------|-----|
| **Dockerization** | #84 | Dockerfile + compose | Can't test composition without running it |
| **E2E harness** | #84 | Real JWT + inference + billing test | Proves the loop works |
| **Flag promotion** | PR #104 | Validate 6 flags in staging | Activates protocol convergence |

### P1 — Should Ship This Cycle

| Track | Issues | What | Why |
|-------|--------|------|-----|
| **x402** | #85 | Pay-per-request middleware | Revenue path |
| **OpenAPI** | #91 | Spec + SDK | Developer adoption surface |

### P2 — If Time Permits

| Track | Issues | What | Why |
|-------|--------|------|-----|
| **Dixie contracts** | #93, #94 | Multi-NFT + corpus version | Cross-service parity |

### Out of Scope

| Item | Why Deferred |
|------|-------------|
| Production Fly.io deployment | Needs E2E proof first (next cycle) |
| Arrakis adoption of v7.11.0 | Separate repo, separate cycle |
| Oracle metacognition (#95) | Depends on Dixie endpoint not yet available |
| NFT personality pipeline | Product layer (PR #103) already merged, personality customization is post-launch |
| Community governance UI | Ostrom principles implicit in architecture; explicit governance is future work |

> Source: Issue #66 command deck critical path (Feb 25), Bridgebuilder deep review Part IV

---

## 7. Risks & Dependencies

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| E2E test reveals integration bugs between JWT auth and hounfour router | High | Medium | Budget extra time for integration debugging; this is the *purpose* of the E2E harness |
| x402 on-chain verification complexity | Medium | High | Use mock payment provider in E2E; real on-chain in staging only |
| Feature flag interactions (6 flags, 64 combinations) | Medium | Medium | Test flags individually first, then all-on; don't test every combination |
| Docker image size bloats past 500MB | Low | Low | Multi-stage build, `.dockerignore`, no dev deps in production |

### Dependencies

| Dependency | Status | Blocking |
|-----------|--------|----------|
| loa-hounfour v7.11.0 | Released ✅ | — |
| loa-finn PR #103 (product layer) | Merged ✅ | — |
| loa-finn PR #104 (protocol convergence) | Merged ✅ | — |
| loa-freeside PR #96 (v7.11.0 adoption) | Merged ✅ | — |
| loa-dixie PR #9 (v7.11.0 adoption) | Merged ✅ | — |
| Redis 7.x | Available via Docker | FR-1.2 |
| `@hono/zod-openapi` | npm package | FR-5.1 |
| EIP-3009 reference implementation | Public | FR-4.2 |

> Source: Issue #66 ecosystem status map (Feb 25 update)

---

## 8. Success Criteria

This cycle is complete when:

1. `docker compose up` starts loa-finn + Redis + loa-freeside, all health endpoints return 200 within 30s
2. E2E test completes: generate ES256 keypair → sign JWT → POST `/api/v1/chat` → receive streamed response → verify budget debit
3. All 6 feature flags from PR #104 are validated individually and collectively
4. x402 middleware returns 402 with pricing headers for unauthenticated requests, and delivers inference for valid payment
5. `GET /openapi.json` returns valid OpenAPI 3.1 spec covering all `/api/v1/*` endpoints
6. E2E test runs in GitHub Actions CI without manual intervention

**The atomic success metric**: A single command (`docker compose up && npm run test:e2e`) that proves the full economic inference loop works.

> Source: Issue #66 ("What bridges infrastructure to product?"), Issue #84, PR #104 Bridgebuilder meditation Part V

---

## Appendix A: Ecosystem State at Cycle Start

```
loa-hounfour v7.11.0  ── RELEASED ✅
loa-finn main         ── PR #103 + #104 merged ✅
loa-freeside main     ── PR #96 merged ✅
loa-dixie v2.0.0      ── PR #9 merged ✅

Global sprints: 131+ across 4 repos
Total tests: 9,874+
Protocol version: v7.11.0 (4 of 4 repos converged)
```

## Appendix B: Issue Cross-Reference

| Issue | Title | PRD Section |
|-------|-------|-------------|
| #84 | Dockerize + E2E Harness | FR-1, FR-2 |
| #85 | x402 Pay-Per-Request | FR-4 |
| #91 | OpenAPI + SDK | FR-5 |
| #93 | Dixie API Contracts | FR-6 |
| #94 | Corpus Version Header | FR-6.3 |
| #95 | Oracle Metacognition | Out of Scope |
