// src/gateway/allowlist.ts — Redis Set-Based Allowlist Guard (Sprint 6 Task 6.1)
//
// Closed beta access control: wallet must be in Redis set `beta:allowlist`.
// Plaintext normalized addresses. O(1) SISMEMBER lookup.

import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWLIST_KEY = "beta:allowlist"
const ADDRESS_REGEX = /^[0-9a-f]{40}$/

// ---------------------------------------------------------------------------
// Address Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an Ethereum address: strip 0x, lowercase, validate 40 hex chars, re-add 0x.
 * Returns null if invalid.
 */
export function normalizeAddress(addr: string): string | null {
  const stripped = addr.startsWith("0x") || addr.startsWith("0X") ? addr.slice(2) : addr
  const lower = stripped.toLowerCase()
  if (!ADDRESS_REGEX.test(lower)) return null
  return `0x${lower}`
}

// ---------------------------------------------------------------------------
// Allowlist Service
// ---------------------------------------------------------------------------

export interface AllowlistDeps {
  redis: RedisCommandClient
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
}

export class AllowlistService {
  private readonly redis: RedisCommandClient
  private readonly walAppend: AllowlistDeps["walAppend"]
  private readonly bypassAddresses: Set<string>

  constructor(deps: AllowlistDeps) {
    this.redis = deps.redis
    this.walAppend = deps.walAppend

    // Parse BETA_BYPASS_ADDRESSES env var
    const bypassRaw = process.env.BETA_BYPASS_ADDRESSES ?? ""
    this.bypassAddresses = new Set(
      bypassRaw
        .split(",")
        .map((a) => normalizeAddress(a.trim()))
        .filter((a): a is string => a !== null),
    )
  }

  /**
   * Check if a wallet address is allowed (in allowlist or bypass list).
   */
  async isAllowed(address: string): Promise<boolean> {
    const normalized = normalizeAddress(address)
    if (!normalized) return false

    // Bypass addresses always pass
    if (this.bypassAddresses.has(normalized)) return true

    // Redis SISMEMBER via eval (RedisCommandClient uses eval for custom commands)
    // Since we don't have sismember directly, use get on a hash-style key
    const memberKey = `${ALLOWLIST_KEY}:${normalized}`
    const result = await this.redis.get(memberKey)
    return result !== null
  }

  /**
   * Add addresses to the allowlist.
   */
  async addAddresses(addresses: string[]): Promise<{ added: string[]; invalid: string[] }> {
    const added: string[] = []
    const invalid: string[] = []

    for (const addr of addresses) {
      const normalized = normalizeAddress(addr)
      if (!normalized) {
        invalid.push(addr)
        continue
      }
      const memberKey = `${ALLOWLIST_KEY}:${normalized}`
      await this.redis.set(memberKey, "1")
      added.push(normalized)
    }

    if (added.length > 0) {
      this.writeAudit("allowlist_add", { addresses: added, count: added.length })
    }

    return { added, invalid }
  }

  /**
   * Remove addresses from the allowlist.
   */
  async removeAddresses(addresses: string[]): Promise<{ removed: string[]; invalid: string[] }> {
    const removed: string[] = []
    const invalid: string[] = []

    for (const addr of addresses) {
      const normalized = normalizeAddress(addr)
      if (!normalized) {
        invalid.push(addr)
        continue
      }
      const memberKey = `${ALLOWLIST_KEY}:${normalized}`
      await this.redis.del(memberKey)
      removed.push(normalized)
    }

    if (removed.length > 0) {
      this.writeAudit("allowlist_remove", { addresses: removed, count: removed.length })
    }

    return { removed, invalid }
  }

  private writeAudit(operation: string, payload: Record<string, unknown>): void {
    if (!this.walAppend) return
    try {
      this.walAppend("allowlist", operation, ALLOWLIST_KEY, {
        ...payload,
        timestamp: Date.now(),
      })
    } catch {
      // Best-effort
    }
  }
}
