// src/nft/entropy.ts — Entropy Protocol (PRD §4.7, Sprint 19 Tasks 19.1-19.3)
//
// Commit-reveal ceremony for personality seed derivation.
// Client submits entropy commitment (hash of mouse/touch events), server
// provides CSPRNG entropy floor, HKDF combines both with a blockhash to
// produce a deterministic personality_seed.
//
// The personality_seed enriches PersonalityVersion but does NOT affect the
// canonical name (nameKDF operates on on-chain signals only).

import { createHash, createHmac, randomBytes, hkdf } from "node:crypto"
import type { Context, Next } from "hono"
import { Hono } from "hono"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum number of input events required in a commitment */
export const MIN_EVENT_COUNT = 50

/** Minimum temporal spread (ms) across the event stream */
export const MIN_TEMPORAL_SPREAD_MS = 5_000

/** Minimum spatial variance (px^2) across the event stream */
export const MIN_SPATIAL_VARIANCE = 100

/** Commitment TTL in milliseconds (10 minutes) */
export const COMMITMENT_TTL_MS = 10 * 60 * 1000

/** HKDF info string for personality seed derivation */
const HKDF_INFO = "mibera-personality-seed-v1"

/** HKDF output length in bytes (32 = 256-bit seed) */
const HKDF_OUTPUT_LENGTH = 32

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single input event from the client entropy stream.
 * Captures mouse or touch position with a timestamp.
 */
export interface EntropyEvent {
  /** X coordinate (px) */
  x: number
  /** Y coordinate (px) */
  y: number
  /** Timestamp (Unix ms) */
  t: number
}

/**
 * Client entropy commitment — the hash of the raw event stream.
 * Stored server-side with a 10-min TTL; client must reveal within the window.
 */
export interface EntropyCommitment {
  /** SHA-256 hash of the serialized event stream (hex) */
  commitment_hash: string
  /** Wallet address that submitted the commitment (from SIWE auth) */
  wallet_address: string
  /** NFT collection address */
  collection: string
  /** NFT token ID */
  token_id: string
  /** Server-side CSPRNG entropy (32 bytes, hex) */
  server_entropy: string
  /** Timestamp of commitment creation (Unix ms) */
  created_at: number
  /** Expiry timestamp (Unix ms) */
  expires_at: number
}

/**
 * Client entropy reveal — the raw event stream whose hash was committed.
 */
export interface EntropyReveal {
  /** Raw input events */
  events: EntropyEvent[]
  /** Blockhash to mix in (from a recent block at commitment time) */
  blockhash: string
}

/**
 * Derived personality seed — output of the commit-reveal ceremony.
 */
export interface PersonalitySeed {
  /** The derived seed (hex-encoded, 32 bytes) */
  seed: string
  /** Hash of the client entropy (for audit/verification) */
  commitment_hash: string
  /** Server entropy used (hex) */
  server_entropy: string
  /** Blockhash mixed in */
  blockhash: string
  /** Derivation timestamp (Unix ms) */
  derived_at: number
}

/**
 * Entropy validation result — returned by validateReveal.
 */
export interface EntropyValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Anti-bot heuristic result.
 */
export interface AntiBotResult {
  human_likely: boolean
  reasons: string[]
}

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export type EntropyErrorCode =
  | "COMMITMENT_NOT_FOUND"
  | "COMMITMENT_EXPIRED"
  | "HASH_MISMATCH"
  | "INSUFFICIENT_EVENTS"
  | "INSUFFICIENT_TEMPORAL_SPREAD"
  | "INSUFFICIENT_SPATIAL_VARIANCE"
  | "BOT_DETECTED"
  | "INVALID_REQUEST"

const ENTROPY_ERROR_STATUS: Record<EntropyErrorCode, number> = {
  COMMITMENT_NOT_FOUND: 404,
  COMMITMENT_EXPIRED: 410,
  HASH_MISMATCH: 400,
  INSUFFICIENT_EVENTS: 400,
  INSUFFICIENT_TEMPORAL_SPREAD: 400,
  INSUFFICIENT_SPATIAL_VARIANCE: 400,
  BOT_DETECTED: 403,
  INVALID_REQUEST: 400,
}

export class EntropyError extends Error {
  public readonly httpStatus: number
  constructor(
    public readonly code: EntropyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "EntropyError"
    this.httpStatus = ENTROPY_ERROR_STATUS[code]
  }
}

// ---------------------------------------------------------------------------
// Hashing Utilities
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a serialized event stream.
 * Events are serialized as JSON with deterministic key ordering.
 */
export function hashEventStream(events: EntropyEvent[]): string {
  const serialized = JSON.stringify(
    events.map((e) => ({ x: e.x, y: e.y, t: e.t })),
  )
  return createHash("sha256").update(serialized).digest("hex")
}

/**
 * Generate server-side CSPRNG entropy (32 bytes, hex-encoded).
 */
export function generateServerEntropy(): string {
  return randomBytes(32).toString("hex")
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an entropy reveal against the stored commitment.
 * Checks: hash match, min event count, temporal spread, spatial variance.
 */
export function validateReveal(
  reveal: EntropyReveal,
  commitment: EntropyCommitment,
  now?: number,
): EntropyValidationResult {
  const errors: string[] = []
  const currentTime = now ?? Date.now()

  // Check expiry
  if (currentTime > commitment.expires_at) {
    return { valid: false, errors: ["Commitment has expired"] }
  }

  // Check hash match
  const revealHash = hashEventStream(reveal.events)
  if (revealHash !== commitment.commitment_hash) {
    errors.push("Hash mismatch: reveal does not match commitment")
  }

  // Check minimum event count
  if (reveal.events.length < MIN_EVENT_COUNT) {
    errors.push(
      `Insufficient events: ${reveal.events.length} < ${MIN_EVENT_COUNT}`,
    )
  }

  // Check temporal spread
  if (reveal.events.length >= 2) {
    const timestamps = reveal.events.map((e) => e.t)
    const minT = Math.min(...timestamps)
    const maxT = Math.max(...timestamps)
    const spread = maxT - minT
    if (spread < MIN_TEMPORAL_SPREAD_MS) {
      errors.push(
        `Insufficient temporal spread: ${spread}ms < ${MIN_TEMPORAL_SPREAD_MS}ms`,
      )
    }
  } else if (reveal.events.length > 0) {
    errors.push(
      `Insufficient temporal spread: need at least 2 events for spread calculation`,
    )
  }

  // Check spatial variance
  if (reveal.events.length >= 2) {
    const xs = reveal.events.map((e) => e.x)
    const ys = reveal.events.map((e) => e.y)
    const xVariance = variance(xs)
    const yVariance = variance(ys)
    const totalVariance = xVariance + yVariance
    if (totalVariance < MIN_SPATIAL_VARIANCE) {
      errors.push(
        `Insufficient spatial variance: ${totalVariance.toFixed(2)} < ${MIN_SPATIAL_VARIANCE}`,
      )
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Compute variance of a numeric array.
 */
function variance(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
}

// ---------------------------------------------------------------------------
// Anti-Bot Heuristics
// ---------------------------------------------------------------------------

/**
 * Run anti-bot heuristics on the event stream.
 * Detects robotic/synthetic patterns:
 * - Perfectly uniform timing intervals
 * - Grid-locked spatial positions
 * - Zero acceleration (constant velocity)
 */
export function detectBot(events: EntropyEvent[]): AntiBotResult {
  const reasons: string[] = []

  if (events.length < MIN_EVENT_COUNT) {
    // Cannot make a meaningful determination with too few events
    return { human_likely: false, reasons: ["Too few events for heuristic analysis"] }
  }

  // Heuristic 1: Timing uniformity
  // Synthetic streams often have perfectly uniform intervals
  if (events.length >= 3) {
    const intervals: number[] = []
    for (let i = 1; i < events.length; i++) {
      intervals.push(events[i].t - events[i - 1].t)
    }
    const intervalVar = variance(intervals)
    // A real human's timing variance should be at least 10ms^2
    if (intervalVar < 10) {
      reasons.push("Timing intervals are suspiciously uniform (variance < 10ms^2)")
    }
  }

  // Heuristic 2: Grid-locked positions
  // Check if all positions snap to a grid
  if (events.length >= 10) {
    const xMods = new Set(events.map((e) => e.x % 10))
    const yMods = new Set(events.map((e) => e.y % 10))
    // If all x or all y values are multiples of 10, likely grid-locked
    if (xMods.size === 1 && yMods.size === 1) {
      reasons.push("All positions are grid-locked (snapped to 10px grid)")
    }
  }

  // Heuristic 3: Zero acceleration (constant velocity)
  // Real mouse movements have varying acceleration
  if (events.length >= 5) {
    const velocities: number[] = []
    for (let i = 1; i < events.length; i++) {
      const dx = events[i].x - events[i - 1].x
      const dy = events[i].y - events[i - 1].y
      const dt = events[i].t - events[i - 1].t
      if (dt > 0) {
        velocities.push(Math.sqrt(dx * dx + dy * dy) / dt)
      }
    }
    if (velocities.length >= 3) {
      const velVar = variance(velocities)
      // Real human mouse movement has significant velocity variance
      if (velVar < 0.0001) {
        reasons.push("Zero acceleration detected (constant velocity)")
      }
    }
  }

  return {
    human_likely: reasons.length === 0,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// HKDF Seed Derivation
// ---------------------------------------------------------------------------

/**
 * Derive a personality seed using HKDF.
 *
 * Formula:
 *   personality_seed = HKDF(
 *     ikm = client_commitment || server_entropy || blockhash,
 *     salt = collectionSalt,
 *     info = "mibera-personality-seed-v1"
 *   )
 *
 * Uses HKDF-SHA256 with a 32-byte output.
 * This is a synchronous wrapper around the async node:crypto hkdf.
 */
export async function derivePersonalitySeed(
  commitmentHash: string,
  serverEntropy: string,
  blockhash: string,
  collectionSalt: string,
): Promise<string> {
  const ikm = Buffer.concat([
    Buffer.from(commitmentHash, "hex"),
    Buffer.from(serverEntropy, "hex"),
    Buffer.from(blockhash, "hex"),
  ])

  const salt = Buffer.from(collectionSalt, "utf-8")

  const derived = await new Promise<Buffer>((resolve, reject) => {
    hkdf(
      "sha256",
      ikm,
      salt,
      HKDF_INFO,
      HKDF_OUTPUT_LENGTH,
      (err, derivedKey) => {
        if (err) reject(err)
        else resolve(Buffer.from(derivedKey))
      },
    )
  })

  return derived.toString("hex")
}

/**
 * Synchronous HKDF derivation using HMAC-based extract-then-expand.
 * Provided as a deterministic alternative that can be tested without async.
 */
export function derivePersonalitySeedSync(
  commitmentHash: string,
  serverEntropy: string,
  blockhash: string,
  collectionSalt: string,
): string {
  const ikm = Buffer.concat([
    Buffer.from(commitmentHash, "hex"),
    Buffer.from(serverEntropy, "hex"),
    Buffer.from(blockhash, "hex"),
  ])

  const salt = Buffer.from(collectionSalt, "utf-8")

  // HKDF-Extract: PRK = HMAC-Hash(salt, IKM)
  const prk = createHmac("sha256", salt).update(ikm).digest()

  // HKDF-Expand: OKM = HMAC-Hash(PRK, info || 0x01)
  const info = Buffer.from(HKDF_INFO, "utf-8")
  const expandInput = Buffer.concat([info, Buffer.from([0x01])])
  const okm = createHmac("sha256", prk).update(expandInput).digest()

  // Return first HKDF_OUTPUT_LENGTH bytes
  return okm.subarray(0, HKDF_OUTPUT_LENGTH).toString("hex")
}

// ---------------------------------------------------------------------------
// Request Validation
// ---------------------------------------------------------------------------

/**
 * Validate a commit request body.
 */
export function validateCommitRequest(
  body: unknown,
): { commitment_hash: string; blockhash: string } {
  if (typeof body !== "object" || body === null) {
    throw new EntropyError("INVALID_REQUEST", "Request body must be a JSON object")
  }
  const b = body as Record<string, unknown>

  if (typeof b.commitment_hash !== "string" || !b.commitment_hash.trim()) {
    throw new EntropyError("INVALID_REQUEST", "commitment_hash is required and must be a non-empty string")
  }

  // Validate hex format (SHA-256 = 64 hex chars)
  if (!/^[0-9a-f]{64}$/i.test(b.commitment_hash)) {
    throw new EntropyError("INVALID_REQUEST", "commitment_hash must be a 64-character hex string (SHA-256)")
  }

  if (typeof b.blockhash !== "string" || !b.blockhash.trim()) {
    throw new EntropyError("INVALID_REQUEST", "blockhash is required and must be a non-empty string")
  }

  return {
    commitment_hash: b.commitment_hash.toLowerCase(),
    blockhash: b.blockhash.trim(),
  }
}

/**
 * Validate a reveal request body.
 */
export function validateRevealRequest(body: unknown): EntropyReveal {
  if (typeof body !== "object" || body === null) {
    throw new EntropyError("INVALID_REQUEST", "Request body must be a JSON object")
  }
  const b = body as Record<string, unknown>

  if (!Array.isArray(b.events)) {
    throw new EntropyError("INVALID_REQUEST", "events must be an array")
  }

  for (let i = 0; i < b.events.length; i++) {
    const event = b.events[i]
    if (typeof event !== "object" || event === null) {
      throw new EntropyError("INVALID_REQUEST", `events[${i}] must be an object`)
    }
    const e = event as Record<string, unknown>
    if (typeof e.x !== "number" || typeof e.y !== "number" || typeof e.t !== "number") {
      throw new EntropyError(
        "INVALID_REQUEST",
        `events[${i}] must have numeric x, y, and t fields`,
      )
    }
  }

  if (typeof b.blockhash !== "string" || !b.blockhash.trim()) {
    throw new EntropyError("INVALID_REQUEST", "blockhash is required and must be a non-empty string")
  }

  return {
    events: b.events as EntropyEvent[],
    blockhash: b.blockhash.trim(),
  }
}

// ---------------------------------------------------------------------------
// In-Memory Commitment Store (Redis-backed in production)
// ---------------------------------------------------------------------------

export interface CommitmentStore {
  get(key: string): Promise<EntropyCommitment | null>
  set(key: string, commitment: EntropyCommitment, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Redis-backed commitment store.
 */
export function createRedisCommitmentStore(redis: {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>
  del(...keys: string[]): Promise<number>
}): CommitmentStore {
  return {
    async get(key: string): Promise<EntropyCommitment | null> {
      const data = await redis.get(`entropy:commit:${key}`)
      if (!data) return null
      try {
        return JSON.parse(data) as EntropyCommitment
      } catch {
        return null
      }
    },
    async set(key: string, commitment: EntropyCommitment, ttlMs: number): Promise<void> {
      const ttlSeconds = Math.ceil(ttlMs / 1000)
      await redis.set(`entropy:commit:${key}`, JSON.stringify(commitment), "EX", ttlSeconds)
    },
    async delete(key: string): Promise<void> {
      await redis.del(`entropy:commit:${key}`)
    },
  }
}

/**
 * In-memory commitment store for testing.
 */
export function createMemoryCommitmentStore(): CommitmentStore & {
  _store: Map<string, { commitment: EntropyCommitment; expiresAt: number }>
} {
  const store = new Map<string, { commitment: EntropyCommitment; expiresAt: number }>()
  return {
    _store: store,
    async get(key: string): Promise<EntropyCommitment | null> {
      const entry = store.get(key)
      if (!entry) return null
      if (Date.now() > entry.expiresAt) {
        store.delete(key)
        return null
      }
      return entry.commitment
    },
    async set(key: string, commitment: EntropyCommitment, ttlMs: number): Promise<void> {
      store.set(key, { commitment, expiresAt: Date.now() + ttlMs })
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  }
}

// ---------------------------------------------------------------------------
// Ceremony Route Factory (Hono sub-app)
// ---------------------------------------------------------------------------

export interface CeremonyRouteDeps {
  commitmentStore: CommitmentStore
  /** Collection salt for HKDF (collection-level namespace isolation) */
  getCollectionSalt: (collection: string) => string
}

/**
 * Create Hono sub-app for entropy ceremony endpoints.
 * Mount at /api/v1/nft
 *
 * Expects SIWE auth middleware to be applied upstream, setting
 * `wallet_address` on the Hono context.
 *
 * Endpoints:
 *   POST /:collection/:tokenId/ceremony/commit  — store commitment
 *   POST /:collection/:tokenId/ceremony/reveal   — validate + derive seed
 */
export function ceremonyRoutes(deps: CeremonyRouteDeps): Hono {
  const app = new Hono()

  // POST /api/v1/nft/:collection/:tokenId/ceremony/commit
  app.post("/:collection/:tokenId/ceremony/commit", async (c) => {
    const { collection, tokenId } = c.req.param()
    const walletAddress: string = c.get("wallet_address") ?? "unknown"

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const req = validateCommitRequest(body)
      const serverEntropy = generateServerEntropy()
      const now = Date.now()

      const commitment: EntropyCommitment = {
        commitment_hash: req.commitment_hash,
        wallet_address: walletAddress,
        collection,
        token_id: tokenId,
        server_entropy: serverEntropy,
        created_at: now,
        expires_at: now + COMMITMENT_TTL_MS,
      }

      const storeKey = `${collection}:${tokenId}:${walletAddress}`
      await deps.commitmentStore.set(storeKey, commitment, COMMITMENT_TTL_MS)

      return c.json(
        {
          status: "committed",
          server_entropy: serverEntropy,
          expires_at: commitment.expires_at,
        },
        201,
      )
    } catch (e) {
      if (e instanceof EntropyError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
      }
      throw e
    }
  })

  // POST /api/v1/nft/:collection/:tokenId/ceremony/reveal
  app.post("/:collection/:tokenId/ceremony/reveal", async (c) => {
    const { collection, tokenId } = c.req.param()
    const walletAddress: string = c.get("wallet_address") ?? "unknown"

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const reveal = validateRevealRequest(body)

      // Look up commitment
      const storeKey = `${collection}:${tokenId}:${walletAddress}`
      const commitment = await deps.commitmentStore.get(storeKey)
      if (!commitment) {
        throw new EntropyError("COMMITMENT_NOT_FOUND", "No active commitment found for this NFT")
      }

      // Validate the reveal against the commitment
      const validation = validateReveal(reveal, commitment)
      if (!validation.valid) {
        // Return the first relevant error code
        const firstError = validation.errors[0]
        if (firstError.includes("expired")) {
          throw new EntropyError("COMMITMENT_EXPIRED", firstError)
        }
        if (firstError.includes("Hash mismatch")) {
          throw new EntropyError("HASH_MISMATCH", firstError)
        }
        if (firstError.includes("Insufficient events")) {
          throw new EntropyError("INSUFFICIENT_EVENTS", firstError)
        }
        if (firstError.includes("temporal spread")) {
          throw new EntropyError("INSUFFICIENT_TEMPORAL_SPREAD", firstError)
        }
        if (firstError.includes("spatial variance")) {
          throw new EntropyError("INSUFFICIENT_SPATIAL_VARIANCE", firstError)
        }
        throw new EntropyError("INVALID_REQUEST", validation.errors.join("; "))
      }

      // Run anti-bot heuristics
      const botResult = detectBot(reveal.events)
      if (!botResult.human_likely) {
        throw new EntropyError("BOT_DETECTED", `Anti-bot heuristics failed: ${botResult.reasons.join("; ")}`)
      }

      // Derive personality seed via HKDF
      const collectionSalt = deps.getCollectionSalt(collection)
      const seed = await derivePersonalitySeed(
        commitment.commitment_hash,
        commitment.server_entropy,
        reveal.blockhash,
        collectionSalt,
      )

      // Clean up the commitment (one-time use)
      await deps.commitmentStore.delete(storeKey)

      const personalitySeed: PersonalitySeed = {
        seed,
        commitment_hash: commitment.commitment_hash,
        server_entropy: commitment.server_entropy,
        blockhash: reveal.blockhash,
        derived_at: Date.now(),
      }

      return c.json(personalitySeed, 200)
    } catch (e) {
      if (e instanceof EntropyError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
      }
      throw e
    }
  })

  return app
}
