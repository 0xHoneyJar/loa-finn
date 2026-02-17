// src/gateway/oracle-auth.ts — Oracle API key auth middleware (SDD §3.3)
// Two-tier auth: Bearer dk_live_* → Redis lookup → authenticated tier,
// or no token → IP-based public tier. Fail-closed on Redis error when
// Authorization header is present (GPT-5.2 Fix #5).

import { createHash } from "node:crypto"
import { isIP } from "node:net"
import type { Context, Next } from "hono"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { TenantContext, JWTClaims } from "../hounfour/jwt-auth.js"
import type { OracleIdentity } from "./oracle-rate-limit.js"

const API_KEY_PREFIX_LIVE = "dk_live_"
const API_KEY_PREFIX_TEST = "dk_test_"
const TRUSTED_PROXY_COUNT = 2 // CloudFront + ALB

export interface OracleTenantContext {
  tier: "public" | "authenticated"
  identity: OracleIdentity
  /** Convert to TenantContext for the invoke pipeline */
  asTenant(): TenantContext
}

export interface OracleAuthConfig {
  trustXff: boolean
}

export function oracleAuthMiddleware(redis: RedisCommandClient, authConfig: OracleAuthConfig) {
  return async (c: Context, next: Next) => {
    const ip = extractClientIp(c, authConfig.trustXff)
    const authHeader = c.req.header("Authorization")

    // Check for API key
    if (authHeader?.startsWith("Bearer dk_")) {
      const token = authHeader.slice(7) // Remove "Bearer "
      if (token.startsWith(API_KEY_PREFIX_LIVE) || token.startsWith(API_KEY_PREFIX_TEST)) {
        const keyHash = createHash("sha256").update(token).digest("hex")
        try {
          const record = await redis.hgetall(`oracle:apikeys:${keyHash}`)
          if (record?.status === "active") {
            // Update last_used_at (fire and forget, via Lua since hset not on interface)
            redis.eval(
              "redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])",
              1, `oracle:apikeys:${keyHash}`, "last_used_at", new Date().toISOString(),
            ).catch(() => {})

            const identity: OracleIdentity = { type: "api_key", keyHash, ip }
            const tenant = createOracleTenant("authenticated", identity)
            c.set("oracleTenant", tenant)
            c.set("oracleIdentity", identity)
            return next()
          }
          // Revoked or unknown key — fall through to public tier
        } catch {
          // Redis error with Authorization header present — FAIL CLOSED.
          // Do NOT silently downgrade to IP-based (GPT-5.2 Fix #5):
          // a revoked key would regain access as public during partial Redis outage.
          return c.json(
            { error: "Service temporarily unavailable", code: "AUTH_UNAVAILABLE" },
            503,
          )
        }
      }
    }

    // Redis error without Authorization → fall through to public tier (Flatline IMP-001)
    // Public tier — IP-based
    const identity: OracleIdentity = { type: "ip", ip }
    const tenant = createOracleTenant("public", identity)
    c.set("oracleTenant", tenant)
    c.set("oracleIdentity", identity)
    return next()
  }
}

function createOracleTenant(
  tier: "public" | "authenticated",
  identity: OracleIdentity,
): OracleTenantContext {
  const identityId = identity.type === "api_key"
    ? `dk:${identity.keyHash.slice(0, 12)}`
    : `ip:${identity.ip}`

  return {
    tier,
    identity,
    asTenant: (): TenantContext => ({
      claims: {
        iss: "oracle",
        aud: "loa-finn",
        sub: `oracle:${identityId}`,
        tenant_id: `oracle:${identityId}`,
        tier: "free",
        req_hash: "",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      } as JWTClaims,
      resolvedPools: ["cheap"],
      requestedPool: undefined,
      isNFTRouted: false,
      isBYOK: false,
    }),
  }
}

/**
 * Extract client IP using rightmost-untrusted-hop algorithm (SDD §6.3).
 *
 * Proxy chain: Client → CloudFront → ALB → ECS.
 * With TRUSTED_PROXY_COUNT=2, the true client IP is at
 * parts[parts.length - TRUSTED_PROXY_COUNT - 1].
 *
 * Prefer CloudFront-Viewer-Address (unspoofable) over XFF.
 */
export function extractClientIp(c: Context, trustXff: boolean): string {
  // Prefer CloudFront-Viewer-Address if available (unspoofable)
  const cfViewer = c.req.header("CloudFront-Viewer-Address")
  if (cfViewer) {
    const ip = cfViewer.split(":")[0]
    if (ip && isValidIp(ip)) return ip
  }

  const xff = c.req.header("X-Forwarded-For")
  if (xff && trustXff) {
    const parts = xff.split(",").map((s) => s.trim())
    // Rightmost-untrusted-hop: skip the known trusted proxy entries from the right
    const clientIndex = parts.length - TRUSTED_PROXY_COUNT - 1
    if (clientIndex >= 0) {
      const candidate = parts[clientIndex]
      if (candidate && isValidIp(candidate)) return candidate
    }
  }

  // Fall back to connection remote address
  return (c.env as Record<string, string> | undefined)?.remoteAddr ?? "unknown"
}

/** Validate IPv4 or IPv6 address format using Node.js stdlib (BB-025-002 fix) */
export function isValidIp(ip: string): boolean {
  return isIP(ip) !== 0
}
