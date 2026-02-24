// src/nft/conversation-wal.ts — Binary WAL for Conversation Durability (T1.1)
//
// Length-prefixed, CRC32-checksummed WAL records with message_id for
// idempotent replay. Binary format: [4B length][1B type][payload][4B CRC32]
//
// This is separate from src/persistence/wal.ts (JSONL general WAL).

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  ftruncateSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { monotonicFactory } from "ulid"

const ulid = monotonicFactory()

// ---------------------------------------------------------------------------
// Record Types (SDD §3.3.1)
// ---------------------------------------------------------------------------

export const WAL_RECORD_TYPE = {
  CREATE: 0x01,
  MESSAGE_APPEND: 0x02,
  SUMMARY_UPDATE: 0x03,
  SNAPSHOT: 0x04,
} as const

export type WalRecordType = (typeof WAL_RECORD_TYPE)[keyof typeof WAL_RECORD_TYPE]

const VALID_RECORD_TYPES = new Set<number>(Object.values(WAL_RECORD_TYPE))

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3 polynomial)
// ---------------------------------------------------------------------------

const CRC32_TABLE = new Uint32Array(256)
;(function buildTable() {
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    CRC32_TABLE[i] = crc >>> 0
  }
})()

export function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationWalRecord {
  type: WalRecordType
  message_id: string
  conversation_id: string
  timestamp: number
  payload: Record<string, unknown>
}

export interface ConversationWalConfig {
  /** Base data directory (e.g., /data or ./data) */
  dataDir: string
  /** Max bytes per WAL file before rotation. Default: 10MB */
  segmentMaxBytes?: number
}

/** Header: [4B length][1B type] = 5 bytes. Footer: [4B CRC32] = 4 bytes */
const HEADER_SIZE = 5
const FOOTER_SIZE = 4
const SEGMENT_MAX_BYTES_DEFAULT = 10 * 1024 * 1024

/** Strict ID pattern — prevents path traversal in filesystem operations */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

// ---------------------------------------------------------------------------
// Conversation WAL
// ---------------------------------------------------------------------------

export class ConversationWal {
  private readonly walDir: string
  private readonly segmentMaxBytes: number

  constructor(config: ConversationWalConfig) {
    this.walDir = join(config.dataDir, "conversation-wal")
    this.segmentMaxBytes = config.segmentMaxBytes ?? SEGMENT_MAX_BYTES_DEFAULT
    mkdirSync(this.walDir, { recursive: true })
  }

  /**
   * Append a record to the WAL for a specific conversation.
   * Synchronous with fsync for durability — THROWS on failure.
   */
  append(record: ConversationWalRecord): void {
    const convDir = this.conversationDir(record.conversation_id)
    mkdirSync(convDir, { recursive: true })

    // Serialize payload to JSON
    const payloadObj = {
      message_id: record.message_id,
      conversation_id: record.conversation_id,
      timestamp: record.timestamp,
      ...record.payload,
    }
    const payloadBuf = Buffer.from(JSON.stringify(payloadObj), "utf-8")

    // Build binary record: [4B length][1B type][payload][4B CRC32]
    const totalPayloadLen = payloadBuf.length
    const recordBuf = Buffer.allocUnsafe(HEADER_SIZE + totalPayloadLen + FOOTER_SIZE)

    // Header
    recordBuf.writeUInt32BE(totalPayloadLen, 0)
    recordBuf.writeUInt8(record.type, 4)

    // Payload
    payloadBuf.copy(recordBuf, HEADER_SIZE)

    // CRC32 over type + payload
    const crcInput = recordBuf.subarray(4, HEADER_SIZE + totalPayloadLen)
    const crc = computeCrc32(crcInput)
    recordBuf.writeUInt32BE(crc, HEADER_SIZE + totalPayloadLen)

    // Find or create current segment
    const segPath = this.getCurrentSegment(convDir)

    // Atomic append with fsync
    const fd = openSync(segPath, "a")
    try {
      writeSync(fd, recordBuf)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Replay WAL records for a conversation (or all conversations).
   * Skips records with CRC32 mismatch (torn tail detection).
   * If seenIds is provided, skips records already in the set (idempotent replay).
   */
  *replaySync(
    conversationId?: string,
    seenIds?: Set<string>,
  ): Generator<ConversationWalRecord> {
    const dirs = conversationId
      ? [this.conversationDir(conversationId)]
      : this.listConversationDirs()

    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      const segments = this.getSegments(dir)

      for (const segPath of segments) {
        yield* this.replaySegment(segPath, seenIds)
      }
    }
  }

  /**
   * Get all conversation IDs that have WAL data.
   */
  getConversationIds(): string[] {
    if (!existsSync(this.walDir)) return []
    return readdirSync(this.walDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  }

  /**
   * Truncate corrupt tail from a segment file.
   * Called during recovery to handle torn writes.
   */
  truncateCorrupt(conversationId: string): number {
    const convDir = this.conversationDir(conversationId)
    if (!existsSync(convDir)) return 0

    let totalTruncated = 0
    const segments = this.getSegments(convDir)

    for (const segPath of segments) {
      const truncated = this.truncateSegment(segPath)
      totalTruncated += truncated
    }

    return totalTruncated
  }

  /** Get the WAL directory path */
  get directory(): string {
    return this.walDir
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Validate and return conversation directory path. Rejects path traversal. */
  private conversationDir(conversationId: string): string {
    if (!SAFE_ID_PATTERN.test(conversationId)) {
      throw new Error(`Invalid conversation ID: contains unsafe characters`)
    }
    return join(this.walDir, conversationId)
  }

  private listConversationDirs(): string[] {
    if (!existsSync(this.walDir)) return []
    return readdirSync(this.walDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(this.walDir, d.name))
  }

  private getSegments(dir: string): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.startsWith("wal-") && f.endsWith(".bin"))
      .sort()
      .map((f) => join(dir, f))
  }

  private getCurrentSegment(convDir: string): string {
    const segments = this.getSegments(convDir)
    if (segments.length > 0) {
      const last = segments[segments.length - 1]
      try {
        const size = statSync(last).size
        if (size < this.segmentMaxBytes) return last
      } catch {
        // Fall through to create new
      }
    }
    return join(convDir, `wal-${ulid()}.bin`)
  }

  private *replaySegment(
    segPath: string,
    seenIds?: Set<string>,
  ): Generator<ConversationWalRecord> {
    let fd: number
    try {
      fd = openSync(segPath, "r")
    } catch {
      return
    }

    try {
      const fileSize = statSync(segPath).size
      let offset = 0

      while (offset + HEADER_SIZE + FOOTER_SIZE <= fileSize) {
        // Read header: [4B length][1B type]
        const headerBuf = Buffer.allocUnsafe(HEADER_SIZE)
        const headerRead = readSync(fd, headerBuf, 0, HEADER_SIZE, offset)
        if (headerRead < HEADER_SIZE) break

        const payloadLen = headerBuf.readUInt32BE(0)
        const recordType = headerBuf.readUInt8(4)

        // Sanity check payload length
        if (payloadLen === 0 || payloadLen > 10 * 1024 * 1024) break
        if (offset + HEADER_SIZE + payloadLen + FOOTER_SIZE > fileSize) break

        // Read payload
        const payloadBuf = Buffer.allocUnsafe(payloadLen)
        const payloadRead = readSync(fd, payloadBuf, 0, payloadLen, offset + HEADER_SIZE)
        if (payloadRead < payloadLen) break

        // Read CRC32
        const crcBuf = Buffer.allocUnsafe(FOOTER_SIZE)
        const crcRead = readSync(fd, crcBuf, 0, FOOTER_SIZE, offset + HEADER_SIZE + payloadLen)
        if (crcRead < FOOTER_SIZE) break

        const storedCrc = crcBuf.readUInt32BE(0)

        // Verify CRC32 over type + payload
        const crcInput = Buffer.allocUnsafe(1 + payloadLen)
        crcInput.writeUInt8(recordType, 0)
        payloadBuf.copy(crcInput, 1)
        const computedCrc = computeCrc32(crcInput)

        if (storedCrc !== computedCrc) {
          // CRC mismatch — torn tail, stop replaying this segment
          break
        }

        // Validate record type
        if (!VALID_RECORD_TYPES.has(recordType)) {
          offset += HEADER_SIZE + payloadLen + FOOTER_SIZE
          continue
        }

        // Parse payload
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(payloadBuf.toString("utf-8"))
        } catch {
          offset += HEADER_SIZE + payloadLen + FOOTER_SIZE
          continue
        }

        const messageId = String(parsed.message_id ?? "")

        // Idempotent: skip if already seen
        if (seenIds && messageId && seenIds.has(messageId)) {
          offset += HEADER_SIZE + payloadLen + FOOTER_SIZE
          continue
        }

        if (seenIds && messageId) {
          seenIds.add(messageId)
        }

        yield {
          type: recordType as WalRecordType,
          message_id: messageId,
          conversation_id: String(parsed.conversation_id ?? ""),
          timestamp: Number(parsed.timestamp ?? 0),
          payload: parsed,
        }

        offset += HEADER_SIZE + payloadLen + FOOTER_SIZE
      }
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Truncate a segment file at the last valid record boundary.
   * Returns the number of bytes truncated.
   */
  private truncateSegment(segPath: string): number {
    let fd: number
    try {
      fd = openSync(segPath, "r+")
    } catch {
      return 0
    }

    try {
      const fileSize = statSync(segPath).size
      let offset = 0
      let lastValidOffset = 0

      while (offset + HEADER_SIZE + FOOTER_SIZE <= fileSize) {
        const headerBuf = Buffer.allocUnsafe(HEADER_SIZE)
        const headerRead = readSync(fd, headerBuf, 0, HEADER_SIZE, offset)
        if (headerRead < HEADER_SIZE) break

        const payloadLen = headerBuf.readUInt32BE(0)
        if (payloadLen === 0 || payloadLen > 10 * 1024 * 1024) break
        if (offset + HEADER_SIZE + payloadLen + FOOTER_SIZE > fileSize) break

        const payloadBuf = Buffer.allocUnsafe(payloadLen)
        const payloadRead = readSync(fd, payloadBuf, 0, payloadLen, offset + HEADER_SIZE)
        if (payloadRead < payloadLen) break

        const crcBuf = Buffer.allocUnsafe(FOOTER_SIZE)
        const crcRead = readSync(fd, crcBuf, 0, FOOTER_SIZE, offset + HEADER_SIZE + payloadLen)
        if (crcRead < FOOTER_SIZE) break

        const storedCrc = crcBuf.readUInt32BE(0)
        const crcInput = Buffer.allocUnsafe(1 + payloadLen)
        crcInput.writeUInt8(headerBuf.readUInt8(4), 0)
        payloadBuf.copy(crcInput, 1)
        const computedCrc = computeCrc32(crcInput)

        if (storedCrc !== computedCrc) break

        offset += HEADER_SIZE + payloadLen + FOOTER_SIZE
        lastValidOffset = offset
      }

      const truncated = fileSize - lastValidOffset
      if (truncated > 0) {
        ftruncateSync(fd, lastValidOffset)
        fsyncSync(fd)
      }

      return truncated
    } finally {
      closeSync(fd)
    }
  }
}
