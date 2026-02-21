# PRD: Launch Execution — From Built to Operable

> **Version**: 1.2.0
> **Date**: 2026-02-20
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-029
> **Origin**: [Command Center — Issue #66](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3931932336) + [Bridgebuilder Deep Review PR #82](https://github.com/0xHoneyJar/loa-finn/pull/82)
> **Predecessor**: cycle-027 "Full Stack Launch" (30 sprints, 1,105 tests, bridge FLATLINED) + cycle-028 "Theory of Identity" (superseded — identity work subsumes into this cycle)
> **Cross-Repo**: [loa-freeside #62](https://github.com/0xHoneyJar/loa-freeside/issues/62), [loa-freeside PR #74](https://github.com/0xHoneyJar/loa-freeside/pull/74), [loa-hounfour PR #2](https://github.com/0xHoneyJar/loa-hounfour/pull/2)
> **Issues**: 16 issues across 3 repos — [dependency map](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3931992001)

---

## 0. The Bridgebuilder Observation — Questioning the Question

The previous cycle (cycle-028 "Theory of Identity") planned 30 sprints and 16 tracks of work to build a complete identity architecture from scratch. That plan was comprehensive. It was also the wrong frame.

The right question is not "how do we build everything?" The right question is: **what is the minimum set of operations that makes this system receive a request from a user, route it through a personality-conditioned agent, and collect payment?**

Everything else — the 70K-edge knowledge graph, the 96-dial dAMP matrix, the entropy ceremony, the credit marketplace — is depth. Depth matters. But depth without an operable system is a library without a door.

### The Freeside Discovery

During infrastructure audit for this PRD, a critical discovery: **both NOWPayments and x402 payment adapters already exist in loa-freeside.**

| Component | Location | Status |
|-----------|----------|--------|
| NOWPayments adapter | `themes/sietch/src/packages/adapters/billing/NOWPaymentsAdapter.ts` | Built, needs real keys |
| x402 payment adapter | `themes/sietch/src/packages/adapters/billing/X402PaymentAdapter.ts` | Built, needs real keys |
| x402 middleware | `themes/sietch/src/api/middleware/x402-middleware.ts` | Built |
| Billing routes | `themes/sietch/src/api/routes/billing-routes.ts` | Built, includes `/api/billing/topup` |
| x402 verifier | `themes/sietch/src/packages/adapters/payment/x402-verifier.ts` | Built |
| x402 config | `themes/siecht/src/packages/core/billing/x402-config.ts` | Built |
| PostgreSQL 15 | `docker-compose.dev.yml` | Running (user: arrakis, db: arrakis) |
| Redis 7 | `docker-compose.dev.yml` | Running |
| Terraform (AWS) | `infrastructure/terraform/` | ECS, RDS, ElastiCache, ALB |

This changes the plan from "build payment infrastructure" to **"activate existing infrastructure with real credentials and connect loa-finn as a new service."**

### What's Actually Missing

The honest inventory of what exists vs. what's needed:

| Built | NOT Built |
|-------|-----------|
| 1,105 tests across identity, credits, marketplace, entropy | Docker Compose for loa-finn (no container yet) |
| Double-entry credit ledger with conservation invariants | Real x402 wallet + keys configured |
| Marketplace with escrow settlement | Service-to-service auth between finn and freeside |
| Anti-narration enforcement (60+ forbidden terms) | Per-NFT personality persistence in Redis/Postgres |
| Experience accumulation with epoch drift | On-chain signal reader (reads NFT metadata from Base) |
| Personality-tiered billing types | Static personality config for v1 (before full signal engine) |
| BillingFinalizeClient with DLQ | Agent homepage / `llms.txt` / `agents.md` |
| Pool claim enforcement (confused deputy prevention) | Prometheus metrics + Grafana dashboard |
| loa-hounfour v7.0.0 protocol | OpenAPI spec + TypeScript SDK for Product B |

---

## 1. Problem Statement

The HoneyJar agent system has been under development for 28 cycles (93+ sprints). It has 1,105 tests. It has a multi-model routing protocol (hounfour v7.0.0), a double-entry credit ledger, a marketplace with escrow settlement, entropy-driven minting, and anti-narration enforcement.

**None of it is operable.**

No Docker container runs loa-finn. No real payment keys are configured. No user can discover an agent endpoint and call it. The billing wire between loa-finn and loa-freeside has been tested in integration but never with real USDC. The personality system has types and tests but no persistence layer that survives a restart.

This PRD addresses the gap between "built" and "operable" — the last mile from code to product.

### Two Products

| Product | Description | User | Revenue Model |
|---------|-------------|------|---------------|
| **Product A: Agent per NFT** | Each finnNFT has a unique AI agent with personality derived from on-chain metadata. NFT holders interact via web chat or API. | NFT holders, community members | Credits (Rektdrop) + USDC top-up |
| **Product B: Twilio-style API** | Developers build on top of the personality-conditioned agent API. OpenAPI spec, TypeScript SDK, API keys. | Developers, integrators | Per-request billing via x402 or API keys |

### Why Now

1. **Infrastructure exists** — freeside has payment adapters, database, Docker, Terraform
2. **Protocol is mature** — hounfour v7.0.0 with pool enforcement, budget, DLQ
3. **Identity stack is deep** — 30 sprints of identity economics code with conservation proofs
4. **Competition is moving** — Conway's Automaton launched `SOUL.md` self-authoring; we have deeper architecture but they have a running product
5. **NOWPayments keys are available** — real crypto payment processing is ready to activate

---

## 2. Goals & Success Metrics

### Strategic Objective

Make the system operable: a user can discover an agent, send a message, receive a personality-conditioned response, and payment is collected — end to end, in production, with real money.

### Success Metrics

#### MVP Metrics (P0 — must pass before launch)

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| **L-1** | Container runs | loa-finn starts in Docker, passes health check | `docker compose up` + `curl /health` returns 200 |
| **L-2** | E2E request flow | User sends message → agent responds with personality | Integration test: POST /api/v1/agent/chat → 200 with personality-conditioned response |
| **L-3** | Payment collection | x402 processes real USDC for at least one paid request | On-chain USDC transfer confirmed on Base for a request routed through finn |
| **L-8** | Static personality | v1 agents have personality from static config (before full signal engine) | Agent responds with archetype-appropriate voice |

#### Post-MVP Metrics (P1 — this cycle, after MVP)

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| **L-4** | Personality persistence | Per-NFT personality state in PostgreSQL survives container restart | Stop/start container, query personality by tokenId, verify unchanged |
| **L-6** | Observability | Conservation invariant violations trigger alerts | Prometheus metric `conservation_violations_total` wired to alert |
| **L-7** | SDK exists | Developer can `npm install @honeyjar/finn-sdk` and call agent API | TypeScript SDK builds, types match OpenAPI spec |

#### Future Metrics (P2 — next cycle)

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| **L-5** | Agent discovery | Agent has a public homepage with `llms.txt` | `curl /llms.txt` returns valid agent manifest |

### Non-Goals for This Cycle

- Full 96-dial dAMP derivation from on-chain signals (deferred to identity cycle)
- Credit marketplace with real USDC settlement (marketplace code exists, activation deferred)
- Entropy ceremony UX (code exists, frontend integration deferred)
- Knowledge graph bridge to mibera-codex (deferred)
- DAO governance (deferred)

---

## 3. User Personas

### P1: The NFT Holder (Product A)

Holds a finnNFT. Wants to talk to their agent. Expects:
- Agent has a unique personality (v1: archetype-based, static config)
- Agent remembers context within a session
- Agent is accessible via web chat or API
- Payment works (credits or USDC)

### P2: The Developer (Product B)

Building on the agent API. Expects:
- OpenAPI spec they can read
- TypeScript SDK they can install
- API keys they can generate
- Per-request billing that "just works" (x402)
- Clear rate limits and error codes

### P3: The Operator (Us)

Running the system. Expects:
- `docker compose up` starts everything
- Prometheus metrics show system health
- Conservation invariant violations are immediately visible
- Logs are structured and queryable

---

## 4. Functional Requirements

### FR-1: Containerization & E2E Harness (Track 0)
> **Issue**: [#84](https://github.com/0xHoneyJar/loa-finn/issues/84) | **Priority**: P0 | **Blockers**: None

**FR-1.1**: Dockerfile for loa-finn — multi-stage build, health check endpoint, graceful shutdown.

**FR-1.2**: Docker Compose that extends freeside's existing `docker-compose.dev.yml` — adds loa-finn as a service alongside PostgreSQL 15 and Redis 7. loa-finn connects to the same PostgreSQL and Redis instances.

**FR-1.3**: E2E test harness that boots the full stack (finn + freeside + postgres + redis) and runs integration tests: health check, agent chat, billing flow.

**FR-1.4**: CI workflow (GitHub Actions) that builds container, runs E2E tests, and reports status.

### FR-2: x402 Pay-Per-Request Middleware (Track 1B)
> **Issue**: [#85](https://github.com/0xHoneyJar/loa-finn/issues/85) | **Priority**: P0 | **Blockers**: None

**Architecture Decision**: loa-finn owns x402 challenge issuance and receipt verification locally. Freeside's `X402PaymentAdapter` and `x402-verifier.ts` are imported as library code (shared package or copy), NOT called as a running service dependency. This means finn can verify payments without freeside being online — payment is a local operation; billing reconciliation with freeside happens asynchronously.

**FR-2.1**: x402 middleware on loa-finn's agent API routes. The x402 flow:
1. Client sends request to `/api/v1/agent/chat` without payment headers
2. Finn responds with HTTP 402 + HMAC-signed x402 challenge:
   ```json
   {
     "amount": "1000000",
     "recipient": "0x...",
     "chain_id": 8453,
     "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
     "nonce": "uuid-v4",
     "expiry": 1708445100,
     "request_path": "/api/v1/agent/chat",
     "hmac": "sha256-hmac-of-all-above-fields"
   }
   ```
   The `hmac` field is `HMAC-SHA256(server_secret, canonical_json(amount|recipient|chain_id|token|nonce|expiry|request_path))`. This binds the challenge to the specific request and prevents field tampering. The server secret is `X402_CHALLENGE_SECRET` (32+ bytes, env var).
3. Client makes USDC payment on Base chain for the exact `amount` to `recipient`, obtains transaction hash
4. Client re-sends request with `X-Payment-Receipt: <tx_hash>` and `X-Payment-Nonce: <nonce>` headers
5. Finn re-derives the HMAC from the original challenge fields (looked up by nonce from Redis) and verifies integrity. Then verifies receipt on-chain (see FR-2.2 verification algorithm)
6. Request proceeds to agent inference

> *Flatline SKP-001 (CRITICAL 930): HMAC challenge signing adopted for MVP. Full JWS deferred to post-MVP.*

**FR-2.2**: Receipt verification algorithm (precise specification per Flatline SKP-002):

1. Fetch transaction by `tx_hash` from Base RPC via viem `getTransactionReceipt()`
2. **Status check**: `receipt.status === 1` (tx succeeded). If status=0 → reject with "transaction reverted"
3. **Confirmation depth**: `currentBlock - receipt.blockNumber >= 10`. If insufficient → return 402 with `X-Payment-Status: pending`
4. **Log parsing**: Find `Transfer(address,address,uint256)` event in receipt logs where:
   - Log emitter address === `X402_USDC_ADDRESS` (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
   - `to` parameter === `X402_WALLET_ADDRESS` (case-insensitive address comparison)
   - `value` parameter === challenged `amount` (exact match, USDC uses 6 decimals)
5. **Replay check**: `SETNX tx_hash` in Redis with 24h TTL. If key already exists → reject with "receipt already used"
6. **Nonce validation**: Lookup nonce in Redis challenge store. Verify HMAC matches. Delete nonce entry (single-use).
7. All checks pass → record in `finn_billing_events`, proceed to inference

If any step fails, return appropriate error (402 for payment issues, 400 for malformed input, 503 for RPC failures per FR-2.6).

**FR-2.3**: x402 wallet configuration:
- `X402_WALLET_ADDRESS`: USDC recipient address on Base (public, included in 402 challenge)
- `X402_CHAIN_ID`: 8453 (Base mainnet)
- `X402_USDC_ADDRESS`: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)
- `X402_CHALLENGE_SECRET`: HMAC signing secret for challenge integrity (32+ bytes, generated once, stored in secrets manager). This is NOT a blockchain private key — it's a symmetric secret used only for HMAC signing of 402 challenge objects.
- Finn does not sign blockchain transactions. It only issues HMAC-protected challenges and verifies on-chain receipts.

**FR-2.4**: Payment method selection — strict decision tree (no ambiguity, no fallback):

> *Flatline SKP-003 (HIGH 760): Tightened payment decision tree to eliminate bypass paths.*

```
REQUEST ARRIVES
  │
  ├─ Path in FREE_ENDPOINTS (/health, /llms.txt, /agents.md, /metrics)?
  │    → Allow (no payment, no auth)
  │
  ├─ Has "Authorization: Bearer dk_..." header?
  │    → API KEY PATH:
  │       1. Validate key format (dk_ prefix, length)
  │       2. Lookup key hash in finn_api_keys (must exist, not revoked)
  │       3. Check credit balance ≥ request cost
  │       4. If credits sufficient → debit credits, proceed
  │       5. If credits exhausted → return 402 with x402 challenge
  │          (X-Payment-Upgrade: x402 header signals upgrade path)
  │       6. If key invalid/revoked → return 401 (NOT 402)
  │
  ├─ Has "X-Payment-Receipt" header?
  │    → X402 PATH:
  │       1. Must also have "X-Payment-Nonce" header
  │       2. Validate receipt per FR-2.2 algorithm
  │       3. If valid → proceed
  │       4. If invalid → return 402 with new challenge
  │
  └─ No auth/payment headers on paid endpoint?
       → return 402 with x402 challenge (default path)
```

**Precedence rule**: If BOTH `Authorization` and `X-Payment-Receipt` are present, `Authorization` wins — API key path is evaluated first. This is deterministic and testable. Mixed headers are not an error, but only one path executes.

**Key invariant**: A 401 response ALWAYS means auth failure (bad/missing/revoked key). A 402 response ALWAYS means payment required (no receipt, invalid receipt, or exhausted credits). These are never conflated.

Each request is recorded in a `billing_events` table with: `request_id`, `payment_method` (x402|api_key|free), `amount_micro`, `tx_hash` (if x402), `api_key_id` (if key), `timestamp`. This makes L-3 measurable — every paid request is attributable to a payment method.

**FR-2.5**: Rate Limiting & Abuse Controls. Public endpoints that trigger expensive inference or payment-challenge flows require explicit abuse controls:
- **Free endpoints** (`/health`, `/llms.txt`): Per-IP rate limit — 60 req/min, 1000 req/hour. Exceeds → 429 with `Retry-After`.
- **x402 endpoints**: Per-wallet rate limit — 30 req/min (identified by `X-Payment-Receipt` sender address). Additionally, per-IP limit of 120 req/min for 402 challenge generation (prevents challenge flooding). Exceeds → 429.
- **API key endpoints**: Per-key rate limit — configurable per tier (default: 60 req/min, 10,000 req/day). Burst: token bucket with 10-request burst allowance. Exceeds → 429 with `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers.
- **Implementation**: Redis-backed sliding window counters. Keys: `ratelimit:{type}:{identifier}:{window}`. Rate limit configuration stored in environment variables with sensible defaults.

**FR-2.6**: On-Chain Verification Failure Modes. Receipt verification against Base chain can fail in several ways that must be handled explicitly:
- **RPC outage**: If Base RPC is unreachable, return 503 with `Retry-After: 30`. Do NOT fall back to accepting unverified receipts. Log to `finn_verification_failures` with reason `rpc_unreachable`.
- **Pending transaction**: If tx exists but has insufficient confirmations, return 402 with `X-Payment-Status: pending` and `X-Confirmations-Required: 10`. Client should retry after ~20 seconds.
- **Confirmation depth**: Require minimum 10 confirmations on Base (approximately 20 seconds at 2s block time). This provides sufficient finality for Base L2 while keeping latency acceptable.
- **Reorg handling**: If a previously-confirmed receipt is reorged out, the Redis replay entry remains (preventing re-use of the tx_hash). A background reconciler runs every 5 minutes, checking recent `finn_billing_events` entries (last 1 hour) against on-chain state. Reorged transactions are flagged with `status: reorged` in the billing events table. No automatic service revocation for v1 — operators handle via alerts.
- **Retry/backoff**: Client-facing: exponential backoff guidance in 402/503 responses. Server-side RPC calls: 3 retries with 1s/2s/4s backoff before returning 503.

**FR-2.7**: API Key Lifecycle. API keys are core to Product B and require explicit lifecycle management:
- **Issuance**: API keys are generated via `POST /api/v1/keys` (authenticated via SIWE wallet signature). Format: `dk_{base58_32bytes}` (prefix identifies key type). Each key is tied to a wallet address and a credit account.
- **Storage**: Keys are stored as bcrypt hashes in `finn_api_keys` table. The plaintext key is shown exactly once at creation time. Associated metadata: `wallet_address`, `credit_account_id`, `created_at`, `last_used_at`, `revoked_at`, `rate_tier`.
- **Rotation**: Users can create multiple active keys per wallet. Old keys continue to work until explicitly revoked. No automatic expiration for v1 (but `last_used_at` tracking enables future cleanup).
- **Revocation**: `DELETE /api/v1/keys/{key_id}` (authenticated via SIWE). Revoked keys return 401 immediately. Revocation is permanent — no un-revoke.
- **Credit mapping**: Each API key is linked to a credit account. When credits are exhausted, the key returns 402 with x402 challenge (upgrade path per FR-2.4). Credit balance is queryable via `GET /api/v1/keys/{key_id}/balance`.

### FR-3: Static Personality Config for v1 (Track 2)
> **Issue**: [#88](https://github.com/0xHoneyJar/loa-finn/issues/88) | **Priority**: P0 | **Blockers**: None

**FR-3.1**: Static personality configuration — a JSON/YAML file that maps NFT token IDs to personality configs. Each config includes: archetype, voice description, behavioral traits, expertise domains, and a pre-written BEAUVOIR.md template.

**FR-3.2**: Four archetype templates (Freetekno, Milady, Chicago/Detroit, Acidhouse) with enough variation to demonstrate personality differentiation.

**FR-3.3**: Personality loader that reads static config at startup and serves it via the existing `PersonalityService` interface. This is the v1 bridge — replaced by the full signal engine in a later cycle.

**FR-3.4**: Anti-narration enforcement on static templates: templates must pass `checkAntiNarration()` validation (the 60+ forbidden term list already exists in `src/nft/reviewer-adapter.ts`).

### FR-4: On-Chain Signal Reader (Track 2)
> **Issue**: [#86](https://github.com/0xHoneyJar/loa-finn/issues/86) | **Priority**: P1 | **Blockers**: None

**FR-4.1**: Ethereum provider integration (viem/ethers) that reads finnNFT metadata from the Base chain contract. Extracts: archetype, ancestor, era, element, and any other on-chain fields.

**FR-4.2**: Signal snapshot construction from on-chain data — populates the `SignalSnapshot` type already defined in `src/nft/signal-types.ts`.

**FR-4.3**: Caching layer: on-chain reads are expensive. Cache signal snapshots in Redis with 24h TTL. Transfer invalidation strategy: **TTL-only for v1** — no event subscriptions. On cache miss, call `ownerOf(tokenId)` to refresh ownership. This is sufficient because static personality config (FR-3) is the source of truth in v1; on-chain signals are informational, not authoritative, until the full signal engine is built. Event-based invalidation (viem `watchContractEvent` with reconnect + `lastProcessedBlock` persisted in Redis) is deferred to the identity cycle when on-chain signals become authoritative for personality derivation.

### FR-5: Per-NFT Personality Persistence (Track 2)
> **Issue**: [#87](https://github.com/0xHoneyJar/loa-finn/issues/87) | **Priority**: P1 | **Blockers**: FR-1 (needs Docker/Postgres)

**FR-5.1**: PostgreSQL schema for personality storage. **Schema ownership**: loa-finn owns its own migrations in its own repo, applied to the shared database. Finn tables are namespaced with `finn_` prefix to avoid collisions with freeside tables. Deploy order: freeside migrations run first (it owns the database), then finn migrations run (additive only — new tables, never modifying freeside tables). Rollback: finn migrations are independently reversible without affecting freeside.

**FR-5.2**: Redis cache layer for hot personality data (BEAUVOIR.md, current dAMP fingerprint). Write-through to Postgres. Redis keys namespaced with `finn:` prefix.

**FR-5.3**: Migration from in-memory storage to persistent storage. The existing `PersonalityService` interface doesn't change — only the storage backend.

**FR-5.4**: Schema constraints: `finn_personalities.current_version_id` is a foreign key to `finn_personality_versions(id)`. Unique constraint on `(personality_id, epoch_number)` for experience snapshots to prevent duplication under concurrent writes. All inserts are idempotent (ON CONFLICT DO NOTHING or upsert semantics).

### FR-6: Agent Homepage & Discovery (Track 3)
> **Issue**: [#89](https://github.com/0xHoneyJar/loa-finn/issues/89) | **Priority**: P2 | **Blockers**: None

**FR-6.1**: `GET /llms.txt` endpoint serving agent capability manifest per the emerging llms.txt convention.

**FR-6.2**: `GET /agents.md` endpoint serving a human-readable agent directory.

**FR-6.3**: Per-agent homepage at `GET /agent/:tokenId` — shows personality summary, capabilities, and interaction link.

### FR-7: Conservation Guard Observability (Track 4)
> **Issue**: [#90](https://github.com/0xHoneyJar/loa-finn/issues/90) | **Priority**: P1 | **Blockers**: None

**FR-7.1**: Prometheus metrics endpoint (`GET /metrics`) exposing:
- `conservation_violations_total` — counter of invariant violations
- `credits_by_state{state}` — gauge per credit state
- `settlement_total{status}` — counter of settlements by outcome
- `escrow_balance_total` — total credits in escrow
- `agent_requests_total{archetype}` — requests by personality archetype

**FR-7.2**: Grafana dashboard JSON (importable) showing conservation health, credit flow, and agent usage.

**FR-7.3**: Alert rules: conservation violation → PagerDuty/Discord webhook.

### FR-8: OpenAPI Spec & TypeScript SDK (Track 5)
> **Issue**: [#91](https://github.com/0xHoneyJar/loa-finn/issues/91) | **Priority**: P1 | **Blockers**: None

**FR-8.1**: OpenAPI 3.1 specification for the agent API — covers: agent chat, personality read, health check, marketplace (when activated), credit balance.

**FR-8.2**: TypeScript SDK generated from the OpenAPI spec (using openapi-typescript-codegen or similar). Published to npm as `@honeyjar/finn-sdk`.

**FR-8.3**: SDK includes typed request/response objects, error handling, and x402 payment integration helpers.

---

## 5. Technical Architecture

### 5.1 Service Topology

```
                    ┌─────────────┐
                    │   Client    │
                    │ (web/SDK)   │
                    └──────┬──────┘
                           │ HTTPS
                           ▼
                    ┌─────────────┐
                    │  loa-finn   │  :3001
                    │  (agent)    │
                    └──┬───┬───┬──┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
       ┌───────────┐ ┌──────────┐ ┌──────────────┐
       │ PostgreSQL │ │  Redis   │ │ loa-freeside │
       │    15      │ │    7     │ │  (billing)   │
       │   :5432    │ │  :6379   │ │   :3000      │
       └───────────┘ └──────────┘ └──────────────┘
                                         │
                                         ▼
                                  ┌──────────────┐
                                  │ loa-hounfour │
                                  │  (routing)   │
                                  └──────────────┘
```

loa-finn runs on port 3001 (freeside occupies 3000). Both services share the same PostgreSQL and Redis instances via Docker Compose networking.

### 5.2 Service-to-Service Communication

| Direction | Protocol | Auth | Purpose |
|-----------|----------|------|---------|
| finn → freeside | HTTP REST | S2S JWT (ES256) | Billing finalization, credit operations |
| finn → hounfour | HTTP REST | S2S JWT (ES256) | Model routing, inference |
| finn → PostgreSQL | TCP | Connection string | Personality persistence |
| finn → Redis | TCP | Connection string | Cache, session, rate limiting |
| finn → Base RPC | HTTPS | API key | On-chain signal reads |
| client → finn | HTTPS | x402 / API key | Agent API |

### 5.2.1 S2S Authentication Contract

Service-to-service authentication uses JWT with ES256 (ECDSA P-256). This is separate from end-user authentication (SIWE/EIP-4361, which is for NFT holder wallet verification only — not used for S2S).

**JWT Claims**:
```json
{
  "iss": "loa-finn",              // Issuing service name
  "aud": "loa-ecosystem",         // Shared audience for all ecosystem services
  "sub": "s2s:finn",              // Subject: service identity
  "exp": 1708444800,              // Expiry: 5 minutes from issuance
  "iat": 1708444500,              // Issued-at
  "jti": "uuid-v4"                // Unique token ID for replay prevention
}
```

**Key Distribution & Identification**:

> *Flatline SKP-005 (HIGH 720): Added `kid` headers, fail-closed behavior, pinned keys, clock skew tolerance.*

- Each service has a pre-generated ES256 key pair. Keys are **pinned per environment** — NOT generated at first boot in production (prevents drift on instance restarts). In development, keys may be auto-generated for convenience.
- JWT headers include `kid` (key ID) — format: `{service}:{environment}:{version}` (e.g., `finn:prod:v1`). This enables key identification during rotation without ambiguity.
- Public keys are distributed via environment variables (`S2S_ES256_PUBLIC_KEY_PATH`) for MVP. In production (ECS), stored in AWS Secrets Manager and injected as Docker secrets.
- **Post-MVP**: JWKS endpoint (`/.well-known/jwks.json`) on each service for automated key discovery. For MVP, env-var distribution is sufficient for a 2-3 service ecosystem.

**Key Rotation**:
1. Generate new key pair with incremented version (e.g., `finn:prod:v2`)
2. Deploy new public key to all consumers (added to trusted key set, old key retained)
3. Switch issuer to new private key (new JWTs use new `kid`)
4. Grace period: accept both `v1` and `v2` public keys for 24h
5. After 24h: remove old public key from trusted set

**Middleware Behavior** (fail-closed):
1. Validate JWT signature with known public key (matched by `kid` header)
2. `iss` is in allowed service set
3. `aud` matches `loa-ecosystem`
4. `exp` is in the future (with **30-second clock skew tolerance** — `exp + 30s > now`)
5. `jti` is not in the Redis replay set (stored with TTL = token lifetime + 30s skew buffer)
6. **Fail-closed on Redis outage**: If Redis is unreachable for `jti` check, **reject the token** (401). This prevents replay attacks during Redis failures. The trade-off (brief S2S outage during Redis failure) is preferable to allowing replays on a payment system.

Invalid tokens → 401. Missing tokens → 401. Redis unavailable → 401 (fail-closed).

**Existing Implementation**: The `BillingFinalizeClient` in loa-finn already uses JWT ES256 for finn→freeside communication (implemented in cycle-022, PR #68). This contract formalizes and extends that pattern to all S2S calls, adding `kid` headers, fail-closed semantics, and clock skew tolerance.

### 5.3 Environment Variables

loa-finn needs these added to `.env`. **Two env files are required**: `.env` for local development (localhost URLs) and `.env.docker` for Docker Compose (service name URLs).

**`.env.docker`** (used by Docker Compose — service names resolve via Compose DNS):
```env
# Database (shared with freeside — Compose service name)
DATABASE_URL=postgresql://arrakis:arrakis@postgres:5432/arrakis

# Redis (shared with freeside — Compose service name)
REDIS_URL=redis://redis:6379

# x402 Payment
X402_WALLET_ADDRESS=0x...           # USDC recipient on Base
X402_CHAIN_ID=8453                  # Base mainnet
X402_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # USDC on Base
X402_CHALLENGE_SECRET=...           # HMAC-SHA256 secret for challenge signing (32+ bytes)

# NOWPayments (backup payment method)
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...

# Base RPC (for on-chain reads)
BASE_RPC_URL=https://mainnet.base.org
FINN_NFT_CONTRACT=0x...             # finnNFT contract address

# Service-to-Service (Compose service names)
FREESIDE_URL=http://freeside:3000
HOUNFOUR_URL=http://hounfour:3002

# S2S Auth (see section 5.4)
S2S_JWT_ISSUER=loa-finn
S2S_JWT_AUDIENCE=loa-ecosystem
S2S_ES256_PRIVATE_KEY_PATH=/run/secrets/finn_es256_private.pem
S2S_ES256_PUBLIC_KEY_PATH=/run/secrets/finn_es256_public.pem

# Existing (already configured)
ANTHROPIC_API_KEY=...
PORT=3001
```

**`.env`** (local development — localhost):
```env
DATABASE_URL=postgresql://arrakis:arrakis@localhost:5432/arrakis
REDIS_URL=redis://localhost:6379
FREESIDE_URL=http://localhost:3000
HOUNFOUR_URL=http://localhost:3002
# ... same x402/NOWPayments/RPC vars as .env.docker
```

Docker Compose service names must match: `postgres`, `redis`, `freeside`, `finn`, `hounfour`.

### 5.5 Security Requirements & Threat Model

> *Flatline IMP-001 (HIGH_CONSENSUS, avg 910): auto-integrated*

This system handles real funds (USDC). Security is not a post-launch concern.

**Threat Model — Payment Path**:

| Threat | Attack Vector | Control |
|--------|--------------|---------|
| Receipt replay | Reuse a valid tx_hash for multiple requests | Redis replay set: `(tx_hash)` stored with 24h TTL. Check before processing. |
| Receipt forgery | Fabricate a tx_hash that doesn't exist on-chain | On-chain verification: tx must exist, be confirmed (10+ blocks), and match amount/recipient/token |
| Underpayment | Send less USDC than required | Exact amount matching: verified amount must equal challenged amount (6 decimal USDC precision) |
| Wrong recipient | Pay a different address | Recipient verification: Transfer event `to` must match `X402_WALLET_ADDRESS` |
| Challenge tampering | Modify challenge fields before payment | HMAC-SHA256 signed challenge (FR-2.1 step 2). Server re-derives and verifies HMAC before accepting receipt. |
| Fee-on-transfer tokens | Token deducts fee, recipient gets less | USDC on Base is not fee-on-transfer. Hardcode USDC contract address, reject other tokens. |
| Front-running | Attacker observes tx in mempool, submits receipt first | Redis replay set keyed on tx_hash prevents double-claim. First valid submission wins. |

**Threat Model — API Key Path**:

| Threat | Attack Vector | Control |
|--------|--------------|---------|
| Key leakage | Key exposed in logs/client code | Keys are bcrypt-hashed at rest. Plaintext shown once at creation. Never logged. |
| Brute force | Enumerate `dk_*` keys | 32 bytes of entropy = 2^256 keyspace. Rate limiting on auth failures (10/min per IP). |
| Stolen key abuse | Attacker uses leaked key | Per-key rate limits. `last_used_at` tracking. Wallet owner can revoke via SIWE. |
| Credit exhaustion attack | Attacker drains someone's credits | Credits are per-key, not per-wallet. Revoke the compromised key; other keys unaffected. |

**Key Management**:
- No private keys for x402 (finn only verifies, does not sign)
- S2S ES256 keys: generated at boot, private key file permissions 0600, never logged, rotated per section 5.2.1
- SIWE verification uses wallet public addresses only (no server-side key material)
- All secrets via environment variables or Docker secrets (never in code or config files)

**Input Validation** (all external inputs):
- `X-Payment-Receipt` header: validate hex string format, max 66 chars (0x + 64 hex)
- `Authorization` header: validate `Bearer dk_` prefix, max 64 chars
- Request body: JSON schema validation, max 10KB for chat requests
- Token IDs: validate uint256 range, reject non-numeric
- Wallet addresses: validate EIP-55 checksum format

### 5.6 Database Schema (finn-owned, namespaced)

**Ownership**: loa-finn owns these migrations. They live in `loa-finn/drizzle/migrations/`. They create new tables only — never modify freeside-owned tables.

> *Flatline SKP-004 (HIGH 740): Added schema isolation, DB roles, connection pool sizing, and CI migration check.*

**Schema isolation**: All finn tables live in a dedicated PostgreSQL schema:
```sql
CREATE SCHEMA IF NOT EXISTS finn;
SET search_path TO finn, public;
```
Tables are still prefixed with `finn_` for defense-in-depth (schema + prefix). Freeside tables remain in `public` schema.

**DB roles & privileges**:
- `finn_app` role: `USAGE` on schema `finn`, `SELECT/INSERT/UPDATE/DELETE` on all finn tables. No access to freeside tables.
- `freeside_app` role: `USAGE` on schema `public` only. No access to schema `finn`.
- Migration runner (`finn_migrate`): `CREATE` on schema `finn`, used only during deployments.
- In development (Docker Compose), the shared `arrakis` user has full access for simplicity. Role separation is enforced in staging/production via Terraform.

**Connection pool sizing**: Shared PostgreSQL connection pool must accommodate both services:
- PostgreSQL `max_connections`: 100 (RDS default)
- Freeside pool: 20 connections (existing)
- Finn pool: 15 connections (initial)
- Headroom: 65 connections for migrations, monitoring, ad-hoc queries
- Pool implementation: pg-pool or Drizzle's built-in pooling, configured via `DATABASE_POOL_SIZE` env var.

**Deploy order**: freeside migrations first, then finn migrations. Finn migrations are idempotent (IF NOT EXISTS). Rollback: finn migrations are independently reversible.

**CI migration check**: GitHub Actions workflow validates that finn migrations:
1. Are non-blocking (no `ALTER TABLE ... ADD COLUMN ... NOT NULL` without default on existing tables)
2. Do not reference freeside-owned tables (grep for table names without `finn_` prefix)
3. Apply cleanly against a fresh database with freeside migrations already applied

```sql
-- Schema setup (finn-owned, first migration)
CREATE SCHEMA IF NOT EXISTS finn;

-- Personality storage (finn-owned tables in finn schema)
CREATE TABLE IF NOT EXISTS finn_personalities (
  id TEXT PRIMARY KEY,                -- collection:tokenId
  canonical_name TEXT NOT NULL,
  display_name TEXT,
  archetype TEXT NOT NULL,
  beauvoir_md TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  governance_model TEXT DEFAULT 'holder',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(canonical_name)
);

CREATE TABLE IF NOT EXISTS finn_personality_versions (
  id TEXT PRIMARY KEY,
  personality_id TEXT NOT NULL REFERENCES finn_personalities(id),
  previous_version_id TEXT REFERENCES finn_personality_versions(id),
  signal_snapshot JSONB NOT NULL,
  damp_fingerprint JSONB,
  beauvoir_md TEXT NOT NULL,
  authored_by TEXT NOT NULL,          -- wallet address
  codex_version TEXT,
  experience_digest JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add FK from personalities to versions after both tables exist
ALTER TABLE finn_personalities
  ADD CONSTRAINT fk_current_version
  FOREIGN KEY (current_version_id)
  REFERENCES finn_personality_versions(id)
  DEFERRABLE INITIALLY DEFERRED;     -- Deferred: allows inserting personality + version in same tx

CREATE TABLE IF NOT EXISTS finn_experience_snapshots (
  id TEXT PRIMARY KEY,
  personality_id TEXT NOT NULL REFERENCES finn_personalities(id),
  epoch_number INTEGER NOT NULL,
  topic_distribution JSONB NOT NULL,
  style_counts JSONB NOT NULL,
  dial_offsets JSONB NOT NULL,
  interaction_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,    -- 2 * half_life retention
  UNIQUE(personality_id, epoch_number) -- Prevent duplicate epochs
);

CREATE TABLE IF NOT EXISTS finn_billing_events (
  id TEXT PRIMARY KEY,                -- request_id
  payment_method TEXT NOT NULL,       -- 'x402' | 'api_key' | 'free'
  amount_micro BIGINT DEFAULT 0,
  tx_hash TEXT,                       -- x402 on-chain tx hash (nullable)
  api_key_id TEXT,                    -- API key identifier (nullable)
  personality_id TEXT,                -- Which agent was called
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finn_api_keys (
  id TEXT PRIMARY KEY,                -- key_id (public identifier)
  key_hash TEXT NOT NULL,             -- bcrypt hash of dk_... key
  wallet_address TEXT NOT NULL,       -- owner wallet (EIP-55)
  credit_account_id TEXT,             -- linked credit account
  rate_tier TEXT DEFAULT 'default',   -- rate limit tier
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ              -- NULL = active, set = revoked
);

CREATE TABLE IF NOT EXISTS finn_verification_failures (
  id TEXT PRIMARY KEY,
  failure_reason TEXT NOT NULL,       -- rpc_unreachable | invalid_receipt | reorged | ...
  tx_hash TEXT,
  request_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finn_pv_pid ON finn_personality_versions(personality_id);
CREATE INDEX IF NOT EXISTS idx_finn_es_pid ON finn_experience_snapshots(personality_id);
CREATE INDEX IF NOT EXISTS idx_finn_be_method ON finn_billing_events(payment_method, created_at);
CREATE INDEX IF NOT EXISTS idx_finn_ak_wallet ON finn_api_keys(wallet_address) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_finn_vf_reason ON finn_verification_failures(failure_reason, created_at);
```

---

## 6. Scope & Prioritization

### MVP (This Cycle — P0)

| Track | What | Issue | Delivers |
|-------|------|-------|----------|
| Track 0 | Docker + E2E harness | [#84](https://github.com/0xHoneyJar/loa-finn/issues/84) | Container runs, tests pass |
| Track 1B | x402 middleware | [#85](https://github.com/0xHoneyJar/loa-finn/issues/85) | Pay-per-request works |
| Track 2a | Static personality config | [#88](https://github.com/0xHoneyJar/loa-finn/issues/88) | Agents have personality |

### Post-MVP (This Cycle — P1)

| Track | What | Issue | Delivers |
|-------|------|-------|----------|
| Track 2b | On-chain signal reader | [#86](https://github.com/0xHoneyJar/loa-finn/issues/86) | Real NFT metadata |
| Track 2c | Personality persistence | [#87](https://github.com/0xHoneyJar/loa-finn/issues/87) | Survives restarts |
| Track 4 | Observability | [#90](https://github.com/0xHoneyJar/loa-finn/issues/90) | Prometheus + Grafana |
| Track 5 | OpenAPI + SDK | [#91](https://github.com/0xHoneyJar/loa-finn/issues/91) | Product B enabled |

### Future (Next Cycle — P2)

| Track | What | Issue | Delivers |
|-------|------|-------|----------|
| Track 3 | Agent homepage + `llms.txt` (L-5) | [#89](https://github.com/0xHoneyJar/loa-finn/issues/89) | Discovery |
| Identity | Full signal engine + dAMP derivation | cycle-028 sprints | Deep personality |
| Marketplace | Real USDC settlement | marketplace code activation | Credit trading |

### Cross-Repo Work (loa-freeside)

| What | Issue | Priority |
|------|-------|----------|
| Deploy finn to existing infra | [freeside #77](https://github.com/0xHoneyJar/loa-freeside/issues/77) | P0 |
| Monitoring for finn service | [freeside #78](https://github.com/0xHoneyJar/loa-freeside/issues/78) | P1 |
| NOWPayments activation | [freeside #79](https://github.com/0xHoneyJar/loa-freeside/issues/79) | P1 |
| Personality routing bridge | [freeside #80](https://github.com/0xHoneyJar/loa-freeside/issues/80) | P1 |

### Cross-Repo Work (loa-hounfour)

| What | Issue | Priority |
|------|-------|----------|
| MicroUSDC type + personality schema | [hounfour #19](https://github.com/0xHoneyJar/loa-hounfour/issues/19) | P1 |

---

## 7. Risks & Dependencies

### Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| x402 wallet setup complexity | Blocks revenue | NOWPayments as fallback (keys already available) |
| Base RPC reliability | Blocks on-chain reads | Multiple RPC providers, aggressive caching |
| freeside DB schema conflicts | Blocks persistence | New tables only, no modifications to existing schema |
| Docker networking between services | Blocks E2E | Shared Docker Compose network, health check dependencies |

### External Dependencies

| Dependency | Owner | Status | Fallback |
|-----------|-------|--------|----------|
| Base chain RPC | Alchemy/Infura | Need API key | Public RPC (rate-limited) |
| x402 protocol | Coinbase | Production | NOWPayments adapter |
| NOWPayments API | NOWPayments | Keys available in env | x402 |
| finnNFT contract | 0xHoneyJar | Deployed on Base | Mock contract for testing |

### Decision Log

| Decision | Rationale | Date |
|----------|-----------|------|
| Reuse freeside's PostgreSQL + Redis | Already deployed, schema extensible, avoids infra duplication | 2026-02-20 |
| Static personality config for v1 | Unblocks launch without full signal engine | 2026-02-20 |
| x402 as primary payment, NOWPayments as fallback | x402 is permissionless (better for Product B), NOWPayments is proven | 2026-02-20 |
| loa-finn on port 3001 | freeside occupies 3000, simple port offset | 2026-02-20 |
| Supersede cycle-028 | Identity depth deferred to post-launch; operability first | 2026-02-20 |

---

## 8. Bridgebuilder Observations

### The Permission to Question the Question

The deepest finding in the review of the previous 28 cycles: **we were building depth before operability.** The conservation invariants are excellent. The anti-narration enforcement is novel. The credit marketplace with escrow settlement is genuinely well-engineered. But none of it matters if no one can use it.

This is the classic infrastructure trap. Google built MapReduce, GFS, and Bigtable before they had Search ads working reliably. But they had Search working first. The infrastructure served the product, not the other way around.

### The Freeside Discovery as Organizational Learning

The fact that both payment adapters already existed in freeside — and the command center in Issue #66 initially said "NOT BUILT" — reveals a cross-repo visibility gap. The code exists. The knowledge of its existence didn't cross the repository boundary.

This is Conway's Law in action: the structure of the organization (separate repos) shapes the structure of the system (isolated infrastructure). The fix isn't reorganization — it's the routing bridge (freeside #80) that makes cross-repo capabilities discoverable at the protocol level.

### What "Operable" Actually Means

An operable system isn't just a running container. It's:
1. **Callable** — someone can send a request and get a response (MVP: L-1, L-2, L-8)
2. **Payable** — the system collects revenue for the service (MVP: L-3)
3. **Persistent** — state survives restarts (Post-MVP: L-4)
4. **Observable** — operators can see what's happening (Post-MVP: L-6)
5. **Documented** — developers can build on it (Post-MVP: L-7)
6. **Discoverable** — someone can find the agent endpoint (Future: L-5)

The MVP delivers the first two — callable and payable. Post-MVP adds persistence, observability, and documentation. Discovery comes in the next cycle. The metrics are phased to match the scope, not the aspiration.

---

*Cycle-029: Launch Execution. The infrastructure exists. The code is tested. The question is no longer "can we build it?" The question is "can we make it work?"*
