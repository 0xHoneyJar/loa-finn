# PRD: Production Activation & Loop Go-Live — Deploy, Wire, Graduate, Verify

> **Version**: 1.1.0
> **Date**: 2026-02-26
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-035
> **Predecessor**: cycle-034 "Loop Closure & Launch Infrastructure" (sprints 138-143, all completed, PR #108)
> **Command Center**: [Issue #66 Round 10](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3959406797), [Round 12](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3963353605)
> **Related Issues**: [#84 Dockerize + E2E](https://github.com/0xHoneyJar/loa-finn/issues/84), [#85 x402 Payments](https://github.com/0xHoneyJar/loa-finn/issues/85), [#80 Conway Automaton](https://github.com/0xHoneyJar/loa-finn/issues/80)

---

## 0. Framing — Why This Matters Now

Cycle-034 built the complete Goodhart-protected autopoietic loop: temporal decay, epsilon-greedy exploration, external calibration, mechanism interaction rules, kill switch, reputation query bridge, x402 settlement, tamper-evident audit trail, and AWS deployment pipeline. **None of it is running in production.** The loop exists in shadow mode only — it scores but doesn't route, it verifies but doesn't settle, it deploys but hasn't deployed.

The Bridgebuilder review of PR #107 crystallized this: *"The question is no longer 'can we close the loop?' but 'how do we prevent the closed loop from gaming itself?'"* Cycle-034 answered that question with Goodhart protection. This cycle answers the follow-up: *"Now cross the bridge."*

Issue #66 Round 12 confirmed: all 4 repos are on v8.2.0, Phase 1 (Protocol Convergence) is complete, dixie's `ReputationQueryFn`-compatible endpoint ships with PR #46. The ball is with loa-finn.

### Why Now

1. **PR #108 is ready** — 54 tasks, 160 tests, 6 sprints of mechanisms waiting to activate
2. **Dixie's reputation endpoint is live** — PR #46 delivers `GET /api/reputation/query` with ES256 JWT, LRU cache, and 4 query surfaces
3. **All 4 repos on v8.2.0** — Shared protocol vocabulary, `ModelPerformanceEvent` variant, commons governance substrate
4. **x402 market momentum** — 75M+ transactions on Coinbase, Google AP2 announced, Conway Terminal proved the flow
5. **Infrastructure exists** — `ecs-finn.tf` provisioned in loa-freeside Terraform, ECR repo ready, ALB configured

### What This Cycle Does NOT Do

This is an **activation cycle**, not a feature cycle. No new mechanisms are designed. The work is:
- Configure what was built
- Wire what was stubbed
- Deploy what was Dockerized
- Graduate what was shadowed
- Verify what was mocked

---

## 1. Problem Statement

### P1: Built but not deployed

Cycle-034 created a complete AWS deployment pipeline (Sprint 5: Dockerfile, ECS task definition, GitHub Actions workflow) but loa-finn has never been deployed to production. The `ecs-finn.tf` task definition in loa-freeside references an ECR image that doesn't exist yet.

> Source: [Issue #84](https://github.com/0xHoneyJar/loa-finn/issues/84), cycle-034 Sprint 5

### P2: Reputation bridge points to stub

The `ReputationQueryAdapter` built in cycle-034 Sprint 2 supports three modes: HTTP client, direct import, and stub fallback. Currently the stub fallback is active — all queries return `null`, and routing is deterministic. Dixie's `GET /api/reputation/query` endpoint (PR #46) is live but not wired.

> Source: [Issue #66 Round 12](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3963353605), cycle-034 Sprint 2

### P3: Shadow mode has not been observed

The shadow rollout (cycle-034 Sprint 6) runs reputation scoring in parallel but returns deterministic results. The 72-hour graduation criteria (8 thresholds) cannot be evaluated without production traffic. No traffic means no graduation. No graduation means no loop closure.

> Source: cycle-034 Sprint 6 shadow graduation criteria

### P4: x402 is verify-only

The x402 settlement system (cycle-034 Sprint 3) verifies EIP-3009 signatures but does not submit on-chain transactions. `X402_SETTLEMENT_MODE=verify_only` is hardcoded in the E2E compose. Activating `on_chain` mode requires a merchant wallet with ETH for gas on Base.

> Source: [Issue #85](https://github.com/0xHoneyJar/loa-finn/issues/85), cycle-034 Sprint 3

### P5: E2E tests use mocks for cross-repo services

The E2E docker-compose (cycle-034 Sprint 6) runs loa-finn with LocalStack and a freeside stub. It does not test the actual JWT exchange with loa-freeside or reputation queries against loa-dixie. Cross-system integration is unverified.

> Source: [Issue #84](https://github.com/0xHoneyJar/loa-finn/issues/84), cycle-034 Sprint 6

---

## 2. Goals & Success Metrics

### Business Objectives

| Goal | Metric | Target |
|------|--------|--------|
| Production deployment | loa-finn healthcheck green on AWS ECS | ALB returns 200, <500ms p99 |
| Live reputation routing | Shadow mode producing comparison logs | >1000 shadow comparisons logged |
| Shadow graduation | All 8 thresholds met over 72h window | Divergence <15%, latency <50ms delta, error rate <0.1% delta |
| x402 settlement | On-chain USDC transfer confirmed | E2E: payment → Base tx receipt → inference |
| Cross-system E2E | finn + freeside + dixie in compose | JWT exchange + billing + reputation verified |

### Non-Goals (explicit)

- Designing new Goodhart protection mechanisms (cycle-034 delivered all 3)
- Building new protocol types in loa-hounfour (Phase 3 work, separate cycle)
- Conway Terminal full integration (depends on x402 go-live, this cycle wires x402 only)
- Production traffic migration or GA announcement (deployment readiness, not launch)
- Web UI for calibration or monitoring dashboards (data model supports it, UI is future)

---

## 3. User & Stakeholder Context

### Personas

| Persona | Need | This Cycle |
|---------|------|------------|
| **Operator** (@janitooor) | See finn running in production | AWS ECS deployment with health monitoring |
| **NFT holder** (agent owner) | Reputation-driven routing working | Shadow → live graduation |
| **Autonomous agent** (x402 consumer) | Pay-per-request on Base mainnet | x402 on_chain settlement |
| **Dixie integration** (cross-repo) | Reputation data actually consumed | HTTP adapter pointed at live endpoint |
| **Freeside integration** (cross-repo) | Billing flow verified end-to-end | Cross-system E2E compose |

---

## 4. Functional Requirements

### FR1: Production Deployment (P0)

#### FR1.1: Deploy to AWS ECS

Push cycle-034's Docker image to ECR and activate the ECS task definition.

- Merge PR #108 to main (prerequisite — all 6 sprints, 160 tests)
- Run GitHub Actions deployment workflow targeting `arrakis-production-loa-finn` ECR repo
- Validate ECS task starts and passes ALB health check
- Configure AWS Secrets Manager with finn-specific secrets:
  - `FINN_S2S_PRIVATE_KEY` (ES256 JWT signing key)
  - `FINN_CALIBRATION_HMAC_KEY` (calibration data integrity)
  - `FINN_KMS_KEY_ID` (audit trail signing)
  - `REDIS_URL` (ElastiCache endpoint)
  - API provider keys (model inference)
- Wire Cloud Map service discovery (`finn.production.local`)

**Acceptance Criteria**:
- AC1: `GET /health` returns 200 from ALB-routed URL within 30s of deploy
- AC2: ECS task stays healthy for >1 hour without restarts
- AC3: All secrets accessible via AWS SDK (no env var fallback in production)
- AC4: Cloud Map DNS resolves `finn.production.local` to ECS task

#### FR1.2: Production Health Monitoring

Verify the observability stack from cycle-034 works in production.

- CloudWatch log group receives structured JSON logs
- OpenTelemetry traces export to configured collector
- Prometheus metrics endpoint (`/metrics`) accessible from monitoring stack

**Two-tier health endpoints** (Fix: prevent dependency cascading via ALB):

| Endpoint | Purpose | Used By | Behavior |
|----------|---------|---------|----------|
| `GET /healthz` | **Liveness** — process is up | ALB target group health check | Returns 200 if HTTP server can respond. No dependency checks. |
| `GET /health/deps` | **Readiness** — dependencies reachable | Monitoring dashboards, alerts | Returns 200 with dependency status JSON. Returns 503 if critical dependency (Redis) is unreachable. Non-critical deps (DynamoDB, KMS) return degraded status but not 503. |

- ALB health check targets `/healthz` only — a Redis/DynamoDB outage does NOT deregister the ECS task
- Alerting monitors `/health/deps` — dependency degradation triggers operator alerts without killing tasks

**Acceptance Criteria**:
- AC5: CloudWatch logs show structured JSON with `level`, `message`, `timestamp` fields
- AC6: `/healthz` returns 200 even when Redis is temporarily unreachable (ALB keeps task registered)
- AC6a: `/health/deps` returns 503 with `{ redis: "unreachable" }` when Redis is down (triggers alert)
- AC7: `/metrics` endpoint returns Prometheus-format counters for routing, exploration, scoring

### FR2: Live Reputation Wiring (P0)

#### FR2.1: Point HTTP Adapter at Dixie

Configure the `ReputationQueryAdapter` (cycle-034 Sprint 2) to call dixie's live HTTP endpoint.

- Set `FINN_REPUTATION_ENDPOINT=https://dixie.production.local/api/reputation/query`
- Configure ES256 JWT for service-to-service auth (finn → dixie)
- Circuit breaker: 3 failures → open, 30s half-open probe, 300ms timeout per request (headroom above 100ms p99 target for network/TLS/DNS variance)
- **Connection optimization**: Use HTTP keep-alive with connection pooling to dixie. Pre-resolve Cloud Map DNS at startup and refresh every 30s (avoids DNS latency on hot path).
- Degradation: when dixie is unreachable, adapter returns `null` (deterministic routing continues)

**Dixie endpoint contract** (from dixie PR #46):
```
GET /api/reputation/query?nftId={nftId}&poolId={poolId}&routingKey={routingKey}
Authorization: Bearer <ES256 JWT>
Response: { score: number, asOfTimestamp: string, sampleCount: number }
```

**Acceptance Criteria**:
- AC8: With dixie running, reputation queries return non-null scores for known NFTs
- AC9: With dixie down, routing continues with deterministic pool selection (no errors)
- AC10: Circuit breaker opens after 3 consecutive failures and stops hitting dixie for 30s
- AC11: JWT service-to-service auth is validated by dixie (401 on bad token)

#### FR2.2: Validate EMA Cache with Live Data

The temporal decay EMA cache (cycle-034 Sprint 1) was tested with synthetic data. Validate it works with real dixie responses.

- First reputation query for a key seeds the EMA
- Subsequent queries update the EMA using the time-weighted formula
- Stale responses (asOfTimestamp < lastKnown) are dropped
- Redis TTL cleanup works (entries expire after 2 * halfLife)

**Acceptance Criteria**:
- AC12: EMA values converge toward dixie's aggregate score over multiple queries
- AC13: Out-of-order responses are dropped with warning log
- AC14: Redis keys expire after 2 * halfLife with no queries

### FR3: Shadow Mode Graduation (P1)

#### FR3.1: Shadow Observation Period

Run shadow mode in production for 72 hours and collect graduation metrics.

- `FINN_REPUTATION_ROUTING=shadow` in production env
- Shadow mode runs reputation scoring but returns deterministic pool
- Comparison logs capture: `{ deterministicPool, shadowPool, diverged, score, tier, routingKey }`
- **Graduation metrics source of truth**: Prometheus counters and histograms (not logs). The routing engine increments OTel counters (`finn_shadow_total`, `finn_shadow_diverged`, `finn_reputation_query_duration_seconds`) on every decision. These counters are the canonical source for graduation threshold evaluation. Comparison logs are supplementary (debug/sampling) and may be dropped without affecting graduation accuracy.
- Metrics aggregated per hour for graduation evaluation via Prometheus queries

**Graduation Thresholds** (from cycle-034 Sprint 6):

| Threshold | Metric | Target | Window |
|-----------|--------|--------|--------|
| T1 | Routing divergence rate | <15% | 72h |
| T2 | Reputation query latency p99 | <100ms | 72h |
| T3 | Latency impact on total request | <50ms delta vs baseline | 72h |
| T4 | Error rate from reputation queries | <0.1% | 72h |
| T5 | EMA stability (coefficient of variation) | <0.3 | Last 24h |
| T6 | Exploration rate adherence | Within [3%, 7%] of epsilon | 72h |
| T7 | Kill switch responsiveness | <1s from env change to routing change | Spot check |
| T8 | Calibration data freshness | <60s from S3 update to routing change | Spot check |

**Acceptance Criteria**:
- AC15: Prometheus counter `finn_shadow_total` increments for >=99.9% of routing decisions (measured via request count comparison)
- AC16: Graduation script reads 72h of logs and evaluates all 8 thresholds
- AC17: When all thresholds pass, script outputs `GRADUATE: safe to enable live routing`

#### FR3.2: Graduation Flip

Once all 8 thresholds are met, switch from shadow to live.

- **Runtime config mechanism**: Routing mode (`disabled`/`shadow`/`enabled`) is stored in **Redis** (key: `finn:config:reputation_routing`, no TTL). The routing engine reads this key on every request (sub-1ms Redis GET). This avoids ECS task redeploys for mode changes.
- **Admin endpoint**: `POST /admin/routing-mode` (ES256 JWT-gated, operator-only) sets the Redis key. Alternatively, operators can set the key directly via Redis CLI.
- **Startup default**: On cold start, if the Redis key does not exist, the routing engine falls back to the `FINN_REPUTATION_ROUTING` env var (default: `shadow`). This ensures the env var serves as the initial seed, but runtime changes do not require a redeploy.
- Kill switch remains available for immediate rollback (same Redis key, set to `disabled`)
- First 24h after graduation: enhanced monitoring (1-minute metric windows)

**Acceptance Criteria**:
- AC18: After graduation, routing decisions use reputation scores (not always deterministic)
- AC19: Setting routing mode to `disabled` via Redis immediately reverts to deterministic (next request)
- AC20: Mode change takes effect within 1 second without service restart or redeploy (verified by admin endpoint round-trip test)

### FR4: Cross-System E2E Verification (P1)

#### FR4.1: Three-Leg Docker Compose

Extend the E2E compose topology to include all three legs: finn, freeside, dixie.

- Add `loa-freeside-e2e` service (real freeside image, not stub)
- Add `loa-dixie-e2e` service (real dixie image with PostgreSQL)
- **Deterministic ES256 test keypairs**: Pre-generated keypairs checked into `tests/e2e/keys/` (test-only, not production secrets). Each service mounts its private key and all services' public keys. This ensures reproducible JWT validation without runtime key generation. The existing `tests/e2e/generate-keys.ts` script generates these once; compose mounts them as volumes.
- Each service's JWKS endpoint (`/.well-known/jwks.json`) serves the mounted public keys — same trust model as production (issuer/audience validation, signature verification) but with deterministic test keys
- Shared Redis for all services
- PostgreSQL for dixie reputation store

**Compose topology**:
```
redis-e2e ──────────────────────────────┐
postgres-e2e ────────────────────────── │ ──── loa-dixie-e2e
localstack-e2e ─────┐                  │
                    ├── loa-finn-e2e ───┤
loa-freeside-e2e ───┘                  │
```

**Acceptance Criteria**:
- AC21: `docker compose -f tests/e2e/docker-compose.e2e-v3.yml up` starts all 5 services
- AC22: finn validates JWT issued by freeside (real ES256 verification)
- AC23: finn queries dixie for reputation data (real HTTP, not stub)
- AC24: Full flow: inference request → JWT validation → reputation query → model routing → billing debit → response

#### FR4.2: Autopoietic Path E2E Test

Verify the complete 6-stage loop in the three-leg compose.

- Stage 1: Quality signal emitted after inference
- Stage 2: Reputation event normalized and forwarded to dixie
- Stage 3: Dixie stores reputation in PostgreSQL
- Stage 4: Next routing decision queries dixie and uses reputation
- Stage 5: Model selected based on reputation-weighted scoring
- Stage 6: Quality measured and fed back (closing the loop)

**Acceptance Criteria**:
- AC25: After 10+ inference requests, dixie contains reputation data for the NFT
- AC26: Routing decisions shift based on accumulated reputation (not always same pool)
- AC27: `ScoringPathLog` shows progression from `"stub"` path to `"reputation"` path

### FR5: x402 Mainnet Activation (P2)

#### FR5.1: Merchant Wallet Configuration

Set up the merchant relayer wallet for Base mainnet settlement.

- Generate or import merchant wallet (EOA with ETH on Base for gas)
- Store private key in AWS Secrets Manager (`FINN_MERCHANT_PRIVATE_KEY`)
- Configure gas estimation with safety margin (1.5x estimated gas)
- Set gas price ceiling to prevent excessive spending (configurable, default 50 gwei)

**Acceptance Criteria**:
- AC28: Merchant wallet has sufficient ETH for gas (>0.01 ETH on Base)
- AC29: Private key is in AWS Secrets Manager (not in env vars or config files)
- AC30: Gas estimation includes safety margin and ceiling

#### FR5.2: On-Chain Settlement Mode

Flip `X402_SETTLEMENT_MODE` from `verify_only` to `on_chain`.

- Settlement flow: verify signature → submit `transferWithAuthorization` → wait for receipt → serve inference
- Transaction confirmation: 1 block on Base L2 (typical ~2s, worst-case ~15s under congestion)
- Timeout: 60s for receipt (headroom above typical 2-5s to handle congestion), return `503 Retry-After: 10` on timeout
- Reconciliation job: every 5 minutes, compare Redis settled set against on-chain state

**Acceptance Criteria**:
- AC31: `X402_SETTLEMENT_MODE=on_chain` causes real on-chain USDC transfer on valid payment
- AC32: Transaction hash logged in DynamoDB audit trail (canonical tamper-evident record) for every settlement
- AC33: Gas failure returns `503` with `relayer_unavailable` and operator alert
- AC34: Reconciliation job detects discrepancies between Redis and chain state

#### FR5.3: x402 Integration Test (Base Sepolia)

Before mainnet activation, verify settlement on **Base Sepolia** testnet (chainId: `84532`).

- Use Base Sepolia USDC contract (`0x036CbD53842c5426634e7929541eC2318f3dCF7e` — Coinbase faucet USDC on Base Sepolia)
- RPC endpoint: `https://sepolia.base.org` (or Alchemy/Infura Base Sepolia)
- The test must use the **same EIP-3009 `transferWithAuthorization` interface** as Base mainnet USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, chainId: `8453`)
- Full flow: client signs authorization (chainId `84532`) → finn submits to Base Sepolia → chain confirms → inference served
- Test nonce replay protection (second submission rejected by contract)
- Test expired deadline handling

**Acceptance Criteria**:
- AC35: Full x402 flow works on Base Sepolia (chainId `84532`) with faucet USDC at the specified contract address
- AC36: Nonce replay correctly rejected by on-chain contract
- AC37: Expired deadline returns `402` before chain submission (saves gas)
- AC37a: Chain ID and token contract address are configurable (env vars), not hardcoded — same code runs on Sepolia and mainnet

---

## 5. Technical & Non-Functional Requirements

### NFR1: Performance

| Metric | Target | Baseline (shadow) |
|--------|--------|--------------------|
| Total request latency | <800ms p99 | ~700ms (without reputation query) |
| Reputation query overhead | <100ms p99 | N/A (stub returns null in <1ms) |
| x402 settlement latency | <20s p99 (includes chain confirmation, timeout at 60s) | N/A (verify_only <50ms) |
| Graduation metric computation | <10s for 72h window | N/A |

### NFR2: Reliability

- Dixie failure must not break routing (graceful degradation to deterministic)
- x402 chain failure returns 503, not 500 (client can retry)
- Shadow mode comparison logging is best-effort (dropped logs don't affect routing or graduation — Prometheus counters are the source of truth)
- Graduation script is idempotent (re-running produces same result)
- **Audit trail canonical record**: DynamoDB hash chain (cycle-034 Sprint 4) is the tamper-evident store for `ScoringPathLog` and x402 settlement events. S3 Object Lock stores KMS-signed daily digests. CloudWatch is observability-only (not tamper-evident, not used for dispute resolution).

### NFR3: Security

#### Secrets vs Configuration Split

| Category | Mechanism | Examples |
|----------|-----------|---------|
| **Secrets** (sensitive credentials) | AWS Secrets Manager | `FINN_S2S_PRIVATE_KEY`, `FINN_MERCHANT_PRIVATE_KEY`, API provider keys, `FINN_CALIBRATION_HMAC_KEY` |
| **Non-secret config** (endpoints, flags, IDs) | ECS task env vars or SSM Parameter Store | `FINN_REPUTATION_ENDPOINT`, `FINN_KMS_KEY_ID` (alias, not key material), `AWS_REGION`, `X402_SETTLEMENT_MODE`, chain IDs, contract addresses |
| **Runtime config** (hot-reloadable) | Redis keys | `finn:config:reputation_routing` (routing mode), `finn:config:exploration_epsilon` |

- Zero secrets in env vars or config files. Secrets Manager SDK retrieval at startup + cached with TTL.
- Merchant wallet private key never logged, never in memory longer than transaction signing.
- `FINN_KMS_KEY_ID` is a key alias (not sensitive) — safe in env vars.

#### JWT Trust Model (inter-service)

All service-to-service communication uses ES256 JWT with the following trust model:

| Parameter | Value |
|-----------|-------|
| Algorithm | ES256 (ECDSA P-256) |
| Key type | Long-lived ES256 keypair per service |
| Key distribution | Each service exposes `GET /.well-known/jwks.json` with its public key(s) |
| Issuer (`iss`) | Service identifier (e.g., `loa-finn`, `loa-freeside`, `loa-dixie`) |
| Audience (`aud`) | Target service identifier |
| Subject (`sub`) | Request context (e.g., `nftId` for reputation queries) |
| Expiry (`exp`) | 5 minutes (short-lived tokens, no refresh) |
| Clock skew tolerance | 30 seconds |
| Key rotation | New key added to JWKS, old key retained for `exp` + skew window, then removed |

- In production: private keys in Secrets Manager, JWKS served from memory
- In E2E compose: deterministic test keypairs mounted as volume (not generated at startup)
- Validation: every inter-service request validates `iss`, `aud`, `exp`, and signature against the issuer's JWKS

### NFR4: Observability

| Signal | Source | Destination |
|--------|--------|-------------|
| Shadow comparison logs | finn routing engine | CloudWatch (observability only, not tamper-evident) |
| Reputation query metrics | HTTP adapter | Prometheus `/metrics` |
| x402 settlement events | merchant relayer | CloudWatch + DynamoDB audit |
| Graduation metrics | aggregation script | stdout (operator review) |

---

## 6. Scope & Prioritization

### In Scope (this cycle)

| Priority | Component | Dependency |
|----------|-----------|------------|
| P0 | Deploy to AWS ECS (FR1) | PR #108 merged |
| P0 | Wire live dixie reputation (FR2) | Dixie PR #46 merged |
| P1 | Shadow observation + graduation (FR3) | FR1 + FR2 |
| P1 | Three-leg E2E compose (FR4) | Freeside + dixie images available |
| P2 | x402 mainnet activation (FR5) | FR1 + merchant wallet funded |

### Out of Scope (explicit)

| Item | Why | When |
|------|-----|------|
| New Goodhart mechanisms | Already built in cycle-034 | N/A (complete) |
| ReputationQueryProtocol hounfour schema | Protocol formalization, cross-repo | Phase 3 (separate cycle) |
| QuarantineContext discriminated union | hounfour schema work | Phase 3 |
| Conway Terminal full interop | Depends on x402 live + Conway integration | Next cycle |
| Production traffic migration / GA | Deployment verification only this cycle | Post-graduation observation |
| Calibration web UI | Data model supports it, UI is future | Next cycle |
| Monitoring dashboards | CloudWatch + Prometheus endpoints exist, dashboards are ops | Operational task |

### MVP Definition

The minimum viable delivery is:
1. loa-finn running on AWS ECS with ALB health check green
2. Reputation query hitting dixie's live endpoint (with circuit breaker)
3. Shadow mode producing comparison logs in production

Everything else (graduation, x402, cross-system E2E) builds on this foundation.

---

## 7. Risks & Dependencies

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PR #108 merge conflicts with main | Low | Medium | Rebase before merge, 160 tests as safety net |
| ECS task definition drift from cycle-034 Dockerfile | Low | High | Validate `docker build` matches `ecs-finn.tf` expectations |
| Dixie endpoint latency in production | Medium | Medium | Circuit breaker + 100ms timeout + null fallback |
| Shadow mode insufficient traffic for graduation | Medium | Low | Can reduce 72h window if thresholds are clearly met |
| Base gas price spike during x402 settlement | Low | Medium | Gas price ceiling prevents excessive spend |
| ES256 JWT clock skew between services | Low | High | NTP sync on ECS, 30s clock skew tolerance in JWT validation |

### External Dependencies

| Dependency | Owner | Status | Fallback |
|-----------|-------|--------|----------|
| PR #108 merged to main | @janitooor (review) | Open (draft) | Cannot deploy without merge |
| loa-dixie PR #46 merged | loa-dixie | Merged (Round 12) | Stub adapter (deterministic routing) |
| loa-freeside Docker image | loa-freeside | Available (v7.11.0+) | Mock freeside in compose |
| AWS credentials (ECR, ECS, Secrets Manager) | @janitooor | Needed | Local docker-compose for dev |
| Base Sepolia test USDC | External faucet | Available | Skip Sepolia, go direct to mainnet (higher risk) |
| Merchant wallet ETH on Base | @janitooor | Needed | Defer x402 (P2, non-blocking) |

### Graduation-Specific Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Reputation scores are all null (dixie has no data) | No graduation possible | Seed reputation data from calibration entries before graduation |
| Divergence rate >15% (shadow disagrees with deterministic too often) | Graduation delayed | Tune decay half-life and exploration epsilon before retrying |
| EMA instability (high coefficient of variation) | Graduation delayed | Extend observation window, review calibration data quality |

---

## 8. Phasing & Dependency Order

```
Phase A: Foundation (P0)
  ├── Merge PR #108 to main
  ├── Deploy to AWS ECS
  └── Wire dixie reputation endpoint
         │
Phase B: Observation (P1)
  ├── Shadow mode in production (72h)
  ├── Collect graduation metrics
  └── Evaluate thresholds
         │
Phase C: Activation (P1)
  ├── Graduate shadow → live
  ├── Three-leg E2E compose
  └── 24h enhanced monitoring
         │
Phase D: Settlement (P2)
  ├── x402 Sepolia testing
  ├── Merchant wallet on Base mainnet
  └── On-chain settlement activation
```

**Critical path**: PR #108 merge → Deploy → Wire dixie → Shadow observation (72h) → Graduate

The 72-hour observation window is the longest-pole item. x402 (Phase D) can proceed in parallel with shadow observation (Phase B).

---

## Appendix A: Autopoietic Loop — Activation Checklist

| Stage | Component | Built In | Activation This Cycle |
|-------|-----------|----------|-----------------------|
| 1 | Quality signal (`scoreToObservation`) | cycle-033 | Already active |
| 2 | Reputation event (`normalizeReputationEvent`) | cycle-033 | Already active |
| 3 | Reputation store (dixie `PgReputationStore`) | loa-dixie PR #11 | Wire HTTP adapter (FR2.1) |
| 4 | Tier resolution (`resolvePoolWithReputation`) | cycle-034 Sprint 2 | Graduate from shadow (FR3.2) |
| 5 | Model selection (`PoolRegistry.resolve`) | existing | Already active |
| 6 | Quality measurement (`QualityObservation`) | cycle-033 | Already active |

**After this cycle**: All 6 stages active in production. The autopoietic loop is closed.

## Appendix B: Issue Closure Map

| Issue | Status After This Cycle |
|-------|------------------------|
| [#84](https://github.com/0xHoneyJar/loa-finn/issues/84) Dockerize + E2E | **Closeable** — three-leg compose + E2E tests |
| [#85](https://github.com/0xHoneyJar/loa-finn/issues/85) x402 Pay-Per-Request | **Closeable** — on-chain settlement active |
| [#66](https://github.com/0xHoneyJar/loa-finn/issues/66) Launch Readiness RFC | **Phase 2+4 complete** — loop closed, deployed, x402 live |

## Appendix C: Predecessor Cycle (034) Deliverables

For reference — what cycle-034 built (PR #108):

| Sprint | What | Tests |
|--------|------|-------|
| 1 (G138) | Goodhart Protection Engine — temporal decay, exploration, calibration, mechanism interaction, kill switch | 35 |
| 2 (G139) | Reputation Query Bridge + Quality Signal — adapter, parallel scoring, quality gate enhancement | 103 |
| 3 (G140) | x402 Settlement System — middleware, EIP-3009, conservation guard, merchant relayer, DLQ | 44 |
| 4 (G141) | Tamper-Evident Audit Trail — DynamoDB hash chain, S3 Object Lock, KMS signing, partition integrity | 36 |
| 5 (G142) | AWS Deployment Pipeline — Dockerfile, ECS deploy, Secrets Manager, Fly.io cleanup | 8 |
| 6 (G143) | E2E Integration + Shadow Rollout — docker-compose, feature flags, shadow mode, graduation criteria | 18 |
