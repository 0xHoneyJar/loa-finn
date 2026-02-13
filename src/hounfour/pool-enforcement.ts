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

// --- Types (SDD §3.1.1) ---

/** Result of pool enforcement on JWT claims — uses PoolId end-to-end */
export type PoolEnforcementResult =
  | {
      ok: true
      resolvedPools: readonly PoolId[]
      requestedPool: PoolId | null
      mismatch: PoolMismatch | null
    }
  | {
      ok: false
      error: string
      code: Extract<HounfourErrorCode, "POOL_ACCESS_DENIED" | "UNKNOWN_POOL">
    }

/** Describes a mismatch between JWT allowed_pools and tier-derived pools */
export interface PoolMismatch {
  type: "subset" | "superset" | "invalid_entry"
  count: number
}

/** Configuration for pool enforcement behavior */
export interface PoolEnforcementConfig {
  strictMode?: boolean
  debugLogging?: boolean
}

/** WS enforcement result — discriminated, not bare null */
export type WsEnforcementResult =
  | { ok: true; context: TenantContext }
  | { ok: false; reason: "UNAUTHENTICATED" | "FORBIDDEN"; code?: HounfourErrorCode }

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
  const tier = claims.tier as Tier
  const resolvedPools = getAccessiblePools(tier)

  // Validate pool_id if present
  let requestedPool: PoolId | null = null
  if (claims.pool_id != null && claims.pool_id !== "") {
    if (!isValidPoolId(claims.pool_id)) {
      return {
        ok: false,
        error: `Unknown pool ID: "${claims.pool_id}"`,
        code: "UNKNOWN_POOL",
      }
    }
    if (!tierHasAccess(tier, claims.pool_id)) {
      return {
        ok: false,
        error: `Tier "${tier}" cannot access pool "${claims.pool_id}"`,
        code: "POOL_ACCESS_DENIED",
      }
    }
    requestedPool = claims.pool_id as PoolId
  }

  // Detect allowed_pools mismatch (priority: invalid_entry > superset > subset)
  let mismatch: PoolMismatch | null = null
  if (claims.allowed_pools && claims.allowed_pools.length > 0) {
    const resolvedSet = new Set<string>(resolvedPools)

    // Check for invalid entries first (highest priority)
    const invalidEntries = claims.allowed_pools.filter((p) => !isValidPoolId(p))
    if (invalidEntries.length > 0) {
      mismatch = { type: "invalid_entry", count: invalidEntries.length }
    } else {
      // Check for superset: entries in allowed_pools NOT in resolvedPools
      const supersetEntries = claims.allowed_pools.filter((p) => !resolvedSet.has(p))
      if (supersetEntries.length > 0) {
        mismatch = { type: "superset", count: supersetEntries.length }
      } else if (claims.allowed_pools.length < resolvedPools.length) {
        // Subset: fewer pools claimed than tier allows
        const diff = resolvedPools.length - claims.allowed_pools.length
        mismatch = { type: "subset", count: diff }
      }
    }

    // Strict mode: superset escalates to 403
    if (config?.strictMode && mismatch?.type === "superset") {
      return {
        ok: false,
        error: `Strict mode: allowed_pools claims more pools than tier "${tier}" permits`,
        code: "POOL_ACCESS_DENIED",
      }
    }
  }

  return { ok: true, resolvedPools, requestedPool, mismatch }
}

// --- Logging (SDD §3.6) ---

function hashPoolList(pools: string[]): string {
  const sorted = [...pools].sort()
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16)
}

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
    entry.derived_hash = hashPoolList([...getAccessiblePools(claims.tier as Tier)])
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

/** Extract PoolEnforcementConfig from FinnConfig (graceful defaults) */
export function getPoolConfig(_config: FinnConfig): PoolEnforcementConfig {
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

    // 2. Pool enforcement
    const enforcement = enforcePoolClaims(authResult.context.claims, getPoolConfig(config))
    if (!enforcement.ok) {
      return c.json({ error: "Forbidden", code: enforcement.code }, 403)
    }

    // 3. Log mismatch
    if (enforcement.mismatch) {
      logPoolMismatch(authResult.context.claims, enforcement.mismatch, getPoolConfig(config))
    }

    // 4. Set enriched TenantContext
    const tenantContext: TenantContext = {
      ...authResult.context,
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
    return { ok: false, reason: "FORBIDDEN", code: result.code }
  }

  if (result.mismatch) {
    logPoolMismatch(ctx.claims, result.mismatch, enforcementConfig)
  }

  return {
    ok: true,
    context: {
      ...ctx,
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
  const tier = tenantContext.claims.tier as Tier
  const poolId = resolvePool(tier, taskType, tenantContext.claims.model_preferences)
  assertValidPoolId(poolId)

  // Enforce JWT pool_id binding
  if (tenantContext.requestedPool && tenantContext.requestedPool !== poolId) {
    throw new HounfourError("POOL_ACCESS_DENIED",
      `Routing selected pool "${poolId}" but JWT binds to "${tenantContext.requestedPool}"`,
      { poolId, requestedPool: tenantContext.requestedPool })
  }

  // Verify resolved pool is in resolvedPools (defense in depth)
  if (tenantContext.resolvedPools.length > 0
      && !tenantContext.resolvedPools.includes(poolId)) {
    throw new HounfourError("POOL_ACCESS_DENIED",
      `Pool "${poolId}" not in tenant's resolved pools`,
      { poolId, tier })
  }

  return poolId
}
