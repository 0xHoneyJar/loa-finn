# Sprint 46: NFT Routing & BYOK — Implementation Report

## Sprint Overview

| Field | Value |
|-------|-------|
| **Sprint** | Sprint 4 (Global ID: 46) |
| **Label** | NFT Routing & BYOK |
| **Cycle** | cycle-018 (Hounfour Phase 5) |
| **Tests** | 144 passing across 6 suites |
| **Files Created** | 8 (2 source, 5 test, 1 mock) |
| **Lines Added** | ~2,223 |

## Task Completion

| Task | Description | Status | Tests | Bead |
|------|-------------|--------|-------|------|
| 4.1 | NFT personality-to-model config | DONE | 25 | bd-1m0t |
| 4.2 | Per-NFT model routing | DONE | 16 | bd-2zxk |
| 4.3 | BYOK credential proxy client (redaction) | DONE | 31 | bd-1zzx |
| 4.4 | BYOK proxy routing — arrakis side | CLOSED (external) | — | bd-36x9 |
| 4.5 | BYOK proxy stub for integration tests | DONE | 22 | bd-6iw8 |
| 4.6 | BYOK stress & security tests | DONE | 30 | bd-2wnl |
| 4.7 | finnNFT E2E demo | DONE | 20 | bd-j8dp |

## Implementation Details

### Task 4.1: NFT Personality Config (`src/hounfour/nft-routing-config.ts`)

- **Types**: `NFTTaskType`, `TaskRouting`, `PersonalityPreferences`, `PersonalityRouting`, `NFTRoutingPolicy`
- **Validation**: `validateNFTRoutingConfig()` — semver version check, personality_id uniqueness, pool ID validation against `isValidPoolId()`, preferences range checks (temperature 0-2, max_tokens positive integer)
- **Cache**: `NFTRoutingCache` — full-replace reload semantics, `resolvePool(personalityId, taskType)` with default fallback, `getPreferences()` for temperature/max_tokens
- **Scale**: Tested with 1,000 personality entries

### Task 4.2: Per-NFT Model Routing (`tests/finn/nft-routing.test.ts`)

- NFT personality cache → pool resolution (4 task types)
- Tier-bridge integration with NFT preferences (enterprise tier)
- Tier authorization enforcement (validates pool access)
- Full routing pipeline: NFT cache → tier bridge → pool → provider:model
- Different personalities route to different pools for same task type

### Task 4.3: BYOK Redaction (`src/hounfour/byok-redaction.ts`)

Two-layer redaction strategy:
1. **Deny-by-default**: `redactResponseBody()` with allowlist (`ALLOWED_RESPONSE_FIELDS`)
2. **Pattern-based backup**: `redactKeyPatterns()` for OpenAI `sk-*`, Anthropic `anthropic-*`, Bearer tokens
3. **Shannon entropy**: High-entropy string detection (>4.5 bits/char) for unknown key formats
4. **Provider error scrubbing**: `scrubProviderError()` with allowlisted error codes only
5. **Audit entries**: `createAuditEntry()` strips query params, guaranteed no key material

### Task 4.5: BYOK Proxy Stub (`tests/mocks/byok-proxy-stub.ts`)

In-memory BYOK proxy stub implementing arrakis semantics:
- **Session minting**: JWT-like tokens with `jti`, `tenant_id`, `provider`, `scopes`, `aud`, `exp`
- **Bounded-use**: Configurable max requests per session (default 100)
- **Nonce replay**: Global nonce store with 60s TTL
- **Session validation**: tenant match, provider match, expired, revoked
- **Key leak simulation**: `simulateKeyLeakError()` for redaction verification

### Task 4.6: BYOK Stress & Security (`tests/finn/byok-stress-security.test.ts`)

- 50 concurrent independent sessions
- Rapid create-use-revoke cycles (20 iterations)
- Tenant isolation (cross-tenant rejection)
- Bounded-use edge cases (exact boundary, single-use, independent limits)
- Nonce replay across sessions and after revocation
- Key material isolation across all code paths (success, error, audit)
- Shannon entropy edge cases for API key classification
- Full lifecycle stress: create → use → exhaust → revoke → verify states

### Task 4.7: finnNFT E2E Demo (`tests/finn/finnNFT-e2e.test.ts`)

Full pipeline E2E tests (20 tests):
- NFT holder routing: JWT claims → pool resolution → provider:model
- BYOK delegation: `isBYOK=true` → `BYOKProxyClient` instead of direct provider
- Tier authorization: free/pro/enterprise access enforcement
- Pool fallback: health-aware fallback chain
- Multiple NFTs: independent routing per personality
- Error cases: missing PoolRegistry, unknown agent, budget exceeded, all providers unhealthy

## Test Counts by Suite

| Suite | Tests |
|-------|-------|
| `nft-routing-config.test.ts` | 25 |
| `nft-routing.test.ts` | 16 |
| `byok-redaction.test.ts` | 31 |
| `byok-proxy-stub.test.ts` | 22 |
| `byok-stress-security.test.ts` | 30 |
| `finnNFT-e2e.test.ts` | 20 |
| **Total** | **144** |

## Files Created/Modified

### New Files
| File | Lines | Description |
|------|-------|-------------|
| `src/hounfour/nft-routing-config.ts` | 239 | NFT personality config + cache |
| `src/hounfour/byok-redaction.ts` | 233 | Deny-by-default redaction |
| `tests/finn/nft-routing-config.test.ts` | 260 | Config validation + cache tests |
| `tests/finn/nft-routing.test.ts` | 204 | Per-NFT routing pipeline tests |
| `tests/finn/byok-redaction.test.ts` | 254 | Redaction + scrubbing tests |
| `tests/finn/byok-proxy-stub.test.ts` | 261 | Proxy stub integration tests |
| `tests/finn/byok-stress-security.test.ts` | 482 | Stress & security tests |
| `tests/mocks/byok-proxy-stub.ts` | 277 | In-memory BYOK proxy mock |

### Modified Files
| File | Description |
|------|-------------|
| `tests/finn/finnNFT-e2e.test.ts` | Already existed from prior session, all 20 tests passing |

## Fixes Applied During Implementation

1. **nft-routing.test.ts**: Changed `"nft_holder" as Tier` to `"enterprise" as Tier` — loa-hounfour vocabulary only defines `free`, `pro`, `enterprise` tiers
2. **byok-stress-security.test.ts**: Fixed `stub.revokeSession(t1)` → `stub.revokeSession(t1.jti)` (passing token object instead of JTI string)
3. **byok-stress-security.test.ts**: Fixed double-revoke expectation — `revokeSession()` returns `true` if session exists (even if already revoked)

## Security Invariants Verified

- No key material in any proxy response (success or error)
- No key material in audit logs after mixed operations
- Shannon entropy correctly classifies API keys vs safe strings
- Deny-by-default strips all non-allowlisted fields from responses
- Provider error scrubbing removes raw error messages, preserves only allowlisted error codes
- Query parameters stripped from audit endpoint field
- BYOK session tokens are bounded-use (cannot exceed configured limit)
- Nonce replay protection is global (cross-session)

## Notes

- Task 4.4 (BYOK proxy routing — arrakis side) is out of scope for loa-finn. The loa-finn side is fully tested via the mock proxy stub.
- The `finnNFT-e2e.test.ts` file was already created in a prior session with 20 comprehensive E2E tests exercising the full `HounfourRouter.invokeForTenant()` pipeline.
