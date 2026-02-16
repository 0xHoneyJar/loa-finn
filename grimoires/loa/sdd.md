# SDD: Sprint B — E2E Smoke Test: Billing Wire Verification

> **Version**: 2.0.0
> **Date**: 2026-02-17
> **Author**: @janitooor
> **Status**: Draft
> **Cycle**: cycle-022
> **PRD**: `grimoires/loa/prd.md` (v2.0.0, GPT-5.2 APPROVED iteration 2)
> **Grounding**: `src/hounfour/s2s-jwt.ts`, `src/hounfour/billing-finalize-client.ts`, `src/hounfour/protocol-handshake.ts`, `deploy/Dockerfile`, `docker-compose.yml`
> **GPT-5.2 Review**: Iteration 2 — 6 blocking issues from iteration 1 resolved

---

## 1. Executive Summary

Sprint B fixes 5 integration mismatches between loa-finn and arrakis's billing finalize endpoint, then proves the fix works via a Docker Compose E2E smoke test. The changes are surgical — 3 files modified (`s2s-jwt.ts`, `billing-finalize-client.ts`, `index.ts`), 3 files created (compose, smoke test, CI workflow). No public API changes.

---

## 2. System Architecture

### 2.1 High-Level Change Map

```
┌────────────────────────────────────────────────────────────┐
│ Sprint B Changes (3 files modified, 3 files created)       │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  MODIFIED:                                                 │
│  ┌─────────────────────────────────┐                       │
│  │ src/hounfour/s2s-jwt.ts         │ +HS256 signing mode   │
│  │   S2SJwtSigner                  │ +algorithm selection  │
│  │   S2SConfig → S2SConfig (union) │ +ambiguity guard     │
│  └─────────────────────────────────┘                       │
│  ┌─────────────────────────────────┐                       │
│  │ billing-finalize-client.ts      │ +camelCase wire body  │
│  │   sendFinalize()                │ +URL path fix         │
│  │   BillingFinalizeConfig         │ +identity mapping     │
│  └─────────────────────────────────┘                       │
│  ┌─────────────────────────────────┐                       │
│  │ src/index.ts                    │ +HS256 env var init   │
│  │   S2S init block (L256-286)     │ +alg selection logic  │
│  └─────────────────────────────────┘                       │
│                                                            │
│  CREATED:                                                  │
│  ┌─────────────────────────────────┐                       │
│  │ tests/e2e/docker-compose.e2e.yml│ 3-service E2E stack  │
│  │ tests/e2e/smoke-test.sh         │ Wire verification    │
│  │ .github/workflows/e2e-smoke.yml │ CI pipeline          │
│  └─────────────────────────────────┘                       │
└────────────────────────────────────────────────────────────┘
```

### 2.2 E2E Stack Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Docker Compose E2E Stack (3 services)                           │
│                                                                 │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────────┐    │
│  │ redis-e2e│◄────│ arrakis-e2e  │◄────│ loa-finn-e2e     │    │
│  │ :6379    │     │ :3000(→3000) │     │ :3000(→3001)     │    │
│  └──────────┘     │              │     │                  │    │
│                   │ HS256 verify │←────│ HS256 sign       │    │
│                   │              │     │                  │    │
│                   │ POST /api/   │     │ BillingFinalize  │    │
│                   │ internal/    │     │ Client           │    │
│                   │ finalize     │     │                  │    │
│                   └──────┬───────┘     └──────────────────┘    │
│                          │                                      │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│            HOST          │                                      │
│                   ┌──────┴───────┐                              │
│                   │ smoke-test.sh│ ← runs on HOST               │
│                   │ Uses:        │                              │
│                   │  localhost:3000 (arrakis)                   │
│                   │  localhost:3001 (loa-finn)                  │
│                   │  localhost:6380 (redis)                     │
│                   │ Verify:      │                              │
│                   │ 1. Health    │                              │
│                   │ 2. Infer     │                              │
│                   │ 3. Verify    │                              │
│                   └──────────────┘                              │
│                                                                 │
│ Shared: BILLING_INTERNAL_JWT_SECRET (HS256 symmetric)           │
└─────────────────────────────────────────────────────────────────┘
```

**Smoke test runs on the host** (not in a container), using `localhost` with mapped ports. This avoids needing a 4th container and simplifies debugging.

---

## 3. Component Design

### 3.1 S2S JWT Signer — HS256 Extension

**File**: `src/hounfour/s2s-jwt.ts`
**Current**: 102 lines, ES256-only via `jose` library

#### 3.1.1 Config Type Changes

```typescript
// Current (Sprint A)
export interface S2SConfig {
  privateKeyPem: string
  kid: string
  issuer: string
  audience: string
}

// Sprint B: Union config supporting both algorithms
export interface S2SConfigBase {
  kid: string
  issuer: string
  audience: string
}

export interface S2SConfigES256 extends S2SConfigBase {
  alg: "ES256"
  privateKeyPem: string
}

export interface S2SConfigHS256 extends S2SConfigBase {
  alg: "HS256"
  secret: string
}

export type S2SConfig = S2SConfigES256 | S2SConfigHS256
```

#### 3.1.2 Init Changes

The `init()` method branches on `config.alg`:

- **ES256**: Import PKCS8 key (existing logic, lines 34-49). Derives public JWK for JWKS endpoint.
- **HS256**: Create `Uint8Array` key from secret string using `new TextEncoder().encode(config.secret)`. No public JWK (symmetric).

```typescript
private signingKey: Uint8Array | null = null  // NEW: for HS256

async init(): Promise<void> {
  if (this.config.alg === "ES256") {
    // Existing ES256 init (lines 34-49)
    this.privateKey = await importPKCS8(this.config.privateKeyPem, "ES256")
    // ... derive public JWK (unchanged)
  } else {
    // HS256: encode secret as Uint8Array for jose
    this.signingKey = new TextEncoder().encode(this.config.secret)
    // No public JWK for symmetric keys
    this.publicJWK = null
  }
}
```

#### 3.1.3 Sign Changes

`signJWT()` uses the algorithm from config in `setProtectedHeader()`. The default TTL is 300s (5 minutes), matching PRD §NFR-2 and Sprint A's billing finalize usage.

```typescript
async signJWT(claims: Record<string, unknown>, expiresInSeconds = 300): Promise<string> {
  if (this.config.alg === "ES256" && !this.privateKey) throw new Error("S2SJwtSigner not initialized")
  if (this.config.alg === "HS256" && !this.signingKey) throw new Error("S2SJwtSigner not initialized")

  const key = this.config.alg === "ES256" ? this.privateKey! : this.signingKey!

  // For HS256 billing tokens: omit kid (arrakis verifies via shared secret, not JWKS lookup)
  const header: Record<string, string> = { alg: this.config.alg, typ: "JWT" }
  if (this.config.alg === "ES256") {
    header.kid = this.config.kid  // Only ES256 tokens include kid (for JWKS resolution)
  }

  return new SignJWT(claims)
    .setProtectedHeader(header)
    .setIssuer(this.config.issuer)
    .setAudience(this.config.audience)
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(key)
}
```

**Critical design decisions:**
- `alg` is hardcoded from `this.config.alg`, never from external/untrusted input
- `kid` is **omitted for HS256 tokens** — arrakis's `requireInternalAuth` middleware verifies HS256 via `BILLING_INTERNAL_JWT_SECRET` env var, not via JWKS/kid resolution. Including `kid` in HS256 tokens would be misleading (no JWKS to resolve against)
- Default TTL changed from 60s to 300s to match PRD requirement. The billing finalize client was already passing 300 explicitly; this makes the default consistent

#### 3.1.4 JWKS/JWS Behavior by Algorithm

| Method | ES256 | HS256 |
|--------|-------|-------|
| `signJWT()` | Sign with EC private key (includes kid) | Sign with shared secret (no kid) |
| `signJWS()` | Sign payload (usage reports) | Throw Error — JWS not used for HS256 |
| `signPayload()` | Convenience wrapper | Throw Error — delegates to `signJWS()` |
| `getPublicJWK()` | Return EC public JWK | Throw Error — no public key for symmetric |
| `getJWKS()` | Return `{ keys: [jwk] }` | Return `{ keys: [] }` — empty, no symmetric key exposure |
| `isReady` | `privateKey !== null` | `signingKey !== null` |

**Rationale for kid omission** (grounded in arrakis code): arrakis's `requireInternalAuth` middleware (`src/middleware/internal-auth.ts`) calls `jwt.verify(token, process.env.BILLING_INTERNAL_JWT_SECRET, { algorithms: ["HS256"] })` — it passes the shared secret directly to `jsonwebtoken.verify()`, which performs HS256 HMAC verification without any JWKS/kid resolution. The `kid` header is ignored by this code path. Including kid in HS256 tokens would be harmless but misleading.

**E2E contract enforcement**: The smoke test includes a specific assertion that HS256 tokens without `kid` are accepted by arrakis. If arrakis's auth path changes to JWKS-based, the E2E test will fail immediately, surfacing the contract break before production. This is the enforceable contract.

#### 3.1.5 Backward Compatibility

The existing `S2SConfig` interface changes from a flat interface to a discriminated union. The single production caller (`src/index.ts:266-271`) is updated in §3.3. The `kid` field remains in the config for both modes (used as metadata/logging) but is only included in JWT headers for ES256.

### 3.2 Billing Finalize Client — Wire Contract Fix

**File**: `src/hounfour/billing-finalize-client.ts`
**Current**: 270 lines

#### 3.2.1 URL Path Fix

Change `BillingFinalizeConfig.billingUrl` semantics from "full endpoint URL" to "base URL":

```typescript
// Config interface — billingUrl is now base URL
export interface BillingFinalizeConfig {
  billingUrl: string    // e.g. "http://arrakis:3000" (base URL, not full path)
  s2sSigner: S2SJwtSigner
  // ... rest unchanged
}
```

In `sendFinalize()` (line 197):

```typescript
// Before: fetch(this.config.billingUrl, { ... })
// After:
const url = `${this.config.billingUrl}/api/internal/finalize`
response = await fetch(url, { ... })
```

#### 3.2.2 Request Body Transformation

In `sendFinalize()` (lines 185-190):

```typescript
// Before (Sprint A — snake_case):
const body = JSON.stringify({
  reservation_id: req.reservation_id,
  tenant_id: req.tenant_id,
  actual_cost_micro: req.actual_cost_micro,
  trace_id: req.trace_id,
})

// After (Sprint B — camelCase, arrakis wire contract):
const body = JSON.stringify({
  reservationId: req.reservation_id,
  actualCostMicro: req.actual_cost_micro,
  accountId: req.tenant_id,        // identity field mapping: tenant_id → accountId
  traceId: req.trace_id,
})
```

**No changes to internal interfaces**: `FinalizeRequest`, `DLQEntry`, and all callers continue using snake_case. The camelCase transformation happens only at the HTTP wire boundary.

#### 3.2.3 Response Handling Enhancement

Add defensive response field parsing (line 218-220):

```typescript
if (response.status === 200) {
  try {
    const data = await response.json() as Record<string, unknown>
    // Defensive: accept both snake_case and camelCase response field
    const billingEntry = data.billing_entry ?? data.billingEntry ?? null
    if (billingEntry) {
      console.log(`[billing-finalize] ok: reservation_id=${req.reservation_id} trace_id=${req.trace_id}`)
    }
  } catch {
    // Response parsing failure is non-fatal — 200 means finalize succeeded
  }
  return { ok: true, status: "finalized" }
}
```

### 3.3 Index.ts — S2S Init Block Update

**File**: `src/index.ts`, lines 256-286

#### 3.3.1 Algorithm Selection Logic

Replace the current `FINN_S2S_PRIVATE_KEY`-only check with dual-mode selection:

```typescript
// Sprint B: Algorithm selection with ambiguity guard
const s2sSecret = process.env.FINN_S2S_JWT_SECRET
const s2sPrivateKey = process.env.FINN_S2S_PRIVATE_KEY
const s2sAlgOverride = process.env.FINN_S2S_JWT_ALG

let s2sConfig: import("./hounfour/s2s-jwt.js").S2SConfig | undefined

if (s2sAlgOverride) {
  // Explicit algorithm — validate corresponding key material
  if (s2sAlgOverride !== "HS256" && s2sAlgOverride !== "ES256") {
    throw new Error(`[finn] FINN_S2S_JWT_ALG must be "HS256" or "ES256", got "${s2sAlgOverride}"`)
  }
  if (s2sAlgOverride === "HS256") {
    if (!s2sSecret) throw new Error("[finn] FINN_S2S_JWT_ALG=HS256 but FINN_S2S_JWT_SECRET is not set")
    s2sConfig = {
      alg: "HS256",
      secret: s2sSecret,
      kid: process.env.FINN_S2S_KID ?? "loa-finn-v1",
      issuer: "loa-finn",
      audience: "arrakis",
    }
  } else {
    if (!s2sPrivateKey) throw new Error("[finn] FINN_S2S_JWT_ALG=ES256 but FINN_S2S_PRIVATE_KEY is not set")
    s2sConfig = {
      alg: "ES256",
      privateKeyPem: s2sPrivateKey,
      kid: process.env.FINN_S2S_KID ?? "loa-finn-v1",
      issuer: "loa-finn",
      audience: "arrakis",
    }
  }
} else if (s2sSecret && s2sPrivateKey) {
  throw new Error("[finn] Both FINN_S2S_JWT_SECRET and FINN_S2S_PRIVATE_KEY set — set FINN_S2S_JWT_ALG to disambiguate")
} else if (s2sSecret) {
  // Auto-detect HS256
  s2sConfig = {
    alg: "HS256",
    secret: s2sSecret,
    kid: process.env.FINN_S2S_KID ?? "loa-finn-v1",
    issuer: "loa-finn",
    audience: "arrakis",
  }
} else if (s2sPrivateKey) {
  // Auto-detect ES256 (backward compatible with Sprint A)
  s2sConfig = {
    alg: "ES256",
    privateKeyPem: s2sPrivateKey,
    kid: process.env.FINN_S2S_KID ?? "loa-finn-v1",
    issuer: "loa-finn",
    audience: "arrakis",
  }
} else if (billingUrl) {
  console.warn("[finn] ARRAKIS_BILLING_URL set but no S2S signing key — billing finalize disabled")
}
```

#### 3.3.2 BillingUrl Semantic Change

```typescript
// Sprint A: billingUrl was the full endpoint URL
// Sprint B: billingUrl is the base URL; client appends /api/internal/finalize
billingFinalizeClient = new BillingFinalizeClient({
  billingUrl,      // e.g., "http://arrakis:3000"
  s2sSigner,
})
```

### 3.4 Docker Compose E2E Stack

**File**: `tests/e2e/docker-compose.e2e.yml`

#### 3.4.1 Services

| Service | Image/Build | Internal Port | Host Port | Health Check | Depends On |
|---------|-------------|--------------|-----------|--------------|------------|
| `redis-e2e` | `redis:7-alpine` | 6379 | 6380 | `redis-cli ping` | — |
| `arrakis-e2e` | Build from `../../arrakis` | 3000 | 3000 | `node -e "fetch('http://localhost:3000/v1/health')..."` | redis-e2e (healthy) |
| `loa-finn-e2e` | Build from `../..`, `deploy/Dockerfile` | 3000 | 3001 | `node -e "fetch('http://localhost:3000/health')..."` | redis-e2e (healthy), arrakis-e2e (healthy) |

**Health check commands**: Both arrakis and loa-finn use `node -e "fetch(...).then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"`. This works because:
- Both images are Node 22-based (Node 22 has built-in `fetch`)
- The existing `deploy/Dockerfile:74` already uses this exact pattern
- `node` is guaranteed to exist in both containers

**Port mapping**:
- Health checks run **inside the container** using `localhost:3000` (internal port)
- The smoke test runs **on the host** using `localhost:3001` (loa-finn) and `localhost:3000` (arrakis)

#### 3.4.2 Secret Wiring

Both services read the same secret value via compose:

```yaml
services:
  arrakis-e2e:
    environment:
      BILLING_INTERNAL_JWT_SECRET: e2e-s2s-jwt-secret-for-testing-only-32chr

  loa-finn-e2e:
    environment:
      FINN_S2S_JWT_SECRET: e2e-s2s-jwt-secret-for-testing-only-32chr
      FINN_S2S_JWT_ALG: HS256
      ARRAKIS_BILLING_URL: http://arrakis-e2e:3000
```

The same literal string value is hardcoded for both services. arrakis reads `BILLING_INTERNAL_JWT_SECRET`, loa-finn reads `FINN_S2S_JWT_SECRET`.

#### 3.4.3 Build Contexts and CI Path Resolution

The compose file lives at `tests/e2e/docker-compose.e2e.yml`. Docker Compose resolves build contexts **relative to the compose file location**.

| Service | Build Context | Resolves To (CI) |
|---------|--------------|-------------------|
| `loa-finn-e2e` | `context: ../..` | `$GITHUB_WORKSPACE/` (loa-finn root) |
| `arrakis-e2e` | `context: ../../arrakis` | `$GITHUB_WORKSPACE/arrakis/` |

**CI workspace layout** (GitHub Actions):
```
$GITHUB_WORKSPACE/          ← loa-finn (default checkout)
├── tests/e2e/
│   ├── docker-compose.e2e.yml
│   └── smoke-test.sh
├── deploy/Dockerfile
├── src/
└── arrakis/                ← actions/checkout with path: arrakis
    ├── Dockerfile
    └── src/
```

**CI invocation**:
```bash
# Run from $GITHUB_WORKSPACE (loa-finn root)
docker compose -f tests/e2e/docker-compose.e2e.yml up -d --build
```

Docker Compose resolves `../..` relative to `tests/e2e/` → `$GITHUB_WORKSPACE/`. Resolves `../../arrakis` → `$GITHUB_WORKSPACE/arrakis/`. Both paths exist in the CI workspace.

### 3.5 E2E Smoke Test Script

**File**: `tests/e2e/smoke-test.sh`

#### 3.5.1 Test Sequence

The smoke test runs **on the host** and communicates with services via mapped ports:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Host-accessible URLs (mapped ports)
ARRAKIS_URL="${ARRAKIS_URL:-http://localhost:3000}"
FINN_URL="${FINN_URL:-http://localhost:3001}"
REDIS_URL="${REDIS_URL:-localhost}"
REDIS_PORT="${REDIS_PORT:-6380}"

TRACE_ID="e2e-$(date +%s)-$(head -c 8 /dev/urandom | xxd -p)"
```

| Step | Action | URL | Expected |
|------|--------|-----|----------|
| 1 | Health check arrakis | `GET $ARRAKIS_URL/v1/health` | 200 |
| 2 | Health check loa-finn | `GET $FINN_URL/health` | 200 |
| 3 | Send inference | `POST $FINN_URL/api/v1/chat/completions` | 200 |
| 4 | Verify billing entry | See §3.5.2 | Entry exists |
| 5 | Validate schema | Assert fields | All present |

#### 3.5.2 Verification Strategy (Pinned — Response Header)

**Mechanism**: loa-finn emits a deterministic response header `x-billing-finalize-status` on every inference response. The smoke test asserts this header value.

**How it works:**

1. After `sendFinalize()` completes in the router, the result (`finalized`, `idempotent`, or `dlq`) is attached to the response as a custom header:

```typescript
// In router.ts, after finalize call:
res.setHeader("x-billing-finalize-status", finalizeResult.ok ? finalizeResult.status : "dlq")
res.setHeader("x-billing-trace-id", req.trace_id)
```

2. The smoke test reads these headers from the inference response:

```bash
# Send inference request and capture response headers
response=$(curl -sD /tmp/e2e-headers -X POST "$FINN_URL/api/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-trace-id: $TRACE_ID" \
  -d '{"model":"mock","messages":[{"role":"user","content":"test"}]}')

# Assert finalize succeeded
finalize_status=$(grep -i "x-billing-finalize-status" /tmp/e2e-headers | tr -d '\r' | awk '{print $2}')
assert_eq "$finalize_status" "finalized" "Billing finalize status"

# Assert trace ID matches
trace_echo=$(grep -i "x-billing-trace-id" /tmp/e2e-headers | tr -d '\r' | awk '{print $2}')
assert_eq "$trace_echo" "$TRACE_ID" "Trace ID correlation"
```

**Why response header is the right mechanism:**
- **Fully deterministic**: header is set from the finalize result, not from log parsing
- **No arrakis introspection**: verification is entirely from loa-finn's perspective
- **Proves the wire**: `finalized` status means arrakis returned HTTP 200 to the finalize call — the JWT was accepted, the request body was valid, the billing entry was created
- **Correlation via traceId**: the same traceId sent in the request appears in the response, proving end-to-end tracing
- **No scope creep**: no arrakis code changes, no Redis key pattern guessing

**What this proves:**
- loa-finn sent an HS256-signed request to arrakis
- arrakis accepted the JWT (HS256 shared secret matched)
- arrakis accepted the request body (camelCase fields, correct accountId)
- arrakis returned 200 (billing entry created)
- loa-finn received the 200 and set status to "finalized"

**Secondary validation (non-blocking):** Additionally check arrakis container logs for the finalize receipt:

```bash
# Optional: verify arrakis also logged the finalize (defense-in-depth, not primary)
docker compose -f tests/e2e/docker-compose.e2e.yml logs arrakis-e2e 2>&1 \
  | grep -q "$TRACE_ID" && echo "PASS: arrakis logged traceId" || echo "WARN: arrakis log check inconclusive"
```

This secondary check is informational only — the primary assertion is the response header.

### 3.6 CI Workflow

**File**: `.github/workflows/e2e-smoke.yml`

```yaml
name: E2E Smoke Test
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout loa-finn
        uses: actions/checkout@v4

      - name: Checkout arrakis
        uses: actions/checkout@v4
        with:
          repository: 0xHoneyJar/arrakis
          path: arrakis
          token: ${{ secrets.ARRAKIS_CHECKOUT_TOKEN }}

      - name: Build and start E2E stack
        run: docker compose -f tests/e2e/docker-compose.e2e.yml up -d --build

      - name: Wait for services healthy
        run: |
          # Docker compose wait for health (built-in with depends_on: condition)
          # Additional explicit wait for safety
          for i in $(seq 1 30); do
            if curl -sf http://localhost:3001/health && curl -sf http://localhost:3000/v1/health; then
              echo "All services healthy"
              break
            fi
            sleep 2
          done

      - name: Run smoke test
        run: ./tests/e2e/smoke-test.sh

      - name: Collect logs on failure
        if: failure()
        run: docker compose -f tests/e2e/docker-compose.e2e.yml logs --no-color > e2e-logs.txt

      - name: Upload logs artifact
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-logs
          path: e2e-logs.txt

      - name: Teardown
        if: always()
        run: docker compose -f tests/e2e/docker-compose.e2e.yml down -v
```

**Workspace after checkout**:
```
$GITHUB_WORKSPACE/
├── (loa-finn files — default checkout)
├── tests/e2e/docker-compose.e2e.yml  (context: ../.. → $GITHUB_WORKSPACE)
├── arrakis/                          (context: ../../arrakis → $GITHUB_WORKSPACE/arrakis)
```

All `docker compose` commands run from `$GITHUB_WORKSPACE` (loa-finn root). The `-f` flag points to the compose file; Docker resolves build contexts relative to the compose file location (`tests/e2e/`), so `../..` = `$GITHUB_WORKSPACE/` and `../../arrakis` = `$GITHUB_WORKSPACE/arrakis/`.

---

## 4. Security Architecture

### 4.1 JWT Algorithm Safety

| Threat | Mitigation |
|--------|------------|
| Algorithm confusion (alg: none) | `setProtectedHeader()` hardcodes alg from config — never reads from token |
| Algorithm confusion (HS256 with public key) | Startup error when both keys set without explicit `FINN_S2S_JWT_ALG` |
| kid-based JWKS confusion for HS256 | HS256 tokens omit `kid` header — arrakis verifies via shared secret, not JWKS |
| Weak HS256 secret | E2E uses 32-char test secret; production secret length enforced by ops |
| Token replay | 5-minute TTL (`exp: iat+300`) — default in `signJWT()` |

### 4.2 arrakis HS256 Verification Contract (Grounded)

arrakis's `requireInternalAuth` middleware (`src/middleware/internal-auth.ts`) for the billing finalize endpoint:
- Reads `BILLING_INTERNAL_JWT_SECRET` from env at startup
- Verifies JWT using `jsonwebtoken.verify(token, secret, { algorithms: ["HS256"] })`
- Does **not** perform JWKS/kid-based key resolution — passes secret directly
- Validates: `exp` (not expired), signature (HS256)
- `kid` header is ignored (not used in the verification code path)

**Enforced in E2E**: The smoke test asserts that HS256 tokens without `kid` are accepted by sending a real request through the billing wire. If arrakis's auth path changes to require JWKS/kid, the E2E test fails immediately with a non-`finalized` response header.

### 4.3 E2E Secret Isolation

All E2E secrets are hardcoded test values in the compose file. No production secrets needed. The test secret (`e2e-s2s-jwt-secret-for-testing-only-32chr`) is named to prevent accidental production use.

---

## 5. Testing Strategy

### 5.1 Unit Test Updates

| File | New Tests |
|------|-----------|
| `s2s-jwt.test.ts` | HS256 init + sign + verify round-trip; algorithm selection from config; ambiguous config rejection; negative: HS256-configured signer rejects ES256 token verification (and vice versa); kid omission for HS256; default TTL is 300s |
| `billing-finalize-client.test.ts` | camelCase wire body assertion (JSON.parse request body); correct URL path `/api/internal/finalize`; accountId mapping from tenant_id; defensive response parsing (both `billing_entry` and `billingEntry`); no `?format=loh` query parameter |

### 5.2 E2E Tests (smoke-test.sh)

| Test | Assertion |
|------|-----------|
| Service health | arrakis (`localhost:3000/v1/health`) and loa-finn (`localhost:3001/health`) return 200 |
| Inference | `POST localhost:3001/api/v1/chat/completions` returns 200 |
| Finalize status | Response header `x-billing-finalize-status: finalized` (proves arrakis accepted HS256 JWT + camelCase body) |
| Trace correlation | Response header `x-billing-trace-id` matches sent traceId |
| HS256 contract | HS256 token without `kid` accepted by arrakis (implicit via finalize success) |

### 5.3 Test Count Estimate

Sprint A: 57 tests (updated for correct wire format)
Sprint B new: ~12 unit + 4 E2E = ~16 new tests
Total: ~73 tests

---

## 6. File Change Summary

| File | Action | Est. Lines |
|------|--------|-----------|
| `src/hounfour/s2s-jwt.ts` | Modify | +45 |
| `src/hounfour/billing-finalize-client.ts` | Modify | +10 |
| `src/index.ts` | Modify | +30 |
| `tests/e2e/docker-compose.e2e.yml` | Create | ~55 |
| `tests/e2e/smoke-test.sh` | Create | ~80 |
| `.github/workflows/e2e-smoke.yml` | Create | ~50 |
| `src/hounfour/__tests__/s2s-jwt.test.ts` | Modify | +35 |
| `src/hounfour/__tests__/billing-finalize-client.test.ts` | Modify | +15 |

**Total**: ~320 new/changed lines
