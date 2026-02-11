// src/hounfour/ledger-exporter.ts — Ledger rotation + R2/S3 archival (SDD §4.9, T-3.4)

import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { readFile, stat, writeFile, mkdir } from "node:fs/promises"
import { join, basename } from "node:path"
import { createGzip } from "node:zlib"
import { pipeline } from "node:stream/promises"
import { Readable, Writable } from "node:stream"
import type { BudgetEnforcer } from "./budget.js"

// --- Config ---

export interface LedgerExporterConfig {
  enabled: boolean
  destination: "r2" | "s3" | "local"
  pathPrefix: string              // Default: "hounfour/ledger"
  compression: "gzip"             // Only gzip supported
  retentionDays: number           // Default: 365
  maxSizeMb: number               // Default: 50
  maxAgeDays: number              // Default: 30
}

export const DEFAULT_EXPORTER_CONFIG: LedgerExporterConfig = {
  enabled: false,
  destination: "local",
  pathPrefix: "hounfour/ledger",
  compression: "gzip",
  retentionDays: 365,
  maxSizeMb: 50,
  maxAgeDays: 30,
}

// --- Object Store Port ---

export interface ObjectStorePort {
  upload(key: string, body: Buffer, metadata?: Record<string, string>): Promise<void>
  download(key: string): Promise<Buffer | null>
}

// --- Results ---

export interface RotationResult {
  archivePath: string
  remotePath: string
  sizeBytes: number
  compressedBytes: number
  checksum: string
  entriesCount: number
}

export interface ArchiveIndexEntry {
  filename: string
  path: string
  date_range: { start: string; end: string }
  entries_count: number
  size_bytes: number
  compressed_bytes: number
  checksum_sha256: string
  uploaded_at: string
}

export interface ArchiveIndex {
  schema_version: 1
  archives: ArchiveIndexEntry[]
}

// --- Ledger Exporter ---

export class LedgerExporter {
  constructor(
    private config: LedgerExporterConfig,
    private budget: BudgetEnforcer,
    private objectStore?: ObjectStorePort,
  ) {}

  /**
   * Check if rotation is needed and execute.
   * Triggered by scheduler (hourly check) or manual /cost-export command.
   */
  async checkAndRotate(): Promise<RotationResult | null> {
    if (!this.config.enabled) return null

    // Delegate rotation to BudgetEnforcer (which owns the ledger file)
    const archivePath = await this.budget.rotateLedgerIfNeeded()
    if (!archivePath) return null

    // Compress the archive
    const compressed = await this.compressFile(archivePath)

    // Calculate checksum of compressed file
    const checksum = createHash("sha256").update(compressed).digest("hex")

    // Count entries
    const raw = await readFile(archivePath, "utf8")
    const lines = raw.split("\n").filter(l => l.trim().length > 0)
    const entriesCount = lines.length

    // Extract date range from entries
    const dateRange = this.extractDateRange(lines)

    // Use stat for accurate byte size (not string length)
    const fileStat = await stat(archivePath)

    // Build remote path: {pathPrefix}/{year}/{month}/{filename}.jsonl.gz
    const now = new Date()
    const year = now.getFullYear().toString()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const gzFilename = `${basename(archivePath)}.gz`
    const remotePath = `${this.config.pathPrefix}/${year}/${month}/${gzFilename}`

    // Upload to object store (with retry)
    if (this.objectStore && this.config.destination !== "local") {
      await this.uploadWithRetry(remotePath, compressed, {
        "checksum-sha256": checksum,
        "entries-count": String(entriesCount),
        "content-encoding": "gzip",
      })

      // Update index
      await this.updateIndex({
        filename: gzFilename,
        path: remotePath,
        date_range: dateRange,
        entries_count: entriesCount,
        size_bytes: fileStat.size,
        compressed_bytes: compressed.length,
        checksum_sha256: checksum,
        uploaded_at: now.toISOString(),
      })
    }

    // Write compressed file locally too
    const localGzPath = `${archivePath}.gz`
    await writeFile(localGzPath, compressed)

    return {
      archivePath,
      remotePath,
      sizeBytes: fileStat.size,
      compressedBytes: compressed.length,
      checksum,
      entriesCount,
    }
  }

  /**
   * Manual export with date range filter.
   */
  async exportRange(startDate: string, endDate: string): Promise<RotationResult | null> {
    const files = await this.budget.listAllLedgerFiles()
    if (files.length === 0) return null

    const start = new Date(startDate).getTime()
    const end = new Date(endDate).getTime()
    const filtered: string[] = []

    for (const file of files) {
      const content = await readFile(file, "utf8")
      const lines = content.split("\n").filter(l => l.trim().length > 0)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          const ts = new Date(entry.timestamp).getTime()
          if (ts >= start && ts <= end) {
            filtered.push(line)
          }
        } catch {
          // Skip malformed entries
        }
      }
    }

    if (filtered.length === 0) return null

    // Write filtered entries to temp file
    const content = filtered.join("\n") + "\n"
    const compressed = await this.compressBuffer(Buffer.from(content))
    const checksum = createHash("sha256").update(compressed).digest("hex")

    const now = new Date()
    const year = now.getFullYear().toString()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const safeStart = this.sanitizeKeyPart(startDate)
    const safeEnd = this.sanitizeKeyPart(endDate)
    const filename = `cost-ledger-export-${safeStart}-${safeEnd}.jsonl.gz`
    const remotePath = `${this.config.pathPrefix}/${year}/${month}/${filename}`

    if (this.objectStore && this.config.destination !== "local") {
      await this.uploadWithRetry(remotePath, compressed, {
        "checksum-sha256": checksum,
        "entries-count": String(filtered.length),
        "content-encoding": "gzip",
      })
    }

    return {
      archivePath: "",
      remotePath,
      sizeBytes: content.length,
      compressedBytes: compressed.length,
      checksum,
      entriesCount: filtered.length,
    }
  }

  // --- Private helpers ---

  private async compressFile(filePath: string): Promise<Buffer> {
    const chunks: Buffer[] = []
    const gzip = createGzip({ level: 6 })
    const input = createReadStream(filePath)
    const collector = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    })

    await pipeline(input, gzip, collector)
    return Buffer.concat(chunks)
  }

  private async compressBuffer(buf: Buffer): Promise<Buffer> {
    const chunks: Buffer[] = []
    const gzip = createGzip({ level: 6 })
    const input = Readable.from(buf)
    const collector = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    })

    await pipeline(input, gzip, collector)
    return Buffer.concat(chunks)
  }

  /** Strip path separators and non-safe chars from key components to prevent path injection. */
  private sanitizeKeyPart(input: string): string {
    return input.replace(/[^a-zA-Z0-9._-]/g, "")
  }

  private extractDateRange(lines: string[]): { start: string; end: string } {
    let earliest = ""
    let latest = ""

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        const ts = entry.timestamp as string
        if (!earliest || ts < earliest) earliest = ts
        if (!latest || ts > latest) latest = ts
      } catch {
        // Skip malformed entries
      }
    }

    return {
      start: earliest || new Date().toISOString(),
      end: latest || new Date().toISOString(),
    }
  }

  private async uploadWithRetry(
    key: string,
    body: Buffer,
    metadata: Record<string, string>,
    maxRetries = 3,
  ): Promise<void> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.objectStore!.upload(key, body, metadata)
        return
      } catch (err) {
        lastError = err as Error
        console.error(`[ledger-exporter] Upload attempt ${attempt + 1}/${maxRetries} failed:`, err)
        if (attempt < maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        }
      }
    }

    console.error(`[ledger-exporter] Upload failed after ${maxRetries} attempts. Keeping local file.`)
    throw lastError
  }

  private async updateIndex(entry: ArchiveIndexEntry): Promise<void> {
    const indexKey = `${this.config.pathPrefix}/index.json`

    let index: ArchiveIndex = { schema_version: 1, archives: [] }

    // Try to load existing index
    try {
      const existing = await this.objectStore!.download(indexKey)
      if (existing) {
        index = JSON.parse(existing.toString("utf8"))
      }
    } catch {
      // Start fresh
    }

    index.archives.push(entry)

    await this.objectStore!.upload(
      indexKey,
      Buffer.from(JSON.stringify(index, null, 2)),
      { "content-type": "application/json" },
    )
  }
}
