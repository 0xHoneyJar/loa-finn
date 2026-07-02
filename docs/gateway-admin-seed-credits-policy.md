# Gateway Admin `seed-credits` Input Policy

> Source of truth for the validation rules enforced by
> `src/gateway/routes/admin.ts` (`POST /api/v1/admin/seed-credits`).
> Issues: #200, #201, #204, #215, #225, #229, #234.

## Purpose

`seed-credits` is a **test/CI support endpoint** (Sprint 3 E2E). It idempotently
*overwrites* a wallet's credit balance. It is not a production credit-granting
path — production credits flow through billing.

## Auth

- Bearer token, injected via `AdminRouteDeps.authToken` (wired from
  `config.auth.bearerToken`, i.e. `FINN_AUTH_TOKEN`). The route module performs
  **no direct `process.env` reads** (#204).
- When no token is configured the endpoint is disabled (`503 ADMIN_DISABLED`).
- Comparison is constant-time (`crypto.timingSafeEqual`).

## Input validation

| Field | Rule | Failure |
|-------|------|---------|
| `wallet_address` | Required string matching `^0x[0-9a-fA-F]{40}$` — validated **before** normalization (#201) | `400 INVALID_REQUEST` |
| `credits` | Required `number`, non-negative **whole** safe integer (`Number.isSafeInteger`); rejects fractional, negative, `NaN`, `Infinity`, unsafe-integer values (#200) | `400 INVALID_REQUEST` |
| `credits` cap | `credits <= MAX_SEED_CREDITS` (default **1,000,000**; override via `AdminRouteDeps.maxSeedCredits`) | `400 CREDITS_OUT_OF_BOUNDS` |

### Denomination

`credits` is denominated in **whole platform credits** (integer count, not
micro-units, not USD). Fractional credit seeding is intentionally unsupported.

### Normalization

EVM addresses are case-insensitive; after format validation the address is
lowercased and balances are keyed by the lowercase form. Checksummed and
lowercase inputs address the same balance.

### Cap rationale

1,000,000 credits is far above any legitimate test fixture while bounding the
damage of a fat-fingered or malicious request. Raising the cap is a deliberate
deployment decision (`maxSeedCredits` dep), not a code default change.

## Audit trail (#225, #234)

Every **accepted** mutation writes an audit record (`action: "seed_credits"`,
payload: normalized wallet, credits, ISO timestamp) via `deps.auditAppend`
**before** the balance is changed (audit-first). If the audit write fails the
mutation is blocked (`503 AUDIT_FAILED`, fail-closed). Rejected inputs are not
audited.

## Rate limiting note (#199, #223)

Admin **mode changes** are rate limited (5/subject/hour). The limiter is
injectable: production deployments with Redis get `RedisAdminRateLimiter`
(shared across replicas, fail-closed on Redis errors); the in-memory default is
per-process and suitable for dev/single-instance only — a startup warning is
logged when the fallback is active.

## Evidence

Test coverage: `tests/finn/gateway/admin-routes.test.ts` — wallet-format cases,
credit boundary cases (negative/fractional/huge/string/null/boolean/cap),
audit-first assertions, and multi-instance rate-limiter behavior.
