// src/cron/store.ts — Atomic JSON file store with corruption recovery (SDD §4.1)

import { open, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Value } from "@sinclair/typebox/value"
import type { TSchema } from "@sinclair/typebox"
import "../hounfour/typebox-formats.js" // Register uuid/date-time formats for Value.Check
import { assertFormatsRegistered } from "../hounfour/typebox-formats.js"
import {
  AUDIT_TRAIL_GENESIS_HASH,
  buildDomainTag,
  computeAuditEntryHash,
  verifyAuditTrailIntegrity,
  AuditEntrySchema,
} from "../hounfour/protocol-types.js"
import type { AuditEntry, AuditEntryHashInput, AuditTrailVerificationResult } from "../hounfour/protocol-types.js"

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
  /** Enable audit trail hash chain sidecar (.audit.jsonl). Default false. (Sprint 5 T-5.6) */
  auditTrail?: boolean
  /** Schema ID for audit trail domain tag (e.g., 'GovernedCredits'). Default: filename stem. */
  auditSchemaId?: string
  /** Protocol version for audit trail domain tag. Default: '8.2.0'. */
  auditContractVersion?: string
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
  // Audit trail (Sprint 5 T-5.6)
  private readonly auditEnabled: boolean
  private readonly auditPath: string
  private readonly auditDomainTag: string
  private auditPrevHash: string = AUDIT_TRAIL_GENESIS_HASH
  private auditEntryCount = 0
  private auditInitialized = false

  constructor(filePath: string, options?: AtomicJsonStoreOptions) {
    this.filePath = filePath
    this.bakPath = filePath + ".bak"
    this.tmpPath = filePath + ".tmp"
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE
    this.schema = options?.schema
    this.migrations = options?.migrations ?? new Map()
    // Audit trail config
    this.auditEnabled = options?.auditTrail ?? false
    this.auditPath = filePath + ".audit.jsonl"
    const schemaId = options?.auditSchemaId ?? filenameStem(filePath)
    const contractVersion = options?.auditContractVersion ?? "8.2.0"
    this.auditDomainTag = buildDomainTag(schemaId, contractVersion)

    // Validate format registration at construction time, not on every read.
    // FormatRegistry is a global singleton — once registered, formats persist.
    if (this.schema) {
      assertFormatsRegistered(["uuid", "date-time"])
    }
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

      // 6. Append audit trail entry (best-effort — failure logged, not thrown) (T-5.6)
      if (this.auditEnabled) {
        try {
          await this.appendAuditEntry("write", json)
        } catch (err) {
          console.error(
            `[store] Audit trail append failed (store write succeeded):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    })
  }

  // -------------------------------------------------------------------------
  // Audit trail (Sprint 5 T-5.6)
  // -------------------------------------------------------------------------

  /**
   * Verify the integrity of the audit trail hash chain.
   * Returns the verification result from the commons verifyAuditTrailIntegrity.
   * Throws if audit trail is not enabled or sidecar file is missing.
   */
  async verifyIntegrity(): Promise<AuditTrailVerificationResult> {
    if (!this.auditEnabled) {
      throw new Error("Audit trail is not enabled for this store")
    }

    let raw: string
    try {
      raw = await readFile(this.auditPath, "utf-8")
    } catch (err) {
      if (isEnoent(err)) {
        // No sidecar yet — empty trail is valid
        return { valid: true }
      }
      throw err
    }

    const lines = raw.trim().split("\n").filter(Boolean)
    const entries: AuditEntry[] = lines.map((line) => JSON.parse(line))

    return verifyAuditTrailIntegrity({
      entries,
      hash_algorithm: "sha256",
      genesis_hash: AUDIT_TRAIL_GENESIS_HASH,
      integrity_status: "unverified",
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

    // TypeBox schema validation (format guard runs at construction time — see NOTES.md)
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

  /**
   * Initialize audit chain state from existing .audit.jsonl sidecar.
   * Reads the last entry to resume the hash chain after process restart.
   * Called lazily on first appendAuditEntry; idempotent.
   */
  private async initAuditState(): Promise<void> {
    if (this.auditInitialized) return
    this.auditInitialized = true

    let raw: string
    try {
      raw = await readFile(this.auditPath, "utf-8")
    } catch (err) {
      if (isEnoent(err)) return // No sidecar yet — start from genesis
      throw err
    }

    const lines = raw.trim().split("\n").filter(Boolean)
    if (lines.length === 0) return

    const lastEntry = JSON.parse(lines[lines.length - 1]) as AuditEntry
    this.auditPrevHash = lastEntry.entry_hash
    this.auditEntryCount = lines.length
  }

  /**
   * Append a single AuditEntry to the .audit.jsonl sidecar.
   * Computes hash using commons computeAuditEntryHash, chains from prev_hash.
   */
  private async appendAuditEntry(eventType: string, canonicalJson: string): Promise<void> {
    await this.initAuditState()
    const { createHash, randomUUID } = await import("node:crypto")

    const payloadHash = "sha256:" + createHash("sha256").update(canonicalJson, "utf-8").digest("hex")

    const hashInput: AuditEntryHashInput = {
      entry_id: randomUUID(),
      timestamp: new Date().toISOString(),
      event_type: `store.data.${eventType}`,
      payload: { payload_hash: payloadHash },
    }

    const entryHash = computeAuditEntryHash(hashInput, this.auditDomainTag)

    const entry: AuditEntry = {
      entry_id: hashInput.entry_id,
      timestamp: hashInput.timestamp,
      event_type: hashInput.event_type,
      payload: hashInput.payload,
      entry_hash: entryHash,
      previous_hash: this.auditPrevHash,
      hash_domain_tag: this.auditDomainTag,
    }

    // Validate entry against schema before writing
    if (!Value.Check(AuditEntrySchema, entry)) {
      throw new Error(`Audit entry does not conform to AuditEntrySchema`)
    }

    await appendFile(this.auditPath, JSON.stringify(entry) + "\n", "utf-8")

    this.auditPrevHash = entryHash
    this.auditEntryCount++
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

/** Extract filename stem (without extension) from a path. */
function filenameStem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(0, dot) : base
}
