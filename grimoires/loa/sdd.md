# SDD: Loop Closure & Launch Infrastructure — Goodhart Protection, AWS Deployment, x402 Payments

> **Version**: 1.2.0
> **Date**: 2026-02-26
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-034
> **PRD**: `grimoires/loa/prd.md` v1.2.0 (GPT-5.2 APPROVED iteration 4, Flatline APPROVED)

---

## 1. Overview

This SDD describes the technical design for closing the autopoietic feedback loop with Goodhart protection, deploying loa-finn to AWS ECS via loa-freeside infrastructure, and upgrading the x402 payment system with merchant relayer settlement.

**Design principles:**
- Goodhart protection mechanisms are **first-class subsystem**, not afterthought middleware
- Redis Lua atomicity for all EMA state mutations — no distributed locks
- `AbortController` deadline propagation for parallel scoring — hard 200ms wall-clock
- Existing x402 module extended with on-chain settlement, not replaced
- AWS infrastructure leverages existing loa-freeside Terraform — no new cloud resource provisioning
- Tamper-evident audit trail uses per-partition DynamoDB hash chains with S3 Object Lock immutable anchor

**What changes:**
- `resolvePoolWithReputation()` signature enriched with `nftId` query parameter
- New `ReputationQueryFn` contract: `(query: { nftId, poolId, routingKey }) => Promise<number | null>`
- New Goodhart protection engine: `src/hounfour/goodhart/` module
- x402 settlement upgraded from quote-verify-settle to full merchant relayer with on-chain confirmation
- Deployment target permanently changed from Fly.io to AWS ECS Fargate
- DynamoDB table + S3 Object Lock bucket for tamper-evident audit

---

## 2. System Architecture

### 2.1 High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           loa-finn                                  │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────────────────────────────┐  │
│  │  Hono Gateway │    │          Hounfour Layer                  │  │
│  │              │    │                                          │  │
│  │ /api/v1/*   ├───►│  tier-bridge.ts                          │  │
│  │ /api/v1/x402├─┐  │    ├── resolvePoolWithReputation()  ◄────┤  │
│  │ /health     │ │  │    │     (enriched: nftId + poolId       │  │
│  │             │ │  │    │      + routingKey)                   │  │
│  └──────────────┘ │  │    │                                     │  │
│                   │  │  ┌─▼────────────────────────────────┐    │  │
│                   │  │  │    Goodhart Protection Engine     │    │  │
│                   │  │  │                                  │    │  │
│                   │  │  │  ┌───────────┐ ┌────────────┐   │    │  │
│                   │  │  │  │ Temporal   │ │ Epsilon-   │   │    │  │
│                   │  │  │  │ Decay     │ │ Greedy     │   │    │  │
│                   │  │  │  │ (EMA+Lua) │ │ Exploration│   │    │  │
│                   │  │  │  └─────┬─────┘ └──────┬─────┘   │    │  │
│                   │  │  │        │               │         │    │  │
│                   │  │  │  ┌─────▼───────────────▼─────┐   │    │  │
│                   │  │  │  │   Mechanism Interaction    │   │    │  │
│                   │  │  │  │   Rules (FR1.4)           │   │    │  │
│                   │  │  │  └─────────────┬─────────────┘   │    │  │
│                   │  │  │        ┌───────▼──────┐          │    │  │
│                   │  │  │        │ Kill Switch  │          │    │  │
│                   │  │  │        │ (FR1.5)      │          │    │  │
│                   │  │  │        └──────────────┘          │    │  │
│                   │  │  │  ┌────────────┐                  │    │  │
│                   │  │  │  │ External   │                  │    │  │
│                   │  │  │  │ Calibration│                  │    │  │
│                   │  │  │  │ (S3-backed)│                  │    │  │
│                   │  │  │  └────────────┘                  │    │  │
│                   │  │  └──────────────────────────────────┘    │  │
│                   │  │                                          │  │
│                   │  │  ┌──────────────────────────────────┐    │  │
│                   │  │  │  Reputation Query Bridge          │    │  │
│                   │  │  │  (dixie adapter + parallel score) │    │  │
│                   │  │  └──────────────────────────────────┘    │  │
│                   │  └──────────────────────────────────────────┘  │
│                   │                                                 │
│                   │  ┌──────────────────────────────────────────┐  │
│                   └─►│  x402 Settlement (Merchant Relayer)      │  │
│                      │  EIP-3009 verify → on-chain submit       │  │
│                      │  → receipt confirm → serve inference      │  │
│                      └──────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Tamper-Evident Audit Trail                                  │  │
│  │  DynamoDB per-partition hash chain + S3 Object Lock anchor   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                    │
    ┌────▼───┐          ┌────▼───┐          ┌────▼────┐
    │ Redis  │          │ DynamoDB│          │ S3 WORM │
    │ (EMA,  │          │ (audit) │          │ (digest)│
    │  nonce)│          │         │          │         │
    └────────┘          └─────────┘          └─────────┘
         │
    ┌────▼────┐
    │  Dixie  │
    │ (RepStore)│
    └─────────┘
```

### 2.2 Request Flow: Reputation-Weighted Routing

```
Request → JWT Auth → Economic Boundary → Kill Switch Check
  │
  ├─ [disabled] → resolvePool() (deterministic) → Provider → Response
  │
  └─ [enabled] → Exploration Coin Flip (Bernoulli r < ε)
       │
       ├─ [explore] → Filter Candidate Set → Uniform Random Selection
       │               (healthy + compatible + cost-bounded + not blocklisted)
       │               → Provider → Response
       │               → Feed back at 0.5x weight to EMA
       │
       └─ [exploit] → Parallel Reputation Scoring (AbortController 200ms)
                       │
                       ├─ Per-pool: dixie adapter → ReputationResponse
                       │            → Temporal Decay (EMA Lua script)
                       │            → Calibration Blending (FR1.4)
                       │            → Clamped [0,1] score
                       │
                       └─ Best pool by score → Provider → Response
```

### 2.3 Request Flow: x402 Settlement

```
Request (no JWT, X-Payment header) → x402 Middleware
  │
  ├─ [no X-Payment] → 402 + Quote (X-Payment-Required header)
  │
  └─ [has X-Payment] → Parse proof → Verify signature
       │                  (chain: 8453, contract: USDC, recipient: merchant)
       │
       ├─ [invalid] → 402 + error details
       │
       └─ [valid] → Dedup check (Redis NX) → Submit on-chain
                     │
                     ├─ [receipt confirmed] → Conservation Guard → Inference → Response
                     ├─ [revert] → 402 settlement_failed
                     ├─ [timeout] → 503 Retry-After
                     └─ [gas fail] → 503 relayer_unavailable + alert
```

---

## 3. Technology Stack

| Layer | Technology | Justification |
|-------|-----------|---------------|
| Runtime | Node.js 22 (existing) | Already in Dockerfile, LTS |
| HTTP | Hono (existing) | Existing gateway, sub-app isolation for x402 |
| EMA State | Redis + Lua scripts | Atomic read-compute-write without distributed locks |
| Audit Store | DynamoDB | Per-partition hash chains, conditional writes for exactly-once |
| Immutable Anchor | S3 Object Lock (compliance mode) | WORM storage outside DynamoDB trust domain |
| Calibration | S3 versioned object | ETag-based conditional GET for hot reload without restart |
| On-chain | viem (existing in x402/) | Already used for EIP-3009 verification |
| Infrastructure | AWS ECS Fargate via loa-freeside Terraform | `ecs-finn.tf` already provisioned |
| CI/CD | GitHub Actions → ECR → ECS | Matching freeside deploy pattern |

### New Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| `@aws-sdk/client-dynamodb` | Audit trail storage | ^3.x |
| `@aws-sdk/client-s3` | Calibration reads + digest writes | ^3.x |
| `@aws-sdk/client-kms` | Daily digest signing | ^3.x |

### Existing Dependencies (no changes)

| Package | Used For |
|---------|----------|
| `ioredis` | EMA cache, nonce dedup, exploration counters |
| `viem` | EIP-3009 verification, on-chain settlement |
| `hono` | HTTP gateway |
| `@0xhoneyjar/loa-hounfour` | Protocol types, tier resolution |
| `@sinclair/typebox` | Schema validation |

---

## 4. Component Design

### 4.1 Goodhart Protection Engine

**New module**: `src/hounfour/goodhart/`

```
src/hounfour/goodhart/
├── index.ts                    # Re-exports
├── temporal-decay.ts           # EMA computation + Redis Lua
├── exploration.ts              # Bernoulli sampling + candidate filtering
├── calibration.ts              # S3-backed HITL calibration
├── mechanism-interaction.ts    # Precedence rules (FR1.4)
├── kill-switch.ts              # Feature flag (FR1.5)
├── reputation-adapter.ts       # ReputationQueryFn implementation
└── lua/
    └── ema-update.lua          # Atomic EMA update script
```

#### 4.1.1 Temporal Decay — EMA with Redis Lua

**File**: `src/hounfour/goodhart/temporal-decay.ts`

The EMA cache stores decayed reputation per `(nftId, poolId, routingKey)` tuple. All mutations use a Lua script for atomicity.

**Redis Key Schema**:
```
finn:ema:{nftId}:{poolId}:{routingKey}
```

**Redis Value** (JSON string):
```typescript
interface EMAState {
  ema: number           // Current EMA value [0, 1]
  lastTimestamp: number  // Unix millis of last update
  sampleCount: number   // Number of observations incorporated
}
```

**TTL**: `2 * halfLifeMs` (default: 14 days for task-cohort, 60 days for aggregate)

**Lua Script** (`lua/ema-update.lua`):

```lua
-- KEYS[1] = finn:ema:{nftId}:{poolId}:{routingKey}
-- ARGV[1] = new observation value
-- ARGV[2] = observation timestamp (unix millis)
-- ARGV[3] = halfLifeMs
-- ARGV[4] = TTL seconds
-- ARGV[5] = event hash (for inline idempotency check)

-- 1. GET current state (idempotency is checked inline via lastEventHash)
local raw = redis.call("GET", KEYS[1])
local value = tonumber(ARGV[1])
local timestamp = tonumber(ARGV[2])
local halfLife = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

if raw == false then
  -- Cold start: first observation
  local state = cjson.encode({ema = value, lastTimestamp = timestamp, sampleCount = 1, lastEventHash = ARGV[5]})
  redis.call("SET", KEYS[1], state, "EX", ttl)
  return state
end

local state = cjson.decode(raw)

-- 2. Idempotency check: compare against last-seen event hash stored in EMA state
-- This is O(1) per key — no separate idempotency keys, no unbounded growth
if state.lastEventHash == ARGV[5] then
  return raw  -- Duplicate event, return existing state
end

-- 3. Out-of-order check
if timestamp < state.lastTimestamp then
  return raw  -- Drop stale event
end

-- 4. Compute alpha and new EMA
local dt = timestamp - state.lastTimestamp
local alpha = 1 - math.exp(-0.693147 * dt / halfLife)  -- ln(2) ≈ 0.693147
local newEma = alpha * value + (1 - alpha) * state.ema

-- 5. SET new state (include lastEventHash for idempotency)
local newState = cjson.encode({
  ema = newEma,
  lastTimestamp = timestamp,
  sampleCount = state.sampleCount + 1,
  lastEventHash = ARGV[5]
})
redis.call("SET", KEYS[1], newState, "EX", ttl)
return newState
```

**Bounded idempotency**: Instead of creating a separate Redis key per event (which would grow unbounded over the EMA TTL window), idempotency is tracked by storing the `lastEventHash` directly in the EMA state value. The Lua script compares the incoming event hash against the stored one — if they match, the event is a duplicate and the existing state is returned. This is O(1) per EMA key with zero additional memory overhead. The tradeoff is that only the most recent event is deduplicated; very old replays (where intermediate events have already updated `lastEventHash`) will be caught by the out-of-order timestamp check instead.

**TypeScript Interface**:

```typescript
interface TemporalDecayConfig {
  halfLifeMs: number           // Default: 7 * 24 * 60 * 60 * 1000 (7 days)
  aggregateHalfLifeMs: number  // Default: 30 * 24 * 60 * 60 * 1000 (30 days)
  redis: RedisCommandClient
}

class TemporalDecayEngine {
  constructor(config: TemporalDecayConfig)

  /** Update EMA with new observation. Atomic via Lua. */
  updateEMA(key: EMAKey, value: number, timestamp: number, eventHash: string): Promise<EMAState>

  /** Query decayed score at current time. O(1). */
  getDecayedScore(key: EMAKey): Promise<{ score: number; decay: "applied" | "unavailable" } | null>
}

interface EMAKey {
  nftId: string
  poolId: PoolId
  routingKey: NFTRoutingKey
}
```

**Decay at query time**: When `getDecayedScore()` is called, the stored EMA is further decayed to `now`:

```
decayedScore = emaValue * exp(-ln(2) * (now - lastTimestamp) / halfLifeMs)
```

This is a pure read — no Redis write on query.

#### 4.1.1b Quality Observation Signal

The EMA requires a numeric observation value ∈ [0, 1] per inference request. This section defines the **quality signal** that closes the autopoietic loop.

**Signal source**: The existing `QualityGateScorer` (`src/hounfour/quality-gate-scorer.ts`) produces a `QualityObservation` from each inference response. The `scoreToObservation()` function at line 89 computes a composite score from:

| Factor | Weight | Source | Range |
|--------|--------|--------|-------|
| Latency percentile | 0.3 | Response time vs p50/p95 of pool's recent history | 0 (>p95) to 1 (<p50) |
| Error indicator | 0.4 | 0 if provider error/timeout, 1 if successful response | binary |
| Content quality | 0.3 | Model-reported finish_reason + token utilization ratio | 0-1 |

**Composite formula**:
```
observation = (latencyScore * 0.3) + (errorScore * 0.4) + (contentScore * 0.3)
```

**Flow**: After each inference response:
1. `QualityGateScorer.scoreToObservation(response, pool, latencyMs)` → `QualityObservation`
2. `ReputationEventNormalizer.normalize(observation)` → `ReputationEvent`
3. `TemporalDecayEngine.updateEMA(key, event.score, event.timestamp, event.hash)` → updated EMA

**Event hash**: `SHA-256(nftId + poolId + routingKey + timestamp + score)` — deterministic, used for inline idempotency check in the Lua script.

**Exploration observations**: When the scoring path is `exploration`, the observation is weighted at `explorationFeedbackWeight` (0.5) before feeding into the EMA. This prevents exploration noise from dominating the decayed score.

**Cold start**: When no EMA exists for a (nftId, poolId, routingKey) tuple, the first observation initializes the EMA directly (`ema = observation`). No bootstrapping or synthetic data is needed — the system gracefully transitions from deterministic routing to reputation-weighted routing as observations accumulate.

#### 4.1.2 Epsilon-Greedy Exploration

**File**: `src/hounfour/goodhart/exploration.ts`

```typescript
interface ExplorationConfig {
  /** Default epsilon per tier. Key = tier name, value = epsilon ∈ [0, 1]. */
  epsilonByTier: Record<string, number>
  /** Default epsilon when tier not in map. */
  defaultEpsilon: number  // 0.05
  /** Blocklisted pool IDs (excluded from exploration). */
  blocklist: ReadonlySet<PoolId>
  /** Max cost multiplier for exploration candidates. */
  costCeiling: number  // 2.0
  /** Redis client for observability counters. */
  redis: RedisCommandClient
}

interface ExplorationDecision {
  explore: boolean
  candidateSetSize: number
  selectedPool?: PoolId
  randomValue: number
  reason?: string  // "exploration_skipped" when no eligible candidates
}

class ExplorationEngine {
  constructor(config: ExplorationConfig)

  /**
   * Decide whether to explore and, if so, select a pool.
   * Pure Bernoulli: Math.random() < epsilon.
   */
  decide(
    tier: Tier,
    accessiblePools: readonly PoolId[],
    circuitBreakerStates: Map<PoolId, "closed" | "half-open" | "open">,
    poolCosts: Map<PoolId, number>,
    defaultPoolCost: number,
    routingKey: NFTRoutingKey,
    poolCapabilities: Map<PoolId, Set<NFTRoutingKey>>,
  ): ExplorationDecision

  /** Increment daily observability counter (best-effort). */
  recordExploration(tier: string): Promise<void>
}
```

**Candidate Set Filtering** (FR1.2 constrained):

```typescript
function filterCandidateSet(
  pools: readonly PoolId[],
  circuitBreakerStates: Map<PoolId, "closed" | "half-open" | "open">,
  poolCosts: Map<PoolId, number>,
  defaultPoolCost: number,
  costCeiling: number,
  routingKey: NFTRoutingKey,
  poolCapabilities: Map<PoolId, Set<NFTRoutingKey>>,
  blocklist: ReadonlySet<PoolId>,
): PoolId[] {
  return pools.filter(pool => {
    // 1. Healthy: circuit breaker closed or half-open
    const cbState = circuitBreakerStates.get(pool) ?? "closed"
    if (cbState === "open") return false

    // 2. Compatible: pool supports requested routing key
    const caps = poolCapabilities.get(pool)
    if (caps && !caps.has(routingKey)) return false

    // 3. Within cost bounds: pool cost <= costCeiling * default
    const cost = poolCosts.get(pool) ?? 0
    if (cost > costCeiling * defaultPoolCost) return false

    // 4. Not blocklisted
    if (blocklist.has(pool)) return false

    return true
  })
}
```

**Observability Counter** (best-effort):
```
finn:explore:count:{tier}:{YYYY-MM-DD}
```
Redis INCR with TTL = 48 hours. Loss on restart is acceptable.

#### 4.1.3 External Calibration via S3

**File**: `src/hounfour/goodhart/calibration.ts`

```typescript
interface CalibrationConfig {
  s3Bucket: string
  s3Key: string                  // "finn/calibration.jsonl"
  pollIntervalMs: number         // 60000 (1 minute)
  localFallbackPath?: string     // "data/calibration.jsonl"
  calibrationWeight: number      // 3.0
  /** HMAC key for calibration data integrity verification (from Secrets Manager). */
  hmacSecret: string
}

interface CalibrationEntry {
  nftId: string
  poolId: PoolId
  routingKey: NFTRoutingKey
  score: number                  // [0, 1]
  evaluator: "human"
  timestamp: string              // ISO 8601
  note?: string
}

class CalibrationEngine {
  private entries: Map<string, CalibrationEntry[]>  // keyed by {nftId}:{poolId}:{routingKey}
  private lastETag: string | null
  private pollTimer: ReturnType<typeof setInterval> | null

  constructor(config: CalibrationConfig)

  /** Start ETag-based polling. Returns immediately. */
  startPolling(): void

  /** Stop polling. For graceful shutdown. */
  stopPolling(): void

  /** Get calibration data for a key. Returns empty array if none. */
  getCalibration(nftId: string, poolId: PoolId, routingKey: NFTRoutingKey): CalibrationEntry[]

  /** Blend calibration with decayed EMA (FR1.4 formula). */
  blendWithDecay(
    decayedEma: number,
    sampleCount: number,
    calibrationEntries: CalibrationEntry[],
  ): number
}
```

**Blending formula** (FR1.4 §3):

```
finalScore = (decayedEma * sampleCount + calibrationScore * calibrationWeight * calibrationCount)
             / (sampleCount + calibrationWeight * calibrationCount)
```

Where `calibrationScore` is the mean of all calibration entries for that key, and `calibrationWeight` defaults to 3.0.

**S3 Polling**:
- Uses `GetObject` with `If-None-Match: {lastETag}`
- 304 Not Modified → no-op (no parsing, no allocation)
- 200 → verify HMAC signature before parsing (see below), parse JSONL, rebuild lookup map, update `lastETag`
- HMAC mismatch → log alarm-severity warning, retain existing entries, do NOT apply tainted data
- Error → log warning, retain existing entries

**Calibration HMAC integrity** (defense-in-depth):
The calibration JSONL file includes a trailing HMAC line: `{"hmac":"<hex>"}`. The HMAC is computed as `HMAC-SHA256(hmacSecret, content_before_hmac_line)`. On fetch:
1. Split last line from body.
2. Verify HMAC against `hmacSecret` (from Secrets Manager).
3. If valid → parse entries. If invalid → reject and retain stale data.

This prevents an attacker with S3 write access (but not Secrets Manager access) from injecting biased calibration entries to manipulate reputation scores. The HMAC secret is stored in Secrets Manager, separate from S3 IAM permissions.

**Local Fallback** (dev mode): When `localFallbackPath` is set and S3 is unreachable (no `AWS_REGION` or connection failure), reads from local JSONL file at startup. No hot-reload in local mode.

#### 4.1.4 Mechanism Interaction Rules

**File**: `src/hounfour/goodhart/mechanism-interaction.ts`

This module implements the precedence rules from FR1.4 as a single entry point for reputation-weighted pool selection.

```typescript
interface MechanismConfig {
  decay: TemporalDecayEngine
  exploration: ExplorationEngine
  calibration: CalibrationEngine
  killSwitch: KillSwitch
  explorationFeedbackWeight: number  // 0.5
}

interface ReputationScoringResult {
  pool: PoolId
  score: number | null
  path: "kill_switch" | "exploration" | "reputation" | "deterministic" | "exploration_skipped"
  metadata: {
    decayApplied?: boolean
    calibrationApplied?: boolean
    explorationCandidateSetSize?: number
    randomValue?: number
  }
}

/**
 * Orchestrate all Goodhart protection mechanisms per FR1.4 precedence:
 * 1. Kill switch → deterministic
 * 2. Exploration → random from constrained candidate set
 * 3. Reputation → decay + calibration blending → best score
 */
async function resolveWithGoodhart(
  config: MechanismConfig,
  tier: Tier,
  nftId: string,
  taskType: string | undefined,
  nftPreferences: Record<string, string> | undefined,
  accessiblePools: readonly PoolId[],
  circuitBreakerStates: Map<PoolId, "closed" | "half-open" | "open">,
  poolCosts: Map<PoolId, number>,
  defaultPoolCost: number,
  poolCapabilities: Map<PoolId, Set<NFTRoutingKey>>,
  abortSignal?: AbortSignal,
): Promise<ReputationScoringResult>
```

**Precedence implementation**:

```typescript
// 1. Kill switch first
if (config.killSwitch.isDisabled()) {
  return {
    pool: resolvePool(tier, taskType, nftPreferences),
    score: null,
    path: "kill_switch",
    metadata: {},
  }
}

// 2. Exploration coin flip
const routingKey = taskType ? mapUnknownTaskTypeToRoutingKey(taskType) : "default"
const explorationDecision = config.exploration.decide(
  tier, accessiblePools, circuitBreakerStates,
  poolCosts, defaultPoolCost, routingKey, poolCapabilities,
)

if (explorationDecision.explore && explorationDecision.selectedPool) {
  // Exploration selected a valid candidate — use it
  return {
    pool: explorationDecision.selectedPool,
    score: null,
    path: "exploration",
    metadata: {
      explorationCandidateSetSize: explorationDecision.candidateSetSize,
      randomValue: explorationDecision.randomValue,
    },
  }
}

// If exploration was triggered but no eligible candidates existed,
// fall through to reputation scoring (NOT deterministic fallback).
// This ensures the feedback loop can still close for constrained tiers.
// The exploration_skipped path is logged for observability.
if (explorationDecision.explore && !explorationDecision.selectedPool) {
  // Log but continue to reputation scoring below
  logScoringPath("exploration_skipped", { reason: "no_eligible_candidates", randomValue: explorationDecision.randomValue })
}

// 3. Reputation scoring with decay + calibration
// (parallel scoring with AbortController — see §4.2.3)
// Falls back to deterministic resolvePool() ONLY when all reputation queries return null/invalid.
```

**Exploration feedback weighting** (FR1.4 §5):

When an exploration result feeds back into the EMA, the observation is weighted at `explorationFeedbackWeight` (default 0.5):

```typescript
// After inference completes for an exploration decision:
await decayEngine.updateEMA(key, score * config.explorationFeedbackWeight, timestamp, eventHash)
```

#### 4.1.5 Runtime Kill Switch

**File**: `src/hounfour/goodhart/kill-switch.ts`

```typescript
class KillSwitch {
  /** Check if reputation routing is disabled. Reads env on every call (no cache). */
  isDisabled(): boolean {
    return process.env.FINN_REPUTATION_ROUTING === "disabled"
  }

  /** Log state transition for audit trail. */
  logTransition(previousState: boolean, currentState: boolean): void {
    if (previousState !== currentState) {
      const action = currentState ? "disabled" : "enabled"
      console.log(JSON.stringify({
        component: "kill-switch",
        event: "state_transition",
        action: `kill_switch_toggle`,
        from: previousState ? "disabled" : "enabled",
        to: action,
        timestamp: new Date().toISOString(),
      }))
    }
  }
}
```

The kill switch is the simplest component: a single env var check on every routing decision. No caching — `process.env` reads are fast enough (~100ns) and caching would delay propagation of changes.

### 4.2 Reputation Query Bridge

#### 4.2.1 Enriched ReputationQueryFn

**File**: `src/hounfour/goodhart/reputation-adapter.ts`

The existing `ReputationQueryFn` type in `src/hounfour/types.ts` takes `(poolId, routingKey)`. This cycle enriches it with `nftId`:

**Current** (`src/hounfour/types.ts:290`):
```typescript
export type ReputationQueryFn = (
  poolId: PoolId,
  routingKey: NFTRoutingKey,
) => Promise<number | null>
```

**New** (same file, updated):
```typescript
export interface ReputationQuery {
  nftId: string
  poolId: PoolId
  routingKey: NFTRoutingKey
}

export interface ReputationQueryOptions {
  signal?: AbortSignal
}

export type ReputationQueryFn = (
  query: ReputationQuery,
  options?: ReputationQueryOptions,
) => Promise<number | null>
```

**AbortSignal threading**: The `signal` is passed from the shared `AbortController` (200ms deadline) through every reputation query and into the Dixie transport layer. Transports must honor the signal by passing it to `fetch()` or equivalent I/O calls. If aborted, the query rejects immediately — `Promise.allSettled` captures it as `"rejected"`.

**Migration**: `resolvePoolWithReputation()` in `tier-bridge.ts:108` currently calls `reputationQuery(poolId, routingKey)`. Updated to `reputationQuery({ nftId, poolId, routingKey })`. The `nftId` is threaded from JWT claims through the routing context.

**Adapter Implementation**:

```typescript
class ReputationAdapter {
  constructor(
    private decay: TemporalDecayEngine,
    private calibration: CalibrationEngine,
    private transport: DixieTransport | null,  // null = stub mode
  )

  async query(q: ReputationQuery): Promise<number | null> {
    // 1. Fetch from dixie
    const response = await this.fetchFromDixie(q)

    // 2. If null/error, return null (deterministic fallback)
    if (!response) return null

    // 3. Update EMA with observation (if timestamped)
    if (response.asOfTimestamp !== "unknown") {
      const timestamp = new Date(response.asOfTimestamp).getTime()
      const eventHash = hashReputationEvent(q, response)
      await this.decay.updateEMA(
        { nftId: q.nftId, poolId: q.poolId, routingKey: q.routingKey },
        response.score,
        timestamp,
        eventHash,
      )
    }

    // 4. Get decayed score
    const decayed = await this.decay.getDecayedScore({
      nftId: q.nftId, poolId: q.poolId, routingKey: q.routingKey,
    })

    if (!decayed) return response.score  // No EMA yet, use raw

    // 5. Blend with calibration (FR1.4 precedence: decay before calibration)
    const calibrationEntries = this.calibration.getCalibration(
      q.nftId, q.poolId, q.routingKey,
    )

    if (calibrationEntries.length > 0) {
      return this.calibration.blendWithDecay(
        decayed.score,
        (await this.decay.getEMAState({ nftId: q.nftId, poolId: q.poolId, routingKey: q.routingKey }))?.sampleCount ?? 1,
        calibrationEntries,
      )
    }

    // 6. Return decayed score, clamped
    return Math.max(0, Math.min(1, decayed.score))
  }
}
```

#### 4.2.2 ReputationResponse Schema

**File**: `src/hounfour/goodhart/reputation-response.ts`

Versioned internal contract (not a hounfour protocol type):

```typescript
import { Type, type Static } from "@sinclair/typebox"

export const ReputationResponseSchema = Type.Object({
  version: Type.Literal(1),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  asOfTimestamp: Type.String(),  // ISO 8601 UTC or "unknown"
  sampleCount: Type.Integer({ minimum: 0 }),
  taskCohort: Type.Optional(Type.Object({
    routingKey: Type.String(),
    score: Type.Number({ minimum: 0, maximum: 1 }),
    sampleCount: Type.Integer({ minimum: 0 }),
  })),
})

export type ReputationResponse = Static<typeof ReputationResponseSchema>
```

**Degraded modes**:

| Dixie Returns | Adapter Behavior |
|--------------|-----------------|
| Full `ReputationResponse` | Normal: decay + calibration |
| Bare number | Wrap as `{ version: 1, score, asOfTimestamp: "unknown", sampleCount: 0 }`. Decay skipped. |
| Error / null | Return `null`. Deterministic fallback. |
| `version > 1` | Forward-compatible: use only known fields. |

#### 4.2.3 Parallel Scoring with AbortController

**File**: Modified `src/hounfour/tier-bridge.ts`

The current `resolvePoolWithReputation()` scores pools sequentially (`for...of` at line 134). This cycle switches to `Promise.allSettled()` with a shared `AbortController`.

```typescript
export async function resolvePoolWithReputation(
  tier: Tier,
  nftId: string,
  taskType?: string,
  nftPreferences?: Record<string, string>,
  reputationQuery?: ReputationQueryFn,
): Promise<PoolId> {
  if (!reputationQuery) {
    return resolvePool(tier, taskType, nftPreferences)
  }

  const accessiblePools = TIER_POOL_ACCESS[tier]
  if (accessiblePools.length <= 1) {
    return resolvePool(tier, taskType, nftPreferences)
  }

  const routingKey: NFTRoutingKey = taskType
    ? mapUnknownTaskTypeToRoutingKey(taskType)
    : "default"

  // Shared deadline: 200ms wall-clock
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 200)

  try {
    const results = await Promise.allSettled(
      accessiblePools.map(async (poolId) => {
        // Per-query timeout: 100ms (races against shared 200ms deadline)
        const perQueryController = new AbortController()
        const perQueryTimeout = setTimeout(() => perQueryController.abort(), 100)

        // Compose signals: abort per-query if either its own timeout or shared deadline fires.
        // AbortSignal.any() (Node 22+) avoids listener accumulation on the shared controller.
        const composedSignal = AbortSignal.any([controller.signal, perQueryController.signal])

        try {
          const score = await reputationQuery(
            { nftId, poolId, routingKey },
            { signal: composedSignal },  // Composed: per-query + shared deadline
          )
          return { poolId, score }
        } finally {
          clearTimeout(perQueryTimeout)
        }
      })
    )

    // Find best pool from fulfilled results
    let bestPool: PoolId | null = null
    let bestScore = -1

    for (const result of results) {
      if (result.status !== "fulfilled") continue
      const { poolId, score } = result.value
      if (score === null || score === undefined || !Number.isFinite(score)) continue
      const clamped = Math.max(0, Math.min(1, score))
      if (clamped > bestScore) {
        bestScore = clamped
        bestPool = poolId
      }
    }

    if (bestPool !== null) return bestPool
    return resolvePool(tier, taskType, nftPreferences)
  } finally {
    clearTimeout(deadline)
  }
}
```

**Key design decisions**:
- **200ms total, 100ms per-query**: The per-query timeout catches individual slow queries. The shared 200ms catches the case where multiple queries are slow simultaneously.
- **`AbortSignal.any()` composition** (Node 22+): Replaces manual `addEventListener` on the shared controller's signal. Each per-query signal is composed with the shared deadline signal via `AbortSignal.any()`, which avoids listener accumulation on the shared controller and ensures clean GC when the request completes.
- **`Promise.allSettled`**: Rejected promises (timeouts, errors) don't cancel other queries. Each pool gets its own chance.

### 4.3 AWS Production Deployment

#### 4.3.1 Fly.io Removal

All Fly.io references are deleted per PRD Appendix B:

| File | Action |
|------|--------|
| `deploy/fly.toml` | DELETE |
| `deploy/vllm/README.md` | EDIT — remove Fly.io GPU section |
| `CHANGELOG.md` | EDIT — remove Fly.io mentions |
| `grimoires/loa/context/research-minimal-pi.md` | EDIT — document AWS decision |
| `.claude/settings.json` | EDIT — remove `fly`/`flyctl` permissions |
| `.claude/commands/permission-audit.md` | EDIT — remove flyctl references |
| `.claude/protocols/helper-scripts.md` | EDIT — remove flyctl suggestions |

#### 4.3.2 ECS Task Definition Alignment

The existing `ecs-finn.tf` in loa-freeside defines:
- **CPU**: 512 (0.5 vCPU)
- **Memory**: 1024 MB
- **ECR Repository**: `arrakis-production-loa-finn`
- **ALB Target Group**: Health check on `/health`
- **Service Discovery**: `finn.production.local` via Cloud Map
- **Secrets**: AWS Secrets Manager ARN references

**Dockerfile changes** (`deploy/Dockerfile`): No structural changes needed. The existing multi-stage build produces an image compatible with the ECS task definition. The `HEALTHCHECK` instruction at line 88 uses `/health` which matches the ALB health check path.

**New environment variables** for ECS (via Secrets Manager):

| Variable | Source | Purpose |
|----------|--------|---------|
| `FINN_REPUTATION_ROUTING` | Secrets Manager | Kill switch (FR1.5) |
| `FINN_MERCHANT_ADDRESS` | Secrets Manager | x402 settlement recipient |
| `FINN_RELAYER_PRIVATE_KEY` | Secrets Manager | x402 gas payment |
| `AWS_REGION` | Task definition | SDK region for DynamoDB/S3/KMS |
| `DYNAMODB_AUDIT_TABLE` | Task definition | Audit trail table name |
| `S3_AUDIT_BUCKET` | Task definition | Object Lock bucket |
| `S3_CALIBRATION_BUCKET` | Task definition | Calibration data bucket |
| `ECS_CONTAINER_METADATA_URI` | Injected by ECS | Partition ID for audit |

#### 4.3.3 GitHub Actions Workflow

**New file**: `.github/workflows/finn-deploy-aws.yml`

```yaml
name: Deploy to AWS ECS
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-arn: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1

      - name: Login to ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push
        run: |
          docker build -f deploy/Dockerfile \
            --build-arg BUILD_TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ) \
            -t $ECR_REGISTRY/arrakis-production-loa-finn:${{ github.sha }} \
            -t $ECR_REGISTRY/arrakis-production-loa-finn:latest .
          docker push $ECR_REGISTRY/arrakis-production-loa-finn --all-tags

      - name: Update ECS service
        run: |
          aws ecs update-service \
            --cluster arrakis-production \
            --service finn \
            --force-new-deployment
```

### 4.4 x402 Settlement System

#### 4.4.1 Merchant Relayer

**File**: Modified `src/x402/settlement.ts`

The existing settlement service performs local verification only. This cycle adds on-chain submission.

```typescript
interface MerchantRelayerConfig {
  /** Private key for gas payment (from Secrets Manager). */
  relayerPrivateKey: string
  /** Merchant address (recipient of USDC transfer). */
  merchantAddress: `0x${string}`
  /** Base RPC URL (from rpc-pool.ts). */
  rpcUrl: string
  /** Gas surcharge as fraction of inference cost (default: 0.05). */
  gasSurchargeRate: number
  /** Max gas surcharge in MicroUSDC (default: 10000 = 0.01 USDC). */
  maxGasSurchargeMicro: bigint
  /** Confirmation timeout in ms (default: 30000). */
  confirmationTimeoutMs: number
  /** Max concurrent in-flight settlements (default: 5). Prevents DoS via slow payments. */
  maxConcurrentSettlements: number
  /** Redis for deduplication. */
  redis: RedisCommandClient
}

class MerchantRelayer implements SettlementService {
  /**
   * Settle an EIP-3009 authorization on-chain.
   *
   * Idempotency key: `{chainId}:{tokenContract}:{from}:{nonce}` — this is the
   * replay-relevant tuple per EIP-3009. Two different payers CAN use the same
   * nonce value because nonces are per-authorizer, so the key MUST include `from`.
   * The `to` is validated at verification time (FR4.2) and doesn't need to be in
   * the dedup key.
   *
   * Settlement state machine: pending → submitted(txHash) → confirmed | reverted
   * Stored in DynamoDB (durable) with Redis cache for hot-path dedup.
   *
   * Bounded concurrency: A semaphore (`p-limit(maxConcurrentSettlements)`, default 5)
   * gates entry to the settle() method. If all slots are occupied by in-flight
   * on-chain settlements (each blocking up to 30s), new requests immediately
   * receive 503 RELAYER_BUSY instead of queueing indefinitely. This prevents
   * an attacker from exhausting all request capacity with slow-to-confirm payments.
   */
  async settle(authorization: EIP3009Authorization, quoteId: string): Promise<SettlementResult> {
    const idempotencyKey = `${authorization.chainId}:${authorization.tokenContract}:${authorization.from}:${authorization.nonce}`
    const redisKey = `finn:x402:settlement:${idempotencyKey}`

    // 0. Preflight: reject if authorization validity window is not current
    const nowSec = Math.floor(Date.now() / 1000)
    const clockSkewAllowanceSec = 30
    if (authorization.validAfter > 0 && nowSec < authorization.validAfter - clockSkewAllowanceSec) {
      throw new X402Error("AUTHORIZATION_NOT_YET_VALID",
        `Authorization validAfter=${authorization.validAfter} is in the future`, 402)
    }
    if (authorization.validBefore > 0 && nowSec > authorization.validBefore + clockSkewAllowanceSec) {
      throw new X402Error("AUTHORIZATION_EXPIRED",
        `Authorization validBefore=${authorization.validBefore} has passed`, 402)
    }

    // 1. Check for existing settlement (DynamoDB durable state, Redis cache)
    const existing = await this.getSettlementState(idempotencyKey)
    if (existing) {
      switch (existing.status) {
        case "confirmed":
          // Idempotent replay — return cached result
          return { txHash: existing.txHash!, status: "confirmed" }
        case "reverted":
          throw new X402Error("SETTLEMENT_FAILED", "Authorization previously reverted on-chain", 402)
        case "submitted":
          // Previous attempt submitted but not confirmed — check receipt
          return this.resumeSettlement(existing, idempotencyKey, redisKey)
        case "pending":
          // Crash between pending and submitted — retry from submission
          break
      }
    }

    // 2. Claim pending slot (DynamoDB conditional write for durability)
    await this.claimPendingSlot(idempotencyKey, quoteId, authorization)
    await this.redis.set(redisKey, "pending", "EX", 7200)  // 2h Redis cache

    try {
      // 3. Submit transferWithAuthorization on-chain
      const txHash = await this.submitOnChain(authorization)

      // 4. Update state to submitted
      await this.updateSettlementState(idempotencyKey, { status: "submitted", txHash })
      await this.redis.set(redisKey, `submitted:${txHash}`, "EX", 7200)

      // 5. Wait for receipt confirmation
      // Base L2: use "safe" block tag when available, else wait for 1 confirmation.
      // Re-check receipt.status to handle reorgs (receipt can appear then disappear).
      const receipt = await this.waitForConfirmation(txHash, {
        confirmations: 1,
        timeoutMs: this.confirmationTimeoutMs,
        blockTag: "safe",  // Base L2 safe head, falls back to 1-conf if unsupported
      })

      if (receipt.status === "reverted") {
        await this.updateSettlementState(idempotencyKey, { status: "reverted", txHash, revertReason: receipt.revertReason })
        await this.redis.set(redisKey, `reverted:${txHash}`, "EX", 7200)
        throw new X402Error("SETTLEMENT_FAILED", receipt.revertReason ?? "Transaction reverted", 402)
      }

      // 6. Mark confirmed
      await this.updateSettlementState(idempotencyKey, { status: "confirmed", txHash })
      await this.redis.set(redisKey, `confirmed:${txHash}`, "EX", 7200)

      return { txHash, status: "confirmed" }
    } catch (err) {
      if (err instanceof X402Error) throw err

      // Gas failure — release pending slot so client can retry
      if (isGasError(err)) {
        await this.updateSettlementState(idempotencyKey, { status: "gas_failed" })
        await this.redis.del(redisKey)
        throw new X402Error("RELAYER_UNAVAILABLE", "Insufficient gas for settlement", 503)
      }

      // Timeout — tx may still confirm; keep submitted state for resume
      if (isTimeoutError(err)) {
        throw new X402Error("SETTLEMENT_TIMEOUT", "Transaction pending confirmation", 503)
      }

      throw err
    }
  }

  /**
   * Resume a previously submitted but unconfirmed settlement.
   * Called on retry (same nonce) when state is "submitted".
   * Queries the tx receipt instead of resubmitting.
   */
  private async resumeSettlement(
    existing: SettlementRecord,
    idempotencyKey: string,
    redisKey: string,
  ): Promise<SettlementResult> {
    const receipt = await this.getTransactionReceipt(existing.txHash!)
    if (receipt?.status === "success") {
      await this.updateSettlementState(idempotencyKey, { status: "confirmed", txHash: existing.txHash! })
      await this.redis.set(redisKey, `confirmed:${existing.txHash}`, "EX", 7200)
      return { txHash: existing.txHash!, status: "confirmed" }
    }
    if (receipt?.status === "reverted") {
      await this.updateSettlementState(idempotencyKey, { status: "reverted", txHash: existing.txHash! })
      throw new X402Error("SETTLEMENT_FAILED", "Transaction reverted on-chain", 402)
    }
    // Still pending — return 503 so client retries
    throw new X402Error("SETTLEMENT_TIMEOUT", "Transaction still pending", 503)
  }
}

**Settlement State Table** (DynamoDB `finn-x402-settlements`):

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `idempotencyKey` | S | PK | `{chainId}:{token}:{from}:{nonce}` |
| `status` | S | — | `pending \| submitted \| confirmed \| reverted \| gas_failed` |
| `txHash` | S | — | On-chain tx hash (set after submission) |
| `quoteId` | S | — | Original quote reference |
| `createdAt` | S | — | ISO 8601 |
| `updatedAt` | S | — | ISO 8601 |
| `revertReason` | S | — | On-chain revert reason (if reverted) |

**TTL**: 24 hours after `updatedAt` for terminal states (`confirmed`, `reverted`). Non-terminal states (`pending`, `submitted`) have no TTL — the reconciliation job handles stale entries.

**Claim pending slot**: `PutItem` with `ConditionExpression: attribute_not_exists(idempotencyKey)` ensures exactly-once creation. If the key exists, the caller checks existing state instead of creating a duplicate.
```

**On-chain submission** uses `viem` (already a dependency):

```typescript
private async submitOnChain(auth: EIP3009Authorization): Promise<`0x${string}`> {
  const client = createWalletClient({
    chain: base,
    transport: http(this.rpcUrl),
    account: privateKeyToAccount(this.relayerPrivateKey),
  })

  return client.writeContract({
    address: USDC_BASE_ADDRESS,  // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
    abi: EIP3009_ABI,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s],
  })
}
```

#### 4.4.2 EIP-3009 Chain/Contract Binding

**File**: Modified `src/x402/verify.ts`

The existing verifier checks signature validity. This cycle adds chain, contract, and recipient binding:

```typescript
// Added to verify() method:

// Chain binding (FR4.2)
if (proof.chainId !== 8453n) {
  throw new X402Error("INVALID_CHAIN", `Expected Base (8453), got ${proof.chainId}`, 402)
}

// Contract binding (FR4.2)
if (proof.tokenContract.toLowerCase() !== USDC_BASE_ADDRESS.toLowerCase()) {
  throw new X402Error("INVALID_TOKEN", "Only USDC on Base accepted", 402)
}

// Recipient binding (FR4.2)
if (proof.to.toLowerCase() !== this.merchantAddress.toLowerCase()) {
  throw new X402Error("INVALID_RECIPIENT", "Payment directed to wrong recipient", 402)
}

// EIP-712 domain separator validation
const expectedDomain = {
  name: "USD Coin",
  version: "2",
  chainId: 8453n,
  verifyingContract: USDC_BASE_ADDRESS,
}
```

#### 4.4.3 Conservation Guard x402 Mode

**File**: Modified `src/hounfour/billing-conservation-guard.ts`

New method for x402 payment verification:

```typescript
/**
 * Check x402 payment conservation: payment ≥ inference cost.
 * Uses MicroUSDC (not MicroUSD) — branded type prevents cross-unit comparison.
 */
checkX402Conservation(paymentMicro: bigint, costMicro: bigint): InvariantResult {
  const adhoc = paymentMicro >= costMicro ? "pass" : "fail" as const
  return this.runCheck("budget_conservation", {
    spent: String(costMicro),
    limit: String(paymentMicro),
    zero: "0",
  }, adhoc)
}
```

**Branded type** for denomination safety:

```typescript
// src/x402/denomination.ts (existing, extended)
declare const MicroUSDCBrand: unique symbol
export type MicroUSDC = bigint & { readonly [MicroUSDCBrand]: true }

export function toMicroUSDC(value: bigint): MicroUSDC {
  return value as MicroUSDC
}
```

This prevents `MicroUSD` (credit-balance path) from being compared with `MicroUSDC` (x402 path) at the TypeScript level.

#### 4.4.4 Gas Surcharge in Quote

**File**: Modified `src/x402/pricing.ts`

```typescript
function computeQuoteWithGas(inferenceCostMicro: bigint, gasSurchargeRate: number, maxSurchargeMicro: bigint): bigint {
  const surcharge = BigInt(Math.ceil(Number(inferenceCostMicro) * gasSurchargeRate))
  const cappedSurcharge = surcharge > maxSurchargeMicro ? maxSurchargeMicro : surcharge
  return inferenceCostMicro + cappedSurcharge
}
```

The `X-Price` header includes the gas surcharge. The client pays the full amount; finn covers gas from its relayer wallet.

#### 4.4.5 Relayer Gas Monitoring

**File**: `src/x402/relayer-monitor.ts`

The relayer wallet holds ETH for gas. If depleted, all x402 settlements fail silently until refilled.

```typescript
interface RelayerMonitorConfig {
  /** Minimum balance in wei before alerting. Default: 0.01 ETH. */
  alertThresholdWei: bigint
  /** Critical threshold — stop accepting new settlements. Default: 0.001 ETH. */
  criticalThresholdWei: bigint
  /** Check interval in ms. Default: 60000 (1 minute). */
  checkIntervalMs: number
}

class RelayerMonitor {
  /** Check balance on startup. Logs warning if below alert threshold. */
  async checkOnStartup(): Promise<{ healthy: boolean; balanceWei: bigint }>

  /** Periodic health probe (called by /health endpoint). */
  async getRelayerHealth(): Promise<{
    balanceWei: bigint
    balanceEth: string
    status: "healthy" | "low" | "critical"
  }>

  /** Start periodic balance monitoring. */
  startMonitoring(): void

  /** Stop monitoring (graceful shutdown). */
  stopMonitoring(): void
}
```

**Health endpoint integration**: The `/health` response includes relayer balance status:
```json
{
  "relayer": {
    "status": "healthy | low | critical",
    "balance_eth": "0.05"
  }
}
```

**Alert flow**: When balance drops below `alertThresholdWei`, a structured log is emitted for CloudWatch alarm ingestion. At `criticalThresholdWei`, the relayer refuses new settlements (returns 503 `RELAYER_UNAVAILABLE`) rather than submitting transactions that will fail.

#### 4.4.6 Settlement Reconciliation Job

**File**: `src/x402/reconciliation.ts`

A periodic job that finalizes stale settlement records in DynamoDB.

```typescript
interface ReconciliationConfig {
  /** Run interval in ms. Default: 300000 (5 minutes). */
  intervalMs: number
  /** Max age for pending records before force-expiring. Default: 3600000 (1 hour). */
  pendingMaxAgeMs: number
  /** Max age for submitted records before re-checking receipt. Default: 600000 (10 minutes). */
  submittedMaxAgeMs: number
}

class SettlementReconciler {
  /**
   * Scan DynamoDB for non-terminal settlement records.
   * For each:
   *   - "pending" older than pendingMaxAgeMs → mark "expired" (process crashed before submission)
   *   - "submitted" older than submittedMaxAgeMs → re-check on-chain receipt:
   *       - receipt confirmed → update to "confirmed"
   *       - receipt reverted → update to "reverted"
   *       - no receipt → if older than 1h, mark "expired" (tx likely dropped from mempool)
   */
  async reconcile(): Promise<ReconciliationResult>

  startPeriodicReconciliation(): void
  stopPeriodicReconciliation(): void
}

interface ReconciliationResult {
  scanned: number
  confirmed: number
  reverted: number
  expired: number
  errors: number
}
```

**DynamoDB query**: Uses a GSI on `status` (sparse index, only non-terminal states) with `updatedAt` range key to efficiently find stale records without table scan.

**GSI addition to `finn-x402-settlements`**:

| GSI Name | PK | SK | Projection |
|----------|----|----|------------|
| `status-updated-index` | `status` | `updatedAt` | `idempotencyKey`, `txHash` |

### 4.5 Cross-System E2E Test Harness

**New file**: `docker-compose.e2e.yml`

```yaml
version: "3.8"
services:
  finn:
    build:
      context: .
      dockerfile: deploy/Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=test
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgres://finn:finn@postgres:5432/finn_test
      - FREESIDE_URL=http://freeside:4000
      - FINN_REPUTATION_ROUTING=enabled
      - ECONOMIC_BOUNDARY_MODE=enforce
    depends_on:
      - redis
      - postgres
      - freeside

  freeside:
    image: ${FREESIDE_IMAGE:-ghcr.io/0xhoneyjar/loa-freeside:latest}
    ports:
      - "4000:4000"
    environment:
      - NODE_ENV=test
      - DATABASE_URL=postgres://freeside:freeside@postgres:5432/freeside_test
      - REDIS_URL=redis://redis:6379
      - FINN_URL=http://finn:3000
    depends_on:
      - redis
      - postgres

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
    ports:
      - "5432:5432"
    volumes:
      - ./deploy/e2e/init-db.sql:/docker-entrypoint-initdb.d/init.sql
```

**E2E Test Flow**:
1. `docker compose -f docker-compose.e2e.yml up -d`
2. Wait for health checks (`finn:3000/health`, `freeside:4000/health`)
3. Create test JWT (real ES256 from freeside's JWKS)
4. `POST /api/v1/invoke` with JWT → verify billing debit
5. `POST /api/v1/x402/invoke` without JWT → verify 402 → submit with payment → verify inference

### 4.6 Tamper-Evident Audit Trail

#### 4.6.1 DynamoDB Per-Partition Hash Chain

**File**: `src/hounfour/audit/dynamo-audit.ts`

```typescript
interface AuditEntry {
  partitionId: string       // ECS task ID (from ECS_CONTAINER_METADATA_URI)
  sequenceNumber: number    // Monotonic per partition
  hash: string              // SHA-256(prev_hash + payload_hash + timestamp)
  prevHash: string          // Hash of previous entry (genesis: "0")
  timestamp: string         // ISO 8601
  action: string            // e.g., "scoring_path", "kill_switch_toggle"
  payloadHash: string       // SHA-256 of the entry payload
}

class DynamoAuditChain {
  private sequenceNumber: number = 0
  private lastHash: string = "0"  // Genesis
  private partitionId: string
  private initialized: boolean = false

  constructor(
    private dynamoClient: DynamoDBClient,
    private tableName: string,
  ) {
    // Extract ECS Task ID (not the metadata URI itself) for stable partition ID.
    // Fetched once at boot from ECS container metadata JSON endpoint.
    this.partitionId = this.extractTaskId()
  }

  /**
   * Extract stable ECS Task ID from container metadata.
   * Uses the ECS_CONTAINER_METADATA_URI_V4 endpoint to fetch task ARN,
   * then extracts the task ID suffix (e.g., "abc123def456").
   * Falls back to hostname + boot timestamp for local dev.
   */
  private extractTaskId(): string {
    const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4
    if (metadataUri) {
      // Parsed at boot: GET {metadataUri}/task → response.TaskARN
      // TaskARN format: arn:aws:ecs:region:account:task/cluster/task-id
      // Extract the final segment as the stable partition ID
      return parseTaskIdFromArn(this.cachedTaskArn)
    }
    // Local dev: use hostname + boot timestamp for uniqueness
    return `local-${os.hostname()}-${Date.now()}`
  }

  /**
   * Initialize chain state by recovering from DynamoDB.
   * MUST be called before first append. Queries the latest entry
   * in this partition to resume sequenceNumber and lastHash.
   * If partition is new, starts from genesis.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    // Query latest entry: ScanIndexForward=false, Limit=1
    const result = await this.dynamoClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "partitionId = :pid",
      ExpressionAttributeValues: marshall({ ":pid": this.partitionId }),
      ScanIndexForward: false,  // Descending by sort key
      Limit: 1,
    }))

    if (result.Items && result.Items.length > 0) {
      const latest = unmarshall(result.Items[0]) as AuditEntry
      this.sequenceNumber = latest.sequenceNumber
      this.lastHash = latest.hash
      console.log(
        `[dynamo-audit] Recovered partition=${this.partitionId} ` +
        `seq=${this.sequenceNumber} hash=${this.lastHash.slice(0, 12)}...`
      )
    } else {
      // New partition — start from genesis
      console.log(`[dynamo-audit] New partition=${this.partitionId}, starting from genesis`)
    }

    this.initialized = true
  }

  /** Append entry to the chain. Atomic via conditional write. */
  async append(action: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.initialized) await this.init()

    const payloadHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")

    const timestamp = new Date().toISOString()
    const nextSeq = this.sequenceNumber + 1
    const hash = createHash("sha256")
      .update(`${this.lastHash}:${payloadHash}:${timestamp}`)
      .digest("hex")

    const entry: AuditEntry = {
      partitionId: this.partitionId,
      sequenceNumber: nextSeq,
      hash,
      prevHash: this.lastHash,
      timestamp,
      action,
      payloadHash,
    }

    // Conditional write: ensure this exact PK+SK does not already exist.
    // attribute_not_exists on the sort key is sufficient because DynamoDB
    // evaluates the condition against the item with the same composite key.
    await this.dynamoClient.send(new PutItemCommand({
      TableName: this.tableName,
      Item: marshall(entry),
      ConditionExpression: "attribute_not_exists(sequenceNumber)",
    }))

    this.sequenceNumber = nextSeq
    this.lastHash = hash
  }

  /** Verify integrity of entire partition. */
  async verifyPartitionIntegrity(): Promise<boolean> {
    // Query all entries in sort-key order (ScanIndexForward=true)
    // Recompute chain from genesis, verify each hash matches prevHash linkage
    // Return false on first mismatch
    // ...
  }
}

/**
 * Conditional write failure recovery:
 *
 * ConditionalCheckFailedException on append means the exact PK+SK already exists.
 * This should only happen if:
 *   (a) A duplicate append was attempted (crash-recovery replayed the same event), or
 *   (b) A bug produced a sequence number collision.
 *
 * Recovery strategy:
 *   1. Re-read the existing entry at that sequence number.
 *   2. If the existing entry's payloadHash matches the one we tried to write → idempotent duplicate, no-op.
 *   3. If the payloadHash differs → genuine collision (bug). Enter degraded mode:
 *      - Log structured error with both entries for forensic analysis.
 *      - Re-query the partition head to resync sequenceNumber and lastHash.
 *      - Retry the append with the corrected sequence number.
 *      - If retry also fails, fall back to CloudWatch audit logging (§4.6.3).
 *   4. A counter tracks consecutive conditional write failures. If >3 in a row,
 *      the audit chain enters permanent degraded mode for this partition and
 *      emits an alarm-severity log for operator investigation.
 */
```

**DynamoDB Table Schema**:

| Attribute | Type | Role |
|-----------|------|------|
| `partitionId` | String | Partition Key |
| `sequenceNumber` | Number | Sort Key |
| `hash` | String | Chain link hash |
| `prevHash` | String | Previous hash (genesis = "0") |
| `timestamp` | String | ISO 8601 |
| `action` | String | Event type |
| `payloadHash` | String | SHA-256 of payload |

**Conditional write**: `attribute_not_exists(sequenceNumber)` on the target PK+SK ensures exactly-once writes. DynamoDB evaluates the condition against the specific item being written (same partitionId + sequenceNumber composite key), so this correctly prevents duplicate sequence numbers within a partition.

#### 4.6.2 S3 Object Lock Immutable Anchor

**File**: `src/hounfour/audit/s3-anchor.ts`

```typescript
class S3AuditAnchor {
  constructor(
    private s3Client: S3Client,
    private kmsClient: KMSClient,
    private bucketName: string,
    private kmsKeyId: string,
  )

  /**
   * Compute daily digest: SHA-256 of all partition head hashes.
   * Sign with KMS. Write to S3 Object Lock bucket.
   */
  async writeDailyDigest(
    partitionHeads: Map<string, { hash: string; sequenceNumber: number }>,
  ): Promise<void> {
    const date = new Date().toISOString().split("T")[0]  // YYYY-MM-DD

    // 1. Compute digest
    const sorted = [...partitionHeads.entries()].sort(([a], [b]) => a.localeCompare(b))
    const digestInput = sorted.map(([pid, head]) => `${pid}:${head.hash}:${head.sequenceNumber}`).join("|")
    const digest = createHash("sha256").update(digestInput).digest("hex")

    // 2. KMS sign
    const signature = await this.kmsClient.send(new SignCommand({
      KeyId: this.kmsKeyId,
      Message: Buffer.from(digest),
      MessageType: "RAW",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    }))

    // 3. Write to S3 with Object Lock
    const key = `finn/audit/daily-digest/${date}.json`
    const body = JSON.stringify({
      date,
      digest,
      signature: Buffer.from(signature.Signature!).toString("base64"),
      partitionHeads: Object.fromEntries(sorted),
      generatedAt: new Date().toISOString(),
    })

    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: body,
      ContentType: "application/json",
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),  // 90 days
    }))
  }

  /**
   * Verify audit trail integrity against S3 checkpoint.
   * Returns true only if KMS signature is valid AND recomputed hashes match.
   */
  async verifyAuditTrailIntegrity(date: string): Promise<boolean> {
    // 1. Fetch S3 digest
    // 2. Verify KMS signature
    // 3. Query all partitions from DynamoDB
    // 4. Recompute heads
    // 5. Compare against signed digest
  }

  /**
   * Enumerate all active partitions for daily digest computation.
   *
   * Strategy: DynamoDB Scan with ProjectionExpression = "partitionId"
   * and a filter for entries within the current digest window (last 24h).
   * Uses pagination (ExclusiveStartKey) and deduplicates partitionId values
   * in-memory.
   *
   * Expected cardinality: Low (~1-10 partitions per ECS service).
   * Each ECS task creates one partition; tasks are short-lived (hours to days).
   * A full table Scan is acceptable at this cardinality.
   *
   * For higher cardinality (>100 partitions), add a GSI:
   *   GSI "partition-index": PK = "PARTITION", SK = partitionId
   *   Populated by a genesis entry written at partition creation.
   *   Query instead of Scan.
   *
   * Current approach: Scan with `Select: "SPECIFIC_ATTRIBUTES"` to minimize
   * read capacity consumption. Runs once per day at digest time.
   */
  async enumeratePartitions(): Promise<string[]>
}
```

**S3 Bucket Config** (Terraform in loa-freeside):
- Object Lock enabled (compliance mode)
- Default retention: 90 days
- Versioning enabled (required by Object Lock)

#### 4.6.3 Fallback

When DynamoDB is unavailable, `ScoringPathLog` entries are written to CloudWatch Logs as structured JSON. No hash chain. A warning is emitted at the first fallback and every 5 minutes thereafter. This ensures routing is never blocked by audit infrastructure failures.

---

## 5. Data Architecture

### 5.1 Redis Data Model

| Key Pattern | Value | TTL | Purpose |
|------------|-------|-----|---------|
| `finn:ema:{nftId}:{poolId}:{routingKey}` | JSON `{ema, lastTimestamp, sampleCount}` | 2 × halfLife | EMA state |
| *(idempotency is inline in EMA value via `lastEventHash` — no separate key)* | | | |
| `finn:explore:count:{tier}:{YYYY-MM-DD}` | Integer | 48h | Exploration counter |
| `finn:x402:settlement:{chainId}:{token}:{from}:{nonce}` | State string (`pending\|submitted:{txHash}\|confirmed:{txHash}\|reverted:{txHash}`) | 2h | Hot-path settlement dedup cache (DynamoDB is source of truth) |
| `x402:rate:{wallet}` | Integer | 1h | Rate limit |

### 5.2 DynamoDB Schema

**Table**: `finn-scoring-path-log`

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `partitionId` | S | PK | ECS task ID |
| `sequenceNumber` | N | SK | Monotonic counter |
| `hash` | S | — | Chain link hash |
| `prevHash` | S | — | Previous hash |
| `timestamp` | S | — | ISO 8601 |
| `action` | S | — | Event type |
| `payloadHash` | S | — | SHA-256 of payload |

**GSI**: None needed. All queries are partition-scoped with sort-key range.

**Capacity**: On-demand (PAY_PER_REQUEST). Expected write volume: ~100 entries/hour per ECS task.

### 5.2b DynamoDB Settlement State (x402)

**Table**: `finn-x402-settlements`

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `idempotencyKey` | S | PK | `{chainId}:{token}:{from}:{nonce}` |
| `status` | S | — | `pending \| submitted \| confirmed \| reverted \| gas_failed` |
| `txHash` | S | — | On-chain tx hash |
| `quoteId` | S | — | Quote reference |
| `createdAt` | S | — | ISO 8601 |
| `updatedAt` | S | — | ISO 8601 |
| `revertReason` | S | — | Revert reason (if applicable) |

**TTL**: `expiresAt` attribute — 24h after `updatedAt` for terminal states. Non-terminal states handled by reconciliation job.

**Capacity**: On-demand. Expected volume: <100 settlements/hour initially.

### 5.3 S3 Object Lock

**Bucket**: `finn-audit-anchors-{account-id}`

| Path | Content | Retention |
|------|---------|-----------|
| `finn/audit/daily-digest/{YYYY-MM-DD}.json` | KMS-signed digest | 90 days compliance mode |
| `finn/calibration.jsonl` | Calibration entries | No lock (versioned) |

---

## 6. API Design

### 6.1 Modified Endpoints

#### `POST /api/v1/invoke` (existing, modified)

**Change**: `resolvePoolWithReputation()` now uses Goodhart protection engine. The routing decision is logged with the scoring path (`kill_switch`, `exploration`, `reputation`, `deterministic`).

**New response headers** (informational, debug mode only):
- `X-Scoring-Path`: `exploration | reputation | deterministic | kill_switch`

#### `POST /api/v1/x402/invoke` (existing, modified)

**Change**: Settlement now includes on-chain confirmation before serving inference.

**New error responses**:

| Code | Body.code | Description |
|------|-----------|-------------|
| 402 | `SETTLEMENT_FAILED` | On-chain tx reverted |
| 429 | `SETTLEMENT_IN_FLIGHT` | Duplicate nonce, tx pending |
| 503 | `RELAYER_UNAVAILABLE` | Insufficient gas |
| 503 | `SETTLEMENT_TIMEOUT` | Tx submitted but unconfirmed |

**New response fields**:
```json
{
  "result": "...",
  "payment_id": "...",
  "quote_id": "...",
  "tx_hash": "0x..."   // NEW: on-chain settlement tx
}
```

### 6.2 New Endpoints

#### `GET /health` (existing, extended)

**New fields in response**:
```json
{
  "goodhart": {
    "kill_switch": "enabled | disabled",
    "exploration_epsilon": 0.05,
    "calibration_last_poll": "2026-02-26T12:00:00Z",
    "ema_keys_active": 42
  },
  "audit": {
    "dynamodb": "healthy | degraded | unavailable",
    "last_digest": "2026-02-25",
    "partition_id": "ecs-task-abc123"
  }
}
```

### 6.3 Internal Interfaces

#### Dixie Transport (adapter pattern)

Dixie's `ReputationStore.get(nftId)` returns an aggregate per NFT. To support per-pool scoring, the transport returns a `ReputationResponse` per NFT which includes the aggregate score. The **adapter** (not dixie) is responsible for mapping this to per-pool scores using the EMA cache — each pool's EMA is independently maintained from observations routed through that pool. Dixie provides the raw signal; finn's EMA cache provides per-pool differentiation.

```typescript
interface DixieTransport {
  /**
   * Fetch reputation aggregate for an NFT.
   * Returns the NFT-level aggregate from dixie's ReputationStore.
   * Per-pool differentiation is handled by finn's EMA cache,
   * not by dixie (which has no concept of finn's pool topology).
   * The optional signal enables abort on deadline expiry.
   */
  getReputation(nftId: string, options?: { signal?: AbortSignal }): Promise<ReputationResponse | null>
}

// HTTP transport (when dixie exposes HTTP endpoint)
class DixieHttpTransport implements DixieTransport {
  async getReputation(nftId: string, options?: { signal?: AbortSignal }): Promise<ReputationResponse | null> {
    const response = await fetch(`${this.baseUrl}/reputation/${nftId}`, {
      signal: options?.signal,  // Honors AbortController deadline
      headers: { "Accept": "application/json" },
    })
    // ...
  }
}

// Direct import transport (when dixie is a library dependency)
class DixieDirectTransport implements DixieTransport { ... }

// Stub transport (always returns null — zero behavioral change)
class DixieStubTransport implements DixieTransport {
  async getReputation(): Promise<null> { return null }
}
```

**Per-pool scoring strategy**: Dixie returns one aggregate score per NFT. Finn maintains per-(nftId, poolId, routingKey) EMA caches. When a request is routed through pool X and produces a quality observation, that observation updates the EMA for (nftId, X, routingKey). Over time, each pool accumulates its own reputation per NFT. During parallel scoring, each pool's decayed EMA is queried independently — no need to query dixie per-pool.

---

## 7. Security Architecture

### 7.1 x402 Security

| Threat | Mitigation | Verification |
|--------|-----------|-------------|
| Replay attack | Nonce tracking via Redis NX + on-chain uniqueness | AC26 |
| Wrong chain signature | `chainId == 8453` check | AC28b |
| Wrong token | `tokenContract == USDC_BASE_ADDRESS` check | AC28c |
| Wrong recipient | `to == FINN_MERCHANT_ADDRESS` check | AC28a |
| Front-running | Merchant relayer submits — not user. Nonce is authorization-bound. | AC30b |
| Gas griefing | Rate limit (100/hr/wallet) + gas cap (0.01 USDC max surcharge) | N/A |
| Gas depletion | Relayer balance monitoring + alert (see §4.4.5) | N/A |
| Quote spam (free 402s) | Rate limit on unauthenticated quote requests (see §7.1.1) | N/A |
| Dust payments | Minimum payment threshold enforcement (see §7.1.1) | N/A |
| CPU DoS via sig verify | Bounded concurrent verification + early rejection (see §7.1.1) | N/A |

#### 7.1.1 x402 Abuse Protection

**Quote spam**: Unauthenticated requests that trigger 402 responses (quotes) are free — no payment required. An attacker can flood quote requests to waste compute and observe pricing.

**Mitigations**:

| Attack | Protection | Implementation |
|--------|-----------|----------------|
| Quote flooding | IP-based rate limit: 60 quotes/min/IP | Hono middleware, `x402:quote-rate:{ip}` Redis key with INCR + TTL |
| Dust payments | Minimum payment threshold: 100 MicroUSDC ($0.0001) | Reject in `verify.ts` before signature verification |
| CPU DoS (sig verify) | Semaphore: max 10 concurrent signature verifications | `p-limit(10)` wrapping `ecrecover` calls |
| Wallet enumeration | Generic 402 response (no wallet-specific info in quotes) | Already implemented |

**Dust payment threshold**:
```typescript
const MIN_PAYMENT_MICRO_USDC = 100n  // $0.0001 — below any realistic inference cost
if (proof.value < MIN_PAYMENT_MICRO_USDC) {
  throw new X402Error("PAYMENT_TOO_SMALL", "Payment below minimum threshold", 402)
}
```

This check runs **before** signature verification (which is CPU-intensive), providing early rejection of trivially invalid payments.

### 7.2 Audit Trail Security

| Threat | Mitigation |
|--------|-----------|
| DynamoDB rewrite | S3 Object Lock (WORM) digest is the trust anchor outside DynamoDB |
| Forged digest | KMS signature verification before accepting any digest |
| Cross-partition manipulation | Each partition has its own independent chain |
| Sequence number skip | Startup verification reads last N entries and checks continuity |

### 7.3 Kill Switch Security

The kill switch (`FINN_REPUTATION_ROUTING`) is a safety valve, not a security control. It's designed to be easy to activate in an emergency:
- No authentication required (env var change)
- Immediate effect (no cache)
- Logged to audit trail

### 7.4 Secret Management

| Secret | Location | Rotation |
|--------|----------|----------|
| `FINN_RELAYER_PRIVATE_KEY` | AWS Secrets Manager | Manual (wallet change) |
| `FINN_MERCHANT_ADDRESS` | AWS Secrets Manager | Manual |
| `OPENAI_API_KEY` | AWS Secrets Manager | Existing |
| `ANTHROPIC_API_KEY` | AWS Secrets Manager | Existing |
| `JWT_SIGNING_KEY` | AWS Secrets Manager | Existing |
| `REDIS_AUTH` | AWS Secrets Manager | Existing |
| `KMS_KEY_ID` | Terraform (not secret) | Automatic (AWS-managed) |

---

## 8. Integration Points

### 8.1 Dixie Integration

| Aspect | Detail |
|--------|--------|
| **Protocol** | HTTP or direct import (adapter pattern) |
| **Contract** | `ReputationResponse` v1 schema |
| **Timeout** | 100ms per query (AbortController) |
| **Fallback** | Stub transport → null → deterministic routing |
| **Dixie state** | v8.2.0 merged, `ReputationStore.get(nftId)` available |

### 8.2 Freeside Integration

| Aspect | Detail |
|--------|--------|
| **JWT exchange** | ES256, existing JWKS endpoint |
| **Billing debit** | Existing finalize client |
| **Service discovery** | `finn.production.local` via Cloud Map |
| **E2E test** | Docker Compose with real JWT exchange |

### 8.3 Base L2 Integration

| Aspect | Detail |
|--------|--------|
| **Chain** | Base (chainId 8453) |
| **Token** | USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| **RPC** | Existing `rpc-pool.ts` with failover |
| **Confirmations** | 1 block (L2 finality is fast) |
| **Reconciliation** | Every 5 minutes, last N tx hashes against on-chain |

---

## 9. Scalability & Performance

### 9.1 Latency Budget

| Operation | Budget | Design |
|-----------|--------|--------|
| Kill switch check | <1ms | Env var read |
| Exploration coin flip | <1ms | Math.random() |
| EMA query (decay) | <5ms | Redis GET + local math |
| Reputation query (dixie) | <100ms | Per-query timeout |
| Parallel scoring (5 pools) | <200ms | AbortController deadline |
| x402 signature verify | <5ms | Local crypto |
| x402 settlement (on-chain) | <30s | Async with timeout |
| Audit chain append | <10ms | DynamoDB PutItem conditional |

### 9.2 Throughput

| Component | Expected Load | Capacity |
|-----------|--------------|----------|
| Redis Lua (EMA) | ~100 ops/s | Redis single-thread handles 100K+ ops/s |
| DynamoDB writes | ~100/hr/task | On-demand scales automatically |
| S3 calibration poll | 1 GET/60s | Negligible |
| S3 digest write | 1 PUT/day | Negligible |

### 9.3 Memory

| Component | Expected | Notes |
|-----------|----------|-------|
| Calibration cache | <1 MB | JSONL parsed to in-memory Map |
| NFT routing cache | <10 MB | Existing, unchanged |
| Exploration state | <1 KB | No persistent state (Bernoulli) |
| Kill switch | 0 | Env var read |

---

## 10. Deployment Architecture

### 10.1 AWS Resources (loa-freeside)

All resources exist in `infrastructure/terraform/` of loa-freeside:

| Resource | Terraform | Status |
|----------|-----------|--------|
| ECS Cluster | `ecs.tf` | Provisioned |
| ECS Task Def (finn) | `ecs-finn.tf` | Provisioned |
| ECR Repository | `ecr.tf` | Provisioned |
| ALB + Target Group | `alb.tf` | Provisioned |
| Redis (ElastiCache) | `redis.tf` | Provisioned |
| RDS PostgreSQL | `rds.tf` | Provisioned |
| Secrets Manager | `secrets.tf` | Provisioned |
| Cloud Map | `service-discovery.tf` | Provisioned |

**New resources needed** (Terraform additions to loa-freeside):

| Resource | Purpose |
|----------|---------|
| DynamoDB Table `finn-scoring-path-log` | Audit trail |
| S3 Bucket `finn-audit-anchors-*` with Object Lock | Immutable digest |
| S3 Bucket `finn-calibration-*` | Calibration data (versioned, no lock) |
| KMS Key `finn-audit-signing` | Daily digest signing |
| IAM Policy for finn task role | DynamoDB, S3, KMS access |

### 10.2 Environment Topology

```
┌─────────────────────────────────────────────┐
│                AWS (us-east-1)              │
│                                             │
│  ┌───────────┐    ┌──────────────────────┐  │
│  │    WAF    │───►│    ALB               │  │
│  └───────────┘    │    ├── /health       │  │
│                   │    ├── /api/v1/*      │  │
│                   │    └── /api/v1/x402/* │  │
│                   └──────────┬───────────┘  │
│                              │              │
│                   ┌──────────▼───────────┐  │
│                   │    ECS Fargate       │  │
│                   │    (finn service)    │  │
│                   │    512 CPU / 1024 MB │  │
│                   └──────────┬───────────┘  │
│                              │              │
│              ┌───────────────┼───────────┐  │
│              │               │           │  │
│    ┌─────────▼──┐  ┌────────▼──┐ ┌──────▼─┐│
│    │ ElastiCache│  │    RDS    │ │DynamoDB ││
│    │  (Redis 7) │  │(Postgres) │ │ (audit) ││
│    └────────────┘  └───────────┘ └─────────┘│
│                                             │
│    ┌────────────┐  ┌───────────┐            │
│    │    S3      │  │    KMS    │            │
│    │  (WORM +  │  │ (signing) │            │
│    │  calibr.) │  └───────────┘            │
│    └────────────┘                           │
└─────────────────────────────────────────────┘
```

---

## 11. Technical Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Dixie adapter not ready | Low | Medium | Stub transport returns null; zero behavioral change |
| Redis Lua script complexity | Medium | Medium | Comprehensive unit tests with real Redis; Lua script is <30 lines |
| EMA cold start (no data) | High (first deploy) | Low | Cold start = raw score pass-through; EMA builds over first few days |
| DynamoDB conditional write contention | Low | Low | Per-partition, monotonic sequence; collisions only on bug |
| S3 Object Lock bucket not provisioned | Medium | Medium | Terraform PR to freeside; fallback = CloudWatch logs (degraded) |
| On-chain settlement timeout | Medium | Medium | 30s timeout → 503 Retry-After; client retries with same nonce |
| Base RPC unreliable | Low | High | rpc-pool.ts already has failover across multiple providers |
| Gas price spike | Low | Medium | Gas surcharge cap (0.01 USDC); alert on relayer balance < threshold |

---

## 12. Testing Strategy

### 12.1 Unit Tests

| Component | Test Focus |
|-----------|-----------|
| `temporal-decay.ts` | EMA formula correctness, cold start, out-of-order rejection |
| `exploration.ts` | Bernoulli distribution (1000 trials, 95% CI), candidate filtering |
| `calibration.ts` | Blending formula, S3 ETag polling mock |
| `mechanism-interaction.ts` | Kill switch precedence, exploration overrides reputation |
| `kill-switch.ts` | Env var reading, transition logging |
| `reputation-adapter.ts` | Degraded modes, version mismatch |
| `verify.ts` | Chain/contract/recipient binding rejection |
| `settlement.ts` | Dedup, timeout handling, gas error |

### 12.2 Integration Tests

| Test | Scope |
|------|-------|
| EMA Lua script | Real Redis instance, concurrent updates |
| DynamoDB chain | LocalStack DynamoDB, integrity verification |
| x402 settlement | Anvil fork of Base, real EIP-3009 flow |
| Parallel scoring | Mock reputation adapter with delays |

### 12.3 E2E Tests

| Test | Docker Compose |
|------|---------------|
| JWT exchange | finn + freeside + Redis + Postgres |
| Billing flow | inference → billing debit → conservation check |
| x402 flow | quote → payment → settlement → inference |

---

## 13. Migration & Rollout

### 13.1 Feature Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `FINN_REPUTATION_ROUTING` | `enabled` | Kill switch for entire Goodhart subsystem |
| `EXPLORATION_ENABLED` | `true` | Granular control for exploration only |
| `CALIBRATION_ENABLED` | `true` | Granular control for calibration only |
| `X402_SETTLEMENT_MODE` | `verify_only` | Start with local verification; promote to `on_chain` |

### 13.2 Rollout Phases

1. **Deploy with kill switch disabled**: `FINN_REPUTATION_ROUTING=disabled`. All existing behavior preserved. Validates deployment pipeline.
2. **Enable in shadow mode**: `FINN_REPUTATION_ROUTING=shadow`. Reputation scoring runs in parallel but does **not** affect routing decisions. The deterministic `resolvePool()` path is always used for the actual routing, while the Goodhart engine runs alongside and emits structured metrics for comparison. See §13.3 for shadow mode specification.
3. **Enable exploration only**: `EXPLORATION_ENABLED=true`, decay still building EMA from observations.
4. **Enable full Goodhart**: `FINN_REPUTATION_ROUTING=enabled`. Decay + exploration + calibration active.
5. **Enable x402 on-chain settlement**: `X402_SETTLEMENT_MODE=on_chain`. Upgrade from verify-only to full settlement.

### 13.3 Shadow Mode Specification

When `FINN_REPUTATION_ROUTING=shadow`, the mechanism interaction module:

1. **Runs the full scoring pipeline** (exploration decision, parallel reputation scoring, calibration blending) for every request.
2. **Discards the result** and routes via deterministic `resolvePool()` instead.
3. **Emits a structured log** comparing the two decisions:

```json
{
  "component": "goodhart-shadow",
  "event": "shadow_comparison",
  "deterministic_pool": "pool-A",
  "reputation_pool": "pool-B",
  "reputation_score": 0.82,
  "scoring_path": "reputation",
  "would_have_changed": true,
  "latency_ms": 45,
  "timestamp": "2026-02-26T12:00:00Z"
}
```

4. **Tracks shadow metrics** via Redis counters (best-effort):
   - `finn:shadow:agreement:{YYYY-MM-DD}` — INCR when both paths select same pool
   - `finn:shadow:divergence:{YYYY-MM-DD}` — INCR when paths disagree
   - `finn:shadow:latency_sum:{YYYY-MM-DD}` — INCRBY with scoring latency

5. **No EMA writes in shadow mode**: The shadow pipeline reads existing EMA state but does not update it. EMA population begins only when promoted to `enabled`. This prevents shadow observations from polluting the EMA before the operator has validated the scoring pipeline.

**Promotion criteria**: Move from `shadow` to `enabled` when:
- Shadow mode has run for ≥24h without errors
- Agreement rate is stable (not oscillating wildly)
- p99 scoring latency is within the 200ms budget

---

## Appendix A: File Change Manifest

### New Files

| Path | Purpose |
|------|---------|
| `src/hounfour/goodhart/index.ts` | Goodhart engine re-exports |
| `src/hounfour/goodhart/temporal-decay.ts` | EMA computation + Redis Lua |
| `src/hounfour/goodhart/exploration.ts` | Bernoulli sampling + filtering |
| `src/hounfour/goodhart/calibration.ts` | S3-backed HITL calibration |
| `src/hounfour/goodhart/mechanism-interaction.ts` | Precedence rules |
| `src/hounfour/goodhart/kill-switch.ts` | Feature flag |
| `src/hounfour/goodhart/reputation-adapter.ts` | Enriched adapter |
| `src/hounfour/goodhart/reputation-response.ts` | Schema definition |
| `src/hounfour/goodhart/lua/ema-update.lua` | Redis Lua script |
| `src/hounfour/audit/dynamo-audit.ts` | DynamoDB hash chain |
| `src/hounfour/audit/s3-anchor.ts` | S3 Object Lock anchor |
| `docker-compose.e2e.yml` | E2E test topology |
| `.github/workflows/finn-deploy-aws.yml` | ECR/ECS deploy |
| `deploy/e2e/init-db.sql` | E2E database init |

### Modified Files

| Path | Change |
|------|--------|
| `src/hounfour/types.ts` | `ReputationQueryFn` enriched with `nftId` |
| `src/hounfour/tier-bridge.ts` | Parallel scoring, enriched signature |
| `src/x402/verify.ts` | Chain/contract/recipient binding |
| `src/x402/settlement.ts` | Merchant relayer on-chain submission |
| `src/x402/pricing.ts` | Gas surcharge in quote |
| `src/x402/denomination.ts` | `MicroUSDC` branded type |
| `src/hounfour/billing-conservation-guard.ts` | `checkX402Conservation()` |
| `src/gateway/server.ts` | Health endpoint Goodhart fields |
| `deploy/Dockerfile` | AWS SDK dependencies |

### Deleted Files

| Path | Reason |
|------|--------|
| `deploy/fly.toml` | Fly.io permanently removed (IDR-001) |
