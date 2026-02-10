# SDD: Hounfour Phase 5 — Integration Hardening & Multi-Model Orchestration

> **Cycle**: 009 — Hounfour Phase 5
> **Status**: Draft
> **Author**: @janitooor
> **Date**: 2026-02-09
> **PRD**: `grimoires/loa/prd-hounfour-phase5.md`
> **Parent SDDs**: `grimoires/loa/sdd-hounfour.md` (Phases 0-2), `grimoires/loa/sdd-hounfour-phase3.md` (Phase 3)
> **RFC**: [#31 — The Hounfour](https://github.com/0xHoneyJar/loa-finn/issues/31)
> **Branch**: `feature/hounfour-phase5`

---

## 1. Executive Summary

This SDD designs the integration layer between loa-finn (Phase 3) and arrakis (Phase 4), plus new model orchestration features. The architecture adds JWT-based auth with tenant context, a split-authority budget system, model pool routing, and the NativeRuntimeAdapter — all wired into the existing Hounfour infrastructure.

**Key Design Decisions:**
- **JWT middleware** replaces simple bearer token for arrakis-originated requests. Bearer token preserved for direct API access (dashboard, dev mode). Dual-auth via Hono middleware chain.
- **Model Pool Registry** introduces an indirection layer: JWT claims reference pool IDs, not raw model names. Router resolves pools to providers via config.
- **Split-authority budget** — loa-finn measures cost (authoritative), reports to arrakis. Arrakis enforces limits (authoritative). Usage reports are the reconciliation mechanism.
- **Integer micro-USD** replaces floating-point everywhere. `1 USD = 1,000,000 micro-USD`. Floor per-request with remainder carry.
- **BYOK proxy model** — loa-finn never sees plaintext keys. Routes inference through arrakis proxy endpoint.
- **NativeRuntimeAdapter** is spike-first: prove programmatic access to Anthropic Messages API, then wrap as `ModelPort`.

**Scope**: Sprint A (integration debt) is fully designed. Sprints B-D are designed at interface level with implementation notes.

---

## 2. System Architecture

### 2.1 Five-Layer Model (Phase 5 Extension)

```
┌──────────────────────────────────────────────────────────────────┐
│                  AGENT DEFINITION LAYER                          │
│  .claude/skills/*/SKILL.md · persona.md · output-schema.md      │
│  Owner: Loa repo (unchanged)                                    │
├──────────────────────────────────────────────────────────────────┤
│                  MODEL ROUTING LAYER (Hounfour)                  │
│  src/hounfour/router.ts · orchestrator.ts                       │
│  + pool-registry.ts (NEW) · ensemble.ts (NEW)                   │
│  + jwt-auth.ts (NEW) · native-adapter.ts (NEW)                  │
│  Owner: loa-finn repo                                           │
├──────────────────────────────────────────────────────────────────┤
│                  MODEL ADAPTER LAYER (Cheval)                    │
│  adapters/cheval_server.py (HTTP sidecar)                       │
│  + byok-proxy-client.ts (NEW — delegates to arrakis)            │
│  + anthropic-adapter.ts (NEW — Anthropic Messages API)          │
│  Owner: loa-finn repo                                           │
├──────────────────────────────────────────────────────────────────┤
│                  STATE LAYER                                     │
│  Redis: circuit breaker · budget (micro-USD) · rate limiter     │
│  JSONL: cost ledger (micro-USD migration)                       │
│  R2/S3: ledger archives                                         │
├──────────────────────────────────────────────────────────────────┤
│                  AUTH & TENANT LAYER (NEW)                       │
│  JWT validation (ES256/JWKS) · tenant context injection          │
│  Usage report pipeline (loa-finn → arrakis)                     │
│  Model pool authorization (tier→pool mapping)                    │
├──────────────────────────────────────────────────────────────────┤
│                  INFRASTRUCTURE LAYER                             │
│  External APIs · Self-hosted (vLLM) · Arrakis BYOK proxy        │
│  Prometheus · GPU monitoring                                     │
├──────────────────────────────────────────────────────────────────┤
│                  DISTRIBUTION LAYER (Arrakis)                    │
│  JWT signing · JWKS · Budget limits · BYOK proxy · Rate limits  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Request Flow (Arrakis → loa-finn)

```
Discord/Telegram User
       │
       ▼
┌─────────────┐     JWT (ES256)     ┌──────────────────────┐
│   Arrakis   │ ──────────────────> │    loa-finn Gateway  │
│ (gateway)   │                     │                      │
│             │                     │  1. JWT validate     │
│ Signs JWT   │                     │  2. req_hash verify  │
│ with claims │                     │  3. Extract claims   │
│             │                     │  4. Pool authorize   │
└─────────────┘                     │  5. Route to model   │
       ▲                            │  6. Execute agent    │
       │                            │  7. Stream response  │
       │                            │  8. Usage report     │
       │    usage_report            └──────────────────────┘
       └────────────────────────────────────┘
```

---

## 3. Component Design

### 3.1 JWT Validation Middleware (`src/hounfour/jwt-auth.ts`)

**Design**: Hono middleware that validates ES256 JWTs per PRD §6.1 verification profile.

```typescript
// New file: src/hounfour/jwt-auth.ts

interface JWTClaims {
  iss: string;          // "arrakis"
  aud: string;          // "loa-finn"
  sub: string;          // "user:discord:123456789"
  tenant_id: string;    // "community:thj"
  tier: "free" | "pro" | "enterprise";
  nft_id?: string;      // "mibera:4269"
  model_preferences?: Record<string, string>; // pool IDs
  byok?: boolean;
  req_hash: string;     // "sha256:..."
  iat: number;
  exp: number;
  jti?: string;
}

interface TenantContext {
  claims: JWTClaims;
  resolvedPools: string[];  // pools available for this tier
  isNFTRouted: boolean;
  isBYOK: boolean;
}
```

**Middleware chain** (in `src/gateway/server.ts`):

Dual-auth is disambiguated at the **structural level**, not by guessing token type:

```
// Route-based auth separation:
// /api/v1/*  → JWT auth (arrakis-originated requests)
// /api/*     → Bearer token auth (direct API, dashboard, dev mode)
// /ws/*      → JWT from query param OR bearer token (checked in order)

app.use("/api/v1/*", jwtAuthMiddleware)    // JWT only — rejects non-JWT tokens
app.use("/api/*", bearerAuthMiddleware)     // Opaque bearer only — existing behavior
```

**JWT detection**: Strict structural pre-check before attempting validation:
1. Token must have exactly 2 dots (3 segments)
2. Header segment must base64-decode to JSON with `"alg":"ES256"` and `"typ":"JWT"`
3. If either check fails → immediately fall through to bearer auth (not an error)
4. If checks pass but validation fails (bad signature, expired) → 401 (not fallback)

This prevents: (a) opaque tokens being parsed as JWTs, (b) malformed JWTs falling through to bearer, (c) ambiguous error responses.

**JWKS client**:
- Fetches `{ARRAKIS_BASE_URL}/.well-known/jwks.json`
- LRU cache with 5-minute TTL
- On `kid` miss: refetch once, then fail
- Accepts current + previous rotation key (dual-key window)
- Uses `jose` npm package (well-maintained, ES256 support)

**`req_hash` verification** (scope-limited to avoid streaming conflicts):

`req_hash` is only verified on **JSON REST requests** (POST/PUT/PATCH with `Content-Type: application/json`). It is NOT applied to WebSocket or SSE streaming paths.

- **REST requests**: Use a tee stream — fork the raw body into (a) SHA-256 hasher and (b) JSON parser. Hard cap: 1MB max body size for hashed requests. Bodies > 1MB are rejected with 413.
- **WebSocket connections**: JWT is validated from the `token` query parameter during HTTP upgrade. Request binding uses `jti` (JWT ID) + server-issued nonce challenge: loa-finn sends a random nonce on WS open, arrakis must echo it signed in a subsequent auth message within 5s.
- **Empty bodies**: Verify against SHA-256 of empty string (`e3b0c44...`).
- **No decompression**: Hash the raw bytes as received (gzip'd if gzip'd). `Content-Encoding` must match between arrakis and loa-finn.

Implementation: Hono `c.req.raw.body` provides a ReadableStream. Use `ReadableStream.tee()` — one fork feeds the hasher, the other feeds Hono's JSON parser. This avoids consuming the stream twice.

**Session metadata extension** (in `src/gateway/sessions.ts`):

```typescript
interface ManagedSession {
  loaSession: LoaSession;
  created: number;
  lastActivity: number;
  // NEW: tenant context from JWT
  tenantContext?: TenantContext;
}
```

**Config extension** (in `src/config.ts`):

```typescript
jwt: {
  enabled: boolean;          // FINN_JWT_ENABLED (default: false)
  issuer: string;            // FINN_JWT_ISSUER (default: "arrakis")
  audience: string;          // FINN_JWT_AUDIENCE (default: "loa-finn")
  jwksUrl: string;           // FINN_JWKS_URL
  clockSkewSeconds: number;  // FINN_JWT_CLOCK_SKEW (default: 30)
  maxTokenLifetimeSeconds: number; // FINN_JWT_MAX_LIFETIME (default: 3600)
}
```

### 3.2 Model Pool Registry (`src/hounfour/pool-registry.ts`)

**Design**: Canonical mapping from pool IDs to provider/model configurations. All routing goes through pools — never raw model names in JWT claims.

```typescript
// New file: src/hounfour/pool-registry.ts

interface PoolDefinition {
  id: string;                    // "fast-code"
  description: string;
  provider: string;              // "qwen-local"
  model: string;                 // "Qwen/Qwen2.5-Coder-7B-Instruct"
  fallback?: string;             // pool ID to fall back to
  capabilities: ModelCapabilities;
  tierAccess: ("free" | "pro" | "enterprise")[];
}

class PoolRegistry {
  private pools: Map<string, PoolDefinition>;

  constructor(config: PoolConfig[]) { /* validate and index */ }

  resolve(poolId: string): PoolDefinition | null;
  authorize(poolId: string, tier: string): boolean;
  resolveForTier(tier: string): PoolDefinition[];
  validatePreferences(prefs: Record<string, string>): ValidationResult;
}
```

**Default pool definitions** (from PRD §6.3):

| Pool ID | Provider | Model | Tier Access |
|---------|----------|-------|-------------|
| `cheap` | qwen-local | Qwen2.5-Coder-1.5B | free, pro, enterprise |
| `fast-code` | qwen-local | Qwen2.5-Coder-7B | pro, enterprise |
| `reviewer` | claude-sonnet | claude-sonnet-4-5 | pro, enterprise |
| `reasoning` | kimi-k2 | Kimi-K2-Thinking | enterprise |
| `architect` | claude-opus | claude-opus-4-6 | enterprise |

**Integration with HounfourRouter**:
- Router receives `TenantContext` from JWT middleware
- Resolves pool from: (1) NFT `model_preferences` → (2) tier default → (3) global fallback
- Validates pool access against tier
- If pool's provider is unhealthy (circuit open), follows fallback chain

### 3.3 Integer Micro-USD Budget (`src/hounfour/budget.ts` modification)

**Design**: Replace all floating-point USD with integer micro-USD (`1 USD = 1,000,000 micro`).

**Migration**:
- Redis keys: `RENAME` existing float keys, create new integer keys
- JSONL ledger: new field `cost_micro` alongside deprecated `total_cost_usd` (backward compat for 1 rotation cycle)
- In-memory mirror: `Map<string, { spent_micro: number; remainder_micro: number }>`

**Arithmetic rules** (float-free cost path):

Cost is computed from integer-only inputs. No floating-point multiplication anywhere in the cost path.

```
// Pricing table stores integer numerator/denominator per model:
//   price_micro_per_million_tokens: number (integer)
//
// Cost computation (JS BigInt, Python int):
//   cost_micro = floor((tokens * price_micro_per_million) / 1_000_000)
//   remainder_micro = (tokens * price_micro_per_million) % 1_000_000
//
// Example: 1523 tokens at $3/1M output ($3 = 3,000,000 micro-USD per 1M tokens)
//   cost_micro = floor((1523 * 3_000_000) / 1_000_000) = floor(4569) = 4569
//   remainder_micro = (1523 * 3_000_000) % 1_000_000 = 0
```

- **Per-request**: Integer division as above. Remainder tracked per `(tenant_id, model)` pair.
- **Remainder carry**: When `accumulated_remainder >= 1_000_000`, add 1 to `cost_micro` and subtract `1_000_000` from remainder. Same integer base throughout.
- **Settlement (monthly)**: Sum all `cost_micro` + remaining `accumulated_remainder` (converted with banker's rounding at this single point).
- **Redis**: `INCRBY` (integer) replaces `INCRBYFLOAT` (float). Remainder stored in separate key: `finn:hounfour:budget:{tenant}:{model}:remainder_micro`.
- **Pricing table**: `src/hounfour/pricing.ts` stores `price_micro_per_million_input` and `price_micro_per_million_output` as plain integers. No `0.003` — only `3_000_000`.

**Cross-language test vectors**: `tests/fixtures/budget-test-vectors.json` with 50+ cases generated from integer inputs (tokens, pricing numerator/denominator). Both JS (BigInt) and Python (int) must produce identical `cost_micro` and `remainder_micro` for every case.

### 3.4 Usage Report Pipeline (`src/hounfour/usage-reporter.ts`)

**Design**: New component that posts cost data from loa-finn to arrakis after each inference.

```typescript
// New file: src/hounfour/usage-reporter.ts

interface UsageReport {
  report_id: string;       // ULID, idempotency key
  trace_id: string;
  request_id: string;
  tenant_id: string;
  nft_id?: string;
  model: string;           // pool ID
  provider: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_micro: number;      // integer micro-USD
  currency: "USD";
  ensemble_id?: string;
  byok: boolean;
  timestamp: string;       // ISO 8601
}

class UsageReporter {
  constructor(
    private arrakisBaseUrl: string,
    private s2sJwtSigner: S2SJwtSigner,  // signs with iss=loa-finn, aud=arrakis
    private deadLetterStore: DurableStore, // R2/S3 for failed reports (NOT local JSONL)
    private replayQueue: ReplayQueue,      // periodic replayer for dead-letter items
  ) {}

  async report(usage: UsageReport): Promise<void>;
  // POST to {arrakisBaseUrl}/internal/usage-reports
  // Auth: S2S JWT (ES256, iss=loa-finn, aud=arrakis)
  // Payload signed: JWS (compact serialization) over canonical JSON of UsageReport
  //   - Arrakis verifies signature via loa-finn JWKS before ingesting
  // Retry: 3x exponential backoff (1s, 2s, 4s)
  // Failure: write to R2/S3 dead-letter bucket (durable, not local filesystem)
  // Replay: background job every 5 minutes retries dead-letter items (max 10 per batch)
}
```

**Integration point**: Called by orchestrator after each model invocation completes (in `orchestrator.ts` after recording to JSONL ledger).

**Arrakis idempotency contract**: Arrakis MUST enforce idempotency on `report_id`:
- Atomic insert-or-ignore via PostgreSQL `ON CONFLICT (report_id) DO NOTHING` or Redis `SETNX`
- Retention window: 90 days (covers monthly billing cycles + dispute window)
- Duplicate reports return 200 OK (not error) — loa-finn treats both as success

**Payload integrity**: Usage reports are signed as JWS (compact serialization) over canonical JSON:
- Arrakis verifies the JWS signature via loa-finn's JWKS before ingesting
- This binds usage to loa-finn's identity — a compromised proxy cannot forge reports
- The report includes `original_jti` field (the user JWT's `jti` if present) for cross-referencing

**S2S JWT signing**: loa-finn has its own ES256 keypair. JWKS served at `{FINN_BASE_URL}/.well-known/jwks.json` (new endpoint in server.ts).

### 3.5 Stream Bridge Abort Fix (`src/gateway/stream-bridge.ts` modification)

**Current bug**: `AbortController` not propagated through the full chain.

**Fix design**:
```
WebSocket disconnect
  → stream-bridge.ts detects ws.close event
  → calls abortController.abort()
  → orchestrator.ts receives AbortSignal
  → cancels current model invocation (sidecar-client abort)
  → awaits drain (flush any pending tool results)
  → cleans up session state
  → logs abort to audit trail with trace_id
```

**Key change**: Orchestrator constructor receives `AbortSignal`. Each iteration checks `signal.aborted` before dispatching to sidecar. Sidecar-client passes signal through to `undici` request.

### 3.6 Idempotency Cache LRU (`src/hounfour/idempotency.ts` modification)

**Current bug**: Unbounded `Map<string, ToolResult>`.

**Fix**: Replace with LRU cache:
- Max entries: 10,000 (configurable via `FINN_IDEMPOTENCY_CACHE_MAX`)
- Eviction: LRU (least recently used)
- Implementation: Simple doubly-linked list + Map (no npm dependency needed, ~50 lines)
- TTL per entry: `max_wall_time_ms` (existing behavior preserved)

### 3.7 NativeRuntimeAdapter (`src/hounfour/native-adapter.ts`) — Sprint B

**Design**: Wrap the Anthropic Messages API as a `ModelPort` implementation.

**Spike acceptance criteria** (must pass before implementing):
1. Anthropic Messages API accessible from loa-finn process (API key available)
2. Streaming works (SSE from Anthropic → pipe into orchestrator event stream)
3. Tool use roundtrip works (tool_use → tool_result → continuation)
4. Token usage available in response for ledger
5. Abort via API cancellation or stream close

**Interface**:
```typescript
class AnthropicAdapter implements ModelPortBase, ModelPortStreaming {
  constructor(
    private apiKey: string,
    private defaultModel: string,  // "claude-sonnet-4-5-20250929"
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult>;
  async *stream(request: CompletionRequest, opts: StreamOptions): AsyncGenerator<StreamChunk>;
  async healthCheck(): Promise<boolean>;
}
```

**Mapping**: `CompletionRequest` (Hounfour canonical) ↔ Anthropic Messages format. Handles:
- `messages` → Anthropic `messages` (role mapping)
- `tools` → Anthropic `tools` (schema mapping)
- `thinking` → Anthropic `thinking` parameter (extended thinking)
- Token usage from `usage` field in response

**Integration**: Registered in `ProviderRegistry` as provider `anthropic-direct`. Pool `reviewer` and `architect` can route here as alternative to cheval sidecar path.

### 3.8 Ensemble Orchestrator (`src/hounfour/ensemble.ts`) — Sprint B

**Design**: Run same prompt against N models in parallel, merge results.

```typescript
// New file: src/hounfour/ensemble.ts

type MergeStrategy = "first_complete" | "best_of_n" | "consensus";

interface EnsembleConfig {
  models: string[];           // pool IDs
  strategy: MergeStrategy;
  budget_per_model_micro: number;
  timeout_ms: number;
  scorer?: (result: CompletionResult) => number;  // for best_of_n
}

class EnsembleOrchestrator {
  async run(
    request: CompletionRequest,
    config: EnsembleConfig,
    context: ExecutionContext,
  ): Promise<EnsembleResult>;
}

interface EnsembleResult {
  ensemble_id: string;
  selected: CompletionResult;
  all_results: { pool: string; result: CompletionResult; cost_micro: number; latency_ms: number }[];
  strategy_used: MergeStrategy;
  total_cost_micro: number;
}
```

**Strategies**:
- `first_complete`: Race N models, return first non-error response. Cancel others via per-invocation AbortController.
- `best_of_n`: Run all in parallel, apply scoring function, return highest score. Do NOT abort others when one completes or hits its cap — only abort that specific model.
- `consensus`: For structured output only. Parse JSON, majority vote per field.

**Budget enforcement** (two-level):
- **Per-model cap**: Each model invocation has an independent `max_tokens` derived from `budget_per_model_micro / price_per_token_micro`. If one model hits its cap, only that model is aborted — others continue (required for `best_of_n`).
- **Total ensemble cap**: Sum of all model costs checked after each completion. If total exceeds `ensemble_budget_micro`, remaining in-flight models are aborted via parent AbortController.
- **Streaming token accounting**: For providers that support usage deltas (Anthropic `usage` in stream events), track running cost during streaming. For providers without streaming usage, enforce via conservative `max_tokens` pre-calculation.

**Abort hierarchy**:
```
EnsembleAbortController (parent)
  ├── ModelA AbortController (child)
  ├── ModelB AbortController (child)
  └── ModelC AbortController (child)

- Per-model cap hit → abort child only
- Total ensemble cap hit → abort parent (cascades to all children)
- Client disconnect → abort parent (cascades to all children)
```

**Cost attribution**: Each model in ensemble gets its own ledger entry with shared `trace_id` and `ensemble_id` field.

### 3.9 BYOK Proxy Client (`src/hounfour/byok-proxy-client.ts`) — Sprint C

**Design**: `ModelPort` adapter that delegates inference to arrakis BYOK proxy.

```typescript
class BYOKProxyClient implements ModelPortBase, ModelPortStreaming {
  constructor(
    private arrakisBaseUrl: string,
    private s2sJwtSigner: S2SJwtSigner,
  ) {}

  async complete(request: CompletionRequest, context: TenantContext): Promise<CompletionResult>;
  async *stream(request: CompletionRequest, context: TenantContext): AsyncGenerator<StreamChunk>;
}
```

**Flow**: loa-finn sends `ProxyInferenceRequest` to `{arrakisBaseUrl}/internal/byok-proxy`. Arrakis decrypts BYOK key, calls provider, returns response. loa-finn consumes response as if it came from direct provider.

**Streaming**: Arrakis proxies SSE from provider → loa-finn consumes via same SSE consumer used for cheval sidecar.

### 3.10 Per-NFT Model Routing — Sprint C

**Integration in HounfourRouter**:

```
Route resolution order:
  1. If JWT has model_preferences AND nft_id → use NFT preferences (per task type)
  2. If JWT has tier → use tier default pools
  3. If no JWT (direct API) → use global default pool

For each resolution:
  - Validate pool ID against PoolRegistry
  - Check tier authorization
  - Check provider health (circuit breaker)
  - Follow fallback chain if primary unhealthy
  - If BYOK: delegate to BYOKProxyClient
  - If not: delegate to sidecar-client or native-adapter
```

---

## 4. Data Models

### 4.1 Micro-USD Budget Schema (Redis)

```
finn:hounfour:budget:{tenant_id}:spent_micro    → integer (INCRBY)
finn:hounfour:budget:{tenant_id}:remainder_micro → integer (INCRBY)
finn:hounfour:budget:{tenant_id}:limit_micro     → integer (SET)
```

### 4.2 JSONL Ledger Entry (Extended)

```json
{
  "timestamp": "2026-02-09T18:30:00Z",
  "trace_id": "tr-01JKQM...",
  "agent": "reviewer",
  "provider": "qwen-local",
  "model": "Qwen/Qwen2.5-Coder-7B-Instruct",
  "pool_id": "fast-code",
  "tenant_id": "community:thj",
  "nft_id": "mibera:4269",
  "prompt_tokens": 1523,
  "completion_tokens": 847,
  "reasoning_tokens": 0,
  "cost_micro": 152,
  "total_cost_usd": 0.000152,
  "ensemble_id": null,
  "byok": false,
  "latency_ms": 1200
}
```

Note: `total_cost_usd` preserved for backward compatibility during migration. Removed after one ledger rotation cycle.

---

## 5. File Map

### New Files (Sprint A)

| File | Purpose |
|------|---------|
| `src/hounfour/jwt-auth.ts` | JWT validation middleware, JWKS client, TenantContext |
| `src/hounfour/pool-registry.ts` | Model pool registry, tier authorization |
| `src/hounfour/usage-reporter.ts` | Usage report pipeline to arrakis |
| `src/hounfour/s2s-jwt.ts` | S2S JWT signing for loa-finn → arrakis auth |
| `tests/finn/jwt-integration.test.ts` | JWT roundtrip, tier→pool, budget, abort tests |
| `tests/fixtures/budget-test-vectors.json` | Cross-language budget arithmetic vectors |

### New Files (Sprint B)

| File | Purpose |
|------|---------|
| `src/hounfour/native-adapter.ts` | Anthropic Messages API as ModelPort |
| `src/hounfour/ensemble.ts` | Ensemble orchestrator with merge strategies |
| `tests/finn/ensemble.test.ts` | Ensemble strategy tests |
| `tests/finn/native-adapter.test.ts` | Anthropic adapter tests |

### New Files (Sprint C)

| File | Purpose |
|------|---------|
| `src/hounfour/byok-proxy-client.ts` | BYOK proxy ModelPort adapter |
| `tests/finn/byok-proxy.test.ts` | BYOK proxy tests |

### Modified Files (Sprint A)

| File | Changes |
|------|---------|
| `src/gateway/server.ts` | JWT middleware in auth chain, JWKS endpoint |
| `src/gateway/sessions.ts` | `ManagedSession.tenantContext` field |
| `src/hounfour/budget.ts` | Integer micro-USD migration |
| `src/hounfour/redis/budget.ts` | `INCRBY` replaces `INCRBYFLOAT` |
| `src/hounfour/idempotency.ts` | LRU cache replaces unbounded Map |
| `src/gateway/stream-bridge.ts` | AbortController propagation fix |
| `src/hounfour/orchestrator.ts` | AbortSignal support, usage reporter hook |
| `src/config.ts` | JWT config, pool config, usage reporter config |
| `src/index.ts` | Boot sequence: PoolRegistry, JWTAuth, UsageReporter |

---

## 6. Security Considerations

### 6.1 JWT Attack Surface

| Attack | Mitigation |
|--------|------------|
| Algorithm confusion (alg:none) | Reject all algorithms except ES256 |
| Key confusion (HMAC with public key) | ES256 only — no symmetric algorithms |
| Token replay | `jti` claim + optional Redis replay detection |
| Expired tokens | `exp` check with 30s max skew |
| Cross-service tokens | `iss`/`aud` validation required |
| req_hash bypass | Raw body bytes hashed before parsing; mismatch → 400 |

### 6.2 BYOK Security

| Concern | Design Decision |
|---------|-----------------|
| Key exposure to loa-finn | Proxy model: loa-finn never sees plaintext |
| Key logging | Arrakis audits trace_id + provider + model only |
| Key at rest | AES-256-GCM + KMS envelope encryption |
| Key in transit | S2S JWT auth + HTTPS only |

---

## 7. Dependencies

### NPM Packages (New)

| Package | Purpose | Justification |
|---------|---------|---------------|
| `jose` | JWT validation, JWKS client | Standard JWT library, maintained, ESM-first, no native deps |

No other new dependencies. LRU cache implemented in-house (~50 lines).

---

## 8. Testing Strategy

### Sprint A Integration Tests

| Test | Description |
|------|-------------|
| JWT roundtrip | Generate ES256 keypair → sign JWT → validate → extract claims |
| req_hash verification | Hash body → embed in JWT → verify on receive |
| Tier→pool authorization | Free tier → only `cheap`; Pro tier → `cheap` + `fast-code` + `reviewer` |
| Unknown pool rejection | JWT with `model_preferences: { chat: "nonexistent" }` → 400 |
| Budget micro-USD arithmetic | 10,000 requests → compare JS and Python totals → drift < 1 micro |
| Abort completeness | Start orchestrator → close WS → verify no orphan after 5s |
| LRU eviction | Insert 10,001 entries → verify size = 10,000, oldest evicted |

### Cross-Language Budget Vectors

Test fixture `budget-test-vectors.json` with 50+ cases containing integer-only inputs: `{ tokens: int, price_micro_per_million_input: int, price_micro_per_million_output: int }` and expected outputs: `{ cost_micro: int, remainder_micro: int }`. Edge cases: zero tokens, single token, costs below 1 micro (remainder only), very large token counts (billions). Both JS (`BigInt` div/mod) and Python (`int` `//` and `%`) must produce identical `cost_micro` and `remainder_micro` for all vectors. No floating-point conversions permitted in the test harness or implementation.
