# Sprint Plan: Production Activation & Loop Go-Live — Deploy, Wire, Graduate, Verify

> **Version**: 1.2.0
> **Date**: 2026-02-26
> **Cycle**: cycle-035
> **PRD**: v1.1.0 (GPT-5.2 APPROVED iter 2)
> **SDD**: v1.2.0 (GPT-5.2 APPROVED iter 2, Flatline: 5 HIGH integrated, 2 BLOCKERS deferred)
> **Global Sprint IDs**: 144-147
> **Total Tasks**: 30
> **Team**: Solo (@janitooor + Claude Opus 4.6)

---

## Sprint Overview

This is an **activation sprint plan**. No new mechanisms — all work is configuring, wiring, deploying, and verifying cycle-034 components in production.

**4 sprints following PRD phasing:**

| Sprint | Phase | Goal | Tasks |
|--------|-------|------|-------|
| 1 | A (Foundation) | Runtime infrastructure + health + shutdown | 9 |
| 2 | A (Foundation) | Admin API + dixie transport + metrics | 8 |
| 3 | B/C (Verification) | Three-leg E2E compose + autopoietic loop tests | 7 |
| 4 | D (Settlement) | x402 chain config + graduation script + Sepolia test | 6 |

**Critical path**: Sprint 1 → Sprint 2 → Sprint 3 (E2E needs all services). Sprint 4 is mostly independent (can partially overlap with Sprint 3).

---

## Sprint 1: Runtime Infrastructure (Global ID: 144)

**Goal**: Build the foundational runtime modules that all other sprints depend on: Redis-backed config, async kill switch, two-tier health endpoints, graceful shutdown, secrets management, and audit buffer.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-1.1 | Implement RuntimeConfig module (Redis GET + env fallback) | `src/hounfour/runtime-config.ts` (new) | AC20: Mode change effective <1s without restart. Redis GET returns valid mode. Redis down → env var fallback. Invalid/missing key → `"shadow"` default. |
| T-1.2 | Upgrade KillSwitch to async (RuntimeConfig integration) | `src/hounfour/goodhart/kill-switch.ts` (modified) | `isDisabled()` and `isShadow()` become async. All callers in `mechanism-interaction.ts` updated to `await`. Existing tests pass with async signatures. |
| T-1.3 | Implement two-tier health endpoints | `src/gateway/server.ts` (modified) | AC6: `/healthz` returns 200 even when Redis is unreachable. AC6a: `/health/deps` returns 503 when Redis down. DynamoDB health uses data-plane `GetItemCommand` (not DescribeTable). Legacy `/health` → 301 → `/healthz`. |
| T-1.4 | Implement GracefulShutdown handler | `src/boot/shutdown.ts` (new) | AC: SIGTERM triggers ordered shutdown. 25s deadline within ECS 30s stopTimeout. All registered targets receive shutdown call. Process exits 0 on clean shutdown, 1 on deadline. |
| T-1.5 | Implement BufferedAuditChain (bounded buffer, fail-closed, hash-chain preserved, crash-resume) | `src/hounfour/audit/buffered-audit-chain.ts` (new) | Critical actions (`routing_mode_change`, `settlement`) throw when buffer full + DynamoDB down. Non-critical actions drop with warning. Buffer flushes in-order on DynamoDB recovery. Expired entries (>5min) discarded. **Tamper-evidence AC**: BufferedAuditChain wraps cycle-034's `DynamoAuditChain` (which provides `prev_hash`/`hash` continuity + KMS signing). Flush path delegates to `inner.append()` preserving hash chain and KMS signatures. Unit test verifies: (1) buffered entries maintain hash-chain continuity after flush, (2) KMS signature present on each flushed record (mock KMS), (3) fail-closed triggers for critical actions when both buffer full AND DynamoDB+KMS unavailable. **Crash resume** (Flatline IMP-002): On startup, `DynamoAuditChain.initialize()` reads the last committed record from DynamoDB (query by partition, descending sequence number, limit 1) to recover `prev_hash`. If no records exist, chain starts fresh. If in-memory buffer was lost (unclean shutdown), the gap is detectable: next appended record's `prev_hash` matches DynamoDB's last `hash`, but missing sequence numbers create a verifiable discontinuity. AC: crash simulation test — append 5 entries, flush 3, simulate process kill, restart, verify chain resumes from DynamoDB's last committed hash and new entries link correctly. Alert on detected gap (structured log `audit_chain_gap_detected`). **Partial failure resilience** (Flatline SKP-003): Additional ACs for edge cases: (4) DynamoDB partial write failure (ConditionalCheckFailed on sequence conflict) → retry with re-read of last hash, no duplicate entries (idempotency via sequence number), (5) KMS transient error during flush → entry stays in buffer, retry on next flush cycle, does not break chain (KMS signing happens inside `inner.append()`), (6) concurrent appenders — BufferedAuditChain is single-writer per process (one instance per ECS task); if multiple async callers attempt concurrent appends, internal mutex/queue ensures sequential ordering. |
| T-1.6 | Implement SecretsLoader (Secrets Manager + TTL cache) | `src/boot/secrets.ts` (new) | All secrets fetched from Secrets Manager at startup. Fail-fast if required secret missing. Cache with 1h TTL for rotation. Parallel fetch via `Promise.all`. |
| T-1.7 | Unit tests: RuntimeConfig + KillSwitch async | `tests/finn/hounfour/runtime-config.test.ts` (new) | Redis mock: mode read, fallback chain, invalid values. KillSwitch: async mode checks, transitions. |
| T-1.8 | Unit tests: health endpoints + audit buffer | `tests/finn/gateway/health.test.ts` (new), `tests/finn/hounfour/audit/buffered-audit-chain.test.ts` (new) | `/healthz` always 200. `/health/deps` reflects dependency states. Buffer: fill, flush, expire, fail-closed for critical actions. |
| T-1.9 | Unit tests: GracefulShutdown + SecretsLoader | `tests/finn/boot/shutdown.test.ts` (new), `tests/finn/boot/secrets.test.ts` (new) | Shutdown: targets called in parallel, deadline enforced. SecretsLoader: cache TTL, refresh, missing secret throws. |

**Task sizing**: T-1.1 (M), T-1.2 (S), T-1.3 (M), T-1.4 (M), T-1.5 (M), T-1.6 (M), T-1.7 (M), T-1.8 (M), T-1.9 (M).
**Critical path**: T-1.1 → T-1.2 (RuntimeConfig before KillSwitch). T-1.5 blocks Sprint 2 admin endpoint. T-1.4 blocks Sprint 2 transport shutdown registration.

**Rollback/recovery**: All modules have safe defaults — Redis down → env var fallback → shadow mode. Audit buffer fail-closed prevents unauditable admin actions. GracefulShutdown has hard deadline preventing process hangs.

**Sprint 1 acceptance**: All foundational runtime modules pass unit tests. Health endpoints correctly separate liveness from readiness. Shutdown handler wires SIGTERM. Audit buffer correctly fail-closes for critical actions. 9 tasks.

---

## Sprint 2: Admin API + Dixie Transport + Graduation Metrics (Global ID: 145)

**Goal**: Build the operator-facing admin API with JWKS auth, the optimized dixie HTTP transport with connection pooling, and Prometheus graduation metrics. These complete the "foundation code" needed before E2E.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-2.1 | Implement Admin API routes (JWKS + audit-first handler) | `src/gateway/routes/admin.ts` (new) | AC: Valid admin JWT (ES256, kid selection via `createLocalJWKSet`) → mode change succeeds. Bad JWT → 401. Wrong role → 403. Audit intent written BEFORE Redis set. Audit failure → 503 (fail closed). GET returns current mode. **JWKS mechanism**: `finn/admin-jwks` is a JWK Set JSON blob in Secrets Manager (not a URL). SecretsLoader fetches JSON → `JSON.parse` → `createLocalJWKSet(parsed)` which returns a local key resolver that selects by `kid`. On TTL refresh, SecretsLoader re-fetches JSON and reconstructs the key set — no restart needed. **Redis write failure after audit intent** (Flatline IMP-001): If `runtimeConfig.setRoutingMode()` throws after audit intent is recorded, the handler must: (1) log a `routing_mode_change_failed` audit entry (best-effort), (2) return 503 with `{ error: "Mode change failed — audit intent exists, Redis write failed" }`, (3) NOT retry automatically (operator retries via admin endpoint). The audit trail will show an intent without confirmation — this is a detectable state. AC: unit test simulates Redis write failure after audit intent succeeds; verifies 503 response, no mode change applied, and audit trail contains intent-only record. |
| T-2.2 | Wire admin JWKS into SecretsLoader + boot + rotation test | `src/boot/secrets.ts` (modified), `src/gateway/server.ts` (modified) | `finn/admin-jwks` loaded from Secrets Manager as JWK Set JSON. `createLocalJWKSet(JSON.parse(jwksJson))` constructed at boot. SecretsLoader `refresh()` re-fetches and reconstructs on TTL expiry. Admin routes mounted at `/admin` on gateway. **Rotation AC**: Unit test simulates key rotation — old kid removed, new kid added to JWKS JSON — and verifies: (1) new kid validates immediately after refresh, (2) old kid rejects after removal, (3) refresh happens without restart. |
| T-2.3 | Implement DixieHttpTransport (undici Agent + DNS warming) | `src/hounfour/goodhart/dixie-transport.ts` (modified) | AC8: Reputation queries return non-null for known NFTs (dixie up). AC9: Dixie down → null (deterministic routing). AC10: Circuit breaker opens after 3 failures. Keep-alive pool (10 connections). DNS pre-resolve via `dns.promises.lookup()` (no hostname rewrite). 300ms timeout. |
| T-2.4 | Register DixieHttpTransport + pollers in GracefulShutdown | `src/boot/index.ts` (modified) | Transport `shutdown()` clears DNS timer + closes undici Agent. Calibration poller, reconciler, audit buffer flush registered. Verify: SIGTERM → all targets shut down cleanly. |
| T-2.5 | Implement Prometheus graduation metrics | `src/hounfour/graduation-metrics.ts` (new) | AC7: `/metrics` returns Prometheus-format counters. Counters: `finn_shadow_total`, `finn_shadow_diverged`, `finn_reputation_query_duration_seconds` (histogram), `finn_reputation_query_total`, `finn_exploration_total`, `finn_ema_updates_total`, `finn_routing_mode_transitions_total`. Fixed label sets (tier, status — no nftId/poolId). |
| T-2.6 | Wire metrics into routing engine + shadow comparisons | `src/hounfour/tier-bridge.ts` (modified), `src/hounfour/goodhart/mechanism-interaction.ts` (modified) | AC15: `finn_shadow_total` increments on every shadow routing decision. `finn_shadow_diverged` increments when shadow disagrees with deterministic. Reputation query histogram records latency per query. |
| T-2.7 | Unit tests: Admin API (auth, mode change, audit-first) | `tests/finn/gateway/admin-routes.test.ts` (new) | JWT validation: valid → 200, expired → 401, wrong issuer → 401, wrong role → 403, missing kid → 401. Mode change: writes audit before Redis. Audit failure → 503. Per-subject rate limit (5/hour). |
| T-2.8 | Unit tests: DixieHttpTransport + Prometheus metrics | `tests/finn/hounfour/dixie-transport.test.ts` (new), `tests/finn/hounfour/graduation-metrics.test.ts` (new) | Transport: keep-alive reuse, circuit breaker open/close/half-open, DNS refresh timer, 300ms timeout. Metrics: counter increments, histogram observations, label cardinality bounded. |

**Task sizing**: T-2.1 (L), T-2.2 (M), T-2.3 (L), T-2.4 (S), T-2.5 (M), T-2.6 (M), T-2.7 (M), T-2.8 (M).
**Critical path**: T-2.1 → T-2.2 (admin routes before wiring). T-2.3 → T-2.4 (transport before shutdown registration). T-2.5 → T-2.6 (metrics before wiring into engine).

**Rollback/recovery**: Admin endpoint behind network controls (ALB VPN-only rule — §8.1.1 SDD). Dixie transport degrades to null (deterministic routing). Prometheus metrics are read-only counters — no rollback needed. If admin JWKS is misconfigured, all admin requests fail-closed (401) until corrected.

**Sprint 2 acceptance**: Admin API with JWKS auth and audit-first semantics. Dixie transport with connection pooling and circuit breaker. Prometheus metrics wired into routing engine. All unit tests pass. 8 tasks.

---

## Sprint 3: Three-Leg E2E Compose + Integration Tests (Global ID: 146)

**Goal**: Build the three-leg docker-compose (finn + freeside + dixie) and verify the complete autopoietic loop, JWT exchange, and shadow metrics in an integrated environment. Closes PRD FR4.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-3.1 | Generate deterministic ES256 test keypairs | `tests/e2e/keys/generate-keys.sh` (new), `tests/e2e/keys/*.pem` (generated) | 4 keypair sets: finn, freeside, dixie, admin. `openssl ecparam -genkey` with prime256v1. Keys checked into repo (test-only). These are seed material for LocalStack — services do NOT mount PEM files directly. |
| T-3.2 | Create three-leg docker-compose v3 | `tests/e2e/docker-compose.e2e-v3.yml` (new), `tests/e2e/init-db.sql` (new) | AC21: `docker compose up` starts all 5 services (redis, postgres, localstack, finn, freeside, dixie). Health checks with `start_period` + `retries`. **Auth contract**: All services use SecretsLoader against LocalStack Secrets Manager (matching prod path). No direct PEM volume mounts on application services. LocalStack init (T-3.3) seeds secrets before services boot (`depends_on` + healthcheck gating). |
| T-3.3 | Create localstack init script (DynamoDB + S3 + KMS + Secrets Manager + key seeding) | `tests/e2e/localstack-init.sh` (new) | Creates audit table, calibration bucket, KMS key. **Seeds all secrets into LocalStack Secrets Manager**: reads PEM files from `tests/e2e/keys/`, creates `finn/s2s-private-key`, `finn/admin-jwks` (constructed from admin-public.pem as JWK Set JSON), `finn/calibration-hmac`, and equivalent secrets for freeside/dixie. AC: Finn boots with `AWS_ENDPOINT_URL=http://localstack-e2e:4566` using only SecretsLoader — no env var key fallbacks. |
| T-3.4 | E2E: JWT exchange test (finn ↔ freeside ↔ dixie) | `tests/e2e/jwt-exchange.test.ts` (new) | AC22: Finn validates JWT issued by freeside (real ES256 sig verification). AC11: Dixie validates finn-issued JWT for reputation queries. Service-to-service auth works across all three legs. |
| T-3.5 | E2E: Autopoietic loop test (6-stage feedback loop) | `tests/e2e/autopoietic-loop.test.ts` (new) | AC25: After 10+ requests, dixie contains reputation data. AC26: Routing decisions shift based on reputation. AC27: ScoringPathLog progresses from `"stub"` to `"reputation"`. Full 6-stage loop verified. |
| T-3.6 | E2E: Shadow metrics + admin routing mode test | `tests/e2e/shadow-metrics.test.ts` (new) | AC15: `finn_shadow_total` increments in shadow mode. Admin JWT flips mode, next request uses new mode. `/metrics` endpoint returns valid Prometheus format. |
| T-3.7 | E2E: Full flow integration test (inference → billing → reputation → response) | `tests/e2e/full-flow.test.ts` (new) | AC24: Request → JWT validation → reputation query → model routing → billing debit → response. All three legs participate. Circuit breaker tested (dixie stopped → deterministic routing continues). |

**Task sizing**: T-3.1 (S), T-3.2 (L), T-3.3 (M), T-3.4 (M), T-3.5 (L), T-3.6 (M), T-3.7 (L).
**Critical path**: T-3.1 → T-3.2 → T-3.3 (keys → compose → localstack init). Then T-3.4, T-3.5, T-3.6, T-3.7 can run sequentially (all need compose up).

**Rollback/recovery**: E2E tests run in isolated Docker environment. No production impact. If compose fails to start, check service health logs and dependency ordering. If freeside/dixie images unavailable, fall back to stubs (reduced coverage, logged as degraded).

**E2E CI contract** (Flatline IMP-005):
- **Suite timeout**: 10 minutes total (`docker compose up --wait --timeout 120` for startup + test execution). Individual test timeout: 60s per test case (configurable via test runner).
- **CI job sizing**: Requires `large` runner (4 CPU, 16GB RAM) for 5+ concurrent containers. Docker layer caching enabled for faster builds.
- **Parallelism**: E2E tests run sequentially within the suite (shared compose state). Sprint 3 E2E job runs in parallel with Sprint 1-2 unit test jobs (no dependency).
- **Merge gating**: E2E tests are **advisory, not blocking** for feature branch merges. They gate the release branch → main merge only. Rationale: E2E depends on external images (freeside, dixie) which may not be updated; blocking feature merges on external repos is unreasonable. Unit tests remain hard gates on all merges.
- **Flake policy**: If E2E fails, CI retries once automatically. Second failure → manual investigation required.

**Sprint 3 acceptance**: Three-leg compose starts reliably. JWT exchange verified across all services. Autopoietic loop closes in E2E. Shadow metrics and admin mode changes work. Full flow integration passes. 7 tasks.

---

## Sprint 4: x402 Chain Config + Graduation Script + Sepolia Test (Global ID: 147)

**Goal**: Make x402 chain/contract configurable for testnet→mainnet migration, build the graduation evaluation script, and verify settlement on Base Sepolia. Closes PRD FR3 and FR5.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-4.1 | Make x402 chain/contract configurable | `src/x402/verify.ts` (modified), `src/x402/settlement.ts` (modified) | AC37a: Chain ID and USDC address configurable via env vars. Same code runs on Sepolia (84532) and mainnet (8453). `CHAIN_CONFIGS` lookup table with known chains. `X402_USDC_ADDRESS` override for custom deployments. Settlement timeout increased to 60s (from 30s). |
| T-4.2 | Implement graduation evaluation script | `scripts/evaluate-graduation.ts` (new), `scripts/graduation-config.example.json` (new) | AC16: Reads 72h of metrics from Prometheus API. AC17: All 8 thresholds evaluated (T1-T8). Outputs `GRADUATE`, `NOT_READY`, or `INSUFFICIENT_DATA`. Uses PromQL `increase()` for counter resets. **T5 Redis contract**: Reads EMA coefficient of variation from Redis keys `ema:{poolId}:{routingKey}` (written by TemporalDecayEngine in cycle-034). Fields: `value` (float), `count` (int), `lastEventTimestamp` (ISO). Script computes CV across all active EMA keys over last 24h. **T7/T8 spot checks**: T7 calls `POST /admin/routing-mode` round-trip. T8 checks S3 calibration ETag polling timestamp from Redis `calibration:last_refresh_ts`. **Config file**: `graduation-config.example.json` specifies `prometheusUrl`, `prometheusJobName` (default: `finn`), `redisUrl`, `adminEndpoint`, `adminJwtPath`. Idempotent. **Prometheus contract**: Script assumes scrape job name `finn`, path `/metrics`, port 3000, labels `tier`/`status` on counters. Smoke query `up{job="finn"}` validates connectivity before evaluation. |
| T-4.3 | x402 Sepolia integration test | `tests/x402/sepolia-settlement.test.ts` (new) | AC35: Full x402 flow on Base Sepolia (chainId 84532) with faucet USDC. AC36: Nonce replay rejected by contract. AC37: Expired deadline returns 402 before chain submission. Real RPC call to Base Sepolia. |
| T-4.4 | Unit tests: chain config + graduation | `tests/finn/x402/chain-config.test.ts` (new), `tests/finn/hounfour/graduation-evaluation.test.ts` (new) | Chain config: default mainnet, env override to Sepolia, invalid chain throws, USDC address override. Graduation: mock Prometheus responses, all 8 thresholds tested individually, insufficient data handling. |
| T-4.5 | E2E: Admin mode change + shadow metrics accumulation | `tests/e2e/graduation-readiness.test.ts` (new) | Compose starts in shadow mode. Admin sets mode via JWT. Shadow metrics accumulate. Graduation script reads metrics and evaluates (INSUFFICIENT_DATA for short window is acceptable). Mode flip to `enabled` → routing uses reputation. Mode flip to `disabled` → immediate deterministic. |
| T-4.6 | Deployment runbook + ECS/ALB preflight checklist | `grimoires/loa/a2a/deployment-runbook.md` (new) | Documents the 10-step deployment order from SDD §6.2. Includes coordinated ALB/code deploy sequence (deploy code first, then ALB path). **ECS task definition requirements**: container port 3000, `stopTimeout >= 30` (aligns with 25s shutdown deadline), health check grace period, `essential: true`, log driver `awslogs`. **ALB target group requirements**: health check path `/healthz`, success codes `200`, interval 30s, timeout 5s, healthy threshold 2, unhealthy threshold 3, deregistration delay 30s. **IAM preflight**: Task role must have `secretsmanager:GetSecretValue` for `finn/*` secrets, `kms:Sign`/`kms:Verify` for audit KMS key, `dynamodb:PutItem`/`GetItem` on audit table, `s3:GetObject` on calibration bucket. **Preflight verification script**: `scripts/preflight-check.sh` runs `aws secretsmanager get-secret-value` for each required secret, `aws kms describe-key` for audit key, `aws dynamodb describe-table` for audit table — validates permissions before deploy. Rollback procedures for each step. |

**Task sizing**: T-4.1 (M), T-4.2 (L), T-4.3 (L), T-4.4 (M), T-4.5 (M), T-4.6 (M).
**Critical path**: T-4.1 → T-4.3 (chain config before Sepolia test). T-4.2 → T-4.5 (graduation script before readiness E2E). T-4.6 is independent.

**Rollback/recovery**: x402 behind `X402_SETTLEMENT_MODE=verify_only` — on-chain settlement disabled until explicitly flipped. Graduation script is read-only (evaluates metrics, doesn't change state). Sepolia tests use faucet USDC (no real money). Deployment runbook includes per-step rollback.

**Sprint 4 acceptance**: x402 chain/contract configurable. Graduation script evaluates all 8 thresholds. Sepolia settlement verified end-to-end. Deployment runbook ready for production go-live. 6 tasks.

---

## Dependency Graph

```
Sprint 1: Runtime Infrastructure
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ T-1.1 Runtime    │  │ T-1.3 Health     │  │ T-1.4 Shutdown   │
  │ Config           │  │ Endpoints        │  │ Handler          │
  └────────┬─────────┘  └──────────────────┘  └────────┬─────────┘
           │                                           │
           ▼                                           │
  ┌──────────────────┐  ┌──────────────────┐           │
  │ T-1.2 KillSwitch │  │ T-1.5 Audit      │           │
  │ async            │  │ Buffer           │           │
  └──────────────────┘  └────────┬─────────┘           │
                                 │                     │
Sprint 2: Admin + Transport      ▼                     ▼
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ T-2.1 Admin API  │──│ T-2.2 Wire JWKS  │  │ T-2.3 Dixie      │
  │ (needs T-1.5)    │  │ into boot        │  │ Transport        │
  └──────────────────┘  └──────────────────┘  └────────┬─────────┘
                                                       │
  ┌──────────────────┐  ┌──────────────────┐           ▼
  │ T-2.5 Prometheus │──│ T-2.6 Wire into  │  ┌──────────────────┐
  │ Metrics          │  │ routing engine   │  │ T-2.4 Register   │
  └──────────────────┘  └──────────────────┘  │ in Shutdown      │
                                               └──────────────────┘
Sprint 3: E2E Compose
  ┌──────────────────┐
  │ T-3.1 Keypairs   │
  └────────┬─────────┘
           ▼
  ┌──────────────────┐  ┌──────────────────┐
  │ T-3.2 Compose v3 │──│ T-3.3 Localstack │
  └────────┬─────────┘  └──────────────────┘
           │
           ├──► T-3.4 JWT exchange
           ├──► T-3.5 Autopoietic loop
           ├──► T-3.6 Shadow metrics
           └──► T-3.7 Full flow

Sprint 4: x402 + Graduation (partially independent)
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ T-4.1 Chain      │  │ T-4.2 Graduation │  │ T-4.6 Deployment │
  │ Config           │  │ Script           │  │ Runbook          │
  └────────┬─────────┘  └────────┬─────────┘  └──────────────────┘
           │                     │
           ▼                     ▼
  ┌──────────────────┐  ┌──────────────────┐
  │ T-4.3 Sepolia    │  │ T-4.5 Graduation │
  │ Test             │  │ E2E Readiness    │
  └──────────────────┘  └──────────────────┘
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Freeside/dixie Docker images not available | Medium | High | Fall back to stub images in compose; log degraded coverage |
| Base Sepolia faucet USDC depleted | Low | Low | Small test amounts (0.01 USDC); reusable wallet |
| Prometheus not available in CI | Medium | Medium | Graduation script falls back to mock Prometheus in tests |
| AdminJWKS key format inconsistency | Low | Medium | Validated by unit tests (T-2.7) + SecretsLoader fail-fast |
| Three-leg compose startup ordering flaky | Medium | Medium | Health checks with `start_period: 30s` + `retries: 10` |

---

## De-Scope Matrix (Flatline SKP-001)

If timeline pressure requires cutting scope, use this prioritization:

| Priority | Tasks | Rationale |
|----------|-------|-----------|
| **Must ship** (blocks go-live) | T-1.1, T-1.2, T-1.3, T-1.4, T-1.5, T-1.6, T-2.1, T-2.2, T-2.3, T-2.5, T-2.6 | Runtime config, health, shutdown, audit, admin, transport, metrics — these are the production activation path |
| **Should ship** (high value) | T-2.4, T-3.2, T-3.3, T-3.4, T-4.1, T-4.6 | Shutdown registration, E2E compose infra, JWT exchange test, chain config, deployment runbook |
| **Could ship** (nice-to-have) | T-3.5, T-3.6, T-3.7, T-4.2, T-4.3, T-4.5 | Autopoietic loop E2E, shadow metrics E2E, full flow E2E, graduation script, Sepolia test, graduation readiness E2E |
| **Test tasks** (follow code) | T-1.7, T-1.8, T-1.9, T-2.7, T-2.8, T-4.4 | Unit tests follow their code tasks — cut only if parent is cut |

**Buffer**: Sprint 4 is the most de-scopable — graduation script (T-4.2) and Sepolia test (T-4.3) can ship in a follow-up cycle since production starts in shadow mode (graduation is a later operational step). This gives ~1 sprint of buffer.

---

## Flatline Blocker Resolutions

| Blocker | Decision | Rationale |
|---------|----------|-----------|
| SKP-001 (solo team, 930) | **Accepted** | De-scope matrix added above |
| SKP-003 (audit partial failures, 900) | **Accepted** | Additional ACs added to T-1.5 |
| SKP-004 (admin JWT replay, 880) | **Override** | SDD §8.1.1 already specifies WAF + VPN CIDR + per-subject rate limit + short exp (5min). jti tracking adds Redis overhead for a VPN-only, rate-limited endpoint with 5-minute token lifetime — replay window is negligible. |
| SKP-002 (Redis multi-instance, 760) | **Override** | Direct Redis GET per request = no caching layer = instant consistency across all ECS tasks. The concern assumes a stale cache that doesn't exist. All instances read the same Redis key on every request — propagation is inherent. |
| SKP-005 (JWKS atomic swap, 720) | **Deferred** | SDD §3.3 rotation procedure specifies overlap period (add new key → start using → remove old after expiry). Cross-instance stale windows are handled by the overlap. Atomic swap is a future improvement for high-concurrency scenarios; admin endpoint is VPN-only, low-traffic. |

---

## Issue Closure Map

| Issue | Sprint(s) | AC Coverage |
|-------|-----------|-------------|
| [#84](https://github.com/0xHoneyJar/loa-finn/issues/84) Dockerize + E2E | Sprint 3 (T-3.1–T-3.7) | AC21–AC27 |
| [#85](https://github.com/0xHoneyJar/loa-finn/issues/85) x402 Payments | Sprint 4 (T-4.1, T-4.3) | AC31–AC37a |
| [#66](https://github.com/0xHoneyJar/loa-finn/issues/66) Launch Readiness | All sprints | Phase 2+4 complete |
