// src/gateway/route-policy.ts — Declarative gateway route guard policy
// (#202, #203, #208, #217, #221, #226, #228, #233)
//
// Single source of truth for which /api/v1 route groups are excluded from the
// shared hounfour JWT + rate-limit middleware chain and WHICH guard protects
// them instead. server.ts derives its skip predicate from this registry —
// there is no hand-maintained skip list to drift.
//
// Rendered matrix: docs/gateway-route-policy.md (kept in sync by
// tests/gateway/route-policy.test.ts).
//
// Adding a route group:
// 1. Add an entry here with its guard + rate-limit declaration.
// 2. Update docs/gateway-route-policy.md (the sync test fails otherwise).
// 3. Add/point to a test proving the local guard rejects unauthenticated
//    requests (see `evidence` field).

export interface RoutePolicyEntry {
  /** Path prefix (exact segment match: `prefix` or `prefix/...`). */
  prefix: string
  /** Authentication guard protecting this group. */
  auth: string
  /** Rate limiting applied to this group. */
  rateLimit: string
  /** Who can reach it. */
  visibility: "public" | "authenticated" | "operator" | "payment"
  /**
   * true → excluded from the shared /api/v1 hounfour JWT + rate-limit chain
   * because the group carries its own guard middleware.
   */
  selfGuarded: boolean
  /** File implementing the guard (source of truth for reviewers). */
  guardSource: string
  /** Test file proving the guard rejects unauthenticated/unauthorized access. */
  evidence: string
  notes?: string
}

export const GATEWAY_ROUTE_POLICY: RoutePolicyEntry[] = [
  {
    prefix: "/api/v1/oracle",
    auth: "Oracle API-key auth (Redis-backed) + billing-evaluator guard",
    rateLimit: "Oracle daily caps + concurrency limiter",
    visibility: "authenticated",
    selfGuarded: true,
    guardSource: "src/gateway/oracle-auth.ts",
    evidence: "tests/finn/oracle-auth.test.ts",
    notes: "Mounted as isolated sub-app with its own middleware chain (SDD §3.6).",
  },
  {
    prefix: "/api/v1/public",
    auth: "None — public product surface by design",
    rateLimit: "None at gateway level",
    visibility: "public",
    selfGuarded: true,
    guardSource: "src/gateway/routes/agent-public-api.ts",
    evidence: "tests/gateway/route-policy.test.ts",
    notes: "Public by design — the policy test asserts this is an explicit declaration, not an omission.",
  },
  {
    prefix: "/api/v1/conversations",
    auth: "SIWE session JWT (requireSiweSession) + NFT ownership check on create",
    rateLimit: "None dedicated (SIWE session implies authenticated caller)",
    visibility: "authenticated",
    selfGuarded: true,
    guardSource: "src/gateway/routes/conversations.ts",
    evidence: "tests/gateway/conversations.test.ts",
  },
  {
    prefix: "/api/v1/admin",
    auth: "JWKS JWT ES256 role check (/mode) · injected admin token (/seed-credits)",
    rateLimit: "5 mode changes/subject/hour (Redis-shared when available)",
    visibility: "operator",
    selfGuarded: true,
    guardSource: "src/gateway/routes/admin.ts",
    evidence: "tests/finn/gateway/admin-routes.test.ts",
  },
  {
    prefix: "/api/v1/x402",
    auth: "x402 payment verification (challenge/receipt)",
    rateLimit: "x402 per-wallet tier (RATE_LIMIT_TIERS.x402_per_wallet)",
    visibility: "payment",
    selfGuarded: true,
    guardSource: "src/gateway/x402-routes.ts",
    evidence: "tests/x402/",
  },
  {
    prefix: "/api/v1/pay",
    auth: "x402 payment verification (alias of /api/v1/x402/invoke)",
    rateLimit: "x402 per-wallet tier",
    visibility: "payment",
    selfGuarded: true,
    guardSource: "src/gateway/x402-routes.ts",
    evidence: "tests/x402/",
  },
  {
    prefix: "/api/identity",
    auth: "Legacy /api/* bearer chain applies when FINN_AUTH_TOKEN is configured (public in dev mode)",
    rateLimit: "Legacy /api/* in-memory limiter",
    visibility: "public",
    selfGuarded: false,
    guardSource: "src/gateway/auth.ts",
    evidence: "tests/finn/identity-routes.test.ts",
    notes:
      "NOT under /api/v1 — never touched by the /api/v1 shared chain. " +
      "Listed for completeness; its former entry in the hand-maintained skip list was inert.",
  },
  // --- Shared-chain groups (documented for the matrix; NOT skipped) ---
  {
    prefix: "/api/v1/invoke",
    auth: "hounfour JWT (arrakis-issued) via shared chain",
    rateLimit: "Shared in-memory limiter + economic boundary + billing guard",
    visibility: "authenticated",
    selfGuarded: false,
    guardSource: "src/hounfour/pool-enforcement.ts",
    evidence: "tests/finn/invoke-handler.test.ts",
  },
  {
    prefix: "/api/v1/usage",
    auth: "hounfour JWT via shared chain",
    rateLimit: "Shared in-memory limiter",
    visibility: "authenticated",
    selfGuarded: false,
    guardSource: "src/hounfour/pool-enforcement.ts",
    evidence: "tests/finn/usage-handler.test.ts",
  },
  {
    prefix: "/api/v1/score",
    auth: "hounfour JWT via shared chain + route-local FINN_AUTH_TOKEN bearer check",
    rateLimit: "Shared in-memory limiter",
    visibility: "authenticated",
    selfGuarded: false,
    guardSource: "src/gateway/routes/score-verdict.ts",
    evidence: "src/cost/score-verdict.test.ts",
  },
  {
    prefix: "/api/v1/agent/chat",
    auth: "hounfour JWT via shared chain + NFT ownership middleware",
    rateLimit: "Shared in-memory limiter",
    visibility: "authenticated",
    selfGuarded: false,
    guardSource: "src/nft/ownership-gate.ts",
    evidence: "tests/gateway/agent-chat.test.ts",
  },
]

// ---------------------------------------------------------------------------
// Derived predicate — replaces the hand-maintained skip list in server.ts
// ---------------------------------------------------------------------------

const SELF_GUARDED_V1_PREFIXES: readonly string[] = GATEWAY_ROUTE_POLICY
  .filter((e) => e.selfGuarded && e.prefix.startsWith("/api/v1/"))
  .map((e) => e.prefix)

/**
 * True when `path` belongs to a self-guarded /api/v1 route group — i.e. the
 * shared hounfour JWT + rate-limit chain must NOT run for it because the group
 * declares its own guard in GATEWAY_ROUTE_POLICY.
 *
 * Segment-exact: "/api/v1/oracle" and "/api/v1/oracle/x" match;
 * "/api/v1/oraclefoo" does not.
 */
export function isSelfGuardedApiV1Path(path: string): boolean {
  return SELF_GUARDED_V1_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  )
}
