// src/nft/conversation.ts — Wallet-Bound Conversation Manager (Sprint 5 Task 5.2)
//
// Conversation persistence with wallet-bound access control.
// owner_address set at creation, not transferable with NFT.
// Three-tier: Redis (hot) → WAL (warm) → R2 (cold).

import { timingSafeEqual } from "node:crypto"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { ConversationWal } from "./conversation-wal.js"
import { WAL_RECORD_TYPE } from "./conversation-wal.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  role: "user" | "assistant"
  content: string
  timestamp: number
  cost_cu?: string
}

export interface Conversation {
  id: string
  nft_id: string
  owner_address: string
  messages: ConversationMessage[]
  created_at: number
  updated_at: number
  message_count: number
  snapshot_offset: number
  /** LLM-generated summary of conversation history (T1.5) */
  summary: string | null
  /** Message count when summary was last generated (T1.5) */
  summary_message_count: number
}

export interface ConversationSummary {
  id: string
  nft_id: string
  created_at: number
  updated_at: number
  message_count: number
  last_message_preview: string
}

export interface PaginatedResult<T> {
  items: T[]
  cursor: string | null
  has_more: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGE_BYTES = 8192
const SNAPSHOT_THRESHOLD = 200
const REDIS_CONVERSATION_TTL = 86400 // 24h
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConversationError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "ACCESS_DENIED" | "MESSAGE_TOO_LARGE" | "INVALID_REQUEST",
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = "ConversationError"
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Result from getSummaries — used by MemoryInjector (T1.8) */
export interface ConversationSummaryRecord {
  id: string
  summary: string | null
  updated_at: number
}

/** Summary trigger threshold constants (T1.6) */
const SUMMARY_MIN_MESSAGES = 10
const SUMMARY_INTERVAL_MESSAGES = 20
const SUMMARY_LOCK_TTL_SECONDS = 30

export interface ConversationDeps {
  redis: RedisCommandClient
  /** Conversation WAL append — synchronous with fsync for durability (T1.2) */
  walAppend?: (conversationId: string, type: number, payload: unknown) => void
  r2Put?: (key: string, content: string) => Promise<boolean>
  r2Get?: (key: string) => Promise<string | null>
  generateId: () => string
  /** Async summary generator callback — fire-and-forget (T1.6) */
  onSummaryNeeded?: (conversationId: string, messages: ConversationMessage[], personalityName: string) => void
  /** Resolve personality name for an NFT (used by summary trigger) */
  getPersonalityName?: (nftId: string) => Promise<string | null>
  /** Optional WAL instance for read-path degradation fallback (T3.10) */
  wal?: ConversationWal
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ConversationManager {
  private readonly redis: RedisCommandClient
  private readonly walAppend: ConversationDeps["walAppend"]
  private readonly r2Put: ConversationDeps["r2Put"]
  private readonly r2Get: ConversationDeps["r2Get"]
  private readonly generateId: () => string
  private readonly onSummaryNeeded: ConversationDeps["onSummaryNeeded"]
  private readonly getPersonalityName: ConversationDeps["getPersonalityName"]
  private readonly wal: ConversationDeps["wal"]

  constructor(deps: ConversationDeps) {
    this.redis = deps.redis
    this.walAppend = deps.walAppend
    this.r2Put = deps.r2Put
    this.r2Get = deps.r2Get
    this.generateId = deps.generateId
    this.onSummaryNeeded = deps.onSummaryNeeded
    this.getPersonalityName = deps.getPersonalityName
    this.wal = deps.wal
  }

  /**
   * Create a new conversation. Caller must verify NFT ownership first.
   */
  async create(nftId: string, ownerAddress: string): Promise<Conversation> {
    const id = this.generateId()
    const now = Date.now()
    const conversation: Conversation = {
      id,
      nft_id: nftId,
      owner_address: ownerAddress.toLowerCase(),
      messages: [],
      created_at: now,
      updated_at: now,
      message_count: 0,
      snapshot_offset: 0,
      summary: null,
      summary_message_count: 0,
    }

    // WAL-first: persist to WAL before Redis (T1.2)
    this.writeWal(0x01, id, { nft_id: nftId, owner_address: ownerAddress.toLowerCase() })
    await this.saveToRedis(conversation)

    return conversation
  }

  /**
   * Get conversation by ID with access check.
   */
  async get(conversationId: string, walletAddress: string): Promise<Conversation> {
    const conversation = await this.load(conversationId)
    if (!conversation) {
      throw new ConversationError("NOT_FOUND", "Conversation not found", 404)
    }
    this.checkAccess(conversation, walletAddress)
    return conversation
  }

  /**
   * Append a message to a conversation.
   */
  /**
   * Append a message to a conversation.
   * WAL-first ordering (T1.2): WAL fsync MUST complete before Redis update.
   * Client does not receive success until WAL confirms.
   */
  async appendMessage(
    conversationId: string,
    walletAddress: string,
    message: ConversationMessage,
  ): Promise<void> {
    // Size check
    if (Buffer.byteLength(message.content, "utf-8") > MAX_MESSAGE_BYTES) {
      throw new ConversationError("MESSAGE_TOO_LARGE", `Message exceeds ${MAX_MESSAGE_BYTES} byte limit`, 400)
    }

    const conversation = await this.get(conversationId, walletAddress)

    const messageId = this.generateId()
    conversation.messages.push(message)
    conversation.message_count++
    conversation.updated_at = Date.now()

    // WAL-first: write to WAL with fsync BEFORE Redis (T1.2)
    // WAL failure → error thrown, message rejected, client can retry
    this.writeWal(0x02, conversationId, {
      message_id: messageId,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      cost_cu: message.cost_cu,
      message_index: conversation.message_count - 1,
    })

    // Redis write failure after WAL success → warning logged, operation succeeds
    try {
      await this.saveToRedis(conversation)
    } catch (err) {
      console.warn(`[conversation] Redis write failed after WAL success for ${conversationId}: ${(err as Error).message}`)
    }

    // Snapshot compaction check
    if (conversation.message_count - conversation.snapshot_offset >= SNAPSHOT_THRESHOLD) {
      await this.snapshot(conversation)
    }

    // Async summary trigger (T1.6) — fire-and-forget, does NOT block appendMessage
    this.maybeTriggerSummary(conversation).catch(() => {})
  }

  /**
   * Check if summary generation is needed and trigger if so (T1.6).
   * Uses Redis SETNX lock and monotonic guard to prevent races.
   */
  private async maybeTriggerSummary(conversation: Conversation): Promise<void> {
    if (!this.onSummaryNeeded) return

    const { message_count, summary, summary_message_count } = conversation
    const needsSummary =
      message_count >= SUMMARY_MIN_MESSAGES &&
      (summary === null || message_count - summary_message_count >= SUMMARY_INTERVAL_MESSAGES)

    if (!needsSummary) return

    // Per-conversation Redis lock: SETNX with TTL (T1.6)
    // Graceful degradation (T3.10): if Redis is down, skip summary trigger silently
    let lockResult: string | null
    try {
      const lockKey = `summary_lock:${conversation.id}`
      lockResult = await this.redis.set(lockKey, "1", "EX", SUMMARY_LOCK_TTL_SECONDS, "NX")
    } catch (err) {
      console.warn(`[conversation] Redis lock failed for summary trigger on ${conversation.id}, skipping: ${(err as Error).message}`)
      return
    }
    if (!lockResult) return // Another instance is summarizing

    // Resolve personality name for the summary prompt
    let personalityName = "Agent"
    if (this.getPersonalityName) {
      try {
        personalityName = await this.getPersonalityName(conversation.nft_id) ?? "Agent"
      } catch {
        // Use default
      }
    }

    // Fire-and-forget — the callback handles summarization and applies the result
    this.onSummaryNeeded(conversation.id, [...conversation.messages], personalityName)
  }

  /**
   * Apply a generated summary to a conversation (T1.6).
   * Uses monotonic guard: only updates if incoming count > current count.
   */
  async applySummary(
    conversationId: string,
    summary: string,
    summaryMessageCount: number,
  ): Promise<boolean> {
    const conversation = await this.load(conversationId)
    if (!conversation) return false

    // Monotonic guard: reject stale summaries (T1.6)
    if (summaryMessageCount <= conversation.summary_message_count) return false

    conversation.summary = summary
    conversation.summary_message_count = summaryMessageCount
    conversation.updated_at = Date.now()

    // WAL-first for summary updates too
    this.writeWal(0x03, conversationId, {
      summary,
      summary_message_count: summaryMessageCount,
      generated_at: Date.now(),
    })

    try {
      await this.saveToRedis(conversation)
    } catch (err) {
      console.warn(`[conversation] Redis write failed for summary update on ${conversationId}: ${(err as Error).message}`)
    }

    return true
  }

  /**
   * Get summaries from the N most recent conversations for an NFT (T1.8).
   * Used by MemoryInjector to build conversation memory context.
   */
  async getSummaries(
    nftId: string,
    walletAddress: string,
    limit: number = 3,
    excludeConvId?: string,
  ): Promise<ConversationSummaryRecord[]> {
    const normalizedWallet = walletAddress.toLowerCase()

    // Get conversation index for this NFT (with WAL fallback — T3.10)
    const allIds = await this.readConversationIndex(nftId)

    const results: ConversationSummaryRecord[] = []

    // Iterate in reverse (newest first) to find conversations with summaries
    for (let i = allIds.length - 1; i >= 0 && results.length < limit; i--) {
      const id = allIds[i]
      if (excludeConvId && id === excludeConvId) continue

      const conv = await this.load(id)
      if (!conv) continue
      if (!conv.summary) continue

      // Timing-safe access check
      const expected = Buffer.from(conv.owner_address)
      const provided = Buffer.from(normalizedWallet)
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) continue

      results.push({
        id: conv.id,
        summary: conv.summary,
        updated_at: conv.updated_at,
      })
    }

    return results
  }

  /**
   * List conversations for an NFT filtered by wallet address.
   */
  async list(
    nftId: string,
    walletAddress: string,
    cursor?: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<PaginatedResult<ConversationSummary>> {
    const effectiveLimit = Math.min(limit, MAX_PAGE_SIZE)
    const normalizedWallet = walletAddress.toLowerCase()

    // Get conversation index for this NFT (with WAL fallback — T3.10)
    const allIds = await this.readConversationIndex(nftId)

    // Cursor-based pagination
    let startIdx = 0
    if (cursor) {
      const cursorIdx = allIds.indexOf(cursor)
      if (cursorIdx >= 0) startIdx = cursorIdx + 1
    }

    const candidates = allIds.slice(startIdx, startIdx + effectiveLimit + 1)
    const items: ConversationSummary[] = []

    for (const id of candidates.slice(0, effectiveLimit)) {
      const conv = await this.load(id)
      if (!conv) continue
      if (conv.owner_address !== normalizedWallet) continue

      items.push({
        id: conv.id,
        nft_id: conv.nft_id,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        message_count: conv.message_count,
        last_message_preview: conv.messages.length > 0
          ? conv.messages[conv.messages.length - 1].content.slice(0, 100)
          : "",
      })
    }

    return {
      items,
      cursor: candidates.length > effectiveLimit ? candidates[effectiveLimit] : null,
      has_more: candidates.length > effectiveLimit,
    }
  }

  /**
   * Get paginated messages for a conversation.
   */
  async getMessages(
    conversationId: string,
    walletAddress: string,
    cursor?: string,
    limit: number = MAX_PAGE_SIZE,
  ): Promise<PaginatedResult<ConversationMessage>> {
    const conversation = await this.get(conversationId, walletAddress)
    const effectiveLimit = Math.min(limit, MAX_PAGE_SIZE)

    let startIdx = 0
    if (cursor) {
      startIdx = parseInt(cursor, 10)
      if (isNaN(startIdx) || startIdx < 0) startIdx = 0
    }

    const endIdx = startIdx + effectiveLimit
    const items = conversation.messages.slice(startIdx, endIdx)
    const hasMore = endIdx < conversation.messages.length

    return {
      items,
      cursor: hasMore ? String(endIdx) : null,
      has_more: hasMore,
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private checkAccess(conversation: Conversation, walletAddress: string): void {
    const expected = Buffer.from(conversation.owner_address.toLowerCase())
    const provided = Buffer.from(walletAddress.toLowerCase())

    // Constant-time comparison
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new ConversationError("ACCESS_DENIED", "Access denied", 403)
    }
  }

  private async load(conversationId: string): Promise<Conversation | null> {
    // Try Redis first (hot cache)
    try {
      const key = `conversation:${conversationId}`
      const data = await this.redis.get(key)
      if (data) {
        try {
          return JSON.parse(data) as Conversation
        } catch {
          // Corrupt JSON in Redis — fall through to R2/WAL
        }
      }
    } catch (err) {
      // Redis error — graceful degradation (T3.10): fall through to R2, then WAL
      console.warn(`[conversation] Redis read failed for ${conversationId}, falling back to R2/WAL: ${(err as Error).message}`)
    }

    // Redis miss or error — try R2 snapshot recovery
    if (this.r2Get) {
      try {
        const snapshotData = await this.r2Get(`conversations/${conversationId}/latest.json`)
        if (snapshotData) {
          const conv = JSON.parse(snapshotData) as Conversation
          // Best-effort re-cache in Redis
          try { await this.saveToRedis(conv) } catch { /* Redis may still be down */ }
          return conv
        }
      } catch {
        // Fall through to WAL
      }
    }

    // R2 miss or error — try WAL replay as last resort (T3.10)
    const walResult = this.replayFromWal(conversationId)
    if (walResult) {
      console.warn(`[conversation] Served ${conversationId} from WAL replay (graceful degradation)`)
      // Best-effort re-cache in Redis
      try { await this.saveToRedis(walResult) } catch { /* Redis may still be down */ }
      return walResult
    }

    return null
  }

  /**
   * Rebuild a conversation from WAL replay (T3.10).
   * Used as a last-resort fallback when Redis and R2 are both unavailable.
   * Mirrors ConversationRecovery.rebuildFromWal but inline for zero-dep degradation.
   */
  private replayFromWal(conversationId: string): Conversation | null {
    if (!this.wal) return null

    try {
      const seenIds = new Set<string>()
      let conversation: Conversation | null = null

      for (const record of this.wal.replaySync(conversationId, seenIds)) {
        switch (record.type) {
          case WAL_RECORD_TYPE.CREATE:
            conversation = {
              id: record.conversation_id,
              nft_id: String(record.payload.nft_id ?? ""),
              owner_address: String(record.payload.owner_address ?? ""),
              messages: [],
              created_at: record.timestamp,
              updated_at: record.timestamp,
              message_count: 0,
              snapshot_offset: 0,
              summary: null,
              summary_message_count: 0,
            }
            break

          case WAL_RECORD_TYPE.MESSAGE_APPEND:
            if (conversation) {
              conversation.messages.push({
                role: (record.payload.role as "user" | "assistant") ?? "user",
                content: String(record.payload.content ?? ""),
                timestamp: Number(record.payload.timestamp ?? record.timestamp),
                ...(record.payload.cost_cu ? { cost_cu: String(record.payload.cost_cu) } : {}),
              })
              conversation.message_count++
              conversation.updated_at = record.timestamp
            }
            break

          case WAL_RECORD_TYPE.SUMMARY_UPDATE:
            if (conversation) {
              const smc = Number(record.payload.summary_message_count ?? 0)
              if (smc > conversation.summary_message_count) {
                conversation.summary = String(record.payload.summary ?? "")
                conversation.summary_message_count = smc
                conversation.updated_at = record.timestamp
              }
            }
            break
        }
      }

      return conversation
    } catch (err) {
      console.warn(`[conversation] WAL replay failed for ${conversationId}: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Read conversation index from Redis with WAL fallback (T3.10).
   * When Redis is down, scans WAL conversation IDs filtered by nftId.
   */
  private async readConversationIndex(nftId: string): Promise<string[]> {
    try {
      const indexKey = `conv_index:${nftId}`
      const indexData = await this.redis.get(indexKey)
      return indexData ? JSON.parse(indexData) : []
    } catch (err) {
      console.warn(`[conversation] Redis index read failed for ${nftId}, falling back to WAL scan: ${(err as Error).message}`)
      // Fallback: scan WAL conversation IDs and filter by loading each (T3.10)
      if (!this.wal) return []
      try {
        const allWalIds = this.wal.getConversationIds()
        const matchingIds: string[] = []
        for (const cid of allWalIds) {
          const conv = this.replayFromWal(cid)
          if (conv && conv.nft_id === nftId) {
            matchingIds.push(cid)
          }
        }
        return matchingIds
      } catch {
        return []
      }
    }
  }

  private async saveToRedis(conversation: Conversation): Promise<void> {
    const key = `conversation:${conversation.id}`
    await this.redis.set(key, JSON.stringify(conversation))

    // Update conversation index
    const indexKey = `conv_index:${conversation.nft_id}`
    const indexData = await this.redis.get(indexKey)
    const ids: string[] = indexData ? JSON.parse(indexData) : []
    if (!ids.includes(conversation.id)) {
      ids.push(conversation.id)
      await this.redis.set(indexKey, JSON.stringify(ids))
    }
  }

  private async snapshot(conversation: Conversation): Promise<void> {
    if (!this.r2Put) return

    try {
      const snapshotData = JSON.stringify(conversation)
      await this.r2Put(`conversations/${conversation.id}/latest.json`, snapshotData)
      conversation.snapshot_offset = conversation.message_count
      await this.saveToRedis(conversation)
      this.writeWal(0x04, conversation.id, {
        message_count: conversation.message_count,
        r2_key: `conversations/${conversation.id}/latest.json`,
      })
    } catch {
      // Best-effort snapshot
    }
  }

  /**
   * Write to conversation WAL with fsync (T1.2).
   * Uses binary WAL framing from T1.1.
   * THROWS on failure — caller must handle (WAL-first means WAL failure = operation failure).
   */
  private writeWal(type: number, conversationId: string, payload: Record<string, unknown>): void {
    if (!this.walAppend) return
    this.walAppend(conversationId, type, {
      conversation_id: conversationId,
      timestamp: Date.now(),
      ...payload,
    })
  }
}
