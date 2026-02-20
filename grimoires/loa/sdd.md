# SDD: Launch Execution — From Built to Operable

> **Version**: 1.1.0
> **Date**: 2026-02-20
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-029
> **PRD Reference**: `grimoires/loa/prd.md` v1.2.0
> **Grounding**: `src/gateway/server.ts`, `src/x402/`, `src/nft/personality.ts`, `src/hounfour/billing-finalize-client.ts`, `src/hounfour/s2s-jwt.ts`, `src/config.ts`, `deploy/Dockerfile`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Component Design](#4-component-design)
5. [Data Architecture](#5-data-architecture)
6. [API Design](#6-api-design)
7. [Security Architecture](#7-security-architecture)
8. [Integration Points](#8-integration-points)
9. [Deployment Architecture](#9-deployment-architecture)
10. [Testing Strategy](#10-testing-strategy)
11. [Development Phases](#11-development-phases)
12. [Technical Risks & Mitigation](#12-technical-risks--mitigation)
13. [Future Considerations](#13-future-considerations)

---

## 1. Executive Summary

### 1.1 What This Cycle Does

loa-finn is a 24-module modular monolith (TypeScript, Node.js 22+, Hono v4) with 1,105 tests, a double-entry credit ledger, marketplace escrow settlement, and multi-model routing via loa-hounfour v7.0.0. None of it is operable — no container exists, no payment keys are configured, no personality survives a restart.

This SDD designs the operational infrastructure to make the existing code callable, payable, persistent, and observable.

### 1.2 What Already Exists (Grounding)

| Component | Location | Status |
|-----------|----------|--------|
| x402 `QuoteService` (price quotes) | `src/x402/middleware.ts` | Built, needs HMAC signing (PRD FR-2.1) |
| x402 `EIP3009Authorization` types | `src/x402/types.ts` | Built, needs receipt verification flow |
| x402 settlement types | `src/x402/settlement.ts` | Built, needs on-chain verification |
| `PersonalityService` (CRUD + Redis) | `src/nft/personality.ts` | Built, needs static config loader |
| `S2SJwtSigner` (ES256 + HS256) | `src/hounfour/s2s-jwt.ts` | Built, needs `kid` header + fail-closed |
| `BillingFinalizeClient` (DLQ) | `src/hounfour/billing-finalize-client.ts` | Built, production-ready |
| Signal types + dAMP derivation | `src/nft/signal-types.ts`, `src/nft/damp.ts` | Built, 96 dials defined |
| Anti-narration (69 terms) | `src/nft/reviewer-adapter.ts` | Built, enforced |
| Hono server + routes | `src/gateway/server.ts` | Built, needs x402/payment routes |
| Docker multi-stage build | `deploy/Dockerfile` | Built, needs Compose integration |
| Redis client | `src/hounfour/redis/client.ts` | Built, production-ready |
| Marketplace settlement | `src/marketplace/settlement.ts` | Built, activation deferred |
| OTLP tracing | `src/tracing/otlp.ts` | Built, needs Prometheus bridge |

### 1.3 What This SDD Designs

| New Component | PRD Ref | Extends |
|---------------|---------|---------|
| Docker Compose integration | FR-1 | `deploy/Dockerfile` |
| HMAC-signed x402 challenge flow | FR-2 | `src/x402/middleware.ts` |
| On-chain receipt verification | FR-2.2 | New: `src/x402/verify.ts` (extend existing) |
| Payment decision tree middleware | FR-2.4 | `src/gateway/server.ts` |
| Rate limiting (multi-tier) | FR-2.5 | `src/gateway/rate-limit.ts` |
| API key lifecycle | FR-2.7 | New: `src/gateway/api-keys.ts` |
| Static personality config | FR-3 | `src/nft/personality.ts` |
| On-chain signal reader | FR-4 | New: `src/nft/on-chain-reader.ts` |
| PostgreSQL persistence | FR-5 | `src/nft/personality.ts` storage backend |
| Prometheus metrics | FR-7 | `src/tracing/otlp.ts` + new `/metrics` |
| OpenAPI spec + SDK | FR-8 | `src/gateway/routes/` |

### 1.4 Design Principles

1. **Extend, don't replace** — existing modules are stable. New code integrates via dependency injection at the existing interfaces.
2. **Feature-flag everything** — new subsystems (x402 verification, Postgres persistence) are behind config flags. In-memory/Redis fallbacks remain functional.
3. **Fail-closed for payments** — if verification infrastructure fails, reject the request. Never grant free service.
4. **Surgical scope** — only what's needed for operability. No refactoring of working code.

---

## 2. System Architecture

### 2.1 Extended Service Topology

```
                         ┌─────────────┐
                         │   Client    │
                         │ (web/SDK)   │
                         └──────┬──────┘
                                │ HTTPS
                                ▼
┌──────────────────────────────────────────────────────────┐
│                    loa-finn :3001                         │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Payment     │  │ Agent        │  │ Personality    │  │
│  │ Decision    │→ │ Inference    │← │ Resolver       │  │
│  │ Tree (§4.1) │  │ (existing)   │  │ (§4.3)        │  │
│  └──────┬──────┘  └──────────────┘  └───────┬────────┘  │
│         │                                    │           │
│  ┌──────┴──────┐                    ┌───────┴────────┐  │
│  │ x402 HMAC   │                    │ Static Config  │  │
│  │ Verifier    │                    │ Loader         │  │
│  │ (§4.2)      │                    │ (§4.3)         │  │
│  └──────┬──────┘                    └───────┬────────┘  │
│         │                                    │           │
│  ┌──────┴──────┐  ┌──────────────┐  ┌───────┴────────┐  │
│  │ API Key     │  │ Prometheus   │  │ On-Chain       │  │
│  │ Manager     │  │ Metrics      │  │ Signal Reader  │  │
│  │ (§4.5)      │  │ (§4.7)       │  │ (§4.4)         │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────┬──────────────┬──────────────────┬─────────────┘
           │              │                  │
    ┌──────┴──────┐ ┌────┴─────┐    ┌──────┴──────┐
    │ PostgreSQL  │ │  Redis   │    │ Base L2 RPC │
    │ 15 (shared) │ │ 7 (shared│    │ (Alchemy/   │
    │ :5432       │ │ ) :6379  │    │  public)    │
    └──────┬──────┘ └──────────┘    └─────────────┘
           │
    ┌──────┴──────┐
    │ loa-freeside│
    │ :3000       │
    └──────┬──────┘
           │
    ┌──────┴──────┐
    │ loa-hounfour│
    │ :3002       │
    └─────────────┘
```

### 2.2 Request Lifecycle

```
Client Request
    │
    ├─ CORS middleware (existing)
    │
    ├─ Rate limiter (§4.6 — per-IP/key/wallet)
    │
    ├─ Payment Decision Tree (§4.1)
    │   ├─ Free path → proceed
    │   ├─ API key path → validate key, check credits → proceed or 402
    │   └─ x402 path → verify HMAC + on-chain receipt → proceed or 402
    │
    ├─ Personality Resolver (§4.3)
    │   ├─ Load from static config (v1)
    │   ├─ Anti-narration check
    │   └─ Inject into request context
    │
    ├─ Agent Inference (existing: HounfourRouter → model pool)
    │   ├─ Billing reserve (existing: BillingFinalizeClient)
    │   └─ Response streaming
    │
    ├─ Billing Event recording (§4.2 — finn_billing_events)
    │
    └─ Response to client
```

### 2.3 Module Dependency Graph (New Components)

```
src/
├── gateway/
│   ├── server.ts           (MODIFY: wire new routes + middleware)
│   ├── payment-decision.ts (NEW: §4.1 payment decision tree)
│   ├── api-keys.ts         (NEW: §4.5 API key lifecycle)
│   └── routes/
│       ├── invoke.ts       (MODIFY: integrate personality context)
│       ├── agent-chat.ts   (NEW: §6.1 /api/v1/agent/chat)
│       ├── keys.ts         (NEW: §6.2 /api/v1/keys/*)
│       └── metrics.ts      (NEW: §6.3 /metrics)
├── x402/
│   ├── types.ts            (MODIFY: add HMACChallenge type)
│   ├── middleware.ts        (MODIFY: HMAC signing on quote generation)
│   ├── verify.ts           (MODIFY: implement receipt verification algorithm)
│   ├── hmac.ts             (NEW: §4.2 HMAC-SHA256 challenge signing)
│   └── reconciler.ts       (NEW: §4.2 background reorg reconciler)
├── nft/
│   ├── personality.ts       (MODIFY: add static config loading path)
│   ├── static-config.ts    (NEW: §4.3 static personality loader)
│   └── on-chain-reader.ts  (NEW: §4.4 Base chain signal reader)
├── persistence/
│   └── postgres.ts         (NEW: §5.1 Drizzle schema + repository)
├── observability/
│   ├── prometheus.ts       (NEW: §4.7 Prometheus metrics registry)
│   └── reconciler.ts       (NEW: §4.2 billing reconciler)
└── config.ts               (MODIFY: add new env vars)
```

---

## 3. Technology Stack

### 3.1 Existing Stack (No Changes)

| Layer | Technology | Version | Justification |
|-------|-----------|---------|---------------|
| Runtime | Node.js | 22+ | LTS, already in Dockerfile |
| Language | TypeScript | 5.7+ | Existing codebase |
| HTTP | Hono | 4.x | Already used, fast, middleware-compatible |
| AI Models | Pi SDK | 0.52.x | Existing agent runtime |
| Routing | loa-hounfour | 7.0.0 | Multi-model routing, already integrated |
| Redis | ioredis | via `redis/client.ts` | Already integrated, production-tested |
| JWT | jose | 6.1+ | Already used for S2S signing |
| Build | tsx + TypeScript | 4.x / 5.7+ | Existing build pipeline |
| Tests | vitest | 4.x | Existing test framework |
| Container | Docker (node:22-slim) | Multi-stage | Existing Dockerfile |

### 3.2 New Additions

| Layer | Technology | Version | Justification |
|-------|-----------|---------|---------------|
| Ethereum | viem | 2.46+ | Already in package.json, used for SIWE. Extends to Base chain reads. |
| Database | Drizzle ORM | 0.30+ | Freeside uses Drizzle — shared migration toolchain reduces operational friction |
| Metrics | prom-client | 15.x | De facto standard for Prometheus metrics in Node.js |
| API Spec | @asteasolutions/zod-to-openapi | 7.x | Generate OpenAPI from Zod schemas (type-safe) |
| SDK Gen | openapi-typescript-codegen | 0.27+ | Generate TypeScript SDK from OpenAPI spec |
| Hashing | Node.js crypto (built-in) | — | HMAC-SHA256 for x402 challenges, bcrypt for API keys |

### 3.3 Technology Decisions

**Why Drizzle over raw SQL**: Freeside already uses Drizzle for its migrations. Using the same ORM means finn migrations follow the same pattern, reducing the knowledge barrier and making CI migration checks simpler. Drizzle's schema-first approach also gives us TypeScript types that match the database schema.

**Why prom-client over OpenTelemetry metrics**: The existing OTLP integration (`src/tracing/otlp.ts`) handles tracing. For metrics, prom-client provides a simpler path to a Prometheus `/metrics` endpoint. The two are complementary — OTLP for distributed traces, Prometheus for aggregated metrics and alerting.

**Why viem over ethers**: viem is already a dependency (used for SIWE/wallet verification). It provides typed ABI encoding, log parsing, and `getTransactionReceipt` — everything needed for receipt verification without adding a second Ethereum library.

---

## 4. Component Design

### 4.1 Payment Decision Tree

**File**: `src/gateway/payment-decision.ts`
**PRD**: FR-2.4

```typescript
export interface PaymentDecision {
  method: "free" | "x402" | "api_key"
  apiKeyId?: string
  creditBalance?: bigint
  x402Receipt?: VerifiedReceipt
}

export interface PaymentDecisionDeps {
  redis: RedisCommandClient
  apiKeyManager: ApiKeyManager
  x402Verifier: X402ReceiptVerifier
  challengeSecret: string
}

export class PaymentDecisionMiddleware {
  constructor(private deps: PaymentDecisionDeps) {}

  /**
   * Hono middleware that determines payment method and attaches
   * PaymentDecision to request context.
   *
   * Decision tree (PRD FR-2.4):
   * 1. Free endpoints → allow (method: "free")
   * 2. BOTH Authorization AND X-Payment-Receipt present → 400 error
   *    "Ambiguous payment method: provide exactly one of
   *    Authorization or X-Payment-Receipt, not both."
   *    (Fail-closed: no implicit precedence on mixed credentials)
   * 3. Has Authorization: Bearer dk_... → API key path
   * 4. Has X-Payment-Receipt + X-Payment-Nonce → x402 path
   * 5. No headers on paid endpoint → return 402 challenge
   *
   * Route handlers MUST check PaymentDecision.method !== "free"
   * for paid endpoints — this is enforced by a type-level guard
   * (PaidRequest extends HonoRequest with PaymentDecision required).
   */
  middleware(): MiddlewareHandler { ... }
}
```

**Free endpoint set** (configurable via `FREE_ENDPOINTS` env var, default):
- `GET /health`
- `GET /llms.txt`
- `GET /agents.md`
- `GET /.well-known/jwks.json`
- `GET /agent/:tokenId` (homepage — read-only)

**Integration point**: Wired into Hono middleware stack in `server.ts`, after CORS and rate limiting, before route handlers.

### 4.2 x402 HMAC Challenge & Receipt Verification

**Files**: `src/x402/hmac.ts` (new), `src/x402/verify.ts` (extend)
**PRD**: FR-2.1, FR-2.2, FR-2.3

#### 4.2.1 HMAC Challenge Signing

```typescript
// src/x402/hmac.ts

import { createHmac } from "node:crypto"

export interface X402Challenge {
  amount: string          // MicroUSDC (6 decimals)
  recipient: string       // X402_WALLET_ADDRESS
  chain_id: number        // 8453
  token: string           // USDC contract address
  nonce: string           // uuid-v4
  expiry: number          // Unix timestamp (5 min from now)
  request_path: string    // e.g., "/api/v1/agent/chat"
  request_method: string  // e.g., "POST"
  request_binding: string // SHA-256 of stable request fields (see binding v1 below)
  hmac: string            // HMAC-SHA256 signature over ALL above fields
}

/**
 * Request binding v1 (Flatline SKP-004):
 * Binds the challenge to specific request parameters so a valid payment
 * cannot be replayed against different inference parameters.
 *
 * request_binding = SHA-256(token_id + "|" + model + "|" + max_tokens)
 *
 * Fields are pipe-delimited, all lowercased, deterministic.
 * If a field is absent, use empty string (e.g., "0x1234||" if model is missing).
 * Version is embedded in the challenge schema — if fields change, bump version.
 */

/**
 * Canonical serialization for HMAC signing.
 * Deterministic: fields in alphabetical order, pipe-delimited.
 * This ensures the same inputs always produce the same HMAC.
 */
// Binding algorithm version: v1 (Flatline SKP-004: includes max_tokens for request specificity)
// If binding fields change, bump version and update challenge schema.
function canonicalize(fields: Omit<X402Challenge, "hmac">): string {
  // Alphabetical order, pipe-delimited, deterministic
  return [
    fields.amount,
    fields.chain_id.toString(),
    fields.expiry.toString(),
    fields.nonce,
    fields.recipient,
    fields.request_binding,
    fields.request_method,
    fields.request_path,
    fields.token,
  ].join("|")
}

export function signChallenge(
  fields: Omit<X402Challenge, "hmac">,
  secret: string
): X402Challenge {
  const canonical = canonicalize(fields)
  const hmac = createHmac("sha256", secret).update(canonical).digest("hex")
  return { ...fields, hmac }
}

export function verifyChallenge(
  challenge: X402Challenge,
  secret: string
): boolean {
  const { hmac: received, ...fields } = challenge

  // Validate HMAC format: must be exactly 64 hex chars
  if (!/^[0-9a-f]{64}$/.test(received)) return false

  const expected = createHmac("sha256", secret)
    .update(canonicalize(fields))
    .digest("hex")

  // Decode as hex (not UTF-8) for proper constant-time comparison
  const receivedBuf = Buffer.from(received, "hex")
  const expectedBuf = Buffer.from(expected, "hex")

  // Length guaranteed equal (both 32 bytes from SHA-256), but guard anyway
  if (receivedBuf.length !== expectedBuf.length) return false

  return timingSafeEqual(receivedBuf, expectedBuf)
}

// All verification errors are caught at the middleware layer and return
// 402 (payment issue) or 400 (malformed input). Never throws uncaught.
```

**Challenge lifecycle**:
1. Generated in `QuoteService.generateQuote()` (existing, extended with HMAC)
2. Stored in Redis: key `x402:challenge:{nonce}`, TTL = 5 minutes
3. Client receives challenge in 402 response body
4. On receipt submission, nonce looked up in Redis, HMAC verified, then deleted (single-use)

#### 4.2.2 Receipt Verification Algorithm

```typescript
// src/x402/verify.ts (extend existing)

import { createPublicClient, http, parseAbiItem } from "viem"
import { base } from "viem/chains"

export interface VerifiedReceipt {
  tx_hash: string
  sender: string
  amount: string
  block_number: bigint
  confirmations: number
}

export class X402ReceiptVerifier {
  private client: ReturnType<typeof createPublicClient>
  private redis: RedisCommandClient
  private walletAddress: string
  private usdcAddress: string
  private minConfirmations: number  // default: 10

  constructor(deps: ReceiptVerifierDeps) { ... }

  /**
   * PRD FR-2.2 verification algorithm — STRICT ORDERING.
   * Challenge validation BEFORE on-chain checks. Replay protection LAST
   * (only after full verification succeeds, prevents replay cache poisoning).
   *
   * Uses atomic Redis Lua script to prevent TOCTOU races between
   * nonce consumption and replay key insertion.
   *
   * 1. Fetch challenge by nonce from Redis — fail if expired/missing
   * 2. Verify HMAC integrity + challenge expiry + request binding
   *    (request_path + token_id + model + max_tokens + method must match)
   * 3. getTransactionReceipt(tx_hash) from Base RPC
   * 4. Check receipt.status === "success" (tx succeeded)
   * 5. Check currentBlock - receipt.blockNumber >= minConfirmations (10)
   * 6. Parse Transfer logs with STRICT matching:
   *    - Emitter === USDC contract address
   *    - to === X402_WALLET_ADDRESS (case-insensitive)
   *    - value === challenged amount (exact match, 6 decimals)
   *    - from === tx.from (payer is the transaction sender)
   *    - Exactly ONE matching Transfer log (fail-closed on multiple matches)
   * 7. ATOMIC Redis Lua script: check nonce exists + unused,
   *    mark nonce used, SETNX replay key on tx_hash (24h TTL)
   *    — all in one atomic operation to prevent races
   * 8. Delete nonce entry (consumed, single-use)
   */
  async verify(
    txHash: string,
    nonce: string,
    expectedAmount: string,
    requestBinding: { path: string; method: string; token_id: string }
  ): Promise<VerifiedReceipt> { ... }
}
```

**RPC failure handling** (PRD FR-2.6):
- RPC unreachable: throw `X402Error` with code `rpc_unreachable`, caught by middleware → 503
- Insufficient confirmations: throw `X402Error` with code `pending`, caught → 402 with `X-Payment-Status: pending`
- Retry policy: 3 attempts with 1s/2s/4s backoff (exponential) before failure

> *Flatline IMP-001 (HIGH_CONSENSUS, avg 765): auto-integrated — RPC circuit breaker*

**RPC circuit breaker**: The Base RPC client is wrapped in a circuit breaker to prevent retry amplification during brownouts:
- **Closed** (normal): requests pass through, failures tracked
- **Open** (after 5 failures in 30s): all requests immediately fail with `rpc_unreachable` (no RPC call). Auto-reset probe after 15s.
- **Half-open**: single probe request. Success → closed. Failure → open.
- Implementation: simple state machine in `X402ReceiptVerifier`, no external library needed.

> *Flatline IMP-002 (HIGH_CONSENSUS, avg 920): auto-integrated — Lua script specification*
> *Flatline SKP-003 (BLOCKER, 850): resolved by IMP-002 — the atomic Lua script eliminates the TOCTOU race between nonce consumption and replay key insertion. No additional fix needed.*

**Atomic Redis Lua script** (step 7 of verification algorithm):

```lua
-- x402_verify_atomic.lua
-- Inputs: KEYS[1] = x402:challenge:{nonce}
--         KEYS[2] = x402:replay:{tx_hash}
--         ARGV[1] = replay TTL (86400 = 24h)
--         ARGV[2] = tx_hash (for binding validation)
-- Returns: 0 = success
--          1 = nonce not found (expired or already consumed)
--          2 = tx_hash already used (replay)
--          3 = nonce already consumed (concurrent request won race)

-- Step A: Check nonce exists and is unconsumed
local challenge = redis.call('GET', KEYS[1])
if not challenge then return 1 end

-- Step B: Check nonce not already consumed (atomic guard)
local consumed = redis.call('GET', KEYS[1] .. ':consumed')
if consumed then return 3 end

-- Step C: Check tx_hash replay
local replay = redis.call('EXISTS', KEYS[2])
if replay == 1 then return 2 end

-- Step D: Atomically mark nonce consumed + set replay key
redis.call('SET', KEYS[1] .. ':consumed', '1', 'EX', 300)
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[1]))
redis.call('DEL', KEYS[1])  -- Clean up challenge

return 0
```

The script is loaded via `EVALSHA` (pre-loaded at boot). Returns integer error codes — the caller maps these to appropriate HTTP responses. No partial state is possible — all mutations happen atomically.

> *Flatline IMP-004 (HIGH_CONSENSUS, avg 850): auto-integrated — HMAC secret rotation*

**X402_CHALLENGE_SECRET rotation procedure**:
1. Generate new secret, set as `X402_CHALLENGE_SECRET_NEW` env var
2. Deploy: service reads both secrets at startup into an ordered array `[new, old]`
3. **Signing**: always uses `new` secret
4. **Verification**: tries `new` first, then `old`. If either produces a valid HMAC, accept.
5. Grace period: 10 minutes (2× challenge TTL of 5 min). After grace, remove `_OLD` env var.
6. Rotation is a config change + restart — no hot-reload needed for MVP.

#### 4.2.3 Background Reconciler

```typescript
// src/observability/reconciler.ts

export class BillingReconciler {
  private interval: ReturnType<typeof setInterval> | null = null

  /**
   * Runs every 5 minutes. Checks recent finn_billing_events (last 1 hour)
   * with payment_method='x402' against on-chain state.
   * If a tx is no longer confirmed (reorged), updates status to 'reorged'.
   * Does NOT revoke service for v1 — operators handle via alerts.
   */
  async reconcile(): Promise<ReconcileResult> { ... }

  start(intervalMs: number = 300_000): void { ... }
  stop(): void { ... }
}
```

### 4.3 Static Personality Config

**File**: `src/nft/static-config.ts`
**PRD**: FR-3

```typescript
// src/nft/static-config.ts

import type { Archetype, SignalSnapshot } from "./signal-types.js"

export interface StaticPersonalityConfig {
  token_id: string
  archetype: Archetype
  display_name: string
  voice_description: string
  behavioral_traits: string[]
  expertise_domains: string[]
  beauvoir_template: string  // Pre-written BEAUVOIR.md
}

export interface StaticConfigFile {
  version: "1.0"
  personalities: StaticPersonalityConfig[]
  archetypes: Record<Archetype, ArchetypeTemplate>
}

/**
 * Loads personality config from JSON file at startup.
 * Validates all entries pass anti-narration check.
 * Integrates with existing PersonalityService via adapter pattern.
 */
export class StaticPersonalityLoader {
  constructor(
    private configPath: string,
    private antiNarration: (text: string) => string[]
  ) {}

  /**
   * Load and validate all personalities from config file.
   * Throws on anti-narration violations (fail-fast at boot).
   */
  async load(): Promise<Map<string, StaticPersonalityConfig>> { ... }

  /**
   * Adapter: converts static config to PersonalityService-compatible format.
   * Used in PersonalityResolver to serve static personalities before
   * full signal engine is built.
   */
  toPersonalityResponse(config: StaticPersonalityConfig): PersonalityResponse { ... }
}
```

**Config file location**: `config/personalities.json` (committed to repo, versioned).

**Four archetype templates** (PRD FR-3.2):

| Archetype | Voice | Behavioral Core | Expertise |
|-----------|-------|----------------|-----------|
| Freetekno | Direct, anti-authoritarian, systems-thinking | Decentralization, autonomy, bottom-up emergence | P2P systems, cryptography, sound systems |
| Milady | Aesthetic, culturally aware, ironic distance | Refinement, cultural synthesis, meta-awareness | Art theory, fashion, memetics, post-irony |
| Chicago/Detroit | Rhythmic, precise, engineering-focused | Structure, discipline, iterative improvement | Music production, engineering, urban systems |
| Acidhouse | Transformative, boundary-dissolving, ecstatic | Emergence, dissolution, psychedelic inquiry | Consciousness, altered states, sonic design |

**Integration with existing PersonalityService**: The `StaticPersonalityLoader` implements a `PersonalityProvider` interface that the existing `PersonalityService` consults. In v1, the static loader is the only provider. In future cycles, the signal engine becomes an additional provider, with the static config as fallback.

```typescript
// Provider interface (new abstraction)
export interface PersonalityProvider {
  get(tokenId: string): Promise<PersonalityResponse | null>
  has(tokenId: string): Promise<boolean>
}

// PersonalityService modification (minimal)
export class PersonalityService {
  private providers: PersonalityProvider[] = []

  addProvider(provider: PersonalityProvider): void {
    this.providers.push(provider)
  }

  // Existing get() method now checks providers first
  async get(tokenId: string): Promise<PersonalityResponse | null> {
    for (const provider of this.providers) {
      const result = await provider.get(tokenId)
      if (result) return result
    }
    return this.getFromRedis(tokenId)  // existing behavior
  }
}
```

### 4.4 On-Chain Signal Reader

**File**: `src/nft/on-chain-reader.ts`
**PRD**: FR-4

```typescript
import { createPublicClient, http, parseAbi } from "viem"
import { base } from "viem/chains"
import type { SignalSnapshot } from "./signal-types.js"
import type { RedisCommandClient } from "../hounfour/redis/client.js"

const FINN_NFT_ABI = parseAbi([
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
])

export class OnChainSignalReader {
  private client: ReturnType<typeof createPublicClient>
  private redis: RedisCommandClient
  private contractAddress: `0x${string}`
  private cacheTtl: number  // default: 86400 (24h)

  constructor(deps: OnChainReaderDeps) {
    this.client = createPublicClient({
      chain: base,
      transport: http(deps.rpcUrl),
    })
    // ...
  }

  /**
   * Read NFT metadata from Base chain.
   * Cache-first: check Redis, then on-chain.
   * PRD FR-4.3: TTL-only invalidation for v1.
   */
  async getSignalSnapshot(tokenId: string): Promise<SignalSnapshot | null> {
    // 1. Check Redis cache
    const cached = await this.redis.get(`finn:signal:${tokenId}`)
    if (cached) return JSON.parse(cached)

    // 2. Cache miss: read from chain
    const [tokenUri, owner] = await Promise.all([
      this.client.readContract({
        address: this.contractAddress,
        abi: FINN_NFT_ABI,
        functionName: "tokenURI",
        args: [BigInt(tokenId)],
      }),
      this.client.readContract({
        address: this.contractAddress,
        abi: FINN_NFT_ABI,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      }),
    ])

    // 3. Fetch and parse metadata from tokenURI
    const metadata = await this.fetchMetadata(tokenUri)
    const snapshot = this.parseToSignalSnapshot(metadata, owner)

    // 4. Cache with TTL
    await this.redis.set(
      `finn:signal:${tokenId}`,
      JSON.stringify(snapshot),
      "EX",
      this.cacheTtl
    )

    return snapshot
  }

  /**
   * Refresh ownership check on cache miss (PRD FR-4.3).
   * Used to verify holder hasn't transferred the NFT.
   */
  async verifyOwnership(tokenId: string): Promise<string> {
    return this.client.readContract({
      address: this.contractAddress,
      abi: FINN_NFT_ABI,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    })
  }
}
```

### 4.5 API Key Manager

**File**: `src/gateway/api-keys.ts`
**PRD**: FR-2.7

```typescript
import { randomBytes, timingSafeEqual } from "node:crypto"
import bcrypt from "bcrypt"

const KEY_PREFIX = "dk_"
const BCRYPT_ROUNDS = 12

export interface ApiKey {
  id: string               // Public identifier (key_id component of dk_{keyId}.{secret})
  key_lookup: string       // HMAC-SHA256(pepper, plaintext) — indexed, for O(1) DB lookup
  key_hash: string         // bcrypt hash — for final verification after indexed lookup
  wallet_address: string   // Owner (EIP-55)
  credit_account_id: string | null
  rate_tier: string
  created_at: Date
  last_used_at: Date | null
  revoked_at: Date | null
}

export class ApiKeyManager {
  private pepper: string  // Server-side pepper for lookup hash (X402_KEY_PEPPER env)

  constructor(
    private db: DrizzleClient,
    private redis: RedisCommandClient,
    pepper: string
  ) {
    this.pepper = pepper
  }

  /**
   * Create a new API key. Returns the plaintext key ONCE.
   * Key format: dk_{keyId}.{secret} — keyId is for display, secret is for auth.
   * Stored as: bcrypt(full_key) for verification + HMAC(pepper, full_key) for indexed lookup.
   */
  async create(walletAddress: string, creditAccountId?: string): Promise<{
    key_id: string
    plaintext_key: string
  }> {
    const keyId = `key_${randomBytes(8).toString("hex")}`
    const secret = randomBytes(32).toString("base64url")
    const plaintext = `${KEY_PREFIX}${keyId}.${secret}`

    const lookupHash = createHmac("sha256", this.pepper)
      .update(plaintext).digest("hex")
    const bcryptHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS)

    await this.db.insert(finnApiKeys).values({
      id: keyId,
      key_lookup: lookupHash,
      key_hash: bcryptHash,
      wallet_address: walletAddress,
      credit_account_id: creditAccountId ?? null,
      rate_tier: "default",
    })

    return { key_id: keyId, plaintext_key: plaintext }
  }

  /**
   * Validate API key. O(1) lookup via indexed HMAC hash, then bcrypt verify.
   * No full-table scan — prevents CPU DoS.
   */
  async validate(plaintextKey: string): Promise<ApiKey | null> {
    if (!plaintextKey.startsWith(KEY_PREFIX)) return null

    // 1. Cache check (Redis, 5-min TTL)
    const lookupHash = createHmac("sha256", this.pepper)
      .update(plaintextKey).digest("hex")
    const cacheKey = `finn:apikey:${lookupHash}`
    const cached = await this.redis.get(cacheKey)
    if (cached === "revoked") return null
    if (cached) {
      const key = JSON.parse(cached) as ApiKey
      this.updateLastUsed(key.id).catch(() => {})
      return key
    }

    // 2. O(1) indexed DB lookup by HMAC hash
    const [key] = await this.db.select()
      .from(finnApiKeys)
      .where(and(
        eq(finnApiKeys.key_lookup, lookupHash),
        isNull(finnApiKeys.revoked_at)
      ))
      .limit(1)

    if (!key) return null

    // 3. bcrypt verification (defense-in-depth — HMAC collision is negligible)
    if (!(await bcrypt.compare(plaintextKey, key.key_hash))) return null

    // 4. Cache validated key
    await this.redis.set(cacheKey, JSON.stringify(key), "EX", 300)
    this.updateLastUsed(key.id).catch(() => {})
    return key
  }

  /**
   * Revoke a key. Immediate effect via Redis cache invalidation.
   */
  async revoke(keyId: string, walletAddress: string): Promise<boolean> { ... }
}
```

**Auth failure rate limiting**: Hard limit of 10 failed auth attempts per IP per minute. After 10 failures, return 429 for 60 seconds. This prevents brute-force attempts against the API key lookup.

### 4.6 Multi-Tier Rate Limiter

**File**: `src/gateway/rate-limit.ts` (extend existing)
**PRD**: FR-2.5

The existing `rateLimitMiddleware` in `src/gateway/rate-limit.ts` uses a simple window counter. Extend with multi-tier support:

```typescript
export interface RateLimitTier {
  identifier: (c: Context) => string   // How to identify the caller
  windowMs: number
  maxRequests: number
  burstAllowance?: number              // Token bucket burst (default: 0)
}

export const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
  free_per_ip: {
    identifier: (c) => c.req.header("x-forwarded-for") ?? c.env.remoteAddr,
    windowMs: 60_000,
    maxRequests: 60,
  },
  x402_per_wallet: {
    identifier: (c) => extractWalletFromReceipt(c),
    windowMs: 60_000,
    maxRequests: 30,
  },
  challenge_per_ip: {
    identifier: (c) => c.req.header("x-forwarded-for") ?? c.env.remoteAddr,
    windowMs: 60_000,
    maxRequests: 120,
  },
  api_key_default: {
    identifier: (c) => c.get("apiKeyId"),
    windowMs: 60_000,
    maxRequests: 60,
    burstAllowance: 10,
  },
}
```

**Redis backend**: Sliding window using `MULTI/EXEC` with sorted sets (score = timestamp). Key: `ratelimit:{tier}:{identifier}`. Expire keys at `windowMs * 2` to prevent memory leak.

### 4.7 Prometheus Metrics

**File**: `src/observability/prometheus.ts`
**PRD**: FR-7

```typescript
import { Registry, Counter, Gauge, Histogram } from "prom-client"

export function createMetricsRegistry(): Registry {
  const registry = new Registry()

  // Conservation health
  registry.registerMetric(new Counter({
    name: "conservation_violations_total",
    help: "Total count of conservation invariant violations",
    labelNames: ["violation_type"],
  }))

  // Credit state distribution
  registry.registerMetric(new Gauge({
    name: "credits_by_state",
    help: "Credit count by billing state",
    labelNames: ["state"],
  }))

  // Settlement outcomes
  registry.registerMetric(new Counter({
    name: "settlement_total",
    help: "Settlement count by outcome",
    labelNames: ["status"],
  }))

  // Escrow balance
  registry.registerMetric(new Gauge({
    name: "escrow_balance_total",
    help: "Total credits in escrow",
  }))

  // Agent request distribution
  registry.registerMetric(new Counter({
    name: "agent_requests_total",
    help: "Agent requests by archetype",
    labelNames: ["archetype", "payment_method"],
  }))

  // Payment verification latency
  registry.registerMetric(new Histogram({
    name: "x402_verification_duration_seconds",
    help: "x402 receipt verification latency",
    buckets: [0.1, 0.5, 1, 2, 5, 10],
  }))

  // DLQ size (existing metric, now exposed via Prometheus)
  registry.registerMetric(new Gauge({
    name: "billing_dlq_size",
    help: "Number of entries in billing DLQ",
  }))

  return registry
}
```

**Route**: `GET /metrics` returns `registry.metrics()` in Prometheus text format.

**Access control**: `/metrics` is NOT publicly exposed. Access is restricted:
- **Development**: No auth (localhost only)
- **Production**: Protected by `METRICS_BEARER_TOKEN` env var. Requests must include `Authorization: Bearer {token}`. Prometheus scraper is configured with this token. Missing/invalid token → 401.
- **Alternative**: In ECS/Kubernetes, expose `/metrics` on a separate internal port (e.g., 9090) that is not routed through the public ALB/ingress. This is the preferred production approach.

**Label cardinality safety**: Labels are restricted to small enum sets only:
- `archetype`: 4 values (freetekno, milady, chicago_detroit, acidhouse)
- `payment_method`: 3 values (x402, api_key, free)
- `violation_type`: bounded enum (conservation, escrow, settlement)
- `status`: bounded enum (success, failure, pending, reorged)
- **NEVER** label by: token_id, wallet address, api_key_id, tx_hash, request_path, or any user-controlled value

**Grafana dashboard**: `config/grafana/finn-dashboard.json` — importable JSON model with panels for conservation health, credit flow, agent usage, payment verification latency, and DLQ health.

### 4.8 Graceful Shutdown Sequence

> *Flatline IMP-006 (HIGH_CONSENSUS, avg 795): auto-integrated*

Shutdown is triggered by `SIGTERM` (Docker/ECS stop signal). The sequence ensures no partial billing flows or inconsistent state:

```typescript
// Shutdown order (src/index.ts, wired at boot)
process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received, starting graceful shutdown")

  // 1. Stop accepting new requests (health check returns 503)
  server.close()

  // 2. Wait for in-flight requests to complete (max 30s)
  await drainInflightRequests({ timeoutMs: 30_000 })

  // 3. Stop background intervals
  reconciler?.stop()
  billingFinalizeClient?.stopReplayTimer()

  // 4. Flush pending DLQ replays
  await billingFinalizeClient?.replayDeadLetters()

  // 5. Flush Prometheus metrics (final scrape window)
  // No-op if metrics are pull-based, but log final state

  // 6. Close database connections
  await postgresPool?.end()

  // 7. Close Redis connections
  await redisClient?.quit()

  // 8. Exit
  process.exit(0)
})
```

**Acceptance tests**: shutdown during active x402 verification completes the verification and records the billing event before exiting. Shutdown during DLQ replay completes current replay batch.

### 4.9 SIWE Authentication Flow

> *Flatline IMP-008 (HIGH_CONSENSUS, avg 745): auto-integrated*

SIWE (Sign-In-With-Ethereum, EIP-4361) is the auth boundary for API key management endpoints (§6.2). The full flow:

```
1. Client: GET /api/v1/auth/nonce
   → Server generates random nonce, stores in Redis: siwe:nonce:{nonce} TTL=5min
   → Response: { nonce: "abc123" }

2. Client: Construct EIP-4361 message:
     domain: finn.honeyjar.xyz
     address: 0x...
     statement: "Sign in to manage API keys"
     uri: https://finn.honeyjar.xyz/api/v1/auth
     version: 1
     chainId: 8453  (Base)
     nonce: "abc123"
     issuedAt: ISO-8601
     expirationTime: +5min

3. Client: Sign message with wallet, POST /api/v1/auth/verify
   → Body: { message: <EIP-4361 string>, signature: <hex> }

4. Server validates:
   a. Parse EIP-4361 message (using siwe library, already in package.json)
   b. Verify signature recovers to stated address
   c. Check nonce exists in Redis and is unconsumed
   d. Check domain matches expected (finn.honeyjar.xyz)
   e. Check chainId matches (8453)
   f. Check expirationTime is in the future
   g. Delete nonce from Redis (single-use, prevents replay)

5. Server issues session token (short-lived JWT, 15min):
   → { token: "eyJ...", expires_in: 900 }
   → JWT contains: sub=wallet_address, exp=15min, aud=finn-api-keys

6. Client uses session token for key management:
   → Authorization: Bearer eyJ... on POST/DELETE /api/v1/keys
```

**Per-request mode** (alternative to sessions): For stateless clients, SIWE signature can be included directly on each key management request. The server validates the signature per-request without issuing a session token. This is more expensive but eliminates session state.

---

## 5. Data Architecture

### 5.1 PostgreSQL Schema

**Schema**: `finn` (isolated from freeside's `public` schema per PRD SKP-004)

**Migration strategy**: Drizzle migrations in `drizzle/migrations/`. Each migration is idempotent (`IF NOT EXISTS`). Finn uses a dedicated `finn_app` DB role with least-privilege grants.

**Role & privilege setup** (first migration, idempotent):

> *Flatline SKP-001 (BLOCKER, 930): Passwords MUST NOT appear in migration SQL. Roles are provisioned externally (Terraform in production, Docker entrypoint in dev). The migration only grants privileges.*

```sql
-- Roles MUST already exist (provisioned by Terraform/Docker entrypoint, NOT by migration)
-- Migration fails fast if roles are missing:
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'finn_app') THEN
    RAISE EXCEPTION 'Role finn_app does not exist — provision via Terraform or Docker entrypoint';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'finn_migrate') THEN
    RAISE EXCEPTION 'Role finn_migrate does not exist — provision via Terraform or Docker entrypoint';
  END IF;
END $$;

-- Schema isolation
CREATE SCHEMA IF NOT EXISTS finn;
ALTER ROLE finn_app SET search_path = finn;
ALTER ROLE finn_migrate SET search_path = finn;

-- Migration role: can create objects in finn schema
GRANT CREATE, USAGE ON SCHEMA finn TO finn_migrate;

-- App role: read/write only, no DDL
GRANT USAGE ON SCHEMA finn TO finn_app;
ALTER DEFAULT PRIVILEGES FOR ROLE finn_migrate IN SCHEMA finn
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO finn_app;
ALTER DEFAULT PRIVILEGES FOR ROLE finn_migrate IN SCHEMA finn
  GRANT USAGE, SELECT ON SEQUENCES TO finn_app;

-- No access to public schema (freeside tables)
REVOKE ALL ON SCHEMA public FROM finn_app;
```

**Role provisioning** (external to migrations):
- **Production**: Terraform `aws_db_user` or equivalent IaC. Passwords in AWS Secrets Manager / Vault. The deployment pipeline provisions roles before running migrations.
- **Staging**: Same as production (Terraform).
- **Development** (Docker Compose): `docker-entrypoint-initdb.d/` script creates roles with dev-only passwords from `.env.docker`. The shared `arrakis` superuser is the entrypoint owner.

```sql
-- docker-entrypoint-initdb.d/01-finn-roles.sql (dev only, NOT in migrations/)
CREATE ROLE finn_app LOGIN PASSWORD :'FINN_APP_PASSWORD';
CREATE ROLE finn_migrate LOGIN PASSWORD :'FINN_MIGRATE_PASSWORD';
```

**updated_at maintenance**: Application code sets `updated_at = NOW()` on every UPDATE call via Drizzle's `.set({ updated_at: sql\`NOW()\` })`. A database trigger is added as defense-in-depth:
```sql
CREATE OR REPLACE FUNCTION finn.update_timestamp()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_personalities_updated
  BEFORE UPDATE ON finn.finn_personalities
  FOR EACH ROW EXECUTE FUNCTION finn.update_timestamp();
```

**Startup health check**: finn refuses to boot if `FINN_POSTGRES_ENABLED=true` and required tables are missing. The boot sequence in `src/index.ts` runs a schema validation query before accepting traffic.

```typescript
// drizzle/schema.ts

import { pgSchema, pgTable, text, bigint, timestamp,
         integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core"

export const finnSchema = pgSchema("finn")

export const finnPersonalities = finnSchema.table("finn_personalities", {
  id: text("id").primaryKey(),                    // collection:tokenId
  canonical_name: text("canonical_name").notNull().unique(),
  display_name: text("display_name"),
  archetype: text("archetype").notNull(),
  beauvoir_md: text("beauvoir_md").notNull(),
  current_version_id: text("current_version_id").notNull(),
  governance_model: text("governance_model").default("holder"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
})

export const finnPersonalityVersions = finnSchema.table("finn_personality_versions", {
  id: text("id").primaryKey(),
  personality_id: text("personality_id").notNull()
    .references(() => finnPersonalities.id),
  previous_version_id: text("previous_version_id")
    .references(() => finnPersonalityVersions.id),
  signal_snapshot: jsonb("signal_snapshot").notNull(),
  damp_fingerprint: jsonb("damp_fingerprint"),
  beauvoir_md: text("beauvoir_md").notNull(),
  authored_by: text("authored_by").notNull(),
  codex_version: text("codex_version"),
  experience_digest: jsonb("experience_digest"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  pidIdx: index("idx_finn_pv_pid").on(table.personality_id),
}))

export const finnExperienceSnapshots = finnSchema.table("finn_experience_snapshots", {
  id: text("id").primaryKey(),
  personality_id: text("personality_id").notNull()
    .references(() => finnPersonalities.id),
  epoch_number: integer("epoch_number").notNull(),
  topic_distribution: jsonb("topic_distribution").notNull(),
  style_counts: jsonb("style_counts").notNull(),
  dial_offsets: jsonb("dial_offsets").notNull(),
  interaction_count: integer("interaction_count").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => ({
  pidIdx: index("idx_finn_es_pid").on(table.personality_id),
  uniqueEpoch: uniqueIndex("idx_finn_es_unique_epoch")
    .on(table.personality_id, table.epoch_number),
}))

export const finnBillingEvents = finnSchema.table("finn_billing_events", {
  id: text("id").primaryKey(),
  payment_method: text("payment_method").notNull(),  // 'x402' | 'api_key' | 'free'
  amount_micro: bigint("amount_micro", { mode: "bigint" }).default(0n),
  tx_hash: text("tx_hash"),
  api_key_id: text("api_key_id"),
  personality_id: text("personality_id"),
  status: text("status").default("confirmed"),       // 'confirmed' | 'reorged'
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  methodIdx: index("idx_finn_be_method").on(table.payment_method, table.created_at),
}))

export const finnApiKeys = finnSchema.table("finn_api_keys", {
  id: text("id").primaryKey(),
  key_lookup: text("key_lookup").notNull().unique(),  // HMAC-SHA256 for O(1) indexed lookup
  key_hash: text("key_hash").notNull(),               // bcrypt for final verification
  wallet_address: text("wallet_address").notNull(),
  credit_account_id: text("credit_account_id"),
  rate_tier: text("rate_tier").default("default"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  last_used_at: timestamp("last_used_at", { withTimezone: true }),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
}, (table) => ({
  walletIdx: index("idx_finn_ak_wallet")
    .on(table.wallet_address)
    .where(sql`${table.revoked_at} IS NULL`),
}))

export const finnVerificationFailures = finnSchema.table("finn_verification_failures", {
  id: text("id").primaryKey(),
  failure_reason: text("failure_reason").notNull(),
  tx_hash: text("tx_hash"),
  request_id: text("request_id"),
  details: jsonb("details"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  reasonIdx: index("idx_finn_vf_reason").on(table.failure_reason, table.created_at),
}))
```

### 5.2 Redis Cache Design

All finn Redis keys use the `finn:` prefix to avoid collisions with freeside/hounfour keys.

| Key Pattern | Value | TTL | Purpose |
|-------------|-------|-----|---------|
| `finn:signal:{tokenId}` | JSON SignalSnapshot | 24h | On-chain signal cache (§4.4) |
| `finn:personality:{tokenId}` | JSON PersonalityResponse | 1h | Hot personality cache (existing pattern) |
| `finn:damp:{tokenId}:{mode}` | JSON DAMPFingerprint | 1h | dAMP mode cache (existing) |
| `x402:challenge:{nonce}` | JSON X402Challenge | 5min | Challenge store for verification |
| `x402:replay:{tx_hash}` | "1" | 24h | Replay prevention |
| `x402:jti:{jti}` | "1" | 5min + 30s | S2S JWT replay prevention |
| `finn:apikey:{hash}` | JSON ApiKey / "revoked" | 5min | API key validation cache |
| `ratelimit:{tier}:{id}` | Sorted set (timestamps) | 2× window | Sliding window rate limiting |

**Memory estimation**: At 100 active personalities + 1000 API keys + 10,000 billing events/day, Redis memory usage is approximately 50MB — well within a 256MB Redis instance.

### 5.3 Data Flow

```
Request with x402 receipt
    │
    ├─ Redis: check x402:replay:{tx_hash}
    ├─ Redis: lookup x402:challenge:{nonce}
    ├─ Base RPC: getTransactionReceipt()
    ├─ PostgreSQL: INSERT finn_billing_events
    ├─ Redis: SET x402:replay:{tx_hash} (24h TTL)
    │
    ├─ Redis: GET finn:personality:{tokenId}
    │   └─ miss → StaticConfigLoader.get() → cache
    │
    ├─ HounfourRouter.route() (existing)
    │   └─ BillingFinalizeClient.finalize() (existing)
    │
    └─ Prometheus: increment counters
```

---

## 6. API Design

### 6.1 Agent Chat Endpoint

```
POST /api/v1/agent/chat
```

**Headers**:
- `X-Payment-Receipt: 0x{tx_hash}` + `X-Payment-Nonce: {uuid}` (x402 path)
- `Authorization: Bearer dk_{key}` (API key path)

**Request**:
```json
{
  "token_id": "42",
  "message": "What do you think about decentralized governance?",
  "session_id": "optional-session-uuid"
}
```

**Response** (200):
```json
{
  "response": "...",
  "personality": {
    "archetype": "freetekno",
    "display_name": "Agent #42"
  },
  "billing": {
    "method": "x402",
    "amount_micro": "1500000",
    "billing_event_id": "evt_..."
  }
}
```

**Error responses**:
- 402: Payment required (includes x402 challenge in body)
- 401: Invalid/revoked API key
- 404: Token ID not found in personality config
- 429: Rate limit exceeded
- 503: RPC/infrastructure failure

### 6.2 API Key Management

```
POST   /api/v1/keys          # Create key (SIWE auth)
GET    /api/v1/keys           # List keys (SIWE auth)
DELETE /api/v1/keys/:key_id   # Revoke key (SIWE auth)
GET    /api/v1/keys/:key_id/balance  # Check credits (SIWE auth)
```

**Authentication**: All key management endpoints require SIWE wallet signature. This uses the existing `siwe` library already in `package.json`.

### 6.3 Metrics & Discovery

```
GET /metrics        # Prometheus text format — REQUIRES auth (see §4.7)
GET /health         # Extended health (existing, add Postgres + personality stats)
GET /llms.txt       # Agent manifest (P2 — Future)
GET /agents.md      # Agent directory (P2 — Future)
GET /agent/:tokenId # Agent homepage (P2 — Future)
```

**`/metrics` is NOT a free endpoint.** It requires `Authorization: Bearer {METRICS_BEARER_TOKEN}` in production (see §4.7 for access control details). In development, auth is optional. It MUST NOT be exposed at the public ALB/ingress without auth or network-level restriction.

### 6.4 OpenAPI Specification

Generated from Zod schemas using `@asteasolutions/zod-to-openapi`. The spec covers all endpoints in §6.1-6.3 and is served at `GET /api/v1/openapi.json`.

The TypeScript SDK (`@honeyjar/finn-sdk`) is generated from this spec during the build process and published to npm. SDK includes:
- Typed request/response objects
- x402 payment flow helper (generate payment, submit receipt)
- API key management methods
- Error handling with typed error codes

---

## 7. Security Architecture

### 7.1 Threat Model Summary

See PRD §5.5 for the full threat model. This section maps threats to implementation controls.

| Threat | PRD Ref | Implementation |
|--------|---------|---------------|
| Receipt replay | §5.5 | Redis `SETNX` with 24h TTL (§4.2) |
| Receipt forgery | §5.5 | On-chain verification algorithm (§4.2.2) |
| Challenge tampering | §5.5, SKP-001 | HMAC-SHA256 signing (§4.2.1) |
| Underpayment | §5.5 | Exact amount matching in verify() |
| API key leakage | §5.5 | bcrypt hashing, single-show plaintext (§4.5) |
| S2S replay | §5.5, SKP-005 | JWT `jti` in Redis, fail-closed (§7.2) |
| Payment bypass | SKP-003 | Strict decision tree, no fallback (§4.1) |
| DB coupling | SKP-004 | Schema isolation, separate roles (§5.1) |

### 7.2 S2S Authentication (Extended)

The existing `S2SJwtSigner` in `src/hounfour/s2s-jwt.ts` already supports ES256. Extensions for this cycle:

1. **Add `kid` header** to all issued JWTs (format: `{service}:{env}:{version}`)
2. **Fail-closed on Redis outage**: If `jti` replay check fails due to Redis being down, reject the token (401). This is a deliberate trade-off — brief S2S outage during Redis failure is preferable to allowing replays.
3. **Clock skew tolerance**: Strict expiry enforcement: `now <= exp` (tokens past expiry are ALWAYS rejected — no post-expiry grace). Skew tolerance applies ONLY to `iat`/`nbf` future-dating: `now + 30s >= nbf` (accept tokens with nbf up to 30s in the future from verifier's perspective, handling clock drift where issuer's clock is ahead). The jose library's `clockTolerance` option is NOT used for exp — exp is validated strictly. Tests MUST prove that a token at `exp + 1s` is rejected.
4. **Redis key prefix**: S2S JWT replay keys use `s2s:jti:{jti}` prefix (NOT `x402:jti:` — separated from payment concerns). TTL = token lifetime + 30s skew buffer.
5. **Required JWT claims**: `iss` (must be in allowed set), `aud` (must match `loa-ecosystem`), `sub` (service identity), `kid` (key identification), `jti` (replay prevention), `exp`, `iat`. Missing any required claim → 401.
6. **Middleware**: New `s2sAuthMiddleware` function that wraps the existing JWT validation with the `kid` + fail-closed + skew + strict claims enhancements.

### 7.3 Input Validation

All external inputs validated at the gateway boundary:

| Input | Validation | Location |
|-------|-----------|----------|
| `X-Payment-Receipt` | Hex string, max 66 chars, `0x` prefix | payment-decision.ts |
| `Authorization` | `Bearer dk_` prefix, max 64 chars | payment-decision.ts |
| Request body | Zod schema, max 10KB | route handler |
| `token_id` | Positive integer string | route handler |
| Wallet address | EIP-55 checksum format | api-keys.ts |

---

## 8. Integration Points

### 8.1 loa-freeside

| Integration | Protocol | Direction | Existing? |
|-------------|----------|-----------|-----------|
| Billing finalization | HTTP + S2S JWT | finn → freeside | Yes (BillingFinalizeClient) |
| Credit balance query | HTTP + S2S JWT | finn → freeside | Yes (usage handler) |
| Shared PostgreSQL | TCP | Both → Postgres | Yes (Docker Compose) |
| Shared Redis | TCP | Both → Redis | Yes (Docker Compose) |

**No new freeside integrations for MVP.** The x402 adapter code is imported as a library, not called as a service.

### 8.2 loa-hounfour

| Integration | Protocol | Direction | Existing? |
|-------------|----------|-----------|-----------|
| Model routing | HTTP + S2S JWT | finn → hounfour | Yes (HounfourRouter) |
| Pool enforcement | In-process | finn internal | Yes (pool-enforcement.ts) |
| Budget management | In-process | finn internal | Yes (budget.ts) |

**No new hounfour integrations.** Personality context (§4.3) is injected into the existing `HounfourRouter.route()` call via the `systemPrompt` parameter.

### 8.3 Base Chain RPC

| Integration | Protocol | Direction | New? |
|-------------|----------|-----------|------|
| Receipt verification | HTTPS (JSON-RPC) | finn → Base RPC | Yes |
| NFT metadata reads | HTTPS (JSON-RPC) | finn → Base RPC | Yes |
| Ownership verification | HTTPS (JSON-RPC) | finn → Base RPC | Yes |

**RPC provider strategy** (Flatline SKP-002, multi-provider pool):

Each provider has its own circuit breaker (§4.2.2). The pool tries providers in priority order; if the current provider's breaker is open, it falls through to the next.

| Priority | Provider | Env Var | Rate Limit | Notes |
|----------|----------|---------|------------|-------|
| 1 (primary) | Alchemy | `ALCHEMY_BASE_RPC_URL` | Per plan (typically 330 CU/s) | Required for production |
| 2 (fallback) | Public Base RPC | hardcoded `https://mainnet.base.org` | ~10 req/s (best effort) | No API key needed; unreliable under load |

```typescript
// src/x402/rpc-pool.ts
interface RpcProvider {
  url: string
  name: string
  circuitBreaker: CircuitBreaker  // per-provider instance (§4.2.2 pattern)
}

class RpcPool {
  private providers: RpcProvider[]

  async call<T>(method: string, params: unknown[]): Promise<T> {
    for (const provider of this.providers) {
      if (provider.circuitBreaker.state === "open") continue
      try {
        const result = await provider.circuitBreaker.execute(() =>
          this.jsonRpc<T>(provider.url, method, params)
        )
        return result
      } catch (err) {
        // Circuit breaker records failure; fall through to next provider
        continue
      }
    }
    throw new X402Error("rpc_unreachable", "All RPC providers unavailable")
  }
}
```

**Config**: If `ALCHEMY_BASE_RPC_URL` is not set, the pool starts with only the public fallback and logs a warning at startup. Production deployments MUST set the Alchemy URL.

---

## 9. Deployment Architecture

### 9.1 Docker Compose (Development)

```yaml
# docker-compose.dev.yml (extends freeside's existing compose)

services:
  finn:
    build:
      context: .
      dockerfile: deploy/Dockerfile
    ports:
      - "3001:3001"
    env_file: .env.docker
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - loa-network

  # These services are defined in freeside's compose
  # Referenced here for completeness
  postgres:
    image: postgres:15
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U arrakis"]
    networks:
      - loa-network

  redis:
    image: redis:7
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
    networks:
      - loa-network

networks:
  loa-network:
    driver: bridge
```

**Port change**: The existing Dockerfile exposes port 3000. For coexistence with freeside, finn runs on 3001. Update `deploy/Dockerfile` EXPOSE and the `PORT` env var.

### 9.2 Migration Runner

```yaml
  finn-migrate:
    build:
      context: .
      dockerfile: deploy/Dockerfile
      # Uses runtime stage (not builder) — has node_modules, compiled JS,
      # and runtime deps (openssl, certs) needed for DB connections.
    command: ["node", "dist/drizzle/migrate.js"]
    env_file: .env.docker
    environment:
      # Migration runner uses finn_migrate role (DDL privileges)
      # Password sourced from .env.docker — NEVER hardcoded
      DATABASE_URL: postgresql://finn_migrate:${FINN_MIGRATE_PASSWORD}@postgres:5432/arrakis
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"    # One-shot, do not restart
    networks:
      - loa-network
```

Runs as a one-shot container before `finn` starts. Creates `finn` schema, roles, and tables. The migration entry point (`dist/drizzle/migrate.js`) is compiled during build and included in the runtime image.

**Migration entry point** (`drizzle/migrate.ts`):
```typescript
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool)

await migrate(db, { migrationsFolder: "drizzle/migrations" })
await pool.end()
process.exit(0)
```

### 9.3 E2E Test Harness

```yaml
  e2e:
    build:
      context: .
      dockerfile: deploy/Dockerfile.test
    command: ["pnpm", "test:e2e"]
    depends_on:
      finn:
        condition: service_healthy
    env_file: .env.docker
    networks:
      - loa-network
```

E2E tests boot the full stack and run integration scenarios: health check, agent chat, x402 payment flow, API key creation + usage. Tests live in `tests/e2e/`.

### 9.4 CI Workflow

```yaml
# .github/workflows/e2e.yml
name: E2E Tests
on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build and test
        run: |
          docker compose -f docker-compose.dev.yml up -d postgres redis
          docker compose -f docker-compose.dev.yml run finn-migrate
          docker compose -f docker-compose.dev.yml up -d finn
          docker compose -f docker-compose.dev.yml run e2e
      - name: Cleanup
        if: always
        run: docker compose -f docker-compose.dev.yml down -v
```

---

## 10. Testing Strategy

### 10.1 Test Pyramid

| Level | What | Tools | Location |
|-------|------|-------|----------|
| Unit | Individual functions (HMAC, validation, parsing) | vitest | `tests/unit/` |
| Integration | Component interactions (x402 → Redis → verify) | vitest + Redis testcontainer | `tests/integration/` |
| E2E | Full request flow (client → finn → response + payment) | vitest + Docker Compose | `tests/e2e/` |
| Contract | API shape matches OpenAPI spec | vitest + zod | `tests/contract/` |

### 10.2 Key Test Scenarios

**x402 Payment Flow**:
1. Happy path: challenge → payment → receipt → verified → inference
2. Replay rejection: same tx_hash used twice → 402
3. Wrong amount: receipt amount != challenged amount → 402
4. Wrong recipient: payment sent to different address → 402
5. Insufficient confirmations: pending tx → 402 with `X-Payment-Status: pending`
6. RPC outage: Base RPC unreachable → 503
7. HMAC tampering: modified challenge fields → 402
8. Expired challenge: nonce expired from Redis → 402

**API Key Lifecycle**:
1. Create key → validate key → use for request → check credits
2. Revoke key → immediately returns 401
3. Exhausted credits → returns 402 with x402 upgrade path
4. Invalid key format → 401 (not 402)

**Static Personality**:
1. Load valid config → all personalities accessible
2. Anti-narration violation in config → fail at boot
3. Unknown token ID → 404
4. Config file missing → fail at boot with clear error

**Conservation Invariants**:
1. Prometheus counter increments on violation
2. Settlement total matches credit flow
3. Escrow balance equals sum of held reserves

### 10.3 Mock Strategy

| External Dependency | Mock Strategy |
|-------------------|---------------|
| Base RPC | viem test client with anvil fork |
| PostgreSQL | Testcontainers (real Postgres, isolated) |
| Redis | Testcontainers (real Redis) |
| freeside S2S | HTTP mock server (MSW or similar) |
| hounfour routing | In-process mock (existing pattern) |

---

## 11. Development Phases

### Phase 1: Foundation (P0 MVP)

| Track | Components | Dependencies |
|-------|-----------|--------------|
| Track 0 | Docker Compose, **PostgreSQL schema + Drizzle migrations**, E2E harness, CI | None |
| Track 1B | x402 HMAC, receipt verification, payment decision tree, API key manager | Track 0 (needs running container + DB) |
| Track 2a | Static personality config, personality provider interface | None |

**Note on persistence**: PostgreSQL schema creation and Drizzle migrations are in Phase 1 (Track 0) because Docker Compose + E2E harness requires the database to be operational. The `finn_billing_events` and `finn_api_keys` tables are needed for x402 and API key flows (Track 1B). Phase 2 adds the *personality persistence migration* (moving from Redis-only to write-through PostgreSQL).

**Deliverables**: Container runs, x402 payment works, agents have personality, billing events recorded in Postgres.

### Phase 2: Depth (P1 Post-MVP)

| Track | Components | Dependencies |
|-------|-----------|--------------|
| Track 2b | On-chain signal reader, Redis caching | Track 0 |
| Track 2c | Personality persistence migration (Redis → write-through Postgres), `finn_personalities` + `finn_personality_versions` populated | Track 0 + 2a |
| Track 4 | Prometheus metrics, Grafana dashboard | Track 0 |
| Track 5 | OpenAPI spec, SDK generation, npm publish | Track 1B + 2a |

**Deliverables**: Personality survives restarts, metrics visible, SDK available.

### Phase 3: Discovery (P2 Future)

| Track | Components | Dependencies |
|-------|-----------|--------------|
| Track 3 | llms.txt, agents.md, agent homepage | Phase 1 |

---

## 12. Technical Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Base RPC rate limiting on public endpoint | High | Blocks on-chain reads | Use Alchemy API key; aggressive Redis caching (24h TTL) |
| x402 HMAC secret rotation during operation | Medium | Challenges signed with old secret become invalid | Grace period: accept both old and new secrets for 5 minutes during rotation |
| Drizzle migration conflicts with freeside | Low | Blocks deployment | Separate schema (`finn`), CI check validates isolation |
| bcrypt API key validation latency | Medium | Slow auth on cold cache | Redis cache (5-min TTL), keep key count bounded |
| Redis failure cascades | Medium | Payment verification, caching, rate limiting all fail | Fail-closed for payments (503), degraded mode for cache misses (direct DB/RPC), in-memory rate limiter fallback |
| Docker Compose port conflicts with freeside | Low | Can't run both services | Fixed ports: freeside=3000, finn=3001, hounfour=3002 |

---

## 13. Future Considerations

### 13.1 Post-MVP Architecture Evolution

| Current (v1) | Future | Trigger |
|-------------|--------|---------|
| Static personality config | Full signal engine + dAMP derivation | Identity cycle |
| HMAC challenge signing | JWS with ES256 | >1000 users or SDK adoption |
| TTL-only cache invalidation | Event-based (viem watchContractEvent) | On-chain signals become authoritative |
| bcrypt key scanning | Prefix-indexed key lookup | >1000 API keys |
| Env-var S2S key distribution | JWKS endpoint per service | >3 services |
| In-memory rate limiter fallback | Redis Cluster | Production scaling |

### 13.2 Technical Debt Tracking

| Debt | Incurred By | Repayment Plan |
|------|------------|----------------|
| bcrypt full-table scan for key validation | §4.5 (MVP simplicity) | Add key prefix hash column for indexed lookup |
| Static personality config is a file, not DB | §4.3 (v1 bridge) | Migrate to PostgreSQL when persistence is stable |
| No event-based NFT transfer detection | §4.4 (TTL-only) | Add viem watchContractEvent in identity cycle |
| ~~Single RPC provider~~ | ~~§8.3~~ | Resolved: multi-provider pool with per-provider circuit breakers (§8.3, Flatline SKP-002) |
| Prometheus metrics not federated | §4.7 (standalone) | Integrate with OTLP collector when OTLP metrics stable |

---

*This SDD designs the minimum viable operational infrastructure for loa-finn. Every component extends existing, tested code. No module reorganization. No unnecessary abstractions. The goal is simple: make the 1,105 tests worth something by making the system they test callable, payable, persistent, and observable.*
