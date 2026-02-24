// src/nft/conversation-recovery.ts — WAL Recovery + Redis Rebuild (T1.2a)
//
// Boot-time WAL replay to restore conversation state and read-path Redis
// repopulation when Redis is empty or stale.
// WAL is the authoritative store; Redis is rebuilt from WAL, never the reverse.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { Conversation, ConversationMessage } from "./conversation.js"
import { ConversationWal, WAL_RECORD_TYPE, type ConversationWalRecord } from "./conversation-wal.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationRecoveryConfig {
  /** Base data directory — defaults to /data in prod, ./data in dev */
  dataDir: string
}

export interface ConversationRecoveryDeps {
  redis: RedisCommandClient
  wal: ConversationWal
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ConversationRecovery {
  private readonly redis: RedisCommandClient
  private readonly wal: ConversationWal

  constructor(deps: ConversationRecoveryDeps) {
    this.redis = deps.redis
    this.wal = deps.wal
  }

  /**
   * Boot-time recovery: scan all WAL files and replay into Redis.
   * Idempotent via message_id — safe to call on every startup.
   * Returns the number of conversations recovered.
   */
  async replayAll(): Promise<number> {
    const conversationIds = this.wal.getConversationIds()
    let recovered = 0

    for (const convId of conversationIds) {
      // Truncate any corrupt tail before replay
      this.wal.truncateCorrupt(convId)

      const conversation = this.rebuildFromWal(convId)
      if (conversation && conversation.messages.length > 0) {
        await this.persistToRedis(conversation)
        recovered++
      }
    }

    return recovered
  }

  /**
   * On-demand recovery for a single conversation.
   * Called when Redis has a cache miss for a conversation.
   * Returns the recovered conversation or null if no WAL data exists.
   */
  async recoverConversation(conversationId: string): Promise<Conversation | null> {
    // Truncate corrupt tail first
    this.wal.truncateCorrupt(conversationId)

    const conversation = this.rebuildFromWal(conversationId)
    if (!conversation) return null

    // Re-cache in Redis
    await this.persistToRedis(conversation)
    return conversation
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Rebuild a Conversation object from WAL records.
   * Uses idempotent replay via message_id set.
   */
  private rebuildFromWal(conversationId: string): Conversation | null {
    const seenIds = new Set<string>()
    let conversation: Conversation | null = null

    for (const record of this.wal.replaySync(conversationId, seenIds)) {
      switch (record.type) {
        case WAL_RECORD_TYPE.CREATE:
          conversation = this.applyCreate(record)
          break

        case WAL_RECORD_TYPE.MESSAGE_APPEND:
          if (conversation) {
            this.applyMessageAppend(conversation, record)
          }
          break

        case WAL_RECORD_TYPE.SUMMARY_UPDATE:
          if (conversation) {
            this.applySummaryUpdate(conversation, record)
          }
          break

        case WAL_RECORD_TYPE.SNAPSHOT:
          // Snapshots are handled by R2, not WAL replay
          break
      }
    }

    return conversation
  }

  private applyCreate(record: ConversationWalRecord): Conversation {
    const p = record.payload
    return {
      id: record.conversation_id,
      nft_id: String(p.nft_id ?? ""),
      owner_address: String(p.owner_address ?? ""),
      messages: [],
      created_at: record.timestamp,
      updated_at: record.timestamp,
      message_count: 0,
      snapshot_offset: 0,
      summary: null,
      summary_message_count: 0,
    }
  }

  private applyMessageAppend(conversation: Conversation, record: ConversationWalRecord): void {
    const p = record.payload
    const message: ConversationMessage = {
      role: (p.role as "user" | "assistant") ?? "user",
      content: String(p.content ?? ""),
      timestamp: Number(p.timestamp ?? record.timestamp),
      ...(p.cost_cu ? { cost_cu: String(p.cost_cu) } : {}),
    }

    conversation.messages.push(message)
    conversation.message_count++
    conversation.updated_at = record.timestamp
  }

  private applySummaryUpdate(conversation: Conversation, record: ConversationWalRecord): void {
    const p = record.payload
    const summaryMessageCount = Number(p.summary_message_count ?? 0)

    // Monotonic guard: only apply if newer than current
    if (summaryMessageCount > conversation.summary_message_count) {
      conversation.summary = String(p.summary ?? "")
      conversation.summary_message_count = summaryMessageCount
      conversation.updated_at = record.timestamp
    }
  }

  private async persistToRedis(conversation: Conversation): Promise<void> {
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
}
