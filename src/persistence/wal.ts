// src/persistence/wal.ts — Write-Ahead Log with atomic appends (SDD §3.3.1, T-3.1)

import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
} from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { monotonicFactory } from "ulid"

const ulid = monotonicFactory()

// WAL entry types matching SDD §3.3.1 + §7.6 (audit entries for BillingConservationGuard)
export type WALEntryType = "session" | "bead" | "memory" | "config" | "audit"

// Known types for forward-compatible replay — unknown types are skipped with warning
const KNOWN_WAL_TYPES = new Set<string>(["session", "bead", "memory", "config", "audit"])

export interface WALEntry {
  id: string            // ULID (monotonic, sortable)
  timestamp: number     // Unix milliseconds
  type: WALEntryType
  operation: "create" | "update" | "delete"
  path: string          // File path affected
  data: unknown         // Serialized payload
  checksum: string      // SHA-256 of JSON.stringify(data)
}

export class DiskPressureError extends Error {
  constructor(freeBytes: number) {
    super(`Disk pressure: ${freeBytes} bytes free (below 100MB threshold)`)
    this.name = "DiskPressureError"
  }
}

const SEGMENT_MAX_BYTES = 10 * 1024 * 1024 // 10MB rotation threshold
const DISK_PRESSURE_LOW = 100 * 1024 * 1024 // 100MB — enter read-only
const DISK_PRESSURE_HIGH = 150 * 1024 * 1024 // 150MB — resume writes (hysteresis)

export class WAL {
  private walDir: string
  private currentSegment: string
  private currentSegmentSize: number
  private diskPressure = false

  constructor(dataDir: string) {
    this.walDir = join(dataDir, "wal")
    mkdirSync(this.walDir, { recursive: true })

    // Find or create the current (latest) segment
    const segments = this.getSegments()
    if (segments.length > 0) {
      this.currentSegment = segments[segments.length - 1]
      this.currentSegmentSize = this.fileSize(this.currentSegment)
    } else {
      this.currentSegment = this.newSegmentPath()
      this.currentSegmentSize = 0
    }
  }

  /** Append a new entry to the WAL. Returns the entry ID. */
  append(
    type: WALEntryType,
    operation: "create" | "update" | "delete",
    path: string,
    data: unknown,
  ): string {
    // Check disk pressure with hysteresis
    if (this.diskPressure) {
      const free = this.checkDiskSpace()
      if (free < DISK_PRESSURE_HIGH) {
        throw new DiskPressureError(free)
      }
      this.diskPressure = false
    } else {
      const free = this.checkDiskSpace()
      if (free < DISK_PRESSURE_LOW) {
        this.diskPressure = true
        throw new DiskPressureError(free)
      }
    }

    // Rotate if needed
    if (this.currentSegmentSize >= SEGMENT_MAX_BYTES) {
      this.rotate()
    }

    const dataStr = JSON.stringify(data)
    const entry: WALEntry = {
      id: ulid(),
      timestamp: Date.now(),
      type,
      operation,
      path,
      data,
      checksum: createHash("sha256").update(dataStr).digest("hex"),
    }

    const line = JSON.stringify(entry) + "\n"
    const lineBytes = Buffer.byteLength(line)

    // appendFileSync with O_APPEND is atomic for writes < PIPE_BUF (4KB on Linux)
    // WAL entries should always be well under this limit
    appendFileSync(this.currentSegment, line)

    this.currentSegmentSize += lineBytes
    return entry.id
  }

  /** Replay WAL entries, optionally since a given ULID.
   *  Forward-compatible: unknown entry types are skipped with warning (SDD §7.6). */
  async *replay(since?: string): AsyncIterable<WALEntry> {
    const segments = this.getSegments()

    for (const segPath of segments) {
      const content = await readFile(segPath, "utf-8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        const entry = JSON.parse(line) as WALEntry
        if (since && entry.id <= since) continue

        // Forward-compatible: skip unknown entry types with warning (SDD §7.6)
        if (!KNOWN_WAL_TYPES.has(entry.type)) {
          console.warn(`[wal] unknown entry type "${entry.type}" in ${entry.id}, skipping`)
          continue
        }

        // Verify checksum
        const expected = createHash("sha256")
          .update(JSON.stringify(entry.data))
          .digest("hex")
        if (expected !== entry.checksum) {
          console.error(`[wal] checksum mismatch for entry ${entry.id}, skipping`)
          continue
        }

        yield entry
      }
    }
  }

  /** Rotate to a new segment file. */
  rotate(): void {
    this.currentSegment = this.newSegmentPath()
    this.currentSegmentSize = 0
  }

  /** Get all segment file paths in ULID order. */
  getSegments(): string[] {
    if (!existsSync(this.walDir)) return []
    return readdirSync(this.walDir)
      .filter((f) => f.startsWith("wal-") && f.endsWith(".jsonl"))
      .sort()
      .map((f) => join(this.walDir, f))
  }

  /** Get segments eligible for pruning (synced and committed). */
  getPrunableSegments(): string[] {
    if (!existsSync(this.walDir)) return []
    return readdirSync(this.walDir)
      .filter((f) => f.endsWith(".prunable"))
      .sort()
      .map((f) => join(this.walDir, f))
  }

  /** Mark segments as prunable (called after confirmed R2 + git checkpoint). */
  markPrunable(segmentPaths: string[]): void {
    for (const segPath of segmentPaths) {
      if (segPath === this.currentSegment) continue
      if (existsSync(segPath)) {
        renameSync(segPath, segPath.replace(".jsonl", ".prunable"))
      }
    }
  }

  /** Delete prunable segments. */
  prune(): number {
    const prunable = this.getPrunableSegments()
    for (const p of prunable) {
      unlinkSync(p)
    }
    return prunable.length
  }

  /** Get the last entry ID in the WAL. */
  async getHeadEntryId(): Promise<string | undefined> {
    const segments = this.getSegments()
    if (segments.length === 0) return undefined

    const lastSeg = segments[segments.length - 1]
    const content = await readFile(lastSeg, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)
    if (lines.length === 0) return undefined

    const lastEntry = JSON.parse(lines[lines.length - 1]) as WALEntry
    return lastEntry.id
  }

  /** Check if WAL is in disk pressure mode. */
  get isDiskPressure(): boolean {
    return this.diskPressure
  }

  get directory(): string {
    return this.walDir
  }

  private newSegmentPath(): string {
    return join(this.walDir, `wal-${ulid()}.jsonl`)
  }

  private fileSize(path: string): number {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  private checkDiskSpace(): number {
    try {
      const fs = statfsSync(this.walDir)
      return fs.bfree * fs.bsize
    } catch {
      return Number.MAX_SAFE_INTEGER // Assume plenty if statfs unavailable
    }
  }
}
