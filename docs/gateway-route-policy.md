# Gateway Route Guard Policy Matrix

> Rendered from the single source of truth: `src/gateway/route-policy.ts`
> (`GATEWAY_ROUTE_POLICY`). The sync test in
> `tests/gateway/route-policy.test.ts` fails when this table and the registry
> drift. Issues: #202, #203, #208, #217, #221, #226, #228, #233.

## How the gateway guards routes

`createApp()` (src/gateway/server.ts) applies a **shared chain** — in-memory
rate limiting + hounfour JWT auth — to `/api/v1/*`. Route groups that carry
their **own guard** are excluded from the shared chain via a predicate
(`isSelfGuardedApiV1Path`) **derived from the policy registry**, not a
hand-maintained skip list. Every excluded prefix therefore has a declared
guard, a guard source file, and test evidence.

## Policy matrix

| Prefix | Self-guarded | Visibility | Auth | Rate limit | Guard source | Evidence |
|--------|--------------|------------|------|------------|--------------|----------|
| `/api/v1/oracle` | yes | authenticated | Oracle API-key auth (Redis-backed) + billing-evaluator guard | Oracle daily caps + concurrency limiter | `src/gateway/oracle-auth.ts` | `tests/finn/oracle-auth.test.ts` |
| `/api/v1/public` | yes | public | None — public product surface by design | None at gateway level | `src/gateway/routes/agent-public-api.ts` | `tests/gateway/route-policy.test.ts` |
| `/api/v1/conversations` | yes | authenticated | SIWE session JWT (requireSiweSession) + NFT ownership check on create | None dedicated (SIWE session implies authenticated caller) | `src/gateway/routes/conversations.ts` | `tests/gateway/conversations.test.ts` |
| `/api/v1/admin` | yes | operator | JWKS JWT ES256 role check (/mode) · injected admin token (/seed-credits) | 5 mode changes/subject/hour (Redis-shared when available) | `src/gateway/routes/admin.ts` | `tests/finn/gateway/admin-routes.test.ts` |
| `/api/v1/x402` | yes | payment | x402 payment verification (challenge/receipt) | x402 per-wallet tier (RATE_LIMIT_TIERS.x402_per_wallet) | `src/gateway/x402-routes.ts` | `tests/x402/` |
| `/api/v1/pay` | yes | payment | x402 payment verification (alias of /api/v1/x402/invoke) | x402 per-wallet tier | `src/gateway/x402-routes.ts` | `tests/x402/` |
| `/api/identity` | no | public | Legacy /api/* bearer chain applies when FINN_AUTH_TOKEN is configured (public in dev mode) | Legacy /api/* in-memory limiter | `src/gateway/auth.ts` | `tests/finn/identity-routes.test.ts` |
| `/api/v1/invoke` | no | authenticated | hounfour JWT (arrakis-issued) via shared chain | Shared in-memory limiter + economic boundary + billing guard | `src/hounfour/pool-enforcement.ts` | `tests/finn/invoke-handler.test.ts` |
| `/api/v1/usage` | no | authenticated | hounfour JWT via shared chain | Shared in-memory limiter | `src/hounfour/pool-enforcement.ts` | `tests/finn/usage-handler.test.ts` |
| `/api/v1/score` | no | authenticated | hounfour JWT via shared chain + route-local FINN_AUTH_TOKEN bearer check | Shared in-memory limiter | `src/gateway/routes/score-verdict.ts` | `src/cost/score-verdict.test.ts` |
| `/api/v1/agent/chat` | no | authenticated | hounfour JWT via shared chain + NFT ownership middleware | Shared in-memory limiter | `src/nft/ownership-gate.ts` | `tests/gateway/agent-chat.test.ts` |

## Notes

- `/api/v1/oracle` is mounted as an isolated sub-app registered **before** the
  shared chain; the predicate exclusion is defense-in-depth (SDD §3.6).
- `/api/identity` is **not** under `/api/v1` and is never touched by the shared
  v1 chain. Its former entry in the hand-maintained skip list was inert; it is
  listed here for completeness. In deployments with `FINN_AUTH_TOKEN` set, the
  legacy `/api/*` bearer chain applies to it.
- Non-`/api` surfaces (`/`, `/healthz`, `/health/deps`, `/health`, `/dashboard`,
  `/.well-known/jwks.json`, `/agent/*`, `/onboarding`, `/chat/*`) are public
  content/health endpoints; `/metrics` requires `FINN_METRICS_BEARER_TOKEN`
  when configured.

## Adding a new route group

1. Add a `RoutePolicyEntry` to `GATEWAY_ROUTE_POLICY` (declare auth, rate
   limit, guard source, and evidence).
2. Add the matching row to this table — `tests/gateway/route-policy.test.ts`
   fails on any mismatch, so an unclassified route cannot land silently.
3. Point `evidence` at a test proving the guard rejects unauthorized access.
