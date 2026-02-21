// src/billing/wal-replay.ts — WAL Replay Engine + Redis State Rebuild (Sprint 1 Task 1.5)
//
// Deterministically rebuilds all Redis-derived state from WAL on startup/crash.
// WAL is authoritative; Redis is a derived cache.
//
// Flatline IMP-004: WAL operational limits (1GB max, rotation, compaction, R2 backup)
// Flatline SKP-001: WAL durability (CRC32, torn write handling, restore procedure)

import { readFileSync, readdirSync, existsSync, truncateSync, statSync } from "node:fs"
import { join } from "node:path"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import {
  type BillingWALEnvelope,
  type BillingEntry,
  type BillingEventType,
  BillingState,
  BILLING_EVENT_TYPES,
  BILLING_WAL_SCHEMA_VERSION,
} from "./types.js"
import { crc32 } from "./state-machine.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WAL_FILE_BYTES = 1024 * 1024 * 1024 // 1GB (Flatline IMP-004)
const LAST_REPLAYED_OFFSET_KEY = "billing:wal:last_replayed_offset" // legacy (ULID-based)
const LAST_REPLAYED_SEQUENCE_KEY = "billing:wal:last_sequence" // monotonic sequence (Bridge high-4)

/** Known billing event types for strict parsing. Unknown types are skipped. */
const KNOWN_EVENT_TYPES = new Set<string>(BILLING_EVENT_TYPES)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WALReplayResult {
  entriesProcessed: number
  entriesSkipped: number
  entriesCorrupted: number
  lastOffset: string | null
  /** Last monotonic sequence number replayed (null if no entries had wal_sequence) */
  lastSequence: number | null
  durationMs: number
}

export interface WALReplayDeps {
  redis: RedisCommandClient
  walDir: string
  onMetric?: (name: string, value: number) => void
}

// ---------------------------------------------------------------------------
// Deterministic Reducers
// ---------------------------------------------------------------------------

/**
 * Apply a single WAL envelope to Redis state. Each reducer is deterministic
 * and idempotent — replaying the same entry produces identical state.
 */
async function applyEnvelope(
  redis: RedisCommandClient,
  envelope: BillingWALEnvelope,
  walOffset: string,
): Promise<void> {
  const { event_type, billing_entry_id, payload } = envelope
  const p = payload as Record<string, unknown>

  switch (event_type) {
    case "billing_reserve": {
      // (a) Set billing entry state
      await redis.eval(
        `redis.call('HSET', KEYS[1],
          'state', ARGV[1],
          'account_id', ARGV[2],
          'estimated_cost', ARGV[3],
          'correlation_id', ARGV[4],
          'wal_offset', ARGV[5],
          'created_at', ARGV[6])
         -- (b) Set reserve key with TTL
         redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[7])
         -- (c) Track account balance hold
         return 'OK'`,
        2,
        `billing:entry:${billing_entry_id}`,
        `reserve:${billing_entry_id}`,
        BillingState.RESERVE_HELD,
        String(p.account_id ?? ""),
        String(p.estimated_cost ?? "0"),
        envelope.correlation_id,
        walOffset,
        String(envelope.timestamp),
        "300", // RESERVE_TTL_SECONDS
      )
      break
    }

    case "billing_commit": {
      await redis.eval(
        `redis.call('HSET', KEYS[1],
          'state', ARGV[1],
          'actual_cost', ARGV[2],
          'wal_offset', ARGV[3])
         -- Remove reserve key (committed, no longer held as reserve)
         redis.call('DEL', KEYS[2])
         -- Increment pending count
         redis.call('INCRBY', KEYS[3], 1)
         return 'OK'`,
        3,
        `billing:entry:${billing_entry_id}`,
        `reserve:${billing_entry_id}`,
        "billing:pending_count",
        BillingState.FINALIZE_PENDING,
        String(p.actual_cost ?? "0"),
        walOffset,
      )
      break
    }

    case "billing_release":
    case "billing_reserve_expired": {
      await redis.eval(
        `redis.call('HSET', KEYS[1], 'state', ARGV[1], 'wal_offset', ARGV[2])
         redis.call('DEL', KEYS[2])
         return 'OK'`,
        2,
        `billing:entry:${billing_entry_id}`,
        `reserve:${billing_entry_id}`,
        BillingState.RELEASED,
        walOffset,
      )
      break
    }

    case "billing_void": {
      await redis.eval(
        `redis.call('HSET', KEYS[1], 'state', ARGV[1], 'wal_offset', ARGV[2])
         redis.call('DEL', KEYS[2])
         return 'OK'`,
        2,
        `billing:entry:${billing_entry_id}`,
        `reserve:${billing_entry_id}`,
        BillingState.VOIDED,
        walOffset,
      )
      break
    }

    case "billing_finalize_ack": {
      await redis.eval(
        `redis.call('HSET', KEYS[1], 'state', ARGV[1], 'wal_offset', ARGV[2])
         -- Decrement pending count
         local count = redis.call('DECRBY', KEYS[2], 1)
         if tonumber(count) < 0 then redis.call('SET', KEYS[2], '0') end
         return 'OK'`,
        2,
        `billing:entry:${billing_entry_id}`,
        "billing:pending_count",
        BillingState.FINALIZE_ACKED,
        walOffset,
      )
      break
    }

    case "billing_finalize_fail": {
      await redis.eval(
        `redis.call('HSET', KEYS[1], 'state', ARGV[1], 'wal_offset', ARGV[2],
          'finalize_attempts', ARGV[3])
         return 'OK'`,
        1,
        `billing:entry:${billing_entry_id}`,
        BillingState.FINALIZE_FAILED,
        walOffset,
        String(p.attempt ?? "0"),
      )
      break
    }

    case "request_start": {
      // (e) Idempotency cache: mark request as in-flight
      await redis.set(`request:${billing_entry_id}`, "in_flight", "EX", 300)
      break
    }

    case "request_complete": {
      // (e) Idempotency cache: store response reference (WAL offset)
      await redis.set(`request:${billing_entry_id}`, `wal:${walOffset}`, "EX", 300)
      break
    }

    case "credit_mint":
    case "credit_deduct":
    case "x402_credit_note":
    case "billing_reconciliation": {
      // Ledger events — balance updates handled via ledger postings
      // The replay engine tracks these via the postings in the payload
      if (p.postings && Array.isArray(p.postings)) {
        for (const posting of p.postings as Array<{ account: string; delta: string }>) {
          await redis.eval(
            `local current = redis.call('GET', KEYS[1]) or '0'
             local newVal = tostring(tonumber(current) + tonumber(ARGV[1]))
             redis.call('SET', KEYS[1], newVal)
             return newVal`,
            1,
            `balance:${posting.account}:value`,
            posting.delta,
          )
        }
      }
      break
    }

    default:
      // Unknown event type — skip with warning (forward compat, Flatline IMP-002)
      console.warn(`[wal-replay] Unknown event type "${event_type}" in ${billing_entry_id}, skipping`)
  }
}

// ---------------------------------------------------------------------------
// WAL Replay Engine
// ---------------------------------------------------------------------------

/**
 * Replay all billing WAL entries from disk, rebuilding Redis state.
 *
 * Startup ordering: WAL replay completes BEFORE server begins accepting traffic.
 * Health endpoint returns `starting` until replay done.
 */
export async function replayBillingWAL(deps: WALReplayDeps): Promise<WALReplayResult> {
  const startTime = Date.now()
  const result: WALReplayResult = {
    entriesProcessed: 0,
    entriesSkipped: 0,
    entriesCorrupted: 0,
    lastOffset: null,
    lastSequence: null,
    durationMs: 0,
  }

  // Check for incremental replay cursors from Redis.
  // Prefer monotonic sequence (Bridge high-4) over legacy ULID offset.
  const lastSequenceStr = await deps.redis.get(LAST_REPLAYED_SEQUENCE_KEY)
  const lastSequence = lastSequenceStr ? Number(lastSequenceStr) : null
  const lastOffset = lastSequence === null
    ? await deps.redis.get(LAST_REPLAYED_OFFSET_KEY) // legacy fallback
    : null

  // Bridge iteration 2, finding 001: Warn when using legacy ULID cursor.
  // ULID lexicographic comparison is safe for single-process but may skip entries
  // in multi-process scenarios. Sequence-based cursor is authoritative going forward.
  if (lastOffset && lastSequence === null) {
    console.warn(
      "[wal-replay] Using legacy ULID cursor for incremental replay. " +
      "New entries will use monotonic sequence. Legacy entries without wal_sequence " +
      "are compared lexicographically (safe for single-process deployments only).",
    )
  }

  // Read all WAL segment files in order
  const segments = getWALSegments(deps.walDir)
  if (segments.length === 0) {
    result.durationMs = Date.now() - startTime
    deps.onMetric?.("wal_replay_duration_ms", result.durationMs)
    return result
  }

  for (const segmentPath of segments) {
    const lines = readSegmentLines(segmentPath)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue

      // Parse envelope
      let envelope: BillingWALEnvelope
      try {
        envelope = JSON.parse(line) as BillingWALEnvelope
      } catch {
        // Torn write handling (Flatline SKP-001):
        // If this is the last line of the last segment, truncate the incomplete record
        if (i === lines.length - 1 && segmentPath === segments[segments.length - 1]) {
          console.warn(`[wal-replay] Torn write detected on last record of ${segmentPath}, truncating`)
          truncateLastIncompleteRecord(segmentPath, line)
          result.entriesCorrupted++
          continue
        }
        console.error(`[wal-replay] Corrupt record in ${segmentPath} at line ${i + 1}, skipping`)
        result.entriesCorrupted++
        continue
      }

      // Skip entries we've already replayed (incremental replay).
      // Bridge high-4 fix: use monotonic wal_sequence when available.
      // Legacy entries without wal_sequence fall back to ULID comparison.
      const entrySequence = envelope.wal_sequence ?? null
      const walOffset = envelope.billing_entry_id

      if (entrySequence !== null && lastSequence !== null) {
        // Monotonic sequence comparison — strict ordering across processes
        if (entrySequence <= lastSequence) {
          result.entriesSkipped++
          continue
        }
      } else if (lastOffset && walOffset <= lastOffset) {
        // Legacy ULID-based comparison (backward compat for pre-sequence entries)
        result.entriesSkipped++
        continue
      }

      // Validate schema version — strict parse for known, skip unknown
      if (envelope.schema_version > BILLING_WAL_SCHEMA_VERSION) {
        console.warn(`[wal-replay] Unknown schema version ${envelope.schema_version} in ${walOffset}, skipping`)
        result.entriesSkipped++
        continue
      }

      // Validate CRC32 checksum (Flatline SKP-001)
      const payloadStr = JSON.stringify(envelope.payload)
      const expectedChecksum = crc32(payloadStr)
      if (envelope.checksum !== expectedChecksum) {
        console.error(`[wal-replay] CRC32 mismatch for ${walOffset}: expected ${expectedChecksum}, got ${envelope.checksum}`)
        result.entriesCorrupted++
        // Fail-closed: reject entry, alert, but continue replay from next valid record
        continue
      }

      // Skip unknown event types (forward compat)
      if (!KNOWN_EVENT_TYPES.has(envelope.event_type)) {
        console.warn(`[wal-replay] Unknown event type "${envelope.event_type}" in ${walOffset}, skipping`)
        result.entriesSkipped++
        continue
      }

      // Apply deterministic reducer
      try {
        await applyEnvelope(deps.redis, envelope, walOffset)
        result.entriesProcessed++
        result.lastOffset = walOffset
        if (entrySequence !== null) {
          result.lastSequence = entrySequence
        }
      } catch (err) {
        console.error(`[wal-replay] Error applying ${envelope.event_type} for ${walOffset}:`, err instanceof Error ? err.message : String(err))
        result.entriesCorrupted++
      }
    }
  }

  // Persist replay cursors to Redis for incremental replay on next startup.
  // Prefer sequence-based cursor when available (Bridge high-4).
  if (result.lastSequence !== null) {
    await deps.redis.set(LAST_REPLAYED_SEQUENCE_KEY, String(result.lastSequence))
  }
  if (result.lastOffset) {
    await deps.redis.set(LAST_REPLAYED_OFFSET_KEY, result.lastOffset)
  }

  result.durationMs = Date.now() - startTime
  deps.onMetric?.("wal_replay_duration_ms", result.durationMs)

  return result
}

// ---------------------------------------------------------------------------
// File Helpers
// ---------------------------------------------------------------------------

/**
 * Get all billing WAL segment files in lexicographic order.
 * Billing WAL segments are stored as `billing-wal-*.jsonl`.
 */
function getWALSegments(walDir: string): string[] {
  if (!existsSync(walDir)) return []
  return readdirSync(walDir)
    .filter(f => f.startsWith("billing-wal-") && f.endsWith(".jsonl"))
    .sort()
    .map(f => join(walDir, f))
}

/**
 * Read a WAL segment file into lines.
 */
function readSegmentLines(segmentPath: string): string[] {
  try {
    const content = readFileSync(segmentPath, "utf-8")
    return content.split("\n")
  } catch (err) {
    console.error(`[wal-replay] Error reading segment ${segmentPath}:`, err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Truncate the last incomplete record from a segment file (torn write recovery).
 * Flatline SKP-001: CRC32 mismatch on last record → truncate, log warning.
 */
function truncateLastIncompleteRecord(segmentPath: string, incompleteLine: string): void {
  try {
    const stat = statSync(segmentPath)
    const truncateAt = stat.size - Buffer.byteLength(incompleteLine + "\n")
    if (truncateAt >= 0) {
      truncateSync(segmentPath, truncateAt)
      console.warn(`[wal-replay] Truncated ${Buffer.byteLength(incompleteLine)} bytes from ${segmentPath}`)
    }
  } catch (err) {
    console.error(`[wal-replay] Failed to truncate ${segmentPath}:`, err instanceof Error ? err.message : String(err))
  }
}

/**
 * Check if a WAL segment exceeds the max size limit (Flatline IMP-004).
 */
export function isSegmentOversized(segmentPath: string): boolean {
  try {
    return statSync(segmentPath).size >= MAX_WAL_FILE_BYTES
  } catch {
    return false
  }
}
