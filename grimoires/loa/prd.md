# PRD: Loop Closure & Launch Infrastructure — Goodhart Protection, AWS Deployment, x402 Payments

> **Version**: 1.2.0
> **Date**: 2026-02-26
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-034
> **Predecessor**: cycle-033 "Hounfour v8.2.0 Upgrade" (sprints 132-137, all completed)
> **Command Center**: [Issue #66 Round 10](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3959406797)
> **Related Issues**: [#84 Dockerize + E2E](https://github.com/0xHoneyJar/loa-finn/issues/84), [#85 x402 Payments](https://github.com/0xHoneyJar/loa-finn/issues/85)

---

## 0. Framing — Why This Matters Now

The autopoietic feedback loop — where quality measurement influences future model selection — is the core value proposition of loa-finn's multi-model routing architecture. As of cycle-033, stages 1-2 and 4-6 are instrumented but the loop is **open**: `resolvePoolWithReputation()` accepts a `ReputationQueryFn` but has no production callers, and no governance mechanism prevents the closed loop from becoming a self-reinforcing bias.

The Bridgebuilder Deep Review of PR #107 identified this as the critical question: **not "when do we close the loop?" but "what governance mechanism prevents the closed loop from becoming a self-reinforcing bias?"** (Goodhart's Law: when quality metrics become optimization targets, they stop being good metrics.)

Simultaneously, loa-finn has no production deployment. The Fly.io configuration (`deploy/fly.toml`) was a placeholder — the actual production infrastructure lives in loa-freeside (formerly arrakis): AWS ECS Fargate with Terraform, complete with ECR, ALB, RDS, Redis, NATS, WAF, and observability. The `ecs-finn.tf` task definition already exists but finn has never been deployed to it.

This cycle delivers three things:
1. **Safe loop closure** — Goodhart protection mechanisms that make the autopoietic loop safe to activate
2. **Production deployment** — loa-finn running on the loa-freeside AWS infrastructure
3. **Permissionless payments** — x402 middleware enabling pay-per-request inference without accounts

### Why Now

1. **Dixie is on v8.2.0** — PR #25 merged, `ReputationStore.get(nftId)` available. The protocol vocabulary is shared. The only gap is the transport layer.
2. **Infrastructure exists** — `ecs-finn.tf` in loa-freeside Terraform is provisioned. No new cloud resources needed.
3. **All 6 autopoietic stages are instrumented** — The missing piece is governance (Goodhart protection), not plumbing.
4. **x402 is market-ready** — Coinbase reports 75M+ x402 transactions. Conway Terminal proved the flow. The economic loop from freeside is config-gated and ready.

---

## 1. Problem Statement

### P1: Ungovernored feedback loops produce bias
The autopoietic loop (`quality_signal → reputation_event → reputation_store → tier_resolution → model_selection → quality_measurement`) will, when closed without governance, converge on whichever model scores highest on the specific quality metrics being measured — even if those metrics don't capture true quality. Models that game the metrics (verbose responses score higher on "completeness," short responses score higher on "latency") will accumulate unfair reputation advantages.

> Source: Bridgebuilder Deep Review [REFRAME-1](https://github.com/0xHoneyJar/loa-finn/pull/107#issuecomment-3959346453), Goodhart's Law analysis

### P2: No production deployment
loa-finn runs locally only. The Fly.io configuration was a fallback that was never used. Production infrastructure exists in loa-freeside's Terraform (AWS ECS Fargate) with `ecs-finn.tf` already provisioned, but the deployment pipeline isn't wired.

> Source: [Issue #84](https://github.com/0xHoneyJar/loa-finn/issues/84), loa-freeside `infrastructure/terraform/ecs-finn.tf`

### P3: No permissionless payment rail
Inference requires pre-provisioned credit balances. Users must have accounts. x402 (HTTP 402 + USDC on Base) enables money-in inference-out without signup — the strategic payment rail for autonomous agents.

> Source: [Issue #85](https://github.com/0xHoneyJar/loa-finn/issues/85), RFC #66 Phase 4

---

## 2. Goals & Success Metrics

### Business Objectives

| Goal | Metric | Target |
|------|--------|--------|
| Safe loop closure | Autopoietic loop active with Goodhart protection | All 3 mechanisms deployed |
| Production deployment | loa-finn running on AWS ECS | Healthcheck green, <500ms p99 routing latency |
| Payment rail | x402 inference flow working | E2E: payment → inference → response |
| Cross-system E2E | Docker Compose with finn + freeside | JWT exchange + billing debit verified |

### Non-Goals (explicit)

- Deploying to Fly.io (infrastructure decision: AWS via loa-freeside Terraform, permanently)
- Full dixie HTTP API (only the `ReputationQueryFn` adapter is in scope)
- Production traffic migration (deployment readiness, not GA)
- Conway Terminal interop (depends on x402, but is next-cycle work)

---

## 3. User & Stakeholder Context

### Personas

| Persona | Need | This Cycle |
|---------|------|------------|
| **NFT holder** (agent owner) | Fair model routing that improves with use | Goodhart protection ensures reputation reflects real quality |
| **Autonomous agent** (x402 consumer) | Pay-per-request without account | x402 middleware + conservation guard |
| **Operator** (@janitooor) | Production deployment on existing infra | AWS ECS via freeside Terraform |
| **Dixie integration** (cross-repo) | Reputation query interface | `ReputationQueryFn` adapter with stub fallback |

---

## 4. Functional Requirements

### FR1: Goodhart Protection Mechanisms (HARD REQUIREMENT)

Three mechanisms must be implemented before the autopoietic loop can be activated in production. These are not optional enhancements — they are prerequisites for safe loop closure.

#### FR1.1: Temporal Decay

Reputation scores must decay over time so that stale performance data doesn't permanently lock in routing decisions.

- Old reputation observations contribute less to the aggregate score
- Configurable half-life (default: 7 days for task-cohort, 30 days for aggregate)
- Existing `emitScoringPathLog()` must log whether temporal decay was applied and the effective weight

**Decay Data Model**: Finn maintains a local EMA (Exponential Moving Average) cache keyed by `(nftId, poolId, routingKey)`. The cache is populated from dixie's reputation responses and updated on each reputation event. The decay computation uses the formula:

```
decayedScore = emaValue * exp(-ln(2) * (now - lastUpdateTimestamp) / halfLifeMs)
```

This requires dixie to return a **timestamped reputation payload**: `{ score: number, asOfTimestamp: string, sampleCount: number }` — not just a bare number. The adapter (FR2.1) is responsible for requesting this shape. If dixie returns only a bare score (stub mode), decay is skipped and the raw score is used with a `decay: "unavailable"` annotation in `ScoringPathLog`.

**Cache invalidation**: Entries expire after `2 * halfLife` with no updates. Redis is the backing store (key: `finn:ema:{nftId}:{poolId}:{routingKey}`, TTL: `2 * halfLife`).

**EMA Update Equation**: When a new reputation observation `(value, timestamp)` arrives:

```
alpha = 1 - exp(-ln(2) * (timestamp - lastUpdateTimestamp) / halfLifeMs)
newEma = alpha * value + (1 - alpha) * oldEma
```

Where `alpha` is the time-weighted smoothing factor. This produces a time-aware EMA where the weight of a new observation depends on how much time has elapsed since the last update — recent observations after a long gap have higher alpha (more influence), while rapid successive observations have lower alpha (less individual influence).

**Concurrency strategy**: All EMA reads and updates use a Redis Lua script (atomic GET + compute + SET) to prevent lost updates from concurrent ECS tasks or parallel scoring requests. The Lua script:
1. `GET` current `{ema, lastTimestamp}` for the key
2. Compute `alpha` and `newEma` using the equation above
3. `SET` new `{ema, lastTimestamp}` with TTL
4. Return the computed `decayedScore`

This guarantees serialization without distributed locks. If the key does not exist (cold start), the first observation sets `ema = value` directly.

**Ordering rules**: Reputation events carry a monotonic `asOfTimestamp` from dixie. If an out-of-order event arrives (its timestamp < `lastUpdateTimestamp` in Redis), it is **dropped with a warning log** rather than corrupting the EMA. The idempotency key is `{nftId}:{poolId}:{routingKey}:{eventHash}` stored in Redis SET NX with TTL = `2 * halfLife`.

**Acceptance Criteria**:
- AC1: A model that performed well 30 days ago but poorly in the last 3 days routes fewer requests than one that performed consistently
- AC2: Half-life is configurable per tier (enterprise may want slower decay)
- AC3: Decay computation is O(1) at query time using cached EMA + timestamp (no event history scan)
- AC3a: When dixie returns a timestamped payload, the decay formula produces a score that decreases monotonically as `(now - asOfTimestamp)` increases with no new events
- AC3b: Two concurrent EMA updates to the same key produce a valid EMA (no lost updates) — verified via parallel test with Redis
- AC3c: Out-of-order reputation events (timestamp < lastUpdate) are dropped with a warning, not applied

#### FR1.2: Epsilon-Greedy Exploration Budget

A configurable percentage of routing decisions must bypass reputation entirely to prevent the loop from starving models that had early bad luck.

**Algorithm**: Pure Bernoulli sampling with probability `epsilon` per request. On each routing decision, generate a uniform random `r ∈ [0,1)`. If `r < epsilon`, this is an exploration decision — select a pool uniformly at random from all tier-accessible pools. No persistent counter or Redis state is needed for the core algorithm; the law of large numbers ensures convergence to `epsilon` over sufficient requests.

- Default exploration rate: `epsilon = 0.05` (configurable per tier, `epsilon = 0` for authoritative tier)
- **Constrained candidate set**: Exploration does NOT select from all tier-accessible pools. The candidate set is filtered to pools that are:
  1. **Healthy**: Pool's circuit breaker is closed or half-open (not open/tripped)
  2. **Compatible**: Pool supports the requested routing key (model capability check)
  3. **Within cost bounds**: Pool's per-request cost is within 2x the tier's default pool cost (prevents exploration routing to dramatically more expensive models)
  4. **Not blocklisted**: Pool has not been manually excluded from exploration via config
  If the constrained candidate set is empty (all pools unhealthy or incompatible), exploration is skipped for that request and deterministic routing is used instead (logged as `path: "exploration_skipped", reason: "no_eligible_candidates"`).
- During exploration, pool selection is uniformly random across the **constrained** candidate set
- Exploration decisions are logged in `ScoringPathLog` with `path: "exploration"`, the selected pool, the random value `r`, and the candidate set size
- Exploration rate can be adjusted dynamically via config reload (but starts static)
- HITL evaluation interface: exploration results are tagged so operators can review whether exploration is discovering better models or wasting capacity
- **Observability counter** (Redis INCR, not algorithmic): `finn:explore:count:{tier}:{YYYY-MM-DD}` tracks daily exploration count per tier for dashboard reporting. This counter is best-effort — loss on restart does not affect the algorithm, only dashboard accuracy.

**Acceptance Criteria**:
- AC4: Over 1000 routing decisions with `epsilon=0.05`, exploration count is within `[30, 70]` (Bernoulli 95% CI)
- AC5: Exploration results are distinguishable from reputation-driven results in `ScoringPathLog` (includes `candidate_set_size`)
- AC6: Authoritative tier never explores (`epsilon=0` override, test verifies 0 explorations over 1000 decisions)
- AC7: HITL dashboard can filter exploration vs exploitation routing decisions via `ScoringPathLog.path` field
- AC7a: Exploration skips pools with open circuit breakers (test: trip a pool's breaker, verify it is excluded from exploration candidate set)
- AC7b: Exploration skips pools exceeding 2x cost ceiling (test: configure a pool at 3x cost, verify excluded)
- AC7c: When all candidate pools are unhealthy, exploration is skipped and deterministic routing is used (logged as `exploration_skipped`)

#### FR1.3: External Calibration via HITL Evaluation

A mechanism for human operators to inject ground-truth quality assessments that override or augment automated quality signals.

- Calibration entries are stored as `QualityObservation` events with `evaluator: "human"` (distinct from `evaluator: "quality-gates"`)
- Calibration observations have higher weight than automated signals (configurable multiplier, default 3x)
- Calibration entries are stored in a **versioned S3 object** (`s3://{bucket}/finn/calibration.jsonl`) polled with ETag-based conditional GET (every 60s, configurable). This ensures operators can update calibration without rebuilding containers or requiring persistent local storage on ECS Fargate.
- Local development uses a file-based fallback (`data/calibration.jsonl`) for testing without S3.
- Future: web UI for calibration (out of scope this cycle, but the data model supports it)

**Acceptance Criteria**:
- AC8: Human calibration entry for a model shifts its reputation score more than 3 automated observations
- AC9: Calibration entries validate against `QualityObservationSchema` with `evaluator: "human"`
- AC10: `resolvePoolWithReputation()` incorporates calibration data when available
- AC10a: Updating the S3 calibration object is reflected in routing within 60s (ETag poll interval) without container restart

#### FR1.4: Mechanism Interaction Rules (Flatline IMP-004)

The three Goodhart protection mechanisms (temporal decay, exploration, calibration) interact. Without explicit precedence rules, implementations will diverge and evaluation will be ambiguous.

**Precedence and composition rules**:

1. **Kill switch first** (FR1.5): If `FINN_REPUTATION_ROUTING=disabled`, skip ALL reputation-influenced routing. Return deterministic tier-default pool. No decay, no exploration, no calibration. This is the highest-precedence rule.

2. **Exploration overrides reputation**: If the Bernoulli coin flip selects exploration (`r < epsilon`), the exploration path is taken regardless of reputation scores or calibration data. Exploration results are tagged `path: "exploration"` and feed back into the EMA like any other observation — but with `source: "exploration"` metadata so HITL reviewers can distinguish exploration-sourced reputation updates from organic ones.

3. **Calibration overrides decay**: When computing the final reputation score for a pool, calibration observations are blended with the decayed EMA. The formula is:
   ```
   finalScore = (decayedEma * sampleCount + calibrationScore * calibrationWeight * calibrationCount)
                / (sampleCount + calibrationWeight * calibrationCount)
   ```
   Where `calibrationWeight` defaults to 3.0 (configurable). This is a weighted average — calibration entries have 3x the influence of automated observations per entry, but automated observations can still dominate if there are many more of them.

4. **Decay applies before calibration blending**: The EMA is decayed first, then blended with calibration. This ensures calibration entries for stale models don't accidentally resurrect them — the decay reduces the automated signal, and calibration augments the reduced signal.

5. **Exploration feedback weighting**: Exploration results feed into the EMA at `0.5x` weight (configurable) to prevent a single exploration observation from dramatically shifting reputation. This dampens noise from exploratory routing while still learning from it.

**Acceptance Criteria**:
- AC10b: When kill switch is active, all routing uses deterministic tier-default (zero reputation queries issued)
- AC10c: Exploration decisions are not influenced by calibration or decay (independent coin flip)
- AC10d: Calibration blending uses the weighted average formula with `calibrationWeight` multiplier
- AC10e: Exploration observations update EMA at reduced weight (`explorationWeight`, default 0.5)

#### FR1.5: Runtime Kill Switch (Flatline IMP-010)

A feature flag to disable reputation-influenced routing entirely, falling back to deterministic pool selection. Critical safety control for a closed-loop system.

- **Flag source**: Environment variable `FINN_REPUTATION_ROUTING` with values `enabled` (default) or `disabled`
- **Propagation**: Checked on every routing decision (not cached). Change takes effect on the next request.
- **Default behavior**: `enabled` — reputation routing is active when the flag is unset
- **When disabled**: `resolvePoolWithReputation()` short-circuits to `resolvePool()` (deterministic). No reputation queries are issued. No exploration coin flips. No calibration reads. Scoring path log records `path: "kill_switch"`.
- **Audit logging**: Every state transition (enabled→disabled or disabled→enabled) is logged as a `ScoringPathLog` entry with `action: "kill_switch_toggle"` and the actor (environment change).

**Acceptance Criteria**:
- AC10f: Setting `FINN_REPUTATION_ROUTING=disabled` causes all subsequent routing to use deterministic pool selection
- AC10g: Unsetting or setting to `enabled` restores reputation routing on the next request
- AC10h: Kill switch state transitions are logged in `ScoringPathLog`

### FR2: Reputation Query Bridge (Dixie Integration)

#### FR2.1: ReputationQueryFn Adapter

Build the transport layer between finn's `ReputationQueryFn` interface and dixie's `ReputationStore`.

- Adapter implements an **enriched query contract**: `ReputationQueryFn = (query: { nftId: string, poolId: PoolId, routingKey: NFTRoutingKey }) => Promise<number | null>`

  > **Note**: The existing `resolvePoolWithReputation()` signature uses `(poolId, routingKey)`. This cycle updates the signature to accept the enriched query object. The `nftId` is available in the routing context from JWT claims / NFT personality binding and must be threaded through `resolvePoolWithReputation()`.

- Internally calls dixie's reputation surface with `nftId` to get per-NFT reputation
- Applies temporal decay at query time using EMA cache (FR1.1)
- Incorporates calibration data if available (FR1.3), blended per FR1.4 precedence rules
- Returns clamped [0,1] score or null if no reputation data exists

**Reputation Response Schema** (versioned internal contract — Flatline SKP-001):

The adapter expects dixie to return a structured, timestamped payload — not a bare number. This is defined as a versioned internal schema (not a hounfour protocol type, since transport is implementation-specific):

```typescript
interface ReputationResponse {
  version: 1;                    // Schema version for forward compat
  score: number;                 // Aggregate reputation score [0, 1]
  asOfTimestamp: string;         // ISO 8601 UTC, monotonically increasing per nftId
  sampleCount: number;           // Number of observations in the aggregate (≥1)
  taskCohort?: {                 // Optional: per-task-type cohort score
    routingKey: string;
    score: number;
    sampleCount: number;
  };
}
```

**Timestamp semantics**: `asOfTimestamp` is UTC (ISO 8601 with `Z` suffix). Dixie guarantees monotonicity per `nftId` — a later response always has `asOfTimestamp >= previous asOfTimestamp` for the same NFT. If finn receives a response with `asOfTimestamp < lastKnownTimestamp` for that key, the response is stale and is discarded (defensive against clock skew or stale caches).

**Degraded modes**: When dixie cannot provide the full `ReputationResponse`:
- **Bare score** (stub mode): Adapter wraps it as `{ version: 1, score, asOfTimestamp: "unknown", sampleCount: 0 }`. Decay is skipped (`decay: "unavailable"` in log). Calibration still applies.
- **Null/error**: Adapter returns `null`. Routing falls back to deterministic.
- **Version mismatch**: If `version > 1`, adapter uses only the fields it understands (forward-compatible).

**Integration approach** (determined by dixie availability):
- **If dixie HTTP endpoint available**: HTTP client with circuit breaker, timeout (100ms), graceful degradation to null. Endpoint returns `ReputationResponse` JSON.
- **If dixie is same-process or shared library**: Direct import of `ReputationStore` interface, adapter constructs `ReputationResponse` from `ReputationAggregate`.
- **Stub fallback**: Returns null for all queries (preserves existing deterministic routing with zero behavioral change)

**Acceptance Criteria**:
- AC11: Adapter satisfies enriched `ReputationQueryFn` type contract with `nftId` in query
- AC11a: Two different `nftId` values can receive different reputation scores for the same `poolId`
- AC12: When dixie is unreachable, adapter returns null (no routing disruption)
- AC13: Temporal decay and calibration are applied before returning the score

#### FR2.2: Parallelize Reputation Scoring

`resolvePoolWithReputation()` currently scores pools sequentially. For enterprise tier (5 pools), switch to parallel scoring.

- Use `Promise.allSettled()` for concurrent pool scoring
- **Deadline propagation**: Create a shared `AbortController` with a 200ms timeout. Pass the `AbortSignal` into every reputation query and calibration read. Any work still pending when the deadline fires is cancelled and treated as null.
- Individual pool timeout: 100ms (rejected promise returns null) — enforced by per-query `AbortSignal` racing against the shared deadline
- Total scoring budget: 200ms wall-clock (hard cutoff via the shared `AbortController.abort()`)

**Acceptance Criteria**:
- AC14: Enterprise tier (5 pools) completes scoring in ≤200ms (vs current ~500ms sequential)
- AC15: Individual pool timeout doesn't block other pool scoring
- AC16: `settled` results with `status: "rejected"` are treated as null scores
- AC16a: When one reputation query hangs (simulated 5s delay), total scoring still completes within 200ms and the hung query is aborted

### FR3: AWS Production Deployment (loa-freeside Infrastructure)

#### FR3.1: Remove Fly.io, Wire AWS Deployment

Replace all Fly.io references with loa-freeside AWS infrastructure.

- Delete `deploy/fly.toml`
- Update `deploy/Dockerfile` for AWS ECR compatibility (if needed)
- Create or update GitHub Actions workflow for ECR push + ECS deploy (matching freeside's `deploy-production.yml` pattern)
- Wire AWS Secrets Manager for finn-specific secrets (API keys, JWT signing, Redis auth)
- Update all documentation that references Fly.io

**Acceptance Criteria**:
- AC17: Zero Fly.io references remain in the codebase (grep returns empty)
- AC18: `docker build` produces image compatible with `ecs-finn.tf` task definition
- AC19: GitHub Actions workflow pushes to ECR and updates ECS task definition
- AC20: Health endpoint responds at ALB-routed URL

#### FR3.2: Cross-System E2E Test Harness (#84)

Docker Compose topology with loa-finn + loa-freeside for local E2E testing.

- `docker-compose.e2e.yml` with both services, Redis, and PostgreSQL
- Real ES256 JWT exchange (not mocked)
- Test flow: `inference request → JWT validation → model routing → billing debit → response`

**Acceptance Criteria**:
- AC21: `docker compose -f docker-compose.e2e.yml up` starts all services
- AC22: E2E test validates JWT exchange between finn and freeside
- AC23: E2E test validates inference → billing debit → response flow

### FR4: x402 Pay-Per-Request Middleware (#85)

#### FR4.1: x402 Hono Middleware

- Intercept unauthenticated requests to inference endpoints
- Return `402 Payment Required` with pricing headers (`X-Price`, `X-Currency: USDC`, `X-Network: base`)
- Accept `X-Payment` header containing signed USDC transfer authorization

**Acceptance Criteria**:
- AC24: Unauthenticated request to `/api/v1/chat` returns 402 with pricing headers
- AC25: Request with valid `X-Payment` header receives inference response

#### FR4.2: EIP-3009 Payment Verification

- Verify `X-Payment` header contains valid `transferWithAuthorization` signature
- **Chain and contract binding** (critical security):
  - Validate `chainId == 8453` (Base mainnet) — reject signatures for other chains/testnets/forks
  - Validate `tokenContract == 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base) — reject signatures for other tokens
  - Validate `to == FINN_MERCHANT_ADDRESS` (configured via Secrets Manager) — reject signatures intended for a different recipient
  - Validate EIP-712 domain separator matches the expected USDC contract domain
- Validate: amount ≥ inference cost, nonce not replayed, deadline not expired
- Nonce replay protection via Redis SET NX with TTL (TTL = deadline - now + grace period)

**Acceptance Criteria**:
- AC26: Replayed payment nonces are rejected
- AC27: Expired deadline payments are rejected
- AC28: Underpayment (amount < cost) is rejected
- AC28a: Payment signed for a different `to` address is rejected even if signature is otherwise valid
- AC28b: Payment signed for a different chain (e.g., chainId 1 for Ethereum mainnet) is rejected
- AC28c: Payment signed for a non-USDC token contract is rejected

#### FR4.3: Conservation Guard x402 Mode

- `budget_conservation` fires against verified x402 payment amount instead of credit balance
- Conservation invariant: `payment_received ≥ inference_cost` before execution

**Denomination policy**: x402 pricing is denominated in **MicroUSDC only** (1 USDC = 1,000,000 MicroUSDC). The x402 endpoint returns `X-Price` in MicroUSDC. The conservation guard compares `payment_amount_micro_usdc >= inference_cost_micro_usdc` — both sides use the same unit. No USD/USDC FX conversion is needed because x402 is a USDC-native payment rail. The internal `MicroUSD` type is NOT used in the x402 path — it remains for credit-balance billing only.

**Acceptance Criteria**:
- AC29: Conservation guard verifies payment ≥ cost before model invocation
- AC30: `MicroUSDC` branded type used exclusively in x402 path; `MicroUSD` used exclusively in credit-balance path; no cross-type comparison compiles (TypeScript branded type prevents it)
- AC30a: `X-Price` header value is in MicroUSDC and matches the cost returned by `computeCostMicro()` converted to MicroUSDC at 1:1

#### FR4.4: Settlement Model (Flatline IMP-002 + SKP-006)

Verifying an EIP-3009 `transferWithAuthorization` signature is NOT the same as settlement. The PRD must define who submits on-chain, when, and what happens on failure.

**Settlement approach: Merchant Relayer (Option B)**

Finn operates a merchant relayer service that submits the `transferWithAuthorization` to the Base USDC contract and waits for transaction inclusion before serving inference.

**Flow**:
1. Client sends `X-Payment` header with signed EIP-3009 authorization
2. Finn verifies signature locally (chain binding, contract binding, amount, deadline, nonce — all FR4.2 checks)
3. Finn's relayer submits `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` to Base USDC contract
4. Finn waits for transaction receipt (confirmation: 1 block, timeout: 30s)
5. **On success**: Receipt proves on-chain settlement. Finn serves inference. Transaction hash logged.
6. **On failure (revert)**: Authorization was already used, cancelled, or invalid on-chain. Return `402` with `X-Payment-Error: settlement_failed` and revert reason.
7. **On timeout**: Transaction submitted but not confirmed within 30s. Return `503 Retry-After: 10` — client can retry with the same authorization (idempotent, since nonce prevents double-execution).
8. **On gas failure**: Relayer has insufficient ETH for gas. Return `503` with `X-Payment-Error: relayer_unavailable`. Alert operator.

**Gas responsibility**: The merchant (finn) pays gas for submitting the authorization. Gas cost is factored into the `X-Price` — the price includes a gas surcharge (configurable, default 5% of inference cost, capped at 0.01 USDC).

**Idempotency**: The EIP-3009 nonce is the idempotency key. If the same authorization is submitted twice:
- If already executed on-chain: The contract reverts with `EIP3009: authorization is used`. Finn returns the cached inference result (if available) or `402` with explanation.
- If in-flight: Finn deduplicates via Redis (key: `finn:x402:nonce:{nonce}`, TTL: 1 hour) and returns `429` until the first submission resolves.

**Chain reorg handling**: For Base L2, reorgs beyond 1 block are extremely rare. If a served inference's settlement tx is later reverted (detected via periodic reconciliation job), the event is logged as a `settlement_reorg` in the audit trail. No automatic clawback — this is an operational alert for manual review.

**Reconciliation**: A periodic job (every 5 minutes) compares `finn:x402:settled` Redis set against on-chain state for the last N transactions. Discrepancies are logged. This catches edge cases (reorgs, RPC inconsistencies) without blocking the hot path.

**Acceptance Criteria**:
- AC30b: Inference is served only after on-chain transaction receipt is confirmed (1 block)
- AC30c: Already-used authorization (on-chain replay) returns `402` with `settlement_failed` error
- AC30d: Relayer gas failure returns `503` with `relayer_unavailable` and triggers operator alert
- AC30e: Same nonce submitted concurrently is deduplicated (second request gets `429`)
- AC30f: Transaction timeout returns `503 Retry-After` (client can retry with same auth)
- AC30g: Gas surcharge is included in `X-Price` header

---

## 5. Technical & Non-Functional Requirements

### NFR1: Performance

| Metric | Target | Current |
|--------|--------|---------|
| Reputation query latency | ≤100ms p99 | N/A (not wired) |
| Pool scoring (5 pools) | ≤200ms p99 | ~500ms sequential |
| x402 payment verification | ≤50ms p99 | N/A |
| Health check response | ≤100ms | ≤50ms |

### NFR2: Reliability

- Reputation query failure must not break routing (graceful degradation to deterministic selection)
- x402 verification failure returns 402, not 500
- Exploration observability counter (Redis INCR) is best-effort — loss on restart does not affect the Bernoulli algorithm, only dashboard accuracy
- **Tamper-evident audit trail** (Flatline IMP-006 + SKP-005 — simplified design):

  **Problem**: A single linear hash chain breaks under concurrent writers (multiple ECS tasks). S3 Object Lock adds complexity and requires bucket configuration that may not exist.

  **Solution**: Per-partition hash chains stored in DynamoDB with conditional writes.

  - **Partitioning**: Each `ScoringPathLog` chain is partitioned by `{ecsTaskId}` (from `ECS_CONTAINER_METADATA_URI`). Each ECS task writes its own chain — no cross-task coordination needed. A single-task deployment (current) has one partition.
  - **Storage**: DynamoDB table `finn-scoring-path-log` with partition key `partitionId` and sort key `sequenceNumber` (monotonic counter per partition). Each entry includes `{ hash, prev_hash, timestamp, action, payload_hash, partitionId, sequenceNumber }`.
  - **Atomic writes**: DynamoDB `PutItem` with `ConditionExpression: attribute_not_exists(partitionId) AND attribute_not_exists(sequenceNumber)` ensures exactly-once writes. If a sequence number collision occurs (shouldn't with monotonic counter), the write fails and is retried with the next sequence number.
  - **Integrity verification**: `verifyPartitionIntegrity(partitionId)` reads all entries for a partition in sort-key order and recomputes the hash chain. Cross-partition integrity is verified by a daily signed digest.
  - **Immutable anchor** (critical for tamper-evidence): The daily digest (SHA-256 of all partition head hashes + timestamp) is **KMS-signed** and written to an **S3 bucket with Object Lock** (WORM, compliance mode, 90-day retention). This places the trust anchor outside the DynamoDB write domain — an attacker with DynamoDB write access cannot forge the S3 Object Lock checkpoint. The DynamoDB `_digest` item is a convenience copy; the authoritative digest is in S3. `verifyAuditTrailIntegrity()` compares the recomputed partition heads against the latest S3 checkpoint, verifying the KMS signature before accepting it.
  - **Fallback (no DynamoDB)**: If DynamoDB is unavailable, `ScoringPathLog` entries are written to CloudWatch Logs as structured JSON (best-effort, no hash chain). A warning is emitted. This ensures routing is never blocked by audit trail failures.

  - **AC-NFR2a**: Hash-chain continuity is verified on startup for the local partition (read last N entries, recompute hashes)
  - **AC-NFR2b**: Daily KMS-signed digest is written to S3 Object Lock bucket (immutable anchor) and DynamoDB `_digest` partition (convenience copy)
  - **AC-NFR2c**: Tampering with a single entry's hash causes `verifyPartitionIntegrity()` to return false
  - **AC-NFR2d**: Two concurrent ECS tasks write to separate partitions without conflicts

### NFR3: Security

- x402 payment verification must be stateless where possible (nonce replay uses Redis)
- No PII in scoring path logs (tenant hash only, per existing `emitScoringPathLog()`)
- AWS Secrets Manager for all credentials (no env vars, no config files)
- WAF rate limiting applies to x402 endpoints (prevent payment spam)

### NFR4: Observability

- Goodhart protection metrics: exploration rate, temporal decay factor distribution, calibration entry count
- Reputation query metrics: latency histogram, null rate, circuit breaker state
- x402 metrics: payment volume, rejection rate by reason, nonce collision rate

---

## 6. Scope & Prioritization

### In Scope (this cycle)

| Priority | Component | Dependency |
|----------|-----------|------------|
| P0 | Goodhart protection (FR1.1, FR1.2, FR1.3) | None |
| P0 | Remove Fly.io + wire AWS deployment (FR3.1) | None |
| P1 | Reputation query bridge (FR2.1) | Dixie adapter or stub |
| P1 | Parallelize scoring (FR2.2) | None |
| P1 | Cross-system E2E (FR3.2) | FR3.1 |
| P1 | x402 middleware (FR4.1, FR4.2, FR4.3) | None |

### Out of Scope (explicit)

| Item | Why | When |
|------|-----|------|
| Dixie HTTP endpoint | Dixie-side work, separate repo | Phase 3 (cross-repo) |
| Conway Terminal interop | Depends on x402 being live | Next cycle |
| Production traffic migration | Deployment readiness only this cycle | Post-E2E verification |
| Web UI for calibration | Data model supports it, UI is future | Next cycle |
| ReputationQueryProtocol schema in hounfour | Protocol formalization, not implementation | Phase 3 |
| QuarantineContext discriminated union | hounfour schema work | Phase 3 |

### MVP Definition

The minimum viable delivery is:
1. Goodhart protection mechanisms active and tested
2. loa-finn Docker image deployable to AWS ECS via GitHub Actions
3. x402 payment middleware with integration tests

---

## 7. Risks & Dependencies

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Dixie reputation adapter unavailable | Low (dixie on v8.2.0) | Medium | Stub adapter returns null; finn routes deterministically |
| x402 signature verification complexity | Medium | Medium | Start with mock verification, add on-chain validation iteratively |
| ECS task definition drift from `ecs-finn.tf` | Low | High | Validate Dockerfile against task def before deploy |
| Exploration budget counter lost on restart | Medium | Low | Redis-backed with TTL; counter resets are safe (exploration resumes at configured rate) |

### External Dependencies

| Dependency | Owner | Status | Fallback |
|-----------|-------|--------|----------|
| loa-dixie `ReputationStore` | loa-dixie | Available (v8.2.0, `PgReputationStore`) | Stub adapter |
| loa-freeside Terraform | loa-freeside | Available (`ecs-finn.tf` provisioned) | — |
| AWS credentials (ECR, ECS, Secrets Manager) | @janitooor | Needed for CI/CD | Local docker-compose for dev |
| `MicroUSDC` branded type | loa-hounfour | Available (v8.2.0) | — |
| EIP-3009 ABI / verification library | External (viem/ethers) | Available | — |

### Goodhart-Specific Risks

| Risk | Mechanism | Mitigation |
|------|-----------|------------|
| Exploration wastes capacity | Epsilon-greedy sends requests to poor models | 5% budget is small; HITL review can lower it |
| Temporal decay loses valuable history | Aggressive decay forgets proven models | Half-life tunable per tier; raw events preserved |
| Calibration bias | Human evaluators have their own biases | Weight multiplier is configurable; multiple evaluators supported |
| Metric gaming | Models optimize for measured dimensions | Multi-dimensional scoring (existing); challenge_rate and anti-sycophancy (cycle-031) |

---

## 8. Infrastructure Decision Record

### IDR-001: AWS ECS via loa-freeside Terraform (not Fly.io)

**Decision**: Deploy loa-finn to AWS ECS Fargate using the existing infrastructure in loa-freeside's Terraform.

**Context**: `deploy/fly.toml` existed as a placeholder. The production infrastructure was always intended to be AWS — `ecs-finn.tf` is already provisioned with:
- 512 CPU / 1024MB memory
- ECR repository `arrakis-production-loa-finn`
- ALB target group with health checks
- AWS Secrets Manager for credentials
- Cloud Map service discovery (`finn.production.local`)
- PgBouncer-finn for database connection pooling

**Consequences**:
- All Fly.io references must be removed (6 files identified)
- Deployment workflow must target ECR + ECS (not `fly deploy`)
- Secrets via AWS Secrets Manager (not `fly secrets`)
- Logs via CloudWatch (not `fly logs`)
- Health checks via ALB target group (not Fly.io machine checks)

**Status**: DECIDED — permanent. Fly.io will never be used for this project.

---

## Appendix A: Autopoietic Loop Stages (updated)

```
Stage 1: Quality signal
  └─ QualityGateScorer.scoreToObservation() [BUILT, Sprint 6 T-6.3]

Stage 2: Reputation event
  └─ normalizeReputationEvent() with KnownFoo [BUILT, Sprint 2 T-2.1 + Sprint 6 T-6.1]

Stage 3: Reputation store
  └─ dixie PgReputationStore [BUILT in dixie, adapter needed in finn — THIS CYCLE]

Stage 4: Tier resolution
  └─ resolvePoolWithReputation() [BUILT, Sprint 6 T-6.2]
  └─ Goodhart protection: temporal decay + exploration + calibration [THIS CYCLE]

Stage 5: Model selection
  └─ PoolRegistry.resolve() [BUILT]

Stage 6: Quality measurement
  └─ QualityObservation schema-validated [BUILT, Sprint 6 T-6.3]
```

## Appendix B: Fly.io Cleanup Manifest

| File | Action |
|------|--------|
| `deploy/fly.toml` | DELETE |
| `deploy/vllm/README.md` | UPDATE — remove Fly.io GPU section |
| `CHANGELOG.md` | UPDATE — remove Fly.io mentions |
| `grimoires/loa/context/research-minimal-pi.md` | UPDATE — document AWS decision |
| `.claude/settings.json` | UPDATE — remove `fly`/`flyctl` permissions |
| `.claude/commands/permission-audit.md` | UPDATE — remove flyctl references |
| `.claude/protocols/helper-scripts.md` | UPDATE — remove flyctl suggestions |
