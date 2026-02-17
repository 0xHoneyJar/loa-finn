---
id: architecture-decisions
type: knowledge-source
format: markdown
tags: [architectural, technical]
priority: 12
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Key architectural decisions and their rationale"
max_age_days: 90
---

# Architecture Decision Records

## ADR-001: Hono over Express

**Decision**: Use Hono as the HTTP framework instead of Express.

**Rationale**:
- Type-safe routing with TypeScript generics
- Edge-compatible (works on Cloudflare Workers, Deno, Bun)
- Middleware composition via `c.set()`/`c.get()` context
- Zero-dependency core (~14KB)
- Native Web Standard Request/Response

**Trade-off**: Smaller ecosystem than Express, but Hono's middleware pattern is cleaner for our use case.

## ADR-002: EFS over S3 for Session Storage

**Decision**: Use EFS-mounted `/data` directory for session JSONL files.

**Rationale**:
- JSONL append is a filesystem operation (no SDK needed)
- Sub-millisecond latency for local file writes
- EFS provides persistence across ECS task restarts
- Single-writer constraint (desired_count=1) eliminates consistency issues

**Trade-off**: Limits horizontal scaling until session store migrated to shared backend.

## ADR-003: ES256 (ECDSA P-256) for S2S JWT

**Decision**: Require ES256 algorithm for server-to-server JWT signing.

**Rationale**:
- FIPS 186-4 compliant (vs RS256 which uses PKCS#1v1.5)
- Shorter signatures (64 bytes vs 256 bytes for RS256)
- Same security level as RSA-3072 with smaller key sizes
- Aligns with modern JWT best practices (RFC 7518 §3.4)

**Enforcement**: `jwt-auth.ts` rejects any algorithm except ES256 at verification time.

## ADR-004: Atomic Lua Scripts for Rate Limiting

**Decision**: Use Redis Lua scripts (EVAL) for rate limiting instead of multi-command transactions.

**Rationale**:
- Atomicity: Lua scripts execute as a single Redis operation
- Three-tier check (cost ceiling → identity limit → global cap) must be atomic
- Counter increment only happens when ALL tiers pass
- Prevents race conditions under concurrent load

**Trade-off**: Lua scripts are harder to debug than simple INCR commands.

## ADR-005: Fail-Closed Auth, Fail-Open Rate Limiting

**Decision**: Different failure modes for different Oracle middleware.

**Rationale**:
- **Auth (fail-closed)**: Redis error with Authorization header → 503. Prevents revoked API keys from regaining access during partial Redis outage.
- **Rate limiting (fail-open)**: Redis error → allow with conservative in-memory limit (1 req/min). Prevents total Oracle outage during Redis blip.
- **Cost reservation (fail-closed)**: Redis error → deny. Prevents unbounded spending.

## ADR-006: Rightmost-Untrusted-Hop IP Extraction

**Decision**: Extract client IP from XFF using `parts[length - TRUSTED_PROXY_COUNT - 1]`.

**Rationale**:
- CloudFront and ALB each append one entry to X-Forwarded-For
- Attackers can only prepend entries (left side)
- Rightmost entries are always from trusted infrastructure
- TRUSTED_PROXY_COUNT=2 (CloudFront + ALB) is stable

**Alternative considered**: CloudFront-Viewer-Address header (preferred when available, cannot be spoofed).

## ADR-007: Sub-App Isolation for Oracle Routes

**Decision**: Mount Oracle as a separate Hono sub-app with its own middleware chain.

**Rationale**:
- Oracle has different auth (API key vs JWT) than `/api/v1/invoke`
- Oracle has different rate limiting (Redis Lua vs token bucket)
- Sub-app prevents wildcard middleware from accidentally applying
- `isOraclePath()` skip guard provides defense-in-depth

## ADR-008: Cost Reservation with Reconciliation

**Decision**: Reserve estimated cost before model invoke, reconcile actual cost after.

**Rationale**:
- Prevents exceeding daily cost ceiling under concurrent load
- Estimated cost is pessimistic (overestimates), protecting budget
- After invoke, `release(actualCost)` adjusts the counter
- On error, `release(0)` provides full refund
- Idempotent release prevents double-accounting
