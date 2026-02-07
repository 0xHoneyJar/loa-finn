// src/cron/store.ts — Atomic JSON file store with corruption recovery (SDD §4.1)

import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Value } from "@sinclair/typebox/value"
import type { TSchema } from "@sinclair/typebox"

// ---------------------------------------------------------------------------
// Error types (SDD §4.1)
// ---------------------------------------------------------------------------

/** Thrown when the primary and backup files both fail schema/JSON validation. */
export class StoreCorruptionError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Store corruption: ${filePath} — ${reason}`)
    this.name = "StoreCorruptionError"
  }
}

/** Thrown when a serialized write exceeds the configured size limit. */
export class WriteSizeLimitError extends Error {
  constructor(actualBytes: number, limitBytes: number) {
    super(`Write size ${actualBytes} bytes exceeds limit of ${limitBytes} bytes`)
    this.name = "WriteSizeLimitError"
  }
}

// ---------------------------------------------------------------------------
// Async mutex — simple promise-chain lock (no external deps) (SDD §4.1)
// ---------------------------------------------------------------------------

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve()

  /** Acquire the lock, execute fn, then release. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    // Enqueue behind current chain
    const prev = this.chain
    this.chain = gate

    await prev
    try {
      return await fn()
    } finally {
      release!()
    }
  }
}

// ---------------------------------------------------------------------------
// Store options
// ---------------------------------------------------------------------------

export interface AtomicJsonStoreOptions<S extends TSchema = TSchema> {
  /** Maximum serialized size in bytes. Default 10 MB. */
  maxSizeBytes?: number
  /** Optional TypeBox schema; validated on every read. */
  schema?: S
  /** Migration callbacks keyed by _schemaVersion they upgrade FROM. */
  migrations?: Map<number, (data: unknown) => unknown>
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024 // 10 MB

// ---------------------------------------------------------------------------
// AtomicJsonStore (SDD §4.1)
// ---------------------------------------------------------------------------

/**
 * Durable JSON file store with atomic writes, backup recovery, and optional
 * TypeBox schema validation.
 *
 * Write path: serialize -> size check -> write .tmp -> fsync -> backup current
 * -> atomic rename -> dir fsync.
 *
 * Read path: primary file -> fallback .bak -> quarantine corrupt file.
 */
export class AtomicJsonStore<T> {
  private readonly filePath: string
  private readonly bakPath: string
  private readonly tmpPath: string
  private readonly maxSizeBytes: number
  private readonly schema: TSchema | undefined
  private readonly migrations: Map<number, (data: unknown) => unknown>
  private readonly mutex = new AsyncMutex()

  constructor(filePath: string, options?: AtomicJsonStoreOptions) {
    this.filePath = filePath
    this.bakPath = filePath + ".bak"
    this.tmpPath = filePath + ".tmp"
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE
    this.schema = options?.schema
    this.migrations = options?.migrations ?? new Map()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Read and parse the store file. Falls back to .bak on primary failure.
   * Quarantines corrupt files (renames to `.corrupt.{timestamp}`).
   */
  async read(): Promise<T | null> {
    // Try primary
    const primary = await this.tryReadFile(this.filePath)
    if (primary !== null) return primary

    // Primary missing or corrupt — try backup
    const backup = await this.tryReadFile(this.bakPath)
    if (backup !== null) return backup

    // Try .tmp — covers crash between rename(primary,.bak) and rename(.tmp,primary)
    const tmp = await this.tryReadFile(this.tmpPath)
    if (tmp !== null) return tmp

    // All missing (ENOENT) is not corruption — just no data yet
    const primaryExists = await fileExists(this.filePath)
    const bakExists = await fileExists(this.bakPath)
    const tmpExists = await fileExists(this.tmpPath)
    if (!primaryExists && !bakExists && !tmpExists) return null

    // At least one file existed but was unreadable — quarantine what's there
    if (primaryExists) await this.quarantine(this.filePath)
    if (bakExists) await this.quarantine(this.bakPath)
    if (tmpExists) await this.quarantine(this.tmpPath)

    throw new StoreCorruptionError(
      this.filePath,
      "primary, backup, and tmp all failed validation",
    )
  }

  /**
   * Atomically write data to the store file.
   *
   * Acquires an internal mutex so concurrent writes to the same store are
   * serialized (prevents interleaved tmp writes / renames).
   */
  async write(data: T): Promise<void> {
    await this.mutex.runExclusive(async () => {
      // Serialize with sorted keys for deterministic output
      const json = JSON.stringify(data, sortedReplacer, 2) + "\n"
      const bytes = Buffer.byteLength(json, "utf-8")

      // Size guard (SDD §4.1)
      if (bytes > this.maxSizeBytes) {
        throw new WriteSizeLimitError(bytes, this.maxSizeBytes)
      }

      // 1. Write to .tmp
      await writeFile(this.tmpPath, json, "utf-8")

      // 2. fsync the .tmp file descriptor
      await fsyncFile(this.tmpPath)

      // 3. Backup current file (best-effort — primary may not exist yet)
      if (await fileExists(this.filePath)) {
        await rename(this.filePath, this.bakPath)
      }

      // 4. Atomic rename .tmp -> primary
      await rename(this.tmpPath, this.filePath)

      // 5. fsync the containing directory so the rename is durable
      await fsyncDir(dirname(this.filePath))
    })
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Attempt to read, parse, migrate, and validate a single file path. */
  private async tryReadFile(path: string): Promise<T | null> {
    let raw: string
    try {
      raw = await readFile(path, "utf-8")
    } catch (err: unknown) {
      if (isEnoent(err)) return null
      return null // I/O error — treat as unreadable
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null // Invalid JSON
    }

    // Run migrations if _schemaVersion is present (SDD §4.1)
    parsed = this.applyMigrations(parsed)

    // TypeBox schema validation
    if (this.schema) {
      if (!Value.Check(this.schema, parsed)) {
        return null // Schema mismatch
      }
    }

    return parsed as T
  }

  /** Apply chained migrations from the data's current version upward. */
  private applyMigrations(data: unknown): unknown {
    if (this.migrations.size === 0) return data

    let current = data
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const version = getSchemaVersion(current)
      const migrate = this.migrations.get(version)
      if (!migrate) break
      current = migrate(current)
    }
    return current
  }

  /** Rename a corrupt file out of the way so recovery doesn't loop. */
  private async quarantine(path: string): Promise<void> {
    const ts = Date.now()
    const dest = `${path}.corrupt.${ts}`
    try {
      await rename(path, dest)
    } catch {
      // Best effort — file may already be gone
    }
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Extract `_schemaVersion` from an object, defaulting to 0. */
function getSchemaVersion(data: unknown): number {
  if (data && typeof data === "object" && "_schemaVersion" in data) {
    const v = (data as Record<string, unknown>)._schemaVersion
    return typeof v === "number" ? v : 0
  }
  return 0
}

/** JSON.stringify replacer that sorts object keys for deterministic output. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}

/** Check if a file exists without throwing. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** fsync an individual file by opening its fd, syncing, and closing. */
async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, "r")
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** fsync a directory to flush metadata (rename visibility). */
async function fsyncDir(dirPath: string): Promise<void> {
  let fh
  try {
    fh = await open(dirPath, "r")
    await fh.sync()
  } catch {
    // Some platforms (Windows / some containers) don't support dir fsync
  } finally {
    await fh?.close()
  }
}

/** Type-guard for Node ENOENT errors. */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT"
}
