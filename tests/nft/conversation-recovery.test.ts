// tests/nft/conversation-recovery.test.ts — WAL Recovery + Redis Rebuild Tests (T1.2a)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ConversationWal, WAL_RECORD_TYPE } from "../../src/nft/conversation-wal.js"
import type { ConversationWalRecord } from "../../src/nft/conversation-wal.js"
import { ConversationRecovery } from "../../src/nft/conversation-recovery.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DATA_DIR = join(process.cwd(), "tmp-test-recovery-" + process.pid)

function makeRedis(): Record<string, string> & {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<string>
} {
  const store: Record<string, string> = {}
  return Object.assign(store, {
    get: vi.fn(async (key: string) => store[key] ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store[key] = value
      return "OK"
    }),
  })
}

let msgCounter = 0
function appendWalRecord(
  wal: ConversationWal,
  type: number,
  conversationId: string,
  payload: Record<string, unknown> = {},
): void {
  wal.append({
    type: type as ConversationWalRecord["type"],
    message_id: `msg-${++msgCounter}`,
    conversation_id: conversationId,
    timestamp: Date.now(),
    payload,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationRecovery", () => {
  let wal: ConversationWal
  let redis: ReturnType<typeof makeRedis>
  let recovery: ConversationRecovery

  beforeEach(() => {
    msgCounter = 0
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
    wal = new ConversationWal({ dataDir: TEST_DATA_DIR })
    redis = makeRedis()
    recovery = new ConversationRecovery({ redis, wal })
  })

  afterEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // replayAll
  // -------------------------------------------------------------------------

  it("recovers a conversation with CREATE + messages from WAL", async () => {
    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-1", {
      nft_id: "nft-42",
      owner_address: "0xabc",
    })
    appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-1", {
      role: "user",
      content: "Hello agent",
    })
    appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-1", {
      role: "assistant",
      content: "Hello human",
    })

    const count = await recovery.replayAll()
    expect(count).toBe(1)

    // Verify Redis was populated
    const stored = redis["conversation:conv-1"]
    expect(stored).toBeDefined()
    const conv = JSON.parse(stored)
    expect(conv.id).toBe("conv-1")
    expect(conv.nft_id).toBe("nft-42")
    expect(conv.messages).toHaveLength(2)
    expect(conv.messages[0].role).toBe("user")
    expect(conv.messages[1].role).toBe("assistant")
    expect(conv.message_count).toBe(2)
  })

  it("recovers multiple conversations", async () => {
    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-a", {
      nft_id: "nft-1",
      owner_address: "0x111",
    })
    appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-a", {
      role: "user",
      content: "Hi",
    })

    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-b", {
      nft_id: "nft-2",
      owner_address: "0x222",
    })
    appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-b", {
      role: "user",
      content: "Hey",
    })

    const count = await recovery.replayAll()
    expect(count).toBe(2)

    expect(redis["conversation:conv-a"]).toBeDefined()
    expect(redis["conversation:conv-b"]).toBeDefined()
  })

  it("applies SUMMARY_UPDATE with monotonic guard", async () => {
    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-sum", {
      nft_id: "nft-1",
      owner_address: "0xabc",
    })
    for (let i = 0; i < 5; i++) {
      appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-sum", {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
      })
    }
    // Summary at message_count 5
    appendWalRecord(wal, WAL_RECORD_TYPE.SUMMARY_UPDATE, "conv-sum", {
      summary: "First summary",
      summary_message_count: 5,
    })
    // Stale summary at message_count 3 — should be ignored
    appendWalRecord(wal, WAL_RECORD_TYPE.SUMMARY_UPDATE, "conv-sum", {
      summary: "Stale summary",
      summary_message_count: 3,
    })

    await recovery.replayAll()

    const conv = JSON.parse(redis["conversation:conv-sum"])
    expect(conv.summary).toBe("First summary")
    expect(conv.summary_message_count).toBe(5)
  })

  it("skips conversations with no messages", async () => {
    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-empty", {
      nft_id: "nft-1",
      owner_address: "0xabc",
    })

    const count = await recovery.replayAll()
    expect(count).toBe(0) // No messages = not recovered
  })

  it("updates conversation index in Redis", async () => {
    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-idx", {
      nft_id: "nft-idx",
      owner_address: "0xabc",
    })
    appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-idx", {
      role: "user",
      content: "Hello",
    })

    await recovery.replayAll()

    const indexData = redis["conv_index:nft-idx"]
    expect(indexData).toBeDefined()
    const ids = JSON.parse(indexData)
    expect(ids).toContain("conv-idx")
  })

  // -------------------------------------------------------------------------
  // recoverConversation
  // -------------------------------------------------------------------------

  it("recovers a single conversation on-demand", async () => {
    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-single", {
      nft_id: "nft-s",
      owner_address: "0xdef",
    })
    appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-single", {
      role: "user",
      content: "Single recovery",
    })

    const conv = await recovery.recoverConversation("conv-single")
    expect(conv).not.toBeNull()
    expect(conv!.id).toBe("conv-single")
    expect(conv!.messages).toHaveLength(1)
  })

  it("returns null for non-existent conversation", async () => {
    const conv = await recovery.recoverConversation("conv-ghost")
    expect(conv).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Idempotent replay
  // -------------------------------------------------------------------------

  it("is idempotent — replaying twice yields same result", async () => {
    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-idemp", {
      nft_id: "nft-i",
      owner_address: "0xaaa",
    })
    appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-idemp", {
      role: "user",
      content: "Test",
    })

    await recovery.replayAll()
    const first = JSON.parse(redis["conversation:conv-idemp"])

    await recovery.replayAll()
    const second = JSON.parse(redis["conversation:conv-idemp"])

    expect(second.messages).toHaveLength(first.messages.length)
    expect(second.message_count).toBe(first.message_count)
  })

  // -------------------------------------------------------------------------
  // Default summary fields
  // -------------------------------------------------------------------------

  it("initializes summary fields to defaults", async () => {
    appendWalRecord(wal, WAL_RECORD_TYPE.CREATE, "conv-defaults", {
      nft_id: "nft-d",
      owner_address: "0xbbb",
    })
    appendWalRecord(wal, WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-defaults", {
      role: "user",
      content: "Test",
    })

    await recovery.replayAll()

    const conv = JSON.parse(redis["conversation:conv-defaults"])
    expect(conv.summary).toBeNull()
    expect(conv.summary_message_count).toBe(0)
  })
})
