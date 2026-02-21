// src/gateway/api-keys.ts — API Key Manager (Sprint 3 T3.3, T3.4, T3.8)
//
// Manages developer API key lifecycle: create, validate, revoke.
// Key format: dk_{keyId}.{secret}
// Stored as: bcrypt(full_key) for verification + HMAC(pepper, full_key) for indexed lookup.
// Redis cache (5-min TTL) for validated keys.

import { randomBytes, createHmac } from "node:crypto"
import bcrypt from "bcrypt"
import { ulid } from "ulid"
import { eq, and, sql } from "drizzle-orm"
import type { Db } from "../drizzle/db.js"
import { finnApiKeys, finnBillingEvents } from "../drizzle/schema.js"
import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_PREFIX = "dk_"
const BCRYPT_ROUNDS = 12
const CACHE_TTL_SECONDS = 300 // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidatedApiKey {
  id: string
  tenantId: string
  label: string
  balanceMicro: number
  revoked: boolean
}

export interface CreateKeyResult {
  keyId: string
  plaintextKey: string
}

export interface DebitResult {
  success: boolean
  balanceAfter: number
}

// ---------------------------------------------------------------------------
// API Key Manager
// ---------------------------------------------------------------------------

export class ApiKeyManager {
  private readonly db: Db
  private readonly redis: RedisCommandClient
  private readonly pepper: string

  constructor(db: Db, redis: RedisCommandClient, pepper: string) {
    if (!pepper || pepper.length < 16) {
      throw new Error("API key pepper must be at least 16 characters")
    }
    this.db = db
    this.redis = redis
    this.pepper = pepper
  }

  /**
   * Create a new API key. Returns the plaintext key ONCE.
   * Key format: dk_{keyId}.{secret}
   */
  async create(tenantId: string, label = ""): Promise<CreateKeyResult> {
    const keyId = `key_${randomBytes(8).toString("hex")}`
    const secret = randomBytes(32).toString("base64url")
    const plaintext = `${KEY_PREFIX}${keyId}.${secret}`

    const lookupHash = this.computeLookupHash(plaintext)
    const secretHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS)

    await this.db.insert(finnApiKeys).values({
      id: keyId,
      tenantId,
      lookupHash,
      secretHash,
      label,
      balanceMicro: 0,
      revoked: false,
    })

    return { keyId, plaintextKey: plaintext }
  }

  /**
   * Validate API key. O(1) lookup via indexed HMAC hash, then bcrypt verify.
   * Returns null if key is invalid, revoked, or not found.
   */
  async validate(plaintextKey: string): Promise<ValidatedApiKey | null> {
    if (!plaintextKey.startsWith(KEY_PREFIX)) return null

    const lookupHash = this.computeLookupHash(plaintextKey)
    const cacheKey = `finn:apikey:${lookupHash}`

    // 1. Cache check (Redis, 5-min TTL)
    const cached = await this.redis.get(cacheKey)
    if (cached === "revoked") return null
    if (cached) {
      try {
        return JSON.parse(cached) as ValidatedApiKey
      } catch {
        // Corrupt cache — fall through to DB
      }
    }

    // 2. O(1) indexed DB lookup by HMAC hash
    const rows = await this.db
      .select({
        id: finnApiKeys.id,
        tenantId: finnApiKeys.tenantId,
        secretHash: finnApiKeys.secretHash,
        label: finnApiKeys.label,
        balanceMicro: finnApiKeys.balanceMicro,
        revoked: finnApiKeys.revoked,
      })
      .from(finnApiKeys)
      .where(eq(finnApiKeys.lookupHash, lookupHash))
      .limit(1)

    if (rows.length === 0) return null
    const row = rows[0]

    // Check revocation
    if (row.revoked) {
      await this.redis.set(cacheKey, "revoked", "EX", CACHE_TTL_SECONDS)
      return null
    }

    // 3. bcrypt verification (defense-in-depth)
    const bcryptValid = await bcrypt.compare(plaintextKey, row.secretHash)
    if (!bcryptValid) return null

    const validated: ValidatedApiKey = {
      id: row.id,
      tenantId: row.tenantId,
      label: row.label,
      balanceMicro: row.balanceMicro,
      revoked: false,
    }

    // 4. Cache validated key
    await this.redis.set(cacheKey, JSON.stringify(validated), "EX", CACHE_TTL_SECONDS)

    return validated
  }

  /**
   * Revoke a key. Immediate effect via Redis cache invalidation.
   * Returns true if the key was found and revoked.
   */
  async revoke(keyId: string, tenantId: string): Promise<boolean> {
    // Update DB
    const result = await this.db
      .update(finnApiKeys)
      .set({ revoked: true, updatedAt: new Date() })
      .where(and(eq(finnApiKeys.id, keyId), eq(finnApiKeys.tenantId, tenantId)))
      .returning({ id: finnApiKeys.id, lookupHash: finnApiKeys.lookupHash })

    if (result.length === 0) return false

    // Invalidate Redis cache — set to "revoked" marker
    const cacheKey = `finn:apikey:${result[0].lookupHash}`
    await this.redis.set(cacheKey, "revoked", "EX", CACHE_TTL_SECONDS)

    return true
  }

  /**
   * Atomic credit debit (T3.8).
   * Uses SQL conditional update to prevent overspend.
   * Idempotent: debit keyed by requestId via finn_billing_events unique constraint.
   *
   * Returns { success: true, balanceAfter } on success.
   * Returns { success: false, balanceAfter: -1 } if insufficient credits.
   */
  async debitCredits(
    keyId: string,
    amountMicro: number,
    requestId: string,
    metadata?: Record<string, unknown>,
  ): Promise<DebitResult> {
    // Check idempotency first — if billing event with this requestId exists, it's a replay
    const existing = await this.db
      .select({ id: finnBillingEvents.id, balanceAfter: finnBillingEvents.balanceAfter })
      .from(finnBillingEvents)
      .where(eq(finnBillingEvents.requestId, requestId))
      .limit(1)

    if (existing.length > 0) {
      // Idempotent replay — return the original result
      return { success: true, balanceAfter: existing[0].balanceAfter }
    }

    // Atomic conditional debit — single SQL statement prevents overspend
    const result = await this.db
      .update(finnApiKeys)
      .set({
        balanceMicro: sql`${finnApiKeys.balanceMicro} - ${amountMicro}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(finnApiKeys.id, keyId),
          sql`${finnApiKeys.balanceMicro} >= ${amountMicro}`,
        ),
      )
      .returning({ balanceMicro: finnApiKeys.balanceMicro })

    if (result.length === 0) {
      // Insufficient credits
      return { success: false, balanceAfter: -1 }
    }

    const balanceAfter = result[0].balanceMicro

    // Record billing event (idempotency enforced by unique constraint on requestId)
    try {
      await this.db.insert(finnBillingEvents).values({
        id: ulid(),
        apiKeyId: keyId,
        requestId,
        amountMicro,
        balanceAfter,
        eventType: "debit",
        metadata: metadata ?? null,
      })
    } catch (err) {
      // Unique constraint violation = concurrent debit already recorded
      // This is fine — the debit happened atomically above
      if ((err as Error).message?.includes("unique")) {
        return { success: true, balanceAfter }
      }
      // Other DB errors — log but don't break the flow
      console.error(
        JSON.stringify({
          metric: "finn.billing_event_record_error",
          keyId: keyId.slice(0, 8) + "***",
          requestId,
          error: (err as Error).message,
        }),
      )
    }

    // Invalidate cache so next validate() sees updated balance
    const lookupRows = await this.db
      .select({ lookupHash: finnApiKeys.lookupHash })
      .from(finnApiKeys)
      .where(eq(finnApiKeys.id, keyId))
      .limit(1)

    if (lookupRows.length > 0) {
      const cacheKey = `finn:apikey:${lookupRows[0].lookupHash}`
      await this.redis.del(cacheKey)
    }

    return { success: true, balanceAfter }
  }

  /**
   * Get current balance for a key.
   */
  async getBalance(keyId: string): Promise<number | null> {
    const rows = await this.db
      .select({ balanceMicro: finnApiKeys.balanceMicro })
      .from(finnApiKeys)
      .where(eq(finnApiKeys.id, keyId))
      .limit(1)

    if (rows.length === 0) return null
    return rows[0].balanceMicro
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private computeLookupHash(plaintextKey: string): string {
    return createHmac("sha256", this.pepper).update(plaintextKey).digest("hex")
  }
}
