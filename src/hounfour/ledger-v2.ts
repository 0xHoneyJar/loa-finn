// src/hounfour/ledger-v2.ts — JSONL Ledger V2 (SDD §4.3, Task A.3 part 2a)
// Per-tenant JSONL files with integer micro-USD, CRC32 integrity, single-writer queue.

import {
  appendFileSync, existsSync, openSync, closeSync, fdatasyncSync,
  mkdirSync, readdirSync, renameSync, statSync, readFileSync,
} from "node:fs"
import { readFile, readdir, mkdir, rename, stat, writeFile, rm } from "node:fs/promises"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { createGzip } from "node:zlib"
import { pipeline } from "node:stream/promises"
import { createReadStream, createWriteStream } from "node:fs"
import type { LedgerEntryV2 } from "./types.js"

// --- CRC32 ---

const CRC32_TABLE = buildCrc32Table()

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1)
    }
    table[i] = crc >>> 0
  }
  return table
}

/** Compute CRC32 of a UTF-8 string. Returns lowercase hex. */
export function crc32(input: string): string {
  const buf = Buffer.from(input, "utf8")
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, "0")
}

/** Verify CRC32 of a ledger entry. Returns true if valid. */
export function verifyCrc32(entry: LedgerEntryV2): boolean {
  if (!entry.crc32) return false
  const expected = entry.crc32
  const clone = { ...entry }
  delete clone.crc32
  return crc32(JSON.stringify(clone)) === expected
}

/** Stamp a CRC32 on an entry (mutates and returns). */
export function stampCrc32(entry: LedgerEntryV2): LedgerEntryV2 {
  const clone = { ...entry }
  delete clone.crc32
  clone.crc32 = crc32(JSON.stringify(clone))
  return clone
}

// --- Config ---

export interface LedgerV2Config {
  /** Base directory for ledger files. Default: "data/ledger" */
  baseDir: string
  /** Enable fdatasync after each write. Default: true in production. */
  fsync: boolean
  /** Daily rotation: compress old files after N days. Default: 1 (daily). */
  rotationAgeDays: number
  /** Retention: delete compressed archives after N days. Default: 90. */
  retentionDays: number
  /** Max entry size in bytes. Entries > 4096 bytes are rejected. */
  maxEntryBytes: number
}

export const DEFAULT_LEDGER_V2_CONFIG: LedgerV2Config = {
  baseDir: "data/ledger",
  fsync: process.env.NODE_ENV === "production" || process.env.LEDGER_FSYNC === "true",
  rotationAgeDays: 1,
  retentionDays: 90,
  maxEntryBytes: 4096,
}

// --- Recovery ---

export interface RecoveryResult {
  entriesRecovered: number
  linesTruncated: number
  corruptedEntries: number
}

// --- Recompute ---

export interface RecomputeResult {
  totalEntries: number
  duplicatesRemoved: number
  totalCostMicro: bigint
}

// --- Ledger V2 ---

export class LedgerV2 {
  private config: LedgerV2Config
  /** Per-tenant write mutex: serializes all writes to avoid interleaving. */
  private tenantMutex = new Map<string, Promise<void>>()

  constructor(config: Partial<LedgerV2Config> = {}) {
    this.config = { ...DEFAULT_LEDGER_V2_CONFIG, ...config }
  }

  // --- Core Operations ---

  /**
   * Append a v2 ledger entry for a tenant.
   * Single-writer queue ensures no concurrent appends to the same file.
   * Entry is stamped with CRC32 before writing.
   */
  async append(tenantId: string, entry: LedgerEntryV2): Promise<void> {
    validateTenantId(tenantId)

    // Stamp CRC32
    const stamped = stampCrc32(entry)
    const line = JSON.stringify(stamped) + "\n"

    // Reject oversized entries (must fit in single O_APPEND write for atomicity)
    const lineBytes = Buffer.byteLength(line, "utf8")
    if (lineBytes > this.config.maxEntryBytes) {
      throw new Error(
        `LEDGER_ENTRY_TOO_LARGE: entry is ${lineBytes} bytes (max ${this.config.maxEntryBytes})`
      )
    }

    // Enqueue write in per-tenant mutex
    const prev = this.tenantMutex.get(tenantId) ?? Promise.resolve()
    const next = prev.then(() => this.doAppend(tenantId, line))
    this.tenantMutex.set(tenantId, next.catch(() => { /* swallow to keep chain alive */ }))
    await next
  }

  /**
   * Recover a tenant's ledger file on startup.
   * Detects and truncates partial/malformed last line.
   * Returns recovery statistics.
   */
  async recover(tenantId: string): Promise<RecoveryResult> {
    validateTenantId(tenantId)
    const filePath = this.tenantFilePath(tenantId)

    if (!existsSync(filePath)) {
      return { entriesRecovered: 0, linesTruncated: 0, corruptedEntries: 0 }
    }

    const raw = await readFile(filePath, "utf8")
    const lines = raw.split("\n")
    const validLines: string[] = []
    let linesTruncated = 0
    let corruptedEntries = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line === "") continue

      try {
        const entry = JSON.parse(line) as LedgerEntryV2
        if (entry.schema_version !== 2) {
          corruptedEntries++
          continue
        }
        // Verify CRC32 if present
        if (entry.crc32 && !verifyCrc32(entry)) {
          corruptedEntries++
          console.warn(`[ledger-v2] CRC32 mismatch at line ${i + 1} for tenant ${tenantId}`)
          continue
        }
        validLines.push(line)
      } catch {
        // Malformed JSON — likely a partial write
        if (i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1].trim() === "")) {
          // Last line: truncate (partial write from crash)
          linesTruncated++
          console.warn(`[ledger-v2] Truncated partial line at end of ${filePath}`)
        } else {
          // Mid-file corruption
          corruptedEntries++
          console.warn(`[ledger-v2] Corrupted entry at line ${i + 1} for tenant ${tenantId}`)
        }
      }
    }

    // Rewrite file with only valid entries
    if (linesTruncated > 0 || corruptedEntries > 0) {
      const content = validLines.length > 0 ? validLines.join("\n") + "\n" : ""
      await writeFile(filePath, content, "utf8")
      console.log(`[ledger-v2] Recovery complete for ${tenantId}: ${validLines.length} valid, ${linesTruncated} truncated, ${corruptedEntries} corrupted`)
    }

    return {
      entriesRecovered: validLines.length,
      linesTruncated,
      corruptedEntries,
    }
  }

  /**
   * Recompute totals by scanning un-rotated entries, deduplicating by trace_id.
   */
  async recompute(tenantId: string): Promise<RecomputeResult> {
    validateTenantId(tenantId)
    const filePath = this.tenantFilePath(tenantId)

    if (!existsSync(filePath)) {
      return { totalEntries: 0, duplicatesRemoved: 0, totalCostMicro: 0n }
    }

    const raw = await readFile(filePath, "utf8")
    const lines = raw.split("\n").filter(l => l.trim() !== "")
    const seen = new Set<string>()
    let totalCostMicro = 0n
    let duplicatesRemoved = 0

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LedgerEntryV2
        if (seen.has(entry.trace_id)) {
          duplicatesRemoved++
          continue
        }
        seen.add(entry.trace_id)
        totalCostMicro += BigInt(entry.total_cost_micro)
      } catch {
        // Skip malformed entries
      }
    }

    return {
      totalEntries: seen.size,
      duplicatesRemoved,
      totalCostMicro,
    }
  }

  /**
   * Rotate tenant's usage.jsonl to compressed archive if older than rotationAgeDays.
   * Format: usage.YYYY-MM-DD.jsonl.gz
   * Returns the archive path if rotated, null otherwise.
   */
  async rotate(tenantId: string): Promise<string | null> {
    validateTenantId(tenantId)
    const filePath = this.tenantFilePath(tenantId)

    if (!existsSync(filePath)) return null

    const fileStat = await stat(filePath)
    const ageDays = (Date.now() - fileStat.mtimeMs) / (1000 * 60 * 60 * 24)

    if (ageDays < this.config.rotationAgeDays) return null
    if (fileStat.size === 0) return null

    const dateStr = new Date(fileStat.mtimeMs).toISOString().slice(0, 10)
    const tenantDir = this.tenantDir(tenantId)
    const archiveName = `usage.${dateStr}.jsonl.gz`
    let archivePath = join(tenantDir, archiveName)

    // Handle collision: append sequence number
    if (existsSync(archivePath)) {
      let seq = 1
      while (existsSync(join(tenantDir, `usage.${dateStr}-${seq}.jsonl.gz`))) {
        seq++
      }
      archivePath = join(tenantDir, `usage.${dateStr}-${seq}.jsonl.gz`)
    }

    // Compress and write
    await pipeline(
      createReadStream(filePath),
      createGzip({ level: 6 }),
      createWriteStream(archivePath),
    )

    // Truncate original file (new empty usage.jsonl)
    await writeFile(filePath, "", "utf8")

    console.log(`[ledger-v2] Rotated ${filePath} → ${archivePath}`)
    return archivePath
  }

  /**
   * Clean up archives older than retentionDays.
   * Returns number of archives deleted.
   */
  async cleanRetention(tenantId: string): Promise<number> {
    validateTenantId(tenantId)
    const tenantDir = this.tenantDir(tenantId)
    if (!existsSync(tenantDir)) return 0

    const entries = await readdir(tenantDir)
    const archives = entries.filter(f => f.endsWith(".jsonl.gz"))
    let deleted = 0

    for (const archive of archives) {
      const archivePath = join(tenantDir, archive)
      const archiveStat = await stat(archivePath)
      const ageDays = (Date.now() - archiveStat.mtimeMs) / (1000 * 60 * 60 * 24)
      if (ageDays > this.config.retentionDays) {
        await rm(archivePath)
        deleted++
      }
    }

    return deleted
  }

  // --- Querying ---

  /**
   * Scan all entries in a tenant's current ledger file.
   * Yields validated LedgerEntryV2 objects. Skips malformed lines.
   */
  async *scanEntries(tenantId: string): AsyncGenerator<LedgerEntryV2> {
    validateTenantId(tenantId)
    const filePath = this.tenantFilePath(tenantId)

    if (!existsSync(filePath)) return

    const raw = await readFile(filePath, "utf8")
    const lines = raw.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === "") continue

      try {
        const entry = JSON.parse(trimmed) as LedgerEntryV2
        if (entry.schema_version === 2) {
          yield entry
        }
      } catch {
        // Skip malformed entries during scan
      }
    }
  }

  /**
   * Get all tenant IDs that have ledger files.
   */
  async getTenantIds(): Promise<string[]> {
    if (!existsSync(this.config.baseDir)) return []

    const entries = await readdir(this.config.baseDir, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
  }

  /**
   * Count entries in a tenant's current ledger file.
   */
  async countEntries(tenantId: string): Promise<number> {
    validateTenantId(tenantId)
    const filePath = this.tenantFilePath(tenantId)

    if (!existsSync(filePath)) return 0

    const raw = await readFile(filePath, "utf8")
    return raw.split("\n").filter(l => l.trim() !== "").length
  }

  // --- Path Helpers ---

  tenantDir(tenantId: string): string {
    return join(this.config.baseDir, tenantId)
  }

  tenantFilePath(tenantId: string): string {
    return join(this.config.baseDir, tenantId, "usage.jsonl")
  }

  // --- Private ---

  private doAppend(tenantId: string, line: string): void {
    const filePath = this.tenantFilePath(tenantId)
    const dir = dirname(filePath)

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // Synchronous O_APPEND write for atomicity (entries < 4096 bytes)
    appendFileSync(filePath, line, { encoding: "utf8", flag: "a" })

    // Optional fsync for durability
    if (this.config.fsync) {
      const fd = openSync(filePath, "r")
      try {
        fdatasyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
  }
}

// --- Validation ---

/** Validate tenant ID to prevent path traversal. */
function validateTenantId(tenantId: string): void {
  if (!tenantId || tenantId.includes("..") || tenantId.includes("/") || tenantId.includes("\\")) {
    throw new Error(`LEDGER_INVALID_TENANT: invalid tenant ID "${tenantId}"`)
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
    throw new Error(`LEDGER_INVALID_TENANT: tenant ID must be alphanumeric with hyphens/underscores: "${tenantId}"`)
  }
}
