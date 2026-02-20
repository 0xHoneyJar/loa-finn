# PRD: Full Stack Launch — Build Everything, Then Ship

> **Version**: 1.2.0
> **Date**: 2026-02-19
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft — GPT-5.2 APPROVED (iteration 3) · Flatline APPROVED (5 HIGH_CONSENSUS + 5 BLOCKERS integrated)
> **Cycle**: cycle-027
> **Command Center**: [#66](https://github.com/0xHoneyJar/loa-finn/issues/66)
> **Command Deck**: [Round 1](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3919495664)
> **Deep Review**: [Bridgebuilder on PR #79](https://github.com/0xHoneyJar/loa-finn/pull/79#issuecomment-3919440062)
> **GTM Plan**: [arrakis PR #74](https://github.com/0xHoneyJar/arrakis/pull/74)
> **Competitive Intel**: [Issue #80 (Conway)](https://github.com/0xHoneyJar/loa-finn/issues/80) · [Issue #37 (Nanobot)](https://github.com/0xHoneyJar/loa-finn/issues/37) · [Issue #46 (Hive)](https://github.com/0xHoneyJar/loa-finn/issues/46)
> **Predecessor**: cycle-026 "Protocol Convergence v7" (PR #79, bridge complete, JACKED_OUT)
> **Grounding**: `src/hounfour/` (33 files), `src/gateway/` (17 files), `grimoires/loa/reality/` (6 spokes), `tests/` (2101 passing)

---

## 1. Problem Statement

### The Product Gap

52 global sprints across 26 development cycles have produced a world-class inference engine. The infrastructure scorecard ([Issue #66 comment](https://github.com/0xHoneyJar/loa-finn/issues/66)):

```
Infrastructure (the "Terraform")           90%  READY
Product Experience (the "Vercel")          25%  NOT READY
```

Multi-model routing, budget conservation, pool enforcement, BYOK redaction, JWT auth, ensemble strategies, protocol contract (loa-hounfour v7) — all production-grade. But no user can buy credits, no agent has a homepage, no NFT personality can be authored, and no value flows through the system.

### The Timing Window

Three market signals demand immediate action:

1. **Conway Terminal** ([Issue #80](https://github.com/0xHoneyJar/loa-finn/issues/80)) launched Feb 18 — sovereign agent infrastructure with x402 payments. 2M views on announcement. Proves market demand for agent economic autonomy.
2. **x402 adoption** — 75M+ transactions on Coinbase. Google AP2 announced. HTTP-native machine payments are standardizing NOW.
3. **ERC-7857** (Intelligent NFTs) in draft — trade agents with intelligence intact. Our Soul/Inbox architecture ([Issue #27](https://github.com/0xHoneyJar/loa-finn/issues/27)) anticipated this.

### The Strategy: Build Everything, Then Ship

The user's mandate is explicit: **build all killer features before onboarding real users.** Ship as closed beta with invite-only access. Internal testing first with real value flowing. Focus QA on the running system, not concurrent feature shipping.

This PRD defines the complete scope for that strategy.

### Staged Rollout Gates (Flatline SKP-001)

"Build everything, then ship" does NOT mean flip one switch. Each track has a feature flag and an explicit release gate:

| Gate | Tracks Enabled | Users | Value Flow |
|------|---------------|-------|------------|
| **Gate 0: Smoke** | E2E loop only | Engineers only | Fake money (test credits) |
| **Gate 1: Ignition** | + Credit packs + Denominations | Internal team (3-5) | Real USDC → real credits |
| **Gate 2: Warmup** | + NFT experience + Onboarding | Internal + 5 invited | Real agents, real conversations |
| **Gate 3: Idle** | + BYOK | Expanded beta (10-20) | Subscription path validated |
| **Gate 4: Launch** | + x402 + Multi-model review | Full closed beta | All revenue paths live |

Each gate requires:
- All acceptance criteria for included tracks pass
- Conservation guard verified with real (or test) value at that gate
- Feature flags for subsequent gates are OFF (kill-switch per track)
- Rollback plan documented: disable feature flag → previous gate behavior

Feature flags stored in Redis (`feature:{track_name}:enabled`), toggled via admin API.

> Source: User directive 2026-02-19, Issue #66 gap analysis §6, Command Deck Round 1

---

## 2. Goals & Success Metrics

### Business Objectives

| Objective | Success Metric |
|-----------|---------------|
| End-to-end value flow | A credit purchase → inference request → credit deduction completes with conservation guard verification |
| Closed beta operational | Invite-only access active, 5+ internal testers using real credits |
| All revenue paths wired | PAYG (credit packs), BYOK ($5/mo platform fee), and x402 (per-request USDC) all functional |
| NFT agent experience | A finnNFT holder can create an agent personality, chat via web, and see usage |
| Cross-system E2E | Docker compose starts arrakis + loa-finn, runs full inference→billing→credit flow |
| Multi-model review | Bridge iterations produce findings from 2+ models with deduplicated severity ranking |
| Zero-regression deployment | All 2101+ existing tests pass, no new test failures |

### Non-Goals

- **Public launch** — this cycle builds for closed beta only, not general availability
- **Mobile apps** — web chat is sufficient for beta; native apps are post-launch
- **Voice interaction** — text-only for beta (Whisper integration deferred)
- **Agent social network** — inter-NFT messaging deferred (Issue #27 Phase 4)
- **On-chain autonomous actions** — ERC-6551 TBA integration deferred (Issue #27 Phase 4)
- **WhatsApp/Slack/additional channels** — Discord + Telegram + web chat sufficient for beta

---

## 3. User & Stakeholder Context

### Primary Persona: The NFT Holder (Closed Beta)

Invite-only testers who hold a finnNFT (or any NFT from a supported collection). They want to:
- Create a personality for their NFT agent
- Chat with their agent via web (and optionally Discord/Telegram)
- See how much they've spent and what's left
- Optionally bring their own API key (BYOK) for cheaper inference

### Secondary Persona: The Community Admin

Manages a community on arrakis (Discord/Telegram). They want to:
- Set community-wide budget limits
- See aggregate usage across community members
- Control which model tiers are available to which conviction levels

### Tertiary Persona: The Permissionless Agent

An autonomous agent (potentially Conway-powered) that wants to:
- Pay for a single inference request via x402 USDC header
- No account, no credit balance, just money-in → inference-out
- Conservation guard verifies the payment covers the cost

### Stakeholder: The Engineering Team

Needs the closed beta to:
- Validate the conservation guard with real money flowing
- Identify edge cases in the billing pipeline under real usage
- Prove the branded type system prevents denomination mixing in production
- Build confidence before public launch

> Source: Issue #66 §3, Issue #27 (finnNFT architecture), Command Deck §I (Conway persona)

---

## 4. Functional Requirements

### Track 1: E2E Billing Loop (P0 — Everything Else Depends on This)

**FR-1.1: Wire loa-finn → arrakis finalize endpoint**

The billing finalize call must flow from loa-finn to arrakis after every inference request.

- loa-finn calls `POST /api/internal/billing/finalize?format=loh` with S2S JWT
- Request body contains `BillingEntry` protocol type (loa-hounfour v7 schema)
- Response validates against `billing-entry` JSON Schema via Ajv
- Conservation guard's `budget_conservation` invariant fires on the finalize response

**Billing State Machine (4 states):**
1. **RESERVE** — Before inference: check credits sufficient, hold estimated amount
2. **COMMIT** — After inference: finalize with actual cost via arrakis endpoint
3. **RELEASE** — On failure: release held reserve, no charge
4. **VOID** — On partial failure: compensating entry to reverse committed charge

**Preflight Finalize Health Check** (Flatline SKP-002): Before starting inference, loa-finn checks arrakis finalize endpoint health via a lightweight ping (`GET /api/internal/billing/health`). If unhealthy, the request is rejected immediately with HTTP 503 `{ "error": "billing_service_unavailable", "retry_after": 30 }`. This prevents streaming responses that can never be committed.

**Response Gating Rule**: If finalize COMMIT fails *after* streaming has begun (transient failure during inference), the model response is still delivered, but the account enters `PENDING_RECONCILIATION` state. Further requests are blocked until DLQ replay commits the pending charge, auto-release at 24h (NFR-6), or admin releases it. This avoids "paid but no answer" incidents while preventing unbounded debt accumulation.

**Bounded Reconciliation** (Flatline SKP-002): To prevent mass account lockout if arrakis goes down:
- Circuit breaker on finalize endpoint: after 5 consecutive failures in 60s, trip breaker → reject new requests at preflight (not after streaming)
- Max concurrent PENDING_RECONCILIATION accounts: 50 (configurable). If exceeded, new requests denied until queue drains.
- Prometheus alert: `billing_pending_reconciliation_count > 10` triggers PagerDuty

**Acceptance Criteria:**
- [ ] S2S JWT signed with ES256 via vetted library (jose/jsonwebtoken), includes `sub: "loa-finn"`, `aud: "arrakis"`, `req_hash`
- [ ] `req_hash` compared with `timingSafeEqual` (not JWT signature verification itself — ECDSA uses constant-time math internally)
- [ ] `BillingEntry` serialized through `serializeMicroUSD()` (branded type, not raw string)
- [ ] Conservation guard dual-path verification passes (evaluator + ad-hoc) on RESERVE
- [ ] Finalize endpoint is idempotent: `billing_entry_id` (ULID) ensures exactly-once commit
- [ ] Failed finalize triggers DLQ entry with replay capability; account enters PENDING_RECONCILIATION
- [ ] DLQ replay test: simulate finalize failure, verify account blocks new requests, replay succeeds, account unblocks
- [ ] Negative tests: invalid JWT signature, wrong `aud`/`sub`, expired token, wrong `req_hash` — all rejected

**FR-1.2: Protocol handshake at startup**

The handshake validates a single contract domain: the `loa_hounfour_billing_contract` version. loa-finn declares its minimum supported version (`4.0.0`); arrakis declares its implemented version (`4.6.0`). The check is: `arrakis_version >= finn_min_supported`.

- Contract domain: `loa_hounfour_billing_contract` (not loa-hounfour package version or arrakis app version)
- loa-finn declares `FINN_MIN_SUPPORTED_BILLING_CONTRACT = '4.0.0'`
- arrakis responds with `billing_contract_version: '4.6.0'` in handshake response
- Handshake failure prevents service startup (fail-closed)

**Acceptance Criteria:**
- [ ] `compatibility.ts` handshake runs during boot sequence using `billing_contract_version` field
- [ ] Incompatible versions produce a clear error message: "loa-finn requires billing contract >= 4.0.0, arrakis reports 3.x.x"
- [ ] Health endpoint reflects handshake status
- [ ] Test matrix: compatible pairs (4.0.0/4.6.0, 4.0.0/5.0.0) pass, incompatible pairs (4.0.0/3.9.9) fail

**FR-1.3: Docker Compose full stack**

- Single `docker compose up` starts arrakis + loa-finn + Redis
- Real ES256 keypair shared via Docker volume (generated by `e2e-keygen.sh`)
- Test sends inference request through full stack: arrakis → loa-finn → model → budget → finalize → credit deduction

**Acceptance Criteria:**
- [ ] `npm run test:e2e` in arrakis repo passes with both services running
- [ ] Credit balance decrements by expected MicroUSD amount after inference
- [ ] DLQ replay recovers from simulated finalize failure

### Track 2: Denomination System (P0)

**FR-2.1: CreditUnit branded type**

New branded type in `wire-boundary.ts` for pre-loaded credit balances. Follows the `parseMicroUSD` template: strict constructor, lenient reader with normalization metrics, serializer.

**Acceptance Criteria:**
- [ ] `CreditUnit` branded type exported from `wire-boundary.ts`
- [ ] `parseCreditUnit()` with same 3-layer enforcement (type, lint, runtime)
- [ ] `MAX_CREDIT_UNIT_LENGTH` constant shared with MicroUSD (symmetric DoS bounds)
- [ ] CreditUnit ↔ MicroUSD conversion function with explicit exchange rate parameter

**FR-2.2: Credit pack purchase flow**

Users purchase credit packs ($5, $10, $25) that mint a credit balance.

**Closed Beta Payment Rail**: Base USDC transfer (single rail for beta simplicity). Stripe deferred to post-beta.

**Payment Proof Schema:**
```typescript
interface CreditPurchaseRequest {
  pack_size: 500 | 1000 | 2500  // CreditUnit amounts (= $5, $10, $25 at 100 CU/$1)
  payment_proof: {
    tx_hash: string              // Base L2 transaction hash
    chain_id: 8453               // Base mainnet
    token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'  // USDC on Base
    sender: string               // Payer wallet address (must match authenticated wallet)
    amount_micro_usdc: string    // MicroUSDC amount (6 decimals)
  }
  idempotency_key: string        // Client-generated ULID, prevents double-mint
}
```

**Verification Steps** (Flatline SKP-003 — event-log level):
1. Fetch transaction receipt for `tx_hash` on Base RPC
2. Parse USDC `Transfer(address,address,uint256)` event logs from receipt:
   - Verify `token` matches USDC contract address (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
   - Verify `to` matches treasury address (`TREASURY_ADDRESS` env var)
   - Verify `value` matches expected `amount_micro_usdc` for the pack size
   - Record `log_index` for uniqueness: idempotency key is `(tx_hash, log_index)` not just `tx_hash`
3. Verify `from` matches authenticated wallet — **with smart wallet support**:
   - If `from == authenticated_wallet` → EOA match, proceed
   - If `from != authenticated_wallet` → check if `authenticated_wallet` is an authorized signer via EIP-1271 `isValidSignature()` on the `from` contract. If valid, proceed. If not, reject.
   - This supports Safe{Wallet}, Argent, and other smart contract wallets
4. Require 12+ L2 confirmations (finality on Base)
5. Check `(tx_hash, log_index)` against WAL — if seen, return existing mint result (exactly-once)
6. Mint credit balance: double-entry ledger produces entries per posting rules above
7. Conservation guard verifies `budget_conservation` post-mint

**Double-Entry Ledger Rules:**

The ledger is the **source of truth** for all credit balances. Balance is derived, not stored:
```
balance(account) = SUM(credits WHERE account_id = account) - SUM(debits WHERE account_id = account)
```

| Event | Debit Account | Credit Account | Amount | Idempotency Key |
|-------|--------------|----------------|--------|-----------------|
| Credit purchase | `treasury:usdc_received` | `user:{id}:credit_balance` | pack_size CU | `idempotency_key` from request |
| Inference RESERVE | `user:{id}:credit_balance` | `system:reserves_held` | estimated CU | `billing_entry_id` |
| Inference COMMIT | `system:reserves_held` | `system:revenue_earned` | actual CU | `billing_entry_id` |
| Reserve RELEASE | `system:reserves_held` | `user:{id}:credit_balance` | (estimated - actual) CU | `billing_entry_id` |
| VOID | `system:revenue_earned` | `user:{id}:credit_balance` | voided CU | `billing_entry_id` |

**Reconciliation**: Daily automated reconciliation sums all ledger entries by account. If derived balance != cached Redis balance, alert fires and Redis is re-derived from WAL. All posting rules use the `billing_entry_id` as idempotency key — replayed entries produce no additional ledger effect.

**Failure Modes (fail-closed):**
- Tx not found or pending → reject, return "payment not confirmed"
- Tx found but wrong amount/recipient → reject, return "payment mismatch"
- Tx already used (idempotency hit) → return original mint result
- Chain RPC unavailable → reject, return "verification unavailable, retry later"

**Acceptance Criteria:**
- [ ] Credit pack endpoint: `POST /api/v1/credits/purchase` with schema above
- [ ] On-chain verification via Base RPC (viem or ethers): tx status, recipient, amount, confirmations
- [ ] Credit balance minted as CreditUnit branded value with double-entry WAL entries
- [ ] Idempotency: same `idempotency_key` returns identical response, no double-mint
- [ ] Conservation guard `budget_conservation` wired to credit balance (limit = credit balance, spent = accumulated cost)
- [ ] WAL audit entry for every credit mint and deduction
- [ ] Negative tests: wrong amount, wrong recipient, insufficient confirmations, replay — all rejected

**FR-2.3: Credit deduction on inference**

Every inference request deducts from the user's credit balance using the billing state machine defined in FR-1.1.

**Deduction Flow (maps to FR-1.1 state machine):**
1. **RESERVE**: Estimate cost from model + max_tokens + pool tier. Convert MicroUSD estimate to CreditUnit. Hold `estimated_credit_cost` against user balance. If insufficient → HTTP 402 immediately.
2. **Inference executes**: Model generates response (streaming may begin).
3. **COMMIT**: Compute `actual_cost` from realized tokens. Call arrakis finalize with `billing_entry_id`. On success, convert committed MicroUSD to CreditUnit and deduct from balance. Release any excess reserve (`estimated - actual`).
4. **On finalize failure**: Account enters `PENDING_RECONCILIATION` (FR-1.1 gating rule). Reserve remains held. DLQ entry created for replay.

**Exactly-once guarantee**: The `billing_entry_id` (ULID, generated at RESERVE) is the idempotency key for the entire deduction. Retried finalizes with the same ID produce the same ledger effect.

**Concurrency Control** (prevents overdraft from parallel requests):
- **Per-wallet sequencing**: RESERVE operations for the same `account_id` are serialized via Redis Lua script that atomically checks balance and holds reserve. No two RESERVEs for the same account can interleave.
- **Lua script** (pseudocode): `if balance - active_reserves >= estimated_cost then INCR active_reserves; return OK else return INSUFFICIENT end`
- **Optimistic concurrency on COMMIT**: COMMIT includes the `reserve_amount` from RESERVE. If the reserve was already released (e.g., timeout), COMMIT fails gracefully and the response is still delivered (PENDING_RECONCILIATION path).
- **Reserve TTL**: Reserves expire after 5 minutes (configurable via `RESERVE_TTL_SECONDS`). Expired reserves are auto-released by Redis TTL + WAL cleanup job.

**Acceptance Criteria:**
- [ ] Inference cost estimated in MicroUSD at RESERVE, actual cost computed at COMMIT
- [ ] CreditUnit conversion uses explicit exchange rate (`CREDIT_UNITS_PER_USD`, initially 100)
- [ ] **Rate frozen per billing_entry_id** (Flatline SKP-005): the exchange rate at RESERVE time is persisted in the WAL entry and used for COMMIT and RELEASE — no rate drift between operations on the same entry
- [ ] Canonical rounding: RESERVE rounds UP (ceil, user pays slightly more), COMMIT rounds DOWN (floor, user pays slightly less), RELEASE returns exact delta — net effect: user never overpays by more than 1 CU
- [ ] RESERVE holds estimated amount; COMMIT deducts actual; excess released atomically
- [ ] Failed COMMIT → account enters PENDING_RECONCILIATION, reserve held, DLQ entry created
- [ ] Insufficient credits at RESERVE returns HTTP 402 with `{ balance_cu, estimated_cost_cu, deficit_cu }`
- [ ] Conservation guard `budget_conservation` verified at both RESERVE (estimate) and COMMIT (actual)
- [ ] Usage dashboard shows remaining credits, per-request cost breakdown, and any pending reconciliations
- [ ] Test: reserve 100 CU, inference costs 80 CU → 20 CU released, balance reduced by 80 CU
- [ ] Test: reserve 100 CU, finalize fails → balance still shows 100 CU held, account blocked until DLQ replay

**FR-2.4: BYOK platform fee**

BYOK users pay a flat monthly platform fee ($5/mo) for platform access. BYOK is **entitlement-gated**, not conservation-gated — the conservation guard does not check per-request cost against a budget. Instead, the guard checks `entitlement_valid` (is the subscription active?).

**BYOK Entitlement State Machine (4 states):**
1. **ACTIVE** — Subscription current, inference allowed. Checked on every request.
2. **PAST_DUE** — Payment failed or expired. Grace period begins (72 hours). Inference still allowed.
3. **GRACE_EXPIRED** — Grace period elapsed without payment. Inference denied. Account shows "Subscription expired — reactivate to continue."
4. **CANCELLED** — User explicitly cancelled. Inference denied immediately (no grace).

**Per-request check** (replaces `budget_conservation` for BYOK):
```
if (account.byok_entitlement !== 'ACTIVE' && account.byok_entitlement !== 'PAST_DUE') {
  deny("BYOK subscription inactive")
}
```

**Abuse controls**: Rate limit of 1000 requests/day per BYOK account (configurable via `BYOK_DAILY_RATE_LIMIT`). Prevents unlimited usage on flat fee.

**Acceptance Criteria:**
- [ ] BYOK monthly fee: `BYOK_MONTHLY_FEE_MICRO_USD` env var (default: `5000000` = $5.00)
- [ ] Entitlement state machine: ACTIVE → PAST_DUE (on payment failure) → GRACE_EXPIRED (after 72h) → requires reactivation
- [ ] CANCELLED state on explicit cancellation (no grace period)
- [ ] Per-request entitlement check replaces conservation guard `budget_conservation` for BYOK accounts
- [ ] BYOK inference requests metered for usage reporting (token count, model, cost-equivalent) but not charged per-request
- [ ] Rate limit: 1000 req/day per BYOK account (configurable), returns HTTP 429 when exceeded
- [ ] Proration: mid-month activation charges `(remaining_days / 30) * monthly_fee`
- [ ] WAL audit entry for every entitlement state transition
- [ ] Test: ACTIVE account → inference succeeds, metered but not charged
- [ ] Test: GRACE_EXPIRED account → inference denied with reactivation message
- [ ] Test: Rate limit exceeded → HTTP 429 with reset time

### Track 3: x402 Agent Payments (P1)

**FR-3.1: x402 middleware**

Hono middleware that returns `402 Payment Required` with a **fixed price quote** for unauthenticated requests. The quote is a deterministic upper bound, not an estimate.

**Pricing Model**: Fixed price quote per request. The client receives a `max_cost` that is the absolute maximum they will pay. loa-finn enforces `max_tokens` bounds to guarantee the actual cost never exceeds the quote.

**Credit-Note Refund** (Flatline SKP-004): If `actual_cost < quoted_max_cost`, the delta is issued as an off-chain credit note to a wallet-bound x402 balance. This balance can be applied to future x402 requests (reducing the required payment amount). Credit notes expire after 7 days. This avoids user-hostile overcharging while keeping settlement simple (no on-chain refund transfers).

**Per-request receipt**: Every x402 response includes `X-Receipt` header with JSON: `{ "quoted": <max_cost>, "actual": <actual_cost>, "credit_note": <delta>, "credit_balance": <total_x402_credits> }`.

**Quote Calculation**:
```
max_cost = model_rate_per_token × max_tokens × markup_factor
```
Where `max_tokens` is capped at the request's `max_tokens` parameter (or model default if omitted), and `markup_factor` accounts for platform overhead (initially 1.0).

**Acceptance Criteria:**
- [ ] Unauthenticated `POST /api/v1/invoke` returns 402 with `X-Payment-Required` header
- [ ] Header includes: `max_cost` (MicroUSDC), `max_tokens`, `model`, `payment_address`, `chain_id: 8453`, `valid_until` (Unix timestamp, 5 min TTL)
- [ ] `max_cost` is a deterministic upper bound computed from `max_tokens × rate`
- [ ] Authenticated requests (JWT or credit balance) bypass x402 flow
- [ ] Quote is cached per `(model, max_tokens)` tuple for 60s to prevent price manipulation

**FR-3.2: x402 payment verification**

Verify `X-Payment` header contains valid USDC transfer authorization where `paid_amount >= quoted_max_cost`.

**Payment Invariant**: `paid_amount >= quoted_max_cost` (not `paid_amount >= estimated_cost`). The quote is the contract — if the client pays the quoted amount, service is guaranteed.

**Acceptance Criteria:**
- [ ] Parse EIP-3009 `transferWithAuthorization` from `X-Payment` header
- [ ] Verify: signature valid, `amount >= quoted_max_cost`, `validBefore >= now`, nonce unused
- [ ] Enforce `max_tokens` from the quote — request cannot exceed the token bound that produced the price
- [ ] Settlement via openx402.ai facilitator (primary) or direct on-chain verification (fallback)
- [ ] Rounding: all MicroUSDC amounts ceil to nearest 1 MicroUSDC (no fractional units)
- [ ] Nonce replay protection: store used nonces in Redis with TTL matching `validBefore`
- [ ] Test: payment of exact `max_cost` → inference succeeds
- [ ] Test: payment less than `max_cost` → rejected with "insufficient payment" and required amount
- [ ] Test: expired `validBefore` → rejected
- [ ] Test: replayed nonce → rejected

**FR-3.3: MicroUSDC branded type**

Wire boundary type for on-chain USDC settlement amounts. Conversion between internal ledger (MicroUSD) and on-chain settlement (MicroUSDC) uses an explicit, auditable rate.

**Acceptance Criteria:**
- [ ] `MicroUSDC` branded type in `wire-boundary.ts` (6-decimal USDC precision, matches USDC contract decimals)
- [ ] `parseMicroUSDC()` / `serializeMicroUSDC()` with same 3-layer enforcement pattern
- [ ] `convertMicroUSDtoMicroUSDC(amount: MicroUSD, rate: USDtoUSDCRate): MicroUSDC` — explicit rate parameter
- [ ] Rate initially `1.0` but configurable via `USD_USDC_EXCHANGE_RATE` env var
- [ ] **Rate frozen per billing_entry_id** (Flatline SKP-005): conversion rate at quote time persisted in WAL; settlement uses same rate regardless of env var changes between quote and settlement
- [ ] Rounding: `Math.ceil()` on MicroUSDC conversions (platform bears sub-unit loss, not user)
- [ ] Rate and rounding logged in WAL for audit trail
- [ ] Reconciliation report: daily job sums rounding deltas by denomination, alerts if cumulative drift exceeds threshold (configurable, default 1000 MicroUSD)

### Track 4: NFT Agent Experience (P0)

**FR-4.1: Per-NFT personality authoring**

Each finnNFT gets a unique BEAUVOIR.md personality file.

**Acceptance Criteria:**
- [ ] `POST /api/v1/nft/:tokenId/personality` creates personality from template + user preferences
- [ ] Preferences: name, voice (analytical/creative/witty/sage), expertise domains, custom instructions
- [ ] Personality stored in persistence layer (WAL → R2), keyed by `collection:tokenId`
- [ ] NFTRoutingConfig updated to route this personality → appropriate task → pool mapping
- [ ] Personality hot-reloadable (FileWatcher or config update endpoint)

**FR-4.2: Agent homepage (web chat)**

Each NFT gets a URL that serves a chat interface.

**Acceptance Criteria:**
- [ ] `GET /agent/:collection/:tokenId` serves agent homepage with personality info + chat widget
- [ ] Chat widget connects via WebSocket for streaming responses
- [ ] Wallet connect (MetaMask, WalletConnect) for authentication
- [ ] Session resume across page reloads (existing session management)
- [ ] Usage display: credits remaining, messages sent, model used

**FR-4.3: Conversation persistence**

User conversations stored per-NFT with session continuity.

**Access Model**: Conversations are **bound to the wallet address at creation time** (not transferable with NFT). If the NFT is transferred to a new owner, the new owner starts fresh conversations. The previous owner retains read-only access to their historical conversations but cannot create new ones for the transferred NFT.

This is the simpler, more private model for closed beta. On-trade conversation transfer (re-encryption for new owner) is deferred to post-beta as part of Soul/Inbox Phase 2 (Issue #27).

**Ownership Verification**: On each API call, verify `msg.sender == conversation.owner_address`. No on-chain ownership check required for conversation access — ownership was verified at creation time. NFT ownership is only checked when creating a NEW conversation (to confirm the wallet holds the NFT).

**Acceptance Criteria:**
- [ ] Conversation thread model: `conversation_id`, `nft_id`, `owner_address`, `messages[]`, `created_at`
- [ ] `owner_address` set at conversation creation time from authenticated wallet
- [ ] Access check: `request.wallet_address === conversation.owner_address` (constant-time comparison)
- [ ] NFT ownership verified via on-chain read (Base RPC, 1 confirmation) only at conversation creation
- [ ] New owner of a transferred NFT can create new conversations but cannot access previous owner's
- [ ] Conversations stored in Redis (hot) with WAL backup (warm) and R2 archive (cold)
- [ ] Conversation list API: `GET /api/v1/nft/:tokenId/conversations` — filtered by authenticated wallet
- [ ] Conversation survives session eviction (SessionRouter's 30min idle / 100 max cache)
- [ ] Test: wallet A creates conversation, NFT transfers to wallet B → B cannot read A's conversations
- [ ] Test: wallet B creates new conversation for same NFT after transfer → succeeds

### Track 5: Onboarding & Access Control (P0)

**FR-5.1: Invite-only access**

Closed beta restricted to invited wallet addresses.

**Allowlist Storage**: For closed beta, store **plaintext normalized addresses** in Redis set (`beta:allowlist`). Hashing deferred — with < 100 beta addresses, the privacy benefit of hashing doesn't justify the implementation complexity. If beta scales beyond 1000 addresses, migrate to `keccak256(lowercase_address)` with no salt (deterministic lookup).

**Normalization**: All addresses normalized to lowercase before storage and lookup. EIP-55 mixed-case checksums are stripped — comparison is case-insensitive hex.

**Lookup**: `SISMEMBER beta:allowlist <lowercase_address>` — O(1) Redis set membership check.

**Acceptance Criteria:**
- [ ] Allowlist stored as Redis set (`beta:allowlist`) with plaintext lowercase addresses
- [ ] Address normalization: strip `0x` prefix optionally, lowercase, validate 40 hex chars, re-add `0x`
- [ ] `SISMEMBER` lookup on every authenticated request (< 1ms with Redis)
- [ ] Non-allowlisted wallets get HTTP 403 with JSON `{ "error": "beta_access_required", "waitlist_url": "..." }`
- [ ] Admin endpoint: `POST /api/v1/admin/allowlist` (add/remove addresses), protected by admin JWT
- [ ] Admin JWT requires `role: "admin"` claim (not just any valid JWT)
- [ ] Allowlist bypass: addresses in `BETA_BYPASS_ADDRESSES` env var always pass (internal testing)
- [ ] Rate limiting on allowlist check endpoint to prevent enumeration (10 req/min per IP)
- [ ] WAL audit entry for every allowlist add/remove operation
- [ ] Test: allowlisted address → access granted
- [ ] Test: non-allowlisted address → 403 with waitlist URL
- [ ] Test: mixed-case address matches lowercase entry in allowlist

**FR-5.2: Onboarding flow**

From wallet connect to first agent message.

**Acceptance Criteria:**
- [ ] Step 1: Connect wallet → detect NFTs (via arrakis NativeReader or direct chain query)
- [ ] Step 2: Select NFT → show as agent avatar
- [ ] Step 3: Configure personality (name, voice, expertise)
- [ ] Step 4: Purchase credits (or activate BYOK)
- [ ] Step 5: Agent goes live → redirect to agent homepage
- [ ] Step 6: First message → streaming response → credit deducted → usage updated
- [ ] Complete flow works end-to-end with real value (even if small amounts for testing)

### Track 6: Multi-Model Review (P1)

**FR-6.1: Bridge + Flatline unification**

Bridge iterations invoke Flatline Protocol for multi-model findings.

**Acceptance Criteria:**
- [ ] Bridge iteration N triggers Flatline with PR diff as content
- [ ] Opus reviews architecture, GPT reviews implementation
- [ ] Findings merged, deduplicated by location + description similarity
- [ ] Severity ranking reflects multi-model consensus (HIGH_CONSENSUS, DISPUTED)
- [ ] Sprint plan generated from consensus findings only

### Track 7: Operational Hardening (P0)

**FR-7.1: Production deployment**

loa-finn deployed to cloud with monitoring.

**Treasury Security:**
- Treasury address for credit pack payments MUST be a multisig (Safe{Wallet} 2-of-3 or similar)
- Key custody: keys held by 3 separate team members, no single point of compromise
- Treasury address configured via `TREASURY_ADDRESS` env var (not hardcoded)
- Monitoring: alert if treasury receives unexpected token types or amounts outside pack sizes
- Rotation: if treasury is compromised, update `TREASURY_ADDRESS` + invalidate all pending payment proofs + alert all users
- Incident response: documented runbook for treasury compromise (freeze credit mints, rotate address, audit recent mints)

**Acceptance Criteria:**
- [ ] Fly.io (or Railway) deployment with health checks
- [ ] Prometheus metrics endpoint (`/metrics`)
- [ ] Grafana dashboard: request rate, latency, error rate, credit balance distribution, conservation guard results
- [ ] JWKS key rotation with production keys (not dev keys)
- [ ] Rate limiting tuned for beta traffic (conservative initially)
- [ ] Treasury address is multisig with 2-of-3 signing requirement
- [ ] Treasury monitoring: alert on unexpected transfers or amounts
- [ ] Treasury rotation runbook documented and tested

**FR-7.2: Conservation guard remaining suggestions**

Address non-blocking items from PR #79 bridge review.

**Acceptance Criteria:**
- [ ] `recoveryStopped` flag (BB-026-iter2-002) — state-based recovery
- [ ] `MAX_MICRO_USD_LENGTH` shared constant (BB-026-iter2-003) — symmetric DoS bounds
- [ ] `"ensemble-untraced"` extracted to constant (BB-026-iter2-004)
- [ ] `native-runtime-adapter.ts:416` trace_id fixed (BB-026-iter2-005)
- [ ] Full backoff sequence test (BB-026-iter2-007)

---

## 5. Technical & Non-Functional Requirements

### NFR-1: Conservation Guarantee

Every financial operation MUST be verified by the BillingConservationGuard's dual-path lattice. This is the constitutional constraint ([Deep Review §II](https://github.com/0xHoneyJar/loa-finn/pull/79#issuecomment-3919440062)).

- Evaluator result AND ad-hoc result must both pass
- Divergence between evaluator and ad-hoc triggers alert
- Bypassed evaluator (null expression) defers to ad-hoc only
- All invariant results logged to WAL

### NFR-2: Branded Type Safety

All financial values MUST flow through wire-boundary branded types. No raw bigint or string for monetary values.

- MicroUSD for internal ledger
- CreditUnit for user balances
- MicroUSDC for on-chain settlement
- BasisPoints for percentage calculations
- ESLint rule bans `as MicroUSD` (only `parseMicroUSD()` can construct)

### NFR-3: Fail-Closed by Default

Every new subsystem MUST default to denying operations when uncertain.

- Missing credit balance → deny (not "assume unlimited")
- Missing personality → use default BEAUVOIR.md (not blank)
- x402 payment verification failure → deny (not "serve anyway")
- Unknown denomination → deny (not "treat as MicroUSD")

### NFR-4: Audit Trail

Every state-changing operation MUST produce a WAL entry.

- Credit mint, deduction, refund
- Personality creation, update
- x402 payment verification (success and failure)
- Conservation guard results (pass, fail, divergence)
- Allowlist changes

### NFR-5: Performance

- Inference latency: < 200ms overhead from loa-finn (excluding model response time)
- Credit check: < 5ms (Redis lookup)
- x402 verification: < 500ms (on-chain or facilitator)
- Conservation guard: < 1ms per invariant (4 invariants = < 4ms total)

### NFR-6: Persistence & Recovery

Three-tier persistence (Redis → WAL → R2) requires explicit failure mode handling:

| Tier | RPO | RTO | Failure Mode | Behavior |
|------|-----|-----|-------------|----------|
| Redis (hot) | 0 (in-memory) | < 1s (reconnect) | Redis down | Fail-closed: deny new requests, serve no stale balances |
| WAL (warm) | 0 (append-only) | < 5s (reopen) | WAL write failure | Fail-closed: deny operation, do not ack to caller |
| R2 (cold) | ≤ 5min (async sync) | < 30s (re-sync) | R2 unavailable | Degrade: continue with Redis+WAL, queue R2 sync, alert |

**DLQ Specification** (supports FR-1.1 PENDING_RECONCILIATION):

- **Backend**: Redis Streams (`billing:dlq` stream) with consumer group per service instance
- **Retry policy**: Exponential backoff (1s, 2s, 4s, 8s, 16s), max 5 retries
- **Poison message**: After max retries, move to `billing:dlq:poison` stream, alert admin
- **Manual resolution**: Admin API endpoint `POST /api/v1/admin/reconcile/:billing_entry_id` with RELEASE or FORCE_COMMIT actions
- **Max pending duration**: 24 hours. After 24h, auto-release reserve and log `auto_release_timeout` WAL entry. Account unblocked with warning.
- **Monitoring**: Prometheus gauge `billing_pending_reconciliation_count`, alert if > 10

### NFR-7: Security

- **JWT verification**: Use a vetted JWT library (jose or jsonwebtoken) for ES256 ECDSA signature verification. ECDSA verification is inherently constant-time — do NOT add manual timing-safe comparison to the signature check itself. Apply `timingSafeEqual` to fixed-length secret comparisons: `req_hash` validation, API key comparison, webhook signature verification.
- **BYOK keys**: Never stored by loa-finn (proxy-only, deny-by-default redaction via existing `byok-redaction-filter.ts`)
- **x402 nonces**: EIP-3009 nonces stored in Redis with TTL matching `validBefore` — prevents replay attacks
- **Allowlist**: Plaintext normalized lowercase addresses for beta (< 100 users). Migrate to `keccak256(address)` if scaling beyond 1000. See FR-5.1.
- **Rate limiting**: Per wallet address (anti-abuse), configurable per tier (credit, BYOK, x402)
- **Negative test requirements**: Invalid JWT signature, wrong `aud`/`sub`, expired token, wrong `req_hash` — all must be rejected with appropriate HTTP status codes and no information leakage

---

## 6. Scope & Prioritization

### What's In Scope (Closed Beta)

| Track | Priority | Sprints Est. |
|-------|----------|-------------|
| Track 1: E2E Billing Loop | P0 | 1 |
| Track 2: Denomination System | P0 | 2 |
| Track 4: NFT Agent Experience | P0 | 2 |
| Track 5: Onboarding & Access | P0 | 1 |
| Track 7: Operational Hardening | P0 | 1 |
| Track 3: x402 Agent Payments | P1 | 1-2 |
| Track 6: Multi-Model Review | P1 | 1 |

**Total estimated: 9-10 sprints (Global IDs 68-77)**

### What's Out of Scope

- Public launch / general availability
- Mobile native apps
- Voice interaction (Whisper)
- Agent social network / inter-NFT messaging
- On-chain autonomous actions (ERC-6551 TBA)
- WhatsApp, Slack, additional channels
- Goal-driven agent generation (Hive-style)
- Full Soul/Inbox with on-trade transfer (Issue #27 Phase 2+)

### Sprint Sequencing

```
Sprint 1: E2E Loop + Conservation Hardening     (Track 1 + Track 7.2)
Sprint 2: Credit Denomination + Purchase Flow    (Track 2.1-2.2)
Sprint 3: Credit Deduction + BYOK Fee           (Track 2.3-2.4)
Sprint 4: NFT Personality Authoring              (Track 4.1)
Sprint 5: Agent Homepage + Web Chat              (Track 4.2-4.3)
Sprint 6: Onboarding Flow + Invite System        (Track 5)
Sprint 7: Production Deployment + Monitoring     (Track 7.1)
Sprint 8: x402 Middleware + Payment Verification (Track 3.1-3.2)
Sprint 9: x402 Denomination + Guard Integration  (Track 3.3)
Sprint 10: Multi-Model Review + Polish           (Track 6 + integration testing)
```

---

## 7. Risks & Dependencies

### Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| x402 facilitator (openx402.ai) unreliable | x402 payments fail | Fall back to direct on-chain verification; credit packs as primary path |
| Conservation guard performance under load | Latency increase | Benchmark early (Sprint 1); constraint evaluation is < 1ms per invariant |
| Arrakis billing schema drift | E2E tests fail | Strangler Fig pattern (`?format=loh`) allows gradual migration |
| WebSocket scaling (in-memory sessions) | Beta user limit | Redis-backed sessions for horizontal scaling (Track 7) |
| Pi SDK stability for headless sessions | Agent failures | NativeRuntimeAdapter spike needed; fallback to direct model calls |

### External Dependencies

| Dependency | Status | Risk |
|------------|--------|------|
| `@0xhoneyjar/loa-hounfour` v7.0.0 | MERGED (PR #79) | Low — pinned to release tag |
| arrakis billing E2E scaffold | SCAFFOLDED (PR #63) | Low — 14 assertions passing |
| arrakis GTM plan | DRAFTED (PR #74) | Medium — 7 decisions pending |
| openx402.ai facilitator | LIVE (external) | Medium — third-party dependency |
| Fly.io or Railway deployment | AVAILABLE | Low — standard deployment |
| MetaMask / WalletConnect | STABLE | Low — well-established libraries |

### PR #74 Decision Dependencies

7 decisions from the GTM plan affect this PRD:

| Decision | This PRD's Assumption | If Different |
|----------|----------------------|-------------|
| D1: Auth model | Hybrid (API key for S2S, wallet connect for users) | Adjust FR-5.2 |
| D2: Account hierarchy | Account → Project → optional Community | Adjust FR-2.2 credit scoping |
| D3: Billing primitive | Prepaid (credit packs) | Adjust Track 2 entirely |
| D4: Dogfood entry gate | Public API MVP before Pillar 2 | Adjust sprint order |
| D5: API contract source | Zod → OpenAPI → SDK | Affects FR-4.2 API design |
| D6: SLA definition | SLO targets only for beta | No impact on beta |
| D7: BYOK metering | Proxy with token metering | Confirms FR-2.4 |

---

## 8. The Philosophical Frame

### From the Deep Review

The [Bridgebuilder deep review](https://github.com/0xHoneyJar/loa-finn/pull/79#issuecomment-3919440062) reframed what we're building:

> *"Is this a billing system, or is it an economic protocol?"*

This PRD answers: **it's an economic protocol** for a token-gated capability market. The conservation guard is constitutional law. The branded types are denominations. The evaluator lattice is the constraint that makes the market sustainable.

### From web4

> *"Money must be scarce, but monies can be infinite."*

Track 2 (denominations) implements the plurality of monies: MicroUSD, CreditUnit, MicroUSDC, BYOKCost. Track 1 (conservation guard) implements the scarcity constraint: you cannot spend more than you have, regardless of which denomination you're using.

### From Conway

Conway proves agents can sustain themselves. We prove communities can govern their agents. The closed beta is where these two ideas meet: real agents, real money, real governance — but in a controlled environment where we can observe, learn, and iterate before opening the doors.

### The Cambrian Moment

loa-hounfour v7 is the skeletal structure. This PRD defines the first organisms that evolve on that skeleton: credit packs, x402 payments, NFT personalities, agent homepages. The closed beta is the Ediacaran period — the first complex life, visible but not yet explosive. Public launch is the Cambrian Explosion.

---

*PRD: Full Stack Launch — Build Everything, Then Ship*
*Cycle 027 | Command Center: [#66](https://github.com/0xHoneyJar/loa-finn/issues/66)*
*"The question is no longer 'does this work?' It is 'what does this make possible?'"*
