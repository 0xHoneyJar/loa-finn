// src/hounfour/pool-enforcement.ts — Pool Claim Enforcement (SDD §3.1)
// Composed auth entrypoints: hounfourAuth() for HTTP, validateAndEnforceWsJWT() for WS.
// enforcePoolClaims() is the pure enforcement function — no side effects.

import { createHash } from "node:crypto"
import type { Context, Next } from "hono"
import type { PoolId, Tier } from "@0xhoneyjar/loa-hounfour"
import type { FinnConfig } from "../config.js"
import type { JtiReplayGuard } from "./jti-replay.js"
import {
  authenticateRequest,
  validateWsJWT,
  type JWTClaims,
  type TenantContext,
  type JWTConfig,
  type EndpointType,
} from "./jwt-auth.js"
import { HounfourError, type HounfourErrorCode } from "./errors.js"
import {
  getAccessiblePools,
  isValidPoolId,
  tierHasAccess,
  resolvePool,
  assertValidPoolId,
} from "./tier-bridge.js"
import { allowedPoolsForTier } from "../nft/routing-affinity.js"
import { parsePoolId } from "./wire-boundary.js"

// --- Types (SDD §3.1.1) ---

/** Result of pool enforcement on JWT claims — uses PoolId end-to-end */
export type PoolEnforcementResult =
  | {
      /** Enforcement passed — pools resolved from tier */
      ok: true
      resolvedPools: readonly PoolId[]
      requestedPool: PoolId | null
      mismatch: PoolMismatch | null
    }
  | {
      /** Enforcement failed — pool_id invalid or unauthorized */
      ok: false
      error: string
      code: Extract<HounfourErrorCode, "POOL_ACCESS_DENIED" | "UNKNOWN_POOL">
      details?: { pool_id?: string; tier?: string }
    }

/** Describes a mismatch between JWT allowed_pools and tier-derived pools */
export interface PoolMismatch {
  type: "subset" | "superset" | "invalid_entry"
  count: number
  entries?: string[]
}

/** Configuration for pool enforcement behavior */
export interface PoolEnforcementConfig {
  strictMode?: boolean
  debugLogging?: boolean
}

/** WS enforcement result — discriminated, not bare null */
export type WsEnforcementResult =
  | { ok: true; context: TenantContext }
  | { ok: false; reason: "UNAUTHENTICATED" | "FORBIDDEN"; code?: HounfourErrorCode; message?: string }

// --- Pure Function: enforcePoolClaims (SDD §3.1.2) ---

/**
 * Enforce pool-level authorization from JWT claims.
 *
 * Steps:
 *   1. Derive resolvedPools from claims.tier via TIER_POOL_ACCESS
 *   2. If pool_id present: validate canonical + tier access
 *   3. If allowed_pools present: detect mismatch type
 *   4. Return enforcement result
 *
 * This is a pure function — no side effects (logging is caller's concern).
 */
export function enforcePoolClaims(
  claims: JWTClaims,
  config?: PoolEnforcementConfig,
): PoolEnforcementResult {
  const tier = claims.tier
  const resolvedPools = getAccessiblePools(tier)

  // Fail-closed: no pools resolved for tier (invariant violation)
  if (resolvedPools.length === 0) {
    return {
      ok: false,
      error: `Tier "${tier}" has no accessible pools`,
      code: "POOL_ACCESS_DENIED",
      details: { tier },
    }
  }

  // Validate pool_id if present
  let requestedPool: PoolId | null = null
  if (claims.pool_id != null && claims.pool_id !== "") {
    if (!isValidPoolId(claims.pool_id)) {
      return {
        ok: false,
        error: `Unknown pool ID: "${claims.pool_id}"`,
        code: "UNKNOWN_POOL",
        details: { pool_id: claims.pool_id, tier },
      }
    }
    if (!tierHasAccess(tier, claims.pool_id)) {
      return {
        ok: false,
        error: `Tier "${tier}" cannot access pool "${claims.pool_id}"`,
        code: "POOL_ACCESS_DENIED",
        details: { pool_id: claims.pool_id, tier },
      }
    }
    requestedPool = parsePoolId(claims.pool_id)
  }

  // Detect allowed_pools mismatch (priority: invalid_entry > superset > subset)
  let mismatch: PoolMismatch | null = null
  if (claims.allowed_pools && claims.allowed_pools.length > 0) {
    const resolvedSet = new Set<string>(resolvedPools)
    const claimedSet = new Set(claims.allowed_pools)

    // Check for invalid entries first (highest priority)
    const invalidEntries = claims.allowed_pools.filter((p) => !isValidPoolId(p))
    if (invalidEntries.length > 0) {
      mismatch = { type: "invalid_entry", count: invalidEntries.length, entries: invalidEntries }
    } else {
      // Check for superset: entries in allowed_pools NOT in resolvedPools
      const supersetEntries = claims.allowed_pools.filter((p) => !resolvedSet.has(p))
      if (supersetEntries.length > 0) {
        mismatch = { type: "superset", count: supersetEntries.length, entries: supersetEntries }
      } else if (claimedSet.size < resolvedPools.length) {
        // Subset: fewer unique pools claimed than tier allows
        const diff = resolvedPools.length - claimedSet.size
        mismatch = { type: "subset", count: diff }
      }
    }

    // Strict mode: superset escalates to 403
    if (config?.strictMode && mismatch?.type === "superset") {
      return {
        ok: false,
        error: `Strict mode: allowed_pools claims more pools than tier "${tier}" permits`,
        code: "POOL_ACCESS_DENIED",
        details: { tier },
      }
    }
  }

  return { ok: true, resolvedPools, requestedPool, mismatch }
}

// --- Logging (SDD §3.6) ---

function hashPoolList(pools: string[]): string {
  const sorted = [...pools].sort()
  return createHash("sha256").update(sorted.join("|")).digest("hex").slice(0, 16)
}

// TODO: migrate to structured logger (pino) when adopted codebase-wide
/** Log pool mismatch with graduated severity (NFR-4: minimal logging) */
export function logPoolMismatch(
  claims: JWTClaims,
  mismatch: PoolMismatch,
  config?: PoolEnforcementConfig,
): void {
  const entry: Record<string, unknown> = {
    event: `confused_deputy_${mismatch.type}`,
    tenant_id: claims.tenant_id,
    tier: claims.tier,
    mismatch_type: mismatch.type,
    mismatch_count: mismatch.count,
  }

  if (config?.debugLogging) {
    entry.claimed_hash = hashPoolList(claims.allowed_pools ?? [])
    entry.derived_hash = hashPoolList([...getAccessiblePools(claims.tier)])
  }

  const msg = JSON.stringify(entry)
  switch (mismatch.type) {
    case "subset":
      console.info("[pool-enforcement]", msg)
      break
    case "superset":
      console.warn("[pool-enforcement]", msg)
      break
    case "invalid_entry":
      console.error("[pool-enforcement]", msg)
      break
  }
}

// --- Config Helper ---

/**
 * Pool enforcement config with graceful defaults.
 * TODO: wire to FinnConfig.hounfour.poolEnforcement when config schema is extended.
 */
export function getPoolConfig(): PoolEnforcementConfig {
  return {
    strictMode: false,
    debugLogging: false,
  }
}

// --- Composed HTTP Middleware: hounfourAuth (SDD §3.1.5) ---

/**
 * Composed auth middleware: JWT validation + pool enforcement.
 * All /api/v1/* routes MUST use this instead of raw jwtAuthMiddleware.
 *
 * On success: TenantContext has populated resolvedPools and optional requestedPool.
 * On pool enforcement failure: returns 403 with structured error code.
 */
export function hounfourAuth(
  config: FinnConfig,
  replayGuard?: JtiReplayGuard,
  endpointType?: EndpointType,
) {
  return async (c: Context, next: Next) => {
    if (!config.jwt.enabled) return next()

    // 1. JWT validation via extracted function
    const authResult = await authenticateRequest({
      authorizationHeader: c.req.header("Authorization"),
      jwtConfig: config.jwt,
      replayGuard,
      endpointType,
    })
    if (!authResult.ok) {
      return c.json(authResult.body, authResult.status)
    }

    // 2. Pool enforcement (single config snapshot for both enforce + log)
    const poolConfig = getPoolConfig()
    const enforcement = enforcePoolClaims(authResult.context.claims, poolConfig)
    if (!enforcement.ok) {
      return c.json({ error: "Forbidden", code: enforcement.code }, 403)
    }

    // 3. Log mismatch
    if (enforcement.mismatch) {
      logPoolMismatch(authResult.context.claims, enforcement.mismatch, poolConfig)
    }

    // 4. Set enriched TenantContext
    const tenantContext: TenantContext = {
      ...authResult.context,
      // Shallow copy: enforcement result is readonly, TenantContext consumers should not mutate
      resolvedPools: [...enforcement.resolvedPools],
      requestedPool: enforcement.requestedPool,
    }
    c.set("tenant", tenantContext)
    c.set("jwtClaims", authResult.context.claims)

    return next()
  }
}

// --- Composed WS Function: validateAndEnforceWsJWT (SDD §3.1.4) ---

/**
 * Combined JWT validation + pool enforcement for WebSocket upgrade.
 * Returns a discriminated result — callers can distinguish authn vs authz failure.
 */
export async function validateAndEnforceWsJWT(
  token: string | undefined,
  config: JWTConfig,
  replayGuard?: JtiReplayGuard,
  enforcementConfig?: PoolEnforcementConfig,
): Promise<WsEnforcementResult> {
  const ctx = await validateWsJWT(token, config, replayGuard)
  if (!ctx) return { ok: false, reason: "UNAUTHENTICATED" }

  const result = enforcePoolClaims(ctx.claims, enforcementConfig)
  if (!result.ok) {
    return { ok: false, reason: "FORBIDDEN", code: result.code, message: "Forbidden" }
  }

  if (result.mismatch) {
    logPoolMismatch(ctx.claims, result.mismatch, enforcementConfig)
  }

  return {
    ok: true,
    context: {
      ...ctx,
      // Shallow copy: enforcement result is readonly, TenantContext consumers should not mutate
      resolvedPools: [...result.resolvedPools],
      requestedPool: result.requestedPool,
    },
  }
}

// --- Single Pool Selection Choke Point (SDD §3.5.1) ---

/**
 * Select and authorize a pool for a tenant request.
 * This is the ONLY function that should resolve pools for routing.
 *
 * Combines: resolve → validate → binding check → membership check
 * All execution paths (HTTP, WS, background jobs) must use this.
 *
 * Note: assertTierAccess() is NOT called here — authorization is via
 * resolvedPools membership only, which was already derived from tier
 * by enforcePoolClaims() at auth time.
 */
export function selectAuthorizedPool(
  tenantContext: TenantContext,
  taskType: string,
): PoolId {
  const tier = tenantContext.claims.tier
  const poolId = resolvePool(tier, taskType, tenantContext.claims.model_preferences)
  assertValidPoolId(poolId)

  // Enforce JWT pool_id binding
  if (tenantContext.requestedPool && tenantContext.requestedPool !== poolId) {
    throw new HounfourError("POOL_ACCESS_DENIED",
      `Routing selected pool "${poolId}" but JWT binds to "${tenantContext.requestedPool}"`,
      { poolId, requestedPool: tenantContext.requestedPool })
  }

  // Invariant: resolvedPools must be populated (fail closed, not open)
  if (tenantContext.resolvedPools.length === 0) {
    throw new HounfourError("POOL_ACCESS_DENIED",
      "No resolved pools for tenant (invariant violation)",
      { tier })
  }

  // Verify resolved pool is in resolvedPools (defense in depth)
  if (!tenantContext.resolvedPools.includes(poolId)) {
    throw new HounfourError("POOL_ACCESS_DENIED",
      `Pool "${poolId}" not in tenant's resolved pools`,
      { poolId, tier })
  }

  return poolId
}

// --- Personality-Aware Pool Selection (Sprint 2, T2.4) ---

/**
 * Select pools ranked by personality routing affinity, constrained to tier.
 * Returns PoolId[] sorted by affinity score descending.
 *
 * Tier Safety Invariant (GPT-5.2 fix #5):
 * Uses allowedPoolsForTier() as SINGLE source of truth for pool access.
 * Only pools in BOTH allowedPools AND resolvedPools (from JWT) are returned.
 * Empty result means NO eligible pools — caller MUST fail, NEVER escalate.
 *
 * The caller iterates pools in affinity order, checking health for each.
 * This replaces resolveWithFallback's cross-pool fallback chains, which
 * can escape tier boundaries (e.g., architect → reasoning → reviewer →
 * fast-code → cheap). Personality affinity IS the fallback order.
 */
export function selectAffinityRankedPools(
  tenantContext: TenantContext,
  routingAffinity: Record<PoolId, number>,
): PoolId[] {
  const tier = tenantContext.claims.tier
  const allowed = allowedPoolsForTier(tier)

  // Intersection: tier-allowed AND JWT-resolved (defense in depth)
  const eligible = allowed.filter(p => tenantContext.resolvedPools.includes(p))

  if (eligible.length === 0) return []

  // Sort by affinity descending, ties broken by pool ID ascending (deterministic)
  eligible.sort((a, b) => {
    const affinityA = routingAffinity[a] ?? 0
    const affinityB = routingAffinity[b] ?? 0
    if (affinityB !== affinityA) return affinityB - affinityA
    return a.localeCompare(b)
  })

  return eligible
}
