# Auth Middleware

> Source: `src/gateway/auth.ts`, `src/hounfour/jwt-auth.ts`, `src/gateway/ws.ts`

## Bearer Token Authentication

- **Source**: `src/gateway/auth.ts` → `authMiddleware(config)`
- **Applies to**: `/api/*` routes (except `/api/v1/*` which use JWT)
- **Mechanism**: `Authorization: Bearer <token>` header
- **Validation**: Timing-safe SHA-256 hash comparison (constant-time via `crypto.timingSafeEqual`)
- **Failure**: 401 with `{ error: "Unauthorized", code: "AUTH_REQUIRED" | "AUTH_INVALID" }`
- **Dev Mode**: Auth skipped if `config.auth.bearerToken` is empty

## CORS Middleware

- **Source**: `src/gateway/auth.ts` → `corsMiddleware(config)`
- **Config**: `FINN_CORS_ORIGINS` (comma-separated, supports `*` and `localhost:*` patterns)
- **Headers**: `Access-Control-Allow-Origin`, `Allow-Methods` (GET, POST, OPTIONS), `Allow-Headers` (Content-Type, Authorization)
- **Credentials**: `Access-Control-Allow-Credentials: true`
- **Preflight**: Returns 204 No Content for OPTIONS requests

## JWT Authentication (Phase 5 — arrakis)

- **Source**: `src/hounfour/jwt-auth.ts` → `jwtAuthMiddleware(config, replayGuard?)`
- **Applies to**: `/api/v1/*` routes
- **Algorithm**: ES256 (ECDSA P-256)
- **Library**: `jose` v6

### Validation Order

1. Structural pre-check: 3 JWT segments, ES256 header
2. Signature validation + standard claims (`exp`, `nbf`, `iss`, `aud`) via `jose`
3. Custom claims: `tenant_id`, `tier` (free|pro|enterprise), `req_hash`
4. JTI replay check (if `JtiReplayGuard` provided)

### Extracted Context

Sets `c.get("tenant")` with:
```typescript
{
  claims: JWTClaims,
  resolvedPools: string[],     // Populated downstream by pool registry
  isNFTRouted: boolean,         // true if nft_id present in claims
  isBYOK: boolean               // true if byok claim present
}
```

### JWKS Caching
- 5-minute TTL with automatic refetch on kid miss

## Request Hash Verification

- **Source**: `src/hounfour/jwt-auth.ts` → `reqHashMiddleware()`
- **Applies to**: POST/PUT/PATCH with `Content-Type: application/json`
- **Claim**: `req_hash: "sha256:<64-hex-digits>"`
- **Mechanism**: SHA-256 of raw request body compared against JWT claim
- **Protects against**: Request tampering, body substitution

## WebSocket Authentication

- **Source**: `src/gateway/ws.ts` + `src/gateway/auth.ts` → `validateWsToken()`
- **Methods**: Query parameter `?token=<bearer>` OR first message `{ token: string }`
- **Validation**: Same timing-safe SHA-256 comparison as REST auth
- **Per-IP limit**: Max 5 concurrent WebSocket connections per source IP

## CSRF Protection

- **Source**: `src/gateway/csrf.ts` → double-submit cookie pattern
- **Token**: 32 bytes randomness (64 hex chars) via `crypto.randomBytes`
- **Cookie**: `_csrf` (configurable)
- **Header**: `x-csrf-token` or form field `_csrf`
- **Validation**: Timing-safe comparison of cookie vs header/body token
- **Safe methods**: GET, HEAD, OPTIONS skip CSRF validation

## Response Redaction

- **Source**: `src/gateway/redaction-middleware.ts` → `ResponseRedactor`
- **Purpose**: Deep-redact sensitive fields from API responses before sending
- **Pattern**: Fields matching `/secret|token|password|key|credential|authorization/i` → `[REDACTED]`
- **Composition**: Uses `SecretRedactor` (from `src/safety/secret-redactor.ts`) for token pattern matching + field-name-based redaction

## Dashboard Auth (RBAC)

- **Source**: `src/gateway/dashboard-auth.ts`
- **Roles**: `viewer` (localhost auto-grant) | `operator` (requires admin token)
- **Admin token**: From env or generated
- **Localhost detection**: `127.0.0.1`, `::1`, `::ffff:127.0.0.1` auto-granted viewer role

## Dashboard Rate Limiting

- **Source**: `src/gateway/dashboard-rate-limit.ts` → `DashboardRateLimiter`
- **Defaults**: 60 requests per 60s window, per IP
- **Headers**: `X-RateLimit-*` always included in response

## S2S JWT Signing

- **Source**: `src/hounfour/s2s-jwt.ts` → `S2SJwtSigner`
- **Purpose**: Sign outbound JWTs for service-to-service auth
- **Algorithm**: ES256
- **Key config**: `FINN_S2S_PRIVATE_KEY` (PEM), `FINN_S2S_KID`, `FINN_S2S_ISSUER`, `FINN_S2S_AUDIENCE`
- **JWKS endpoint**: `GET /.well-known/jwks.json` exposes the public key
