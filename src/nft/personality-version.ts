// src/nft/personality-version.ts — Personality Version Service (SDD §3.3, Sprint 3 Task 3.1-3.3)
//
// Manages immutable personality version chain with compare-and-set semantics.
// Each version is linked to its predecessor, forming a non-destructive audit trail.
// Codex version is pinned at creation time and immutable thereafter.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type {
  PersonalityVersion,
  SignalSnapshot,
  DAPMFingerprint,
  CompatibilityMode,
} from "./signal-types.js"
import { loadCodexVersion } from "./codex-data/loader.js"

// ---------------------------------------------------------------------------
// ULID Generation (monotonic, no external deps)
// ---------------------------------------------------------------------------

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford Base32

function encodeTime(now: number, len: number): string {
  let str = ""
  let t = now
  for (let i = len; i > 0; i--) {
    const mod = t % 32
    str = ENCODING[mod] + str
    t = (t - mod) / 32
  }
  return str
}

function encodeRandom(len: number): string {
  let str = ""
  for (let i = 0; i < len; i++) {
    str += ENCODING[Math.floor(Math.random() * 32)]
  }
  return str
}

/** Generate a ULID: 10-char timestamp + 16-char random = 26 chars */
export function generateUlid(now?: number): string {
  const timestamp = now ?? Date.now()
  return encodeTime(timestamp, 10) + encodeRandom(16)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateVersionData {
  beauvoir_md: string
  signals: SignalSnapshot | null
  dapm: DAPMFingerprint | null
  authored_by: string
  governance_model?: "holder" | "community" | "dao"
  change_summary?: string
}

export interface VersionHistoryPage {
  versions: PersonalityVersion[]
  next_cursor: string | null
}

export class VersionConflictError extends Error {
  public readonly httpStatus = 409
  constructor(nftId: string) {
    super(`VERSION_CONFLICT: latest pointer changed during create for ${nftId}`)
    this.name = "VersionConflictError"
  }
}

// ---------------------------------------------------------------------------
// Redis Key Helpers
// ---------------------------------------------------------------------------

function versionKey(nftId: string, versionId: string): string {
  return `pv:${nftId}:${versionId}`
}

function chainKey(nftId: string): string {
  return `pv:chain:${nftId}`
}

function latestKey(nftId: string): string {
  return `pv:latest:${nftId}`
}

// ---------------------------------------------------------------------------
// Lua Scripts
// ---------------------------------------------------------------------------

/**
 * Atomic create-version script:
 * KEYS[1] = latest pointer key
 * KEYS[2] = version record key
 * KEYS[3] = chain sorted set key
 * ARGV[1] = expected current latest (or "" for first version)
 * ARGV[2] = new version ID
 * ARGV[3] = serialized version JSON
 * ARGV[4] = score (created_at timestamp)
 *
 * Returns:
 *   "OK" on success
 *   "CONFLICT" if latest pointer != expected
 */
const CREATE_VERSION_LUA = `
local expected = ARGV[1]
local current = redis.call('GET', KEYS[1])
if expected == "" then
  if current ~= false then
    return "CONFLICT"
  end
else
  if current ~= expected then
    return "CONFLICT"
  end
end
redis.call('SET', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[2])
redis.call('SET', KEYS[1], ARGV[2])
return "OK"
`

/**
 * Paginated history query (newest first):
 * KEYS[1] = chain sorted set key
 * ARGV[1] = cursor score ("+inf" for first page, or a timestamp string)
 * ARGV[2] = limit
 *
 * Returns array of [member, score, member, score, ...] pairs
 * Uses ZREVRANGEBYSCORE with WITHSCORES and LIMIT
 */
const GET_HISTORY_LUA = `
local cursor = ARGV[1]
local limit = tonumber(ARGV[2])
return redis.call('ZREVRANGEBYSCORE', KEYS[1], cursor, '-inf', 'WITHSCORES', 'LIMIT', 0, limit + 1)
`

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface PersonalityVersionServiceDeps {
  redis: RedisCommandClient
}

export class PersonalityVersionService {
  private readonly redis: RedisCommandClient

  constructor(deps: PersonalityVersionServiceDeps) {
    this.redis = deps.redis
  }

  /**
   * Create a new personality version with compare-and-set semantics.
   * On VERSION_CONFLICT: one automatic retry, second conflict throws 409.
   */
  async createVersion(nftId: string, data: CreateVersionData): Promise<PersonalityVersion> {
    const result = await this.attemptCreate(nftId, data)
    if (result) return result

    // One retry on conflict — re-read latest and try again
    const retryResult = await this.attemptCreate(nftId, data)
    if (retryResult) return retryResult

    throw new VersionConflictError(nftId)
  }

  /**
   * Get a specific version by ID.
   */
  async getVersion(nftId: string, versionId: string): Promise<PersonalityVersion | null> {
    const key = versionKey(nftId, versionId)
    const data = await this.redis.get(key)
    if (!data) return null
    try {
      return JSON.parse(data) as PersonalityVersion
    } catch {
      return null
    }
  }

  /**
   * Get paginated version history (newest first).
   * cursor is the created_at timestamp of the last item on the previous page.
   * For the first page, omit cursor.
   */
  async getHistory(nftId: string, cursor?: string, limit?: number): Promise<VersionHistoryPage> {
    const effectiveLimit = limit ?? 20
    const cursorScore = cursor ?? "+inf"

    // Use Lua script for ZREVRANGEBYSCORE (not in base interface)
    const raw = await this.redis.eval(
      GET_HISTORY_LUA,
      1,
      chainKey(nftId),
      cursorScore,
      effectiveLimit,
    ) as string[]

    if (!raw || !Array.isArray(raw) || raw.length === 0) {
      return { versions: [], next_cursor: null }
    }

    // Parse [member, score, member, score, ...] pairs
    const pairs: Array<{ versionId: string; score: string }> = []
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({ versionId: raw[i], score: raw[i + 1] })
    }

    // Check if there's a next page (we fetched limit+1)
    const hasMore = pairs.length > effectiveLimit
    const pageItems = hasMore ? pairs.slice(0, effectiveLimit) : pairs
    const nextCursor = hasMore
      ? String(Number(pageItems[pageItems.length - 1].score) - 1)
      : null

    // Fetch full version records
    const versions: PersonalityVersion[] = []
    for (const item of pageItems) {
      const version = await this.getVersion(nftId, item.versionId)
      if (version) {
        versions.push(version)
      }
    }

    return { versions, next_cursor: nextCursor }
  }

  /**
   * Get the latest version for an NFT (fast pointer lookup).
   */
  async getLatest(nftId: string): Promise<PersonalityVersion | null> {
    const latestId = await this.redis.get(latestKey(nftId))
    if (!latestId) return null
    return this.getVersion(nftId, latestId)
  }

  /**
   * Non-destructive rollback: creates a NEW version with old content.
   * The chain continues forward — old version content is copied, not restored.
   */
  async rollback(nftId: string, targetVersionId: string, authoredBy: string): Promise<PersonalityVersion> {
    const targetVersion = await this.getVersion(nftId, targetVersionId)
    if (!targetVersion) {
      throw new Error(`Version not found: ${targetVersionId} for ${nftId}`)
    }

    return this.createVersion(nftId, {
      beauvoir_md: targetVersion.beauvoir_md,
      signals: targetVersion.signal_snapshot,
      dapm: targetVersion.dapm_fingerprint,
      authored_by: authoredBy,
      governance_model: targetVersion.governance_model,
      change_summary: `Rollback to version ${targetVersionId}`,
    })
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Single attempt to create a version with compare-and-set.
   * Returns the version on success, null on conflict.
   */
  private async attemptCreate(nftId: string, data: CreateVersionData): Promise<PersonalityVersion | null> {
    const now = Date.now()
    const newVersionId = generateUlid(now)

    // Read current latest
    const currentLatestId = await this.redis.get(latestKey(nftId))
    const previousVersionId = currentLatestId ?? null

    // Pin codex version
    let codexVersion: string
    try {
      const codex = loadCodexVersion()
      codexVersion = codex.version
    } catch {
      codexVersion = "unknown"
    }

    // Determine compatibility mode
    const compatibilityMode: CompatibilityMode = data.signals ? "signal_v2" : "legacy_v1"

    const version: PersonalityVersion = {
      version_id: newVersionId,
      previous_version_id: previousVersionId,
      personality_id: nftId,
      signal_snapshot: data.signals,
      dapm_fingerprint: data.dapm,
      beauvoir_md: data.beauvoir_md,
      authored_by: data.authored_by,
      governance_model: data.governance_model ?? "holder",
      codex_version: codexVersion,
      compatibility_mode: compatibilityMode,
      created_at: now,
      change_summary: data.change_summary ?? "",
    }

    // Atomic compare-and-set via Lua
    const result = await this.redis.eval(
      CREATE_VERSION_LUA,
      3,
      latestKey(nftId),
      versionKey(nftId, newVersionId),
      chainKey(nftId),
      currentLatestId ?? "",
      newVersionId,
      JSON.stringify(version),
      now,
    )

    if (result === "CONFLICT") {
      return null
    }

    return version
  }
}
