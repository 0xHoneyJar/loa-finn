// src/nft/conversation.ts — Wallet-Bound Conversation Manager (Sprint 5 Task 5.2)
//
// Conversation persistence with wallet-bound access control.
// owner_address set at creation, not transferable with NFT.
// Three-tier: Redis (hot) → WAL (warm) → R2 (cold).

import { timingSafeEqual } from "node:crypto"
import type { RedisCommandClient } from "../hounfour/redis/client.js"

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

export interface ConversationDeps {
  redis: RedisCommandClient
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
  r2Put?: (key: string, content: string) => Promise<boolean>
  r2Get?: (key: string) => Promise<string | null>
  generateId: () => string
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

  constructor(deps: ConversationDeps) {
    this.redis = deps.redis
    this.walAppend = deps.walAppend
    this.r2Put = deps.r2Put
    this.r2Get = deps.r2Get
    this.generateId = deps.generateId
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
    }

    await this.saveToRedis(conversation)
    this.writeWal("conversation_create", id, { nft_id: nftId, owner_address: ownerAddress.toLowerCase() })

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

    conversation.messages.push(message)
    conversation.message_count++
    conversation.updated_at = Date.now()

    await this.saveToRedis(conversation)
    this.writeWal("conversation_message_append", conversationId, {
      role: message.role,
      content_length: message.content.length,
      message_index: conversation.message_count - 1,
    })

    // Snapshot compaction check
    if (conversation.message_count - conversation.snapshot_offset >= SNAPSHOT_THRESHOLD) {
      await this.snapshot(conversation)
    }
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

    // Get conversation index for this NFT
    const indexKey = `conv_index:${nftId}`
    const indexData = await this.redis.get(indexKey)
    const allIds: string[] = indexData ? JSON.parse(indexData) : []

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
    const key = `conversation:${conversationId}`
    const data = await this.redis.get(key)
    if (data) {
      try {
        return JSON.parse(data) as Conversation
      } catch {
        return null
      }
    }

    // Redis miss — try R2 snapshot recovery
    if (this.r2Get) {
      try {
        const snapshotData = await this.r2Get(`conversations/${conversationId}/latest.json`)
        if (snapshotData) {
          const conv = JSON.parse(snapshotData) as Conversation
          // Re-cache in Redis
          await this.saveToRedis(conv)
          return conv
        }
      } catch {
        // Fall through
      }
    }

    return null
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
      this.writeWal("conversation_snapshot", conversation.id, {
        message_count: conversation.message_count,
        r2_key: `conversations/${conversation.id}/latest.json`,
      })
    } catch {
      // Best-effort snapshot
    }
  }

  private writeWal(operation: string, conversationId: string, extra?: Record<string, unknown>): void {
    if (!this.walAppend) return
    try {
      this.walAppend("conversation", operation, `conversation:${conversationId}`, {
        conversation_id: conversationId,
        timestamp: Date.now(),
        ...extra,
      })
    } catch {
      // Best-effort
    }
  }
}
