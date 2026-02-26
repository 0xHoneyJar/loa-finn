# Sprint Plan: Loop Closure & Launch Infrastructure — Goodhart Protection, AWS Deployment, x402 Payments

> **Version**: 1.1.0
> **Date**: 2026-02-26
> **Cycle**: cycle-034
> **PRD**: v1.2.0 (GPT-5.2 APPROVED iter 4, Flatline APPROVED)
> **SDD**: v1.2.0 (GPT-5.2 APPROVED iter 3+4, Flatline: 7 HIGH integrated, 6 BLOCKERS resolved)
> **Global Sprint IDs**: 138-143
> **Total Tasks**: 54
> **Team**: Solo (@janitooor + Claude Opus 4.6)

---

## Sprint 1: Goodhart Protection Engine (Global ID: 138)

**Goal**: Build the core Goodhart protection subsystem — temporal decay, exploration, calibration, mechanism interaction, and kill switch. This is the P0 prerequisite for safe loop closure.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-1.1 | Create goodhart module structure + index re-exports | `src/hounfour/goodhart/index.ts` (new) | Module resolves with `import { ... } from './goodhart'` |
| T-1.2 | Implement EMA Redis Lua script | `src/hounfour/goodhart/lua/ema-update.lua` (new) | AC3b: Two concurrent EMA updates produce valid EMA (no lost updates). Inline `lastEventHash` idempotency. Out-of-order timestamp rejection. |
| T-1.3 | Implement TemporalDecayEngine | `src/hounfour/goodhart/temporal-decay.ts` (new) | AC1: Model performing well 30d ago but poorly in 3d routes fewer requests. AC2: Half-life configurable per tier. AC3: O(1) query via cached EMA. AC3a: Decay decreases monotonically with time. AC3c: Out-of-order events dropped with warning. |
| T-1.4 | EMA unit tests (formula, cold start, idempotency, concurrency) | `tests/finn/goodhart/temporal-decay.test.ts` (new) | All AC1-AC3c verified. Real Redis required for concurrency test. |
| T-1.5 | Implement ExplorationEngine (Bernoulli + candidate filtering) | `src/hounfour/goodhart/exploration.ts` (new) | AC4: Over 1000 decisions with ε=0.05, exploration count ∈ [30,70]. AC6: Authoritative tier never explores. AC7a: Open circuit breaker pools excluded. AC7b: >2x cost pools excluded. AC7c: Empty candidate set → exploration_skipped. |
| T-1.6 | Exploration unit tests (Bernoulli CI, filtering, edge cases) | `tests/finn/goodhart/exploration.test.ts` (new) | All AC4-AC7c verified. |
| T-1.7 | Implement CalibrationEngine (S3 polling + HMAC + blending) | `src/hounfour/goodhart/calibration.ts` (new) | AC8: Human calibration shifts score more than 3 automated observations. AC10a: S3 update reflected within 60s. HMAC-SHA256 verification on fetch. |
| T-1.8 | Implement MechanismInteraction (precedence rules) | `src/hounfour/goodhart/mechanism-interaction.ts` (new) | AC10b: Kill switch → zero reputation queries. AC10c: Exploration independent of calibration/decay. AC10d: Calibration blending formula correct. AC10e: Exploration feedback at 0.5x weight. |
| T-1.9 | Implement KillSwitch (env var, audit logging) | `src/hounfour/goodhart/kill-switch.ts` (new) | AC10f: `disabled` → deterministic routing. AC10g: `enabled` → reputation routing. AC10h: Transitions logged. |
| T-1.10 | Mechanism interaction + kill switch tests | `tests/finn/goodhart/mechanism-interaction.test.ts` (new) | All AC10b-AC10h verified. Precedence chain tested end-to-end. |

**Task sizing**: T-1.1 (S), T-1.2 (M), T-1.3 (M), T-1.4 (M), T-1.5 (M), T-1.6 (M), T-1.7 (M), T-1.8 (S), T-1.9 (S), T-1.10 (M).
**Critical path**: T-1.2 → T-1.3 → T-1.4 (EMA must work before decay tests). T-1.5 and T-1.7 parallelizable after T-1.1.

**Rollback/recovery**: Kill switch (`FINN_REPUTATION_ROUTING=disabled`) is the safe-disable path. If EMA Lua script misbehaves, flush Redis keys prefixed `ema:` and restart with cold-start initialization. Feature flag `EXPLORATION_ENABLED=false` disables exploration independently.

**Sprint 1 acceptance**: Goodhart engine passes all unit tests with real Redis. Kill switch, exploration, decay, and calibration work independently and compose correctly via mechanism interaction rules. 10 tasks.

---

## Sprint 2: Reputation Query Bridge + Quality Signal (Global ID: 139)

**Goal**: Connect the Goodhart engine to dixie via the reputation adapter, wire the quality observation signal that closes the loop, and parallelize scoring with AbortSignal.any().

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-2.1 | Define ReputationResponse schema (TypeBox) | `src/hounfour/goodhart/reputation-response.ts` (new) | Schema validates v1 payloads. Forward-compat: v>1 uses known fields only. |
| T-2.2 | Enrich ReputationQueryFn type signature | `src/hounfour/types.ts` (modified) | AC11: `ReputationQueryFn = (query: { nftId, poolId, routingKey }, options?: { signal? }) => Promise<number \| null>`. Existing callers updated. |
| T-2.3 | Implement ReputationAdapter (decay + calibration + dixie) | `src/hounfour/goodhart/reputation-adapter.ts` (new) | AC11a: Different nftIds get different scores for same pool. AC12: Dixie unreachable → null. AC13: Decay + calibration applied before return. |
| T-2.4 | Implement Dixie transport (HTTP + direct + stub) | `src/hounfour/goodhart/dixie-transport.ts` (new) | Stub returns null. HTTP passes AbortSignal to fetch(). Degraded mode handling (bare number, null, version mismatch). |
| T-2.5 | Wire quality observation signal (QualityGateScorer → EMA) | `src/hounfour/goodhart/quality-signal.ts` (new) | §4.1.1b: After inference, QualityGateScorer → ReputationEventNormalizer → TemporalDecayEngine.updateEMA(). Event hash deterministic. |
| T-2.6 | Parallel scoring with AbortSignal.any() | `src/hounfour/tier-bridge.ts` (modified) | AC14: 5 pools ≤ 200ms. AC15: Individual timeout doesn't block others. AC16: Rejected = null. AC16a: Hung query aborted within 200ms. AbortSignal.any() composition (no listener leaks). |
| T-2.7 | Thread nftId through routing context | `src/hounfour/tier-bridge.ts`, `src/gateway/server.ts` (modified) | nftId from JWT claims passed to resolvePoolWithReputation(). |
| T-2.8 | Reputation adapter + parallel scoring tests | `tests/finn/goodhart/reputation-adapter.test.ts` (new), `tests/finn/goodhart/parallel-scoring.test.ts` (new) | All AC11-AC16a verified. Mock transport with configurable delays. |

**Task sizing**: T-2.1 (S), T-2.2 (S), T-2.3 (M), T-2.4 (M), T-2.5 (M), T-2.6 (L), T-2.7 (S), T-2.8 (M).
**Critical path**: T-2.1 → T-2.2 → T-2.3 → T-2.5 (schema → type → adapter → signal wiring). T-2.6 is independent L-size task (AbortSignal.any() composition).

**Rollback/recovery**: Stub transport (T-2.4) returns null, making dixie integration zero-behavioral-change. If quality signal causes EMA pollution, disable with `QUALITY_SIGNAL_ENABLED=false` and flush affected EMA keys. Parallel scoring fallback: sequential mode with `PARALLEL_SCORING=false`.

**Redis outage degradation mode**: If Redis is unreachable, the reputation adapter returns null (equivalent to stub transport). Routing falls back to deterministic tier assignment. Exploration is disabled (no state to read). Scoring uses conservative defaults (no EMA available). System logs `redis_degraded` metric and continues serving. No manual intervention required — recovery is automatic when Redis reconnects.

**Sprint 2 acceptance**: Reputation bridge connects Goodhart engine to dixie (or stub). Quality observation signal closes the loop from inference → EMA. Parallel scoring completes within 200ms budget. 8 tasks.

---

## Sprint 3: x402 Settlement System (Global ID: 140)

**Goal**: Upgrade x402 from local verification to full merchant relayer settlement with on-chain confirmation, abuse protection, and bounded concurrency.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-3.1 | Add chain/contract/recipient binding to verify.ts | `src/x402/verify.ts` (modified) | AC28a: Wrong `to` rejected. AC28b: Wrong chainId rejected. AC28c: Non-USDC token rejected. EIP-712 domain separator validated. |
| T-3.2 | Implement MerchantRelayer settlement state machine | `src/x402/settlement.ts` (modified) | AC30b: Inference only after receipt confirmed. AC30c: Used auth → 402. AC30d: Gas failure → 503 + alert. AC30e: Concurrent nonce → dedup. AC30f: Timeout → 503 Retry-After. Bounded concurrency semaphore (5 slots). |
| T-3.3 | DynamoDB settlement state table + GSI | `src/x402/settlement-store.ts` (new) | `finn-x402-settlements` PK=idempotencyKey. GSI `status-updated-index` for reconciliation. TTL on terminal states. |
| T-3.4 | Implement MicroUSDC branded type | `src/x402/denomination.ts` (modified) | AC30: MicroUSDC branded type in x402 path. No cross-type comparison compiles. |
| T-3.5 | Gas surcharge in quote pricing | `src/x402/pricing.ts` (modified) | AC30g: Gas surcharge included in X-Price header. Capped at 0.01 USDC. |
| T-3.6 | Conservation guard x402 mode | `src/hounfour/billing-conservation-guard.ts` (modified) | AC29: payment ≥ cost verified before invocation. AC30a: X-Price in MicroUSDC matches computeCostMicro(). |
| T-3.7 | x402 abuse protection (quote rate limit, dust, CPU DoS) | `src/x402/abuse-protection.ts` (new), `src/x402/verify.ts` (modified) | §7.1.1: IP rate limit 60 quotes/min. Dust rejection < 100 MicroUSDC before sig verify. Semaphore on concurrent verifications (10). |
| T-3.8 | Relayer gas monitoring | `src/x402/relayer-monitor.ts` (new) | §4.4.5: Balance check on startup. Periodic probe. Alert at threshold. Critical → refuse settlements. /health integration. |
| T-3.9 | Settlement reconciliation job | `src/x402/reconciliation.ts` (new) | §4.4.6: Periodic scan of non-terminal records. Pending > 1h → expired. Submitted > 10min → re-check receipt. |
| T-3.10 | Anvil chain profile + test fixtures | `tests/fixtures/anvil-chain-profile.ts` (new), `tests/fixtures/deploy-test-usdc.ts` (new) | Deterministic test chain config: chainId, RPC URL (Anvil localhost), USDC contract address (deployed mock ERC20 with EIP-3009 transferWithAuthorization), merchant address, funded relayer key. Script deploys mock USDC to Anvil at deterministic address. CI-safe: `pnpm test` starts Anvil, deploys fixtures, runs tests. |
| T-3.11 | x402 settlement + abuse protection tests | `tests/finn/x402/settlement.test.ts` (new), `tests/finn/x402/abuse.test.ts` (new) | All AC26-AC30g verified against Anvil fixtures (T-3.10). Settlement state machine transitions tested with DynamoDB Local. Abuse protection: quote rate limit, dust rejection, semaphore concurrency. |

**Task sizing**: T-3.1 (M), T-3.2 (L), T-3.3 (M), T-3.4 (S), T-3.5 (S), T-3.6 (M), T-3.7 (M), T-3.8 (M), T-3.9 (M), T-3.10 (L), T-3.11 (L).
**Critical path**: T-3.1 → T-3.2 → T-3.3 (verify → state machine → DynamoDB store). T-3.10 must complete before T-3.11 (Anvil fixtures before settlement tests). T-3.7 and T-3.8 parallelizable.

**Rollback/recovery**: `X402_SETTLEMENT_MODE=verify_only` bypasses on-chain settlement entirely (signature verification still runs). If relayer key compromised, rotate key in Secrets Manager and redeploy — pending settlements will fail with gas error, reconciliation job (T-3.9) marks them expired. DynamoDB conditional writes prevent duplicate settlements. Feature flag `X402_ENABLED=false` disables entire x402 path.

**Settlement Threat Model**:
| Threat | Mitigation | Sprint Task |
|--------|-----------|-------------|
| **Relayer key compromise** | Key in Secrets Manager (T-5.4), rotation = redeploy. Pending settlements fail-safe via reconciliation (T-3.9). Gas monitoring alerts on unexpected drain (T-3.8). | T-3.8, T-3.9, T-5.4 |
| **Payment replay** | Nonce semantics: `transferWithAuthorization` nonce is one-time on-chain. Idempotency key `{chainId}:{token}:{from}:{nonce}` prevents duplicate DynamoDB entries (T-3.3). | T-3.2, T-3.3 |
| **Front-running** | Relayer submits via private mempool (Flashbots Protect RPC or similar). `validAfter`/`validBefore` window constrains timing. Dust rejection prevents probe attacks (T-3.7). | T-3.2, T-3.7 |
| **Chain binding bypass** | EIP-712 domain separator includes `chainId` + `verifyingContract`. Wrong chain/contract → signature invalid (T-3.1). | T-3.1 |
| **Nonce exhaustion DoS** | Quote rate limit (60/min per IP) + dust rejection (<100 MicroUSDC) before signature verification. CPU DoS semaphore limits concurrent sig verifications to 10 (T-3.7). | T-3.7 |
| **Settlement monitoring gap** | Reconciliation job scans non-terminal records via GSI. Pending >1h → expired. Submitted >10min → re-check receipt. Relayer balance monitored with alert/critical thresholds (T-3.8). | T-3.8, T-3.9 |

**Sprint 3 acceptance**: Full x402 settlement flow with on-chain confirmation, abuse protection, gas monitoring, and reconciliation. DynamoDB settlement state machine tested. Deterministic Anvil chain profile for CI. 11 tasks.

---

## Sprint 4: Tamper-Evident Audit Trail (Global ID: 141)

**Goal**: Build the DynamoDB per-partition hash chain with S3 Object Lock immutable anchor, startup recovery, and conditional write failure recovery.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-4.1 | Implement DynamoAuditChain (append, init, extractTaskId) | `src/hounfour/audit/dynamo-audit.ts` (new) | AC-NFR2d: Separate partitions per ECS task. Stable partition ID from Task ARN. init() recovers last seq+hash. |
| T-4.2 | Conditional write failure recovery | `src/hounfour/audit/dynamo-audit.ts` (continued) | §4.6.1 recovery: Duplicate → no-op. Collision → resync + retry. >3 consecutive failures → degraded mode + alarm. |
| T-4.3 | Partition enumeration strategy | `src/hounfour/audit/dynamo-audit.ts` (continued) | §4.6.2: Scan with ProjectionExpression for distinct partitionIds. Paginated. |
| T-4.4 | Implement S3AuditAnchor (daily digest, KMS signing, Object Lock) | `src/hounfour/audit/s3-anchor.ts` (new) | AC-NFR2b: Daily KMS-signed digest to S3 Object Lock. 90-day COMPLIANCE retention. |
| T-4.5 | Implement verifyPartitionIntegrity + verifyAuditTrailIntegrity | `src/hounfour/audit/dynamo-audit.ts`, `src/hounfour/audit/s3-anchor.ts` | AC-NFR2a: Chain continuity verified on startup. AC-NFR2c: Tampered entry detected. |
| T-4.6 | CloudWatch fallback (§4.6.3) | `src/hounfour/audit/audit-fallback.ts` (new) | When DynamoDB unavailable, structured JSON to CloudWatch. Warning emitted. Routing never blocked. |
| T-4.7 | Wire audit chain into scoring path + settlement | `src/hounfour/goodhart/mechanism-interaction.ts`, `src/x402/settlement.ts` (modified) | Scoring path decisions logged to audit chain. Settlement events logged. Kill switch toggles logged. |
| T-4.8 | Audit trail unit + integration tests (LocalStack) | `tests/finn/audit/dynamo-audit.test.ts` (new), `tests/finn/audit/s3-anchor.test.ts` (new) | All AC-NFR2a-d verified against LocalStack (DynamoDB + S3 with Object Lock). KMS signing mocked (LocalStack KMS). Conditional write behavior validated. |

**Task sizing**: T-4.1 (M), T-4.2 (M), T-4.3 (S), T-4.4 (L), T-4.5 (M), T-4.6 (S), T-4.7 (M), T-4.8 (L).
**Critical path**: T-4.1 → T-4.2 → T-4.5 (chain → recovery → verification). T-4.4 independent but must complete before T-4.5 (S3 anchor verification). T-4.7 depends on Sprint 1+3 code existing.

**Rollback/recovery**: CloudWatch fallback (T-4.6) is the safe-disable path — if DynamoDB audit fails, structured logs go to CloudWatch and routing is never blocked. If hash chain becomes corrupted, `verifyPartitionIntegrity` detects it on next startup and emits alarm. Recovery: re-initialize partition from last known-good S3 daily digest. Feature flag: audit can be set to log-only mode (no conditional writes, no chain verification).

**Sprint 4 acceptance**: Tamper-evident audit trail operational with per-partition hash chains, startup recovery, S3 Object Lock anchoring, and CloudWatch fallback. All tests against LocalStack — real AWS staging validation deferred to Sprint 5 (T-5.8). 8 tasks.

---

## Sprint 5: AWS Deployment Pipeline (Global ID: 142)

**Goal**: Remove Fly.io permanently, wire GitHub Actions → ECR → ECS deployment, provision new AWS resources (DynamoDB, S3, KMS).

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-5.1 | Delete fly.toml + remove all Fly.io references | `deploy/fly.toml` (delete), 5 other files (edit) | AC17: `grep -ri fly.io` returns empty. `grep -ri flyctl` returns empty. |
| T-5.2 | Create GitHub Actions ECR/ECS deploy workflow | `.github/workflows/finn-deploy-aws.yml` (new) | AC19: Workflow pushes to ECR and updates ECS service. OIDC role authentication. |
| T-5.3 | Update Dockerfile for AWS SDK dependencies | `deploy/Dockerfile` (modified) | AC18: `docker build` produces image compatible with ecs-finn.tf. AWS SDK deps included. |
| T-5.4 | Wire Secrets Manager for new env vars | `src/config/aws-secrets.ts` (new or modified) | All new secrets (FINN_RELAYER_PRIVATE_KEY, FINN_MERCHANT_ADDRESS, KMS_KEY_ID, etc.) from Secrets Manager. |
| T-5.5 | Terraform additions for DynamoDB + S3 + KMS (loa-freeside PR) | `infrastructure/terraform/dynamodb-finn.tf`, `s3-finn-audit.tf`, `kms-finn.tf` (new, in freeside) | DynamoDB tables `finn-scoring-path-log` + `finn-x402-settlements` (with GSI). S3 bucket with Object Lock enabled at creation + versioning + COMPLIANCE 90d default retention. S3 calibration bucket (versioned, no lock). KMS key with policy granting ECS task role sign/verify. IAM policy additions to existing finn task role for DynamoDB, S3, KMS access. **Note**: ECS cluster, service, task definition, ECR repo, ALB, networking, CloudWatch log group, and execution role already exist in loa-freeside (`ecs-finn.tf`, `ecs.tf`, `ecr.tf`, `alb.tf`). Only new resources are DynamoDB/S3/KMS. |
| T-5.6 | Health endpoint Goodhart + audit + relayer fields | `src/gateway/server.ts` (modified) | AC20: /health responds with goodhart status, audit status, relayer balance. |
| T-5.7 | Validate deployment locally (docker build + health check) | (verification) | Docker image builds, starts, /health responds with all subsystem statuses. |
| T-5.8 | Staging validation: audit trail + Object Lock against real AWS | (verification against staging) | `terraform apply` creates resources. Audit chain appends 2+ entries to real DynamoDB. Daily digest writes to S3 with Object Lock retention metadata present. KMS signing succeeds with task role credentials. Confirms LocalStack tests (Sprint 4) match real AWS behavior. |

**Task sizing**: T-5.1 (S), T-5.2 (L), T-5.3 (S), T-5.4 (M), T-5.5 (L), T-5.6 (S), T-5.7 (M), T-5.8 (L).
**Critical path**: T-5.5 → T-5.8 (Terraform must apply before staging validation). T-5.1 can run first (deletion). T-5.2 and T-5.3 parallelizable.

**Rollback/recovery**: Terraform state is versioned — `terraform plan` before apply, review diff. S3 Object Lock COMPLIANCE mode is irreversible (see Risk Register). If deploy workflow fails, ECS service remains on previous task definition (blue/green via rolling update). Secrets Manager versions allow rollback to previous secret values. Compensating action for bad deploy: `aws ecs update-service --force-new-deployment` with previous task definition ARN.

**Sprint 5 acceptance**: Fly.io permanently removed. GitHub Actions deploys to ECR/ECS. New AWS resources provisioned. Audit trail validated against real AWS staging. Health endpoint reports all subsystem statuses. 8 tasks.

---

## Sprint 6: E2E Integration + Shadow Rollout (Global ID: 143)

**Goal**: Cross-system E2E tests with Docker Compose, shadow mode rollout, and feature flag verification.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-6.1 | Create docker-compose.e2e.yml (with LocalStack) | `docker-compose.e2e.yml` (new), `deploy/e2e/localstack-init.sh` (new) | AC21: `docker compose up` starts finn + freeside + Redis + Postgres + LocalStack (DynamoDB + S3). Init script creates DynamoDB tables (`finn-scoring-path-log`, `finn-x402-settlements` with GSI), S3 buckets (audit with Object Lock, calibration with seed JSONL), and KMS key. E2E tests exercise settlement record write/read, audit append, and calibration fetch against LocalStack endpoints. |
| T-6.2 | E2E: JWT exchange (finn ↔ freeside) | `tests/e2e/jwt-exchange.test.ts` (new) | AC22: Real ES256 JWT from freeside JWKS validates in finn. |
| T-6.3 | E2E: Billing flow (inference → debit → conservation) | `tests/e2e/billing-flow.test.ts` (new) | AC23: Full inference → billing debit → response with conservation guard. |
| T-6.4 | E2E: x402 flow (quote → payment → settlement → inference) | `tests/e2e/x402-flow.test.ts` (new) | AC24: Unauth → 402 with pricing. AC25: Valid payment → inference. |
| T-6.5 | E2E database init script | `deploy/e2e/init-db.sql` (new) | Creates finn_test and freeside_test databases. |
| T-6.6 | Implement shadow mode (§13.3) | `src/hounfour/goodhart/mechanism-interaction.ts` (modified) | Shadow: scoring runs, doesn't affect routing. Comparison logs emitted. Shadow metrics counters. No EMA writes in shadow. |
| T-6.7 | Feature flag verification tests | `tests/finn/goodhart/feature-flags.test.ts` (new) | §13.1: FINN_REPUTATION_ROUTING disabled/shadow/enabled. EXPLORATION_ENABLED. CALIBRATION_ENABLED. X402_SETTLEMENT_MODE verify_only/on_chain. |
| T-6.8 | Calibration HMAC integration test | `tests/finn/goodhart/calibration-hmac.test.ts` (new) | HMAC mismatch → data rejected, stale data retained. Valid HMAC → data applied. |
| T-6.9 | Full regression suite + CI green | (all tests) | All existing + new tests pass. `pnpm test` exits 0. |

**Task sizing**: T-6.1 (L), T-6.2 (M), T-6.3 (M), T-6.4 (L), T-6.5 (S), T-6.6 (M), T-6.7 (M), T-6.8 (S), T-6.9 (M).
**Critical path**: T-6.1 → T-6.2 → T-6.3 → T-6.4 (compose → JWT → billing → x402 E2E). T-6.6 and T-6.7 parallelizable after T-6.1.

**Rollback/recovery**: Shadow mode (T-6.6) IS the safe-rollout path — scoring runs but doesn't affect routing. If E2E tests reveal integration issues, fix without production risk. Feature flags (T-6.7) allow independent enable/disable of each subsystem. Full rollback: set `FINN_REPUTATION_ROUTING=disabled`, `X402_SETTLEMENT_MODE=verify_only` — system behaves as pre-cycle-034.

**Shadow Mode Graduation Criteria** (§13.3):
| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| **Minimum shadow window** | 72 hours continuous | Clock starts when `FINN_REPUTATION_ROUTING=shadow` deployed to production |
| **Routing divergence** | <5% of decisions differ from deterministic baseline | Compare shadow routing decision vs actual deterministic routing over window |
| **EMA stability** | No single-provider EMA drift >20% from mean | Monitor per-provider EMA values; flag if any diverge significantly |
| **Latency impact** | P99 latency increase <50ms from baseline | Shadow scoring adds parallel work; must not degrade response times |
| **Error rate** | Shadow scoring error rate <1% | Errors in shadow path (Redis timeouts, adapter failures) |
| **Exploration coverage** | Exploration events fire at configured ε rate ±2% | Bernoulli sampling produces expected distribution |
| **Audit chain health** | Zero hash chain breaks during window | Partition integrity verification passes on every startup |
| **Approval step** | Manual sign-off by @janitooor | Review shadow metrics dashboard, confirm graduation |

**Graduation process**: After all criteria met for 72h, change `FINN_REPUTATION_ROUTING=enabled` via env var update + ECS redeploy. If any criterion fails during shadow window, investigate root cause before re-attempting. Shadow mode can run indefinitely with zero production impact.

**Sprint 6 acceptance**: Cross-system E2E validates JWT exchange, billing, and x402 flows. Shadow mode enables safe rollout with explicit graduation criteria. All feature flags tested. Full regression green. 9 tasks.

---

## Summary

| Sprint | Global ID | Label | Tasks | Dependencies |
|--------|-----------|-------|-------|--------------|
| 1 | 138 | Goodhart Protection Engine | 10 | None |
| 2 | 139 | Reputation Query Bridge + Quality Signal | 8 | Sprint 1 |
| 3 | 140 | x402 Settlement System | 11 | None (parallel with 1-2) |
| 4 | 141 | Tamper-Evident Audit Trail | 8 | Sprint 1, 3 (wiring). Tests against LocalStack only. |
| 5 | 142 | AWS Deployment Pipeline | 8 | Sprint 3, 4 (Terraform). Includes real AWS staging validation for audit trail. |
| 6 | 143 | E2E Integration + Shadow Rollout | 9 | Sprint 1-5 |
| **Total** | | | **54** | |

### Dependency Graph

```
Sprint 1 (Goodhart) ──────────┐
                               ├── Sprint 2 (Reputation Bridge)
                               │
Sprint 3 (x402) ──────────────┤
                               ├── Sprint 4 (Audit Trail)
                               │
                               ├── Sprint 5 (AWS Deploy)
                               │
                               └── Sprint 6 (E2E + Rollout)
```

Sprints 1 and 3 can execute in parallel. Sprint 2 depends on Sprint 1. Sprint 4 depends on Sprints 1 and 3 (for wiring audit into scoring + settlement). Sprint 5 depends on Sprint 3 and 4 (Terraform resources). Sprint 6 depends on all previous sprints.

### Acceptance Criteria Traceability

| PRD AC | Sprint.Task |
|--------|-------------|
| AC1-AC3c | S1: T-1.2, T-1.3, T-1.4 |
| AC4-AC7c | S1: T-1.5, T-1.6 |
| AC8-AC10a | S1: T-1.7 |
| AC10b-AC10h | S1: T-1.8, T-1.9, T-1.10 |
| AC11-AC13 | S2: T-2.1, T-2.2, T-2.3, T-2.4 |
| AC14-AC16a | S2: T-2.6, T-2.8 |
| AC17-AC20 | S5: T-5.1, T-5.2, T-5.3, T-5.6 |
| AC21-AC23 | S6: T-6.1, T-6.2, T-6.3 |
| AC24-AC25 | S6: T-6.4 |
| AC26-AC28c | S3: T-3.1, T-3.10 |
| AC29-AC30a | S3: T-3.6 |
| AC30b-AC30g | S3: T-3.2, T-3.5, T-3.10 |
| AC-NFR2a-d | S4: T-4.1, T-4.4, T-4.5, T-4.8 |

### Task Size Distribution

| Size | Count | Definition |
|------|-------|------------|
| S (Small) | 15 | <2h — config, types, simple wiring |
| M (Medium) | 27 | 2-6h — single module with tests |
| L (Large) | 12 | 6-12h — complex integration, multiple dependencies |

### Risk Register

| Risk | Sprint | Mitigation |
|------|--------|------------|
| Redis Lua script complexity | S1 | T-1.4 tests with real Redis; Lua is <30 lines |
| Redis outage | S2 | Degradation mode: null reputation → deterministic routing, no exploration |
| Dixie adapter not ready | S2 | Stub transport (T-2.4) returns null; zero behavioral change |
| Anvil fork flaky for x402 tests | S3 | Separate integration test job; mock fallback for unit tests |
| Relayer key compromise | S3 | Secrets Manager + reconciliation job fail-safe (see Threat Model) |
| DynamoDB LocalStack discrepancies | S4 | Conditional write behavior verified against real DynamoDB in staging |
| S3 Object Lock COMPLIANCE irreversible | S5 | Test with GOVERNANCE mode first; COMPLIANCE only on production bucket |
| GitHub Actions workflow scope | S5 | PAT with workflow scope or OIDC role; document requirements |
| Docker Compose E2E slow | S6 | Parallel service startup; health check polling with timeout |
| Shadow graduation premature | S6 | Explicit 72h window + 8 criteria + manual sign-off required |
