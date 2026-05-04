// tests/nft/conversation-wal.test.ts — Binary WAL Framing Tests (T1.1)

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ConversationWal, WAL_RECORD_TYPE, computeCrc32 } from "../../src/nft/conversation-wal.js"
import type { ConversationWalRecord } from "../../src/nft/conversation-wal.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DATA_DIR = join(process.cwd(), "tmp-test-wal-" + process.pid)

function makeRecord(
  type: number = WAL_RECORD_TYPE.MESSAGE_APPEND,
  conversationId: string = "conv-001",
  overrides: Record<string, unknown> = {},
): ConversationWalRecord {
  return {
    type: type as ConversationWalRecord["type"],
    message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: conversationId,
    timestamp: Date.now(),
    payload: { role: "user", content: "hello", ...overrides },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationWal", () => {
  let wal: ConversationWal

  beforeEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
    wal = new ConversationWal({ dataDir: TEST_DATA_DIR })
  })

  afterEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // append + replay round-trip
  // -------------------------------------------------------------------------

  it("appends and replays a single record", () => {
    const record = makeRecord()
    wal.append(record)

    const replayed = [...wal.replaySync(record.conversation_id)]
    expect(replayed).toHaveLength(1)
    expect(replayed[0].message_id).toBe(record.message_id)
    expect(replayed[0].conversation_id).toBe(record.conversation_id)
    expect(replayed[0].type).toBe(WAL_RECORD_TYPE.MESSAGE_APPEND)
  })

  it("appends and replays multiple records in order", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord(WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-multi", { index: i }),
    )

    for (const r of records) wal.append(r)

    const replayed = [...wal.replaySync("conv-multi")]
    expect(replayed).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(replayed[i].message_id).toBe(records[i].message_id)
    }
  })

  it("supports all four record types", () => {
    const types = [
      WAL_RECORD_TYPE.CREATE,
      WAL_RECORD_TYPE.MESSAGE_APPEND,
      WAL_RECORD_TYPE.SUMMARY_UPDATE,
      WAL_RECORD_TYPE.SNAPSHOT,
    ]

    for (const type of types) {
      wal.append(makeRecord(type, "conv-types"))
    }

    const replayed = [...wal.replaySync("conv-types")]
    expect(replayed).toHaveLength(4)
    expect(replayed.map((r) => r.type)).toEqual(types)
  })

  // -------------------------------------------------------------------------
  // Binary framing verification
  // -------------------------------------------------------------------------

  it("produces valid binary framing: [4B len][1B type][payload][4B CRC32]", () => {
    const record = makeRecord(WAL_RECORD_TYPE.CREATE, "conv-binary")
    wal.append(record)

    // Find the segment file
    const convDir = join(TEST_DATA_DIR, "conversation-wal", "conv-binary")
    expect(existsSync(convDir)).toBe(true)

    const files = require("node:fs").readdirSync(convDir) as string[]
    expect(files.length).toBeGreaterThan(0)
    const segPath = join(convDir, files[0])
    const raw = readFileSync(segPath)

    // Parse header
    const payloadLen = raw.readUInt32BE(0)
    const recordType = raw.readUInt8(4)
    expect(recordType).toBe(WAL_RECORD_TYPE.CREATE)

    // Verify total record size
    expect(raw.length).toBe(5 + payloadLen + 4) // header + payload + CRC

    // Verify CRC32
    const crcInput = raw.subarray(4, 5 + payloadLen)
    const computedCrc = computeCrc32(crcInput)
    const storedCrc = raw.readUInt32BE(5 + payloadLen)
    expect(storedCrc).toBe(computedCrc)

    // Verify payload is valid JSON
    const payloadBuf = raw.subarray(5, 5 + payloadLen)
    const parsed = JSON.parse(payloadBuf.toString("utf-8"))
    expect(parsed.message_id).toBe(record.message_id)
    expect(parsed.conversation_id).toBe("conv-binary")
  })

  // -------------------------------------------------------------------------
  // CRC32 integrity
  // -------------------------------------------------------------------------

  it("computeCrc32 produces consistent results", () => {
    const buf = Buffer.from("hello world")
    const crc1 = computeCrc32(buf)
    const crc2 = computeCrc32(buf)
    expect(crc1).toBe(crc2)
    // Known CRC32 for "hello world"
    expect(crc1).toBe(0x0d4a1185)
  })

  it("detects CRC mismatch on corrupted data", () => {
    const record = makeRecord(WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-corrupt")
    wal.append(record)

    // Corrupt one byte of the payload
    const convDir = join(TEST_DATA_DIR, "conversation-wal", "conv-corrupt")
    const files = require("node:fs").readdirSync(convDir) as string[]
    const segPath = join(convDir, files[0])
    const raw = readFileSync(segPath)

    // Flip a byte in the payload region
    const corrupted = Buffer.from(raw)
    corrupted[10] = corrupted[10] ^ 0xff
    require("node:fs").writeFileSync(segPath, corrupted)

    // Replay should yield 0 records (CRC mismatch stops replay)
    const replayed = [...wal.replaySync("conv-corrupt")]
    expect(replayed).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Idempotent replay
  // -------------------------------------------------------------------------

  it("skips duplicate message_ids with seenIds", () => {
    const record = makeRecord(WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-idemp")
    // Append same record twice
    wal.append(record)
    wal.append(record)

    const seenIds = new Set<string>()
    const replayed = [...wal.replaySync("conv-idemp", seenIds)]
    // Only first should be yielded
    expect(replayed).toHaveLength(1)
    expect(seenIds.has(record.message_id)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Per-conversation isolation
  // -------------------------------------------------------------------------

  it("isolates WAL files per conversation", () => {
    wal.append(makeRecord(WAL_RECORD_TYPE.CREATE, "conv-a"))
    wal.append(makeRecord(WAL_RECORD_TYPE.CREATE, "conv-b"))
    wal.append(makeRecord(WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-a"))

    const replayA = [...wal.replaySync("conv-a")]
    const replayB = [...wal.replaySync("conv-b")]

    expect(replayA).toHaveLength(2)
    expect(replayB).toHaveLength(1)
  })

  it("replays all conversations when no ID specified", () => {
    wal.append(makeRecord(WAL_RECORD_TYPE.CREATE, "conv-x"))
    wal.append(makeRecord(WAL_RECORD_TYPE.CREATE, "conv-y"))

    const all = [...wal.replaySync()]
    expect(all).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // getConversationIds
  // -------------------------------------------------------------------------

  it("lists all conversation IDs", () => {
    wal.append(makeRecord(WAL_RECORD_TYPE.CREATE, "conv-alpha"))
    wal.append(makeRecord(WAL_RECORD_TYPE.CREATE, "conv-beta"))

    const ids = wal.getConversationIds()
    expect(ids.sort()).toEqual(["conv-alpha", "conv-beta"])
  })

  // -------------------------------------------------------------------------
  // Segment rotation
  // -------------------------------------------------------------------------

  it("rotates segments when max size exceeded", () => {
    // Use tiny segment size to force rotation
    const tinyWal = new ConversationWal({ dataDir: TEST_DATA_DIR, segmentMaxBytes: 100 })

    for (let i = 0; i < 5; i++) {
      tinyWal.append(makeRecord(WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-rotate", { content: "x".repeat(50) }))
    }

    const convDir = join(TEST_DATA_DIR, "conversation-wal", "conv-rotate")
    const files = require("node:fs").readdirSync(convDir) as string[]
    expect(files.length).toBeGreaterThan(1) // Should have rotated

    // All records should still replay correctly
    const replayed = [...tinyWal.replaySync("conv-rotate")]
    expect(replayed).toHaveLength(5)
  })

  // -------------------------------------------------------------------------
  // truncateCorrupt
  // -------------------------------------------------------------------------

  it("truncates corrupt tail and preserves valid records", () => {
    // Append 3 valid records
    for (let i = 0; i < 3; i++) {
      wal.append(makeRecord(WAL_RECORD_TYPE.MESSAGE_APPEND, "conv-trunc"))
    }

    // Append garbage to the end of the segment
    const convDir = join(TEST_DATA_DIR, "conversation-wal", "conv-trunc")
    const files = require("node:fs").readdirSync(convDir) as string[]
    const segPath = join(convDir, files[0])
    const fd = require("node:fs").openSync(segPath, "a")
    require("node:fs").writeSync(fd, Buffer.from("GARBAGE_DATA_12345"))
    require("node:fs").closeSync(fd)

    // truncateCorrupt should remove the garbage
    const truncated = wal.truncateCorrupt("conv-trunc")
    expect(truncated).toBeGreaterThan(0)

    // All 3 valid records should still replay
    const replayed = [...wal.replaySync("conv-trunc")]
    expect(replayed).toHaveLength(3)
  })

  it("returns 0 for conversation with no corrupt data", () => {
    wal.append(makeRecord(WAL_RECORD_TYPE.CREATE, "conv-clean"))
    const truncated = wal.truncateCorrupt("conv-clean")
    expect(truncated).toBe(0)
  })

  it("returns 0 for non-existent conversation", () => {
    const truncated = wal.truncateCorrupt("conv-nonexistent")
    expect(truncated).toBe(0)
  })

  // -------------------------------------------------------------------------
  // WAL directory path
  // -------------------------------------------------------------------------

  it("exposes walDir via directory getter", () => {
    expect(wal.directory).toBe(join(TEST_DATA_DIR, "conversation-wal"))
  })
})
