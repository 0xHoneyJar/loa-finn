// src/safety/audit-trail.ts — Write-Ahead Audit Trail with hash-chained JSONL (SDD §4.3)
//
// Append-only JSONL audit trail with SHA-256 hash chaining, canonical serialization,
// optional HMAC-SHA256 signing, and intent-result pairing. Every GitHub mutation is
// logged before (intent) and after (result) execution. The hash chain provides tamper
// detection; HMAC provides authenticity when a signing key is configured.

import { createHmac, createHash } from "node:crypto"
import { appendFile, readFile, stat, rename, open } from "node:fs/promises"
// CJS module with `export default` in .d.ts — need type-level workaround for NodeNext
import _canonicalizeJCS from "canonicalize"
const canonicalizeJCS: (input: unknown) => string | undefined = _canonicalizeJCS as never

// Simple async mutex to serialize appendRecord calls and prevent hash chain corruption.
class Mutex {
  private queue: Array<() => void> = []
  private locked = false

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    return new Promise<void>((resolve) => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }
}

/**
 * Advisory file lock for single-writer enforcement (SDD §8.3, Task 3.9).
 * Uses flock-style locking via file descriptor exclusive mode.
 * Prevents concurrent writers from corrupting the hash chain.
 */
class FileLock {
  private fd: Awaited<ReturnType<typeof open>> | null = null
  private lockPath: string
  private _acquired = false

  constructor(filePath: string) {
    this.lockPath = filePath + ".lock"
  }

  get acquired(): boolean {
    return this._acquired
  }

  /**
   * Acquire advisory lock. Returns true if acquired, false if another writer holds it.
   * On acquisition, writes PID to lock file for stale detection.
   */
  async acquire(): Promise<boolean> {
    if (this._acquired) return true
    try {
      // O_WRONLY | O_CREAT | O_EXCL — fails if lock file already exists
      this.fd = await open(this.lockPath, "wx")
      // Write PID for stale lock detection
      await this.fd.write(Buffer.from(String(process.pid)))
      this._acquired = true
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock file exists — check if stale
        const isStale = await this.isStale()
        if (isStale) {
          // Remove stale lock and retry once
          try {
            const { unlink } = await import("node:fs/promises")
            await unlink(this.lockPath)
            return this.acquire()
          } catch {
            return false
          }
        }
        return false
      }
      console.error("[audit-trail] Lock acquisition error:", err)
      return false
    }
  }

  /**
   * Check if the existing lock is stale (PID not running).
   */
  private async isStale(): Promise<boolean> {
    try {
      const content = await readFile(this.lockPath, "utf-8")
      const pid = parseInt(content.trim(), 10)
      if (isNaN(pid)) return true // Corrupt lock file
      // Check if process is running (signal 0 = test existence)
      try {
        process.kill(pid, 0)
        return false // Process is running — lock is active
      } catch {
        return true // Process not found — lock is stale
      }
    } catch {
      return true // Can't read lock file — treat as stale
    }
  }

  /**
   * Release the advisory lock and remove lock file.
   */
  async release(): Promise<void> {
    if (!this._acquired) return
    try {
      if (this.fd) {
        await this.fd.close()
        this.fd = null
      }
      const { unlink } = await import("node:fs/promises")
      await unlink(this.lockPath)
    } catch {
      // Best-effort release
    }
    this._acquired = false
  }
}

// ── Types ───────────────────────────────────────────────────

/** Phases of an audit record. (SDD §4.3) */
export type AuditPhase = "intent" | "result" | "denied" | "dry_run"

/** A single audit record in the hash-chained JSONL trail. (SDD §4.3) */
export interface AuditRecord {
  seq: number
  prevHash: string
  hash: string
  hmac?: string
  phase: AuditPhase
  intentSeq?: number
  ts: string
  jobId: string
  runUlid: string
  templateId: string
  action: string
  target: string
  params: Record<string, unknown>
  dedupeKey?: string
  result?: unknown
  error?: string
  rateLimitRemaining?: number
  dryRun: boolean
}

/** Data required to create an intent/denied/dry_run record. (SDD §4.3) */
export interface AuditRecordInput {
  action: string
  target: string
  params: Record<string, unknown>
  dedupeKey?: string
  dryRun?: boolean
}

/** Data required to create a result record. (SDD §4.3) */
export interface AuditResultInput {
  action: string
  target: string
  params: Record<string, unknown>
  result?: unknown
  error?: string
  rateLimitRemaining?: number
  dryRun?: boolean
}

/** Run context stored via setRunContext for automatic field inclusion. (SDD §4.3) */
export interface RunContext {
  jobId: string
  runUlid: string
  templateId: string
}

/** Result of chain verification. (SDD §4.3) */
export interface VerifyResult {
  valid: boolean
  errors: string[]
}

/** Options for AuditTrail constructor. (SDD §4.3) */
export interface AuditTrailOptions {
  hmacKey?: Buffer
  now?: () => number
}

// ── Secret Redaction ────────────────────────────────────────

/** Patterns that indicate a value is a secret and should be redacted. (SDD §4.3) */
const SECRET_VALUE_PATTERNS = [/^ghp_/, /^ghs_/, /^gho_/, /^Bearer\s+/]
const SECRET_KEY_PATTERNS = [/token/i, /secret/i, /key/i, /password/i]

/** Recursively redact secret values from a params object. (SDD §4.3) */
function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && isSecretValue(key, value)) {
      result[key] = "[REDACTED]"
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "string" && isSecretValue(key, item)
          ? "[REDACTED]"
          : typeof item === "object" && item !== null
            ? redactSecrets(item as Record<string, unknown>)
            : item,
      )
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSecrets(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

/** Check if a key/value pair looks like a secret. (SDD §4.3) */
function isSecretValue(key: string, value: string): boolean {
  // Check if the key name suggests a secret
  if (SECRET_KEY_PATTERNS.some((p) => p.test(key))) return true
  // Check if the value itself matches a known secret pattern
  if (SECRET_VALUE_PATTERNS.some((p) => p.test(value))) return true
  return false
}

// ── Canonical Serialization ─────────────────────────────────

/**
 * Produce canonical JSON for hashing: sorted keys, excluding `hash` and `hmac`.
 * This ensures deterministic hashing regardless of property insertion order. (SDD §4.3)
 */
function canonicalize(record: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {}
  const keys = Object.keys(record).sort()
  for (const key of keys) {
    if (key === "hash" || key === "hmac") continue
    filtered[key] = record[key]
  }
  return JSON.stringify(filtered, sortReplacer)
}

/** JSON.stringify replacer that sorts object keys at every nesting level. (SDD §4.3) */
function sortReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}

// ── Rotation threshold ──────────────────────────────────────

/** Maximum file size before rotation is recommended: 10 MB. (SDD §4.3) */
const ROTATION_THRESHOLD_BYTES = 10 * 1024 * 1024

// --- v7.11.0 Feature Flag (SDD §2.2) ---

/** When true, new audit records use protocol_v1 envelope format with RFC 8785 JCS. Default: false. */
export const PROTOCOL_HASH_CHAIN_ENABLED = process.env.PROTOCOL_HASH_CHAIN_ENABLED === "true"

// ── Protocol v1 Envelope (SDD §4.5) ────────────────────────

/** Protocol v1 envelope format for hash chain entries (SDD §4.5.1) */
export type HashChainFormat = "legacy" | "bridge" | "protocol_v1"

/** Protocol v1 envelope wrapping an audit record (SDD §4.5.2).
 *
 * Envelope fields align with SDD §4.5.3 / test vectors:
 *   { version, algo, format, timestamp, action, payload_hash }
 *
 * Chain pointers (prevHashProtocol, prevHashLegacy) are NOT part of the
 * canonical envelope that gets hashed — they are structural metadata.
 * entry_hash = SHA-256(prevHashProtocol + '\n' + JCS(envelope))
 */
export interface ProtocolEnvelope {
  format: "protocol_v1"
  version: 1
  algo: "sha256"              // Hash algorithm (SDD §4.5.3)
  timestamp: string           // ISO 8601 timestamp
  action: string              // Action from the payload record
  payload_hash: string        // SHA-256 of JCS-canonicalized payload
  prevHashProtocol: string    // Protocol chain pointer (not hashed in envelope)
  prevHashLegacy?: string     // Legacy chain pointer (dual-write only, not hashed)
  entry_hash: string          // SHA-256(prevHashProtocol + '\n' + JCS({version,algo,format,timestamp,action,payload_hash}))
}

/** Bridge entry linking legacy chain to protocol chain (SDD §4.5.4) */
export interface BridgeEntry {
  format: "bridge"
  version: 1
  legacy_chain_tip: string     // Last legacy hash
  protocol_genesis: string     // First protocol hash (genesis sentinel)
  bridge_hash: string          // SHA-256 of JCS({legacy_chain_tip, protocol_genesis, ts, seq})
  ts: string
  seq: number
}

/** Genesis sentinel for protocol chain */
export const PROTOCOL_GENESIS_HASH = "protocol_genesis"

/**
 * Canonicalize a record using RFC 8785 JCS (JSON Canonicalization Scheme).
 * Uses the `canonicalize` npm package for spec-compliant deterministic serialization.
 * Returns null if input cannot be serialized (defensive — never throws).
 */
export function canonicalizeProtocol(record: Record<string, unknown>): string | null {
  try {
    const result = canonicalizeJCS(record)
    return result ?? null
  } catch {
    console.error("[audit-trail] JCS canonicalization failed for record")
    return null
  }
}

/**
 * Compute SHA-256 hash of a JCS-canonicalized payload.
 * Used for payload_hash field in protocol_v1 envelopes.
 */
export function computePayloadHash(payload: Record<string, unknown>): string | null {
  const canonical = canonicalizeProtocol(payload)
  if (!canonical) return null
  return createHash("sha256").update(canonical).digest("hex")
}

/**
 * Compute the entry hash for a protocol_v1 envelope (SDD §4.5.2).
 * entry_hash = SHA-256(prevHashProtocol_hex + '\n' + JCS(envelope_without_prevHashProtocol_and_entry_hash))
 *
 * The prevHashProtocol is concatenated as a prefix (not inside the JCS object)
 * to ensure chain binding is structurally separated from envelope content.
 */
export function computeProtocolEntryHash(envelope: Omit<ProtocolEnvelope, "entry_hash">): string | null {
  // SDD §4.5.3: entry_hash = SHA-256(prevHashProtocol + '\n' + JCS(canonical_envelope))
  // Canonical envelope contains ONLY: version, algo, format, timestamp, action, payload_hash
  // Chain pointers (prevHashProtocol, prevHashLegacy) are NOT included in the hash input.
  const canonicalEnvelope: Record<string, unknown> = {
    version: envelope.version,
    algo: envelope.algo,
    format: envelope.format,
    timestamp: envelope.timestamp,
    action: envelope.action,
    payload_hash: envelope.payload_hash,
  }
  const canonical = canonicalizeProtocol(canonicalEnvelope)
  if (!canonical) return null
  const preimage = envelope.prevHashProtocol + "\n" + canonical
  return createHash("sha256").update(preimage).digest("hex")
}

/**
 * Build a protocol_v1 envelope for an audit record payload.
 * Computes payload_hash and entry_hash using JCS canonicalization.
 */
export function buildEnvelope(
  payload: Record<string, unknown>,
  action: string,
  prevHashProtocol: string,
  timestamp: string,
  prevHashLegacy?: string,
): ProtocolEnvelope | null {
  const payload_hash = computePayloadHash(payload)
  if (!payload_hash) return null

  const partial: Omit<ProtocolEnvelope, "entry_hash"> = {
    format: "protocol_v1",
    version: 1,
    algo: "sha256",
    timestamp,
    action,
    payload_hash,
    prevHashProtocol,
  }
  if (prevHashLegacy !== undefined) {
    partial.prevHashLegacy = prevHashLegacy
  }

  const entry_hash = computeProtocolEntryHash(partial)
  if (!entry_hash) return null

  return { ...partial, entry_hash }
}

/**
 * Compute bridge entry hash (SDD §4.5.4).
 * Hashes: legacy_chain_tip + protocol_genesis + ts + seq
 */
export function computeBridgeHash(
  legacyChainTip: string,
  protocolGenesis: string,
  ts: string,
  seq: number,
): string | null {
  const canonical = canonicalizeProtocol({
    legacy_chain_tip: legacyChainTip,
    protocol_genesis: protocolGenesis,
    ts,
    seq,
  })
  if (!canonical) return null
  return createHash("sha256").update(canonical).digest("hex")
}

// ── AuditTrail ──────────────────────────────────────────────

/**
 * Write-ahead audit trail with hash-chained JSONL records. (SDD §4.3)
 *
 * Each record contains a SHA-256 hash of its canonical serialization and a prevHash
 * linking to the previous record's hash, forming a tamper-evident chain. Optional
 * HMAC-SHA256 signing provides authenticity guarantees when a key is configured.
 */
export class AuditTrail {
  private readonly filePath: string
  private readonly hmacKey: Buffer | undefined
  private readonly now: () => number

  private seq = 0
  private lastHash = "genesis"
  private runContext: RunContext | undefined
  private readonly mutex = new Mutex()
  private fileLock: FileLock
  private quarantined = false
  private migrated = false
  private lastHashProtocol = PROTOCOL_GENESIS_HASH
  private lastHashLegacy = "genesis"  // Mirrors lastHash for legacy chain
  private dualWriteRemaining = 0

  constructor(filePath: string, options?: AuditTrailOptions) {
    this.filePath = filePath
    this.hmacKey = options?.hmacKey
    this.now = options?.now ?? Date.now
    this.fileLock = new FileLock(filePath)
  }

  // ── Run context ─────────────────────────────────────────

  /** Store run context for automatic inclusion in subsequent records. (SDD §4.3) */
  setRunContext(ctx: RunContext): void {
    this.runContext = ctx
  }

  /** Clear the stored run context. (SDD §4.3) */
  clearRunContext(): void {
    this.runContext = undefined
  }

  // ── Single-writer enforcement (SDD §8.3, Task 3.9) ────

  /**
   * Acquire single-writer lock at boot time (SDD §8.3, Task 3.9).
   * Must be called before any append operations.
   * Returns true if lock acquired, false if another writer is active.
   */
  async acquireWriteLock(): Promise<boolean> {
    const acquired = await this.fileLock.acquire()
    if (!acquired) {
      console.error("[audit-trail] CRITICAL: Single-writer lock acquisition failed — another writer is active. Entering quarantine mode.")
      this.quarantined = true
      return false
    }
    return true
  }

  /** Check if this trail is in quarantine mode (lock acquisition failed). */
  isQuarantined(): boolean {
    return this.quarantined
  }

  // ── Bridge entry (SDD §4.5.4, Task 3.5) ────────────────

  /**
   * Append a bridge entry linking legacy chain to protocol chain (SDD §4.5.4, Task 3.5).
   * This is the point of no return for migration — after this, the protocol chain is active.
   * Must be called exactly once during migration.
   */
  async appendBridgeEntry(): Promise<BridgeEntry> {
    await this.mutex.acquire()
    try {
      if (this.quarantined) {
        throw new Error("[audit-trail] Write denied: trail is in quarantine mode")
      }
      if (this.migrated) {
        throw new Error("[audit-trail] Bridge entry already exists — cannot re-bridge")
      }

      this.seq += 1
      const currentSeq = this.seq
      const ts = new Date(this.now()).toISOString()

      const bridgeHash = computeBridgeHash(this.lastHash, PROTOCOL_GENESIS_HASH, ts, currentSeq)
      if (!bridgeHash) {
        throw new Error("[audit-trail] Failed to compute bridge hash")
      }

      const entry: BridgeEntry = {
        format: "bridge",
        version: 1,
        legacy_chain_tip: this.lastHash,
        protocol_genesis: PROTOCOL_GENESIS_HASH,
        bridge_hash: bridgeHash,
        ts,
        seq: currentSeq,
      }

      const line = JSON.stringify(entry) + "\n"
      await appendFile(this.filePath, line, "utf-8")

      // Transition state
      this.migrated = true
      this.lastHashProtocol = PROTOCOL_GENESIS_HASH
      this.lastHash = bridgeHash  // Legacy chain continues through bridge hash
      this.lastHashLegacy = bridgeHash  // Legacy pointer advances through bridge entry

      // Start dual-write period
      const dualWriteCount = parseInt(process.env.HASH_CHAIN_DUAL_WRITE_COUNT ?? "1000", 10)
      this.dualWriteRemaining = isNaN(dualWriteCount) ? 1000 : dualWriteCount

      console.log(`[audit-trail] Bridge entry appended at seq=${currentSeq}. Dual-write period: ${this.dualWriteRemaining} records.`)

      return entry
    } finally {
      this.mutex.release()
    }
  }

  // ── State recovery ──────────────────────────────────────

  /**
   * Recover chain state from an existing audit file. Reads the last line to extract
   * the current seq and lastHash for chain continuity. (SDD §4.3)
   */
  async recoverState(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.filePath, "utf-8")
    } catch {
      // File doesn't exist yet — start fresh
      return
    }

    const lines = content.trim().split("\n").filter((l) => l.length > 0)
    if (lines.length === 0) return

    const lastLine = lines[lines.length - 1]
    const record: AuditRecord = JSON.parse(lastLine)
    this.seq = record.seq
    this.lastHash = record.hash
  }

  /**
   * Reconstruct migration state from the audit log on startup (SDD §4.5.5.1, Task 3.6).
   * Replaces recoverState() for protocol-aware chains.
   * Handles: fresh log, bridge entry, dual-write period, post-dual-write.
   * SKP-004: truncates partial trailing line on crash recovery.
   */
  async reconstructStateFromLog(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.filePath, "utf-8")
    } catch {
      // File doesn't exist — start fresh
      return
    }

    // SKP-004: Handle partial trailing line (crash during write)
    let lines = content.split("\n").filter((l) => l.length > 0)

    // Validate last line is parseable JSON; if not, truncate it
    if (lines.length > 0) {
      try {
        JSON.parse(lines[lines.length - 1])
      } catch {
        console.warn("[audit-trail] Truncating partial trailing line (crash recovery)")
        lines = lines.slice(0, -1)
        // Rewrite file without the partial line
        const truncated = lines.join("\n") + (lines.length > 0 ? "\n" : "")
        const { writeFile } = await import("node:fs/promises")
        await writeFile(this.filePath, truncated, "utf-8")
      }
    }

    if (lines.length === 0) return

    // Scan all records to reconstruct state
    let dualWriteCount = 0
    const maxDualWrite = parseInt(process.env.HASH_CHAIN_DUAL_WRITE_COUNT ?? "1000", 10)
    const effectiveMaxDualWrite = isNaN(maxDualWrite) ? 1000 : maxDualWrite

    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>
      this.seq = record.seq as number

      if (record.format === "bridge") {
        this.migrated = true
        this.lastHashProtocol = PROTOCOL_GENESIS_HASH
        this.lastHash = record.bridge_hash as string
        this.lastHashLegacy = record.bridge_hash as string  // Legacy pointer advances through bridge entry
      } else if (record.format === "protocol_v1") {
        this.lastHashProtocol = record.entry_hash as string
        if (record.prevHashLegacy !== undefined) {
          this.lastHashLegacy = record.entry_hash as string  // Advance legacy pointer through protocol entry
          dualWriteCount++
        }
        this.lastHash = record.entry_hash as string
      } else {
        // Legacy record
        this.lastHash = record.hash as string
        this.lastHashLegacy = record.hash as string
      }
    }

    // Compute dualWriteRemaining
    if (this.migrated) {
      this.dualWriteRemaining = Math.max(0, effectiveMaxDualWrite - dualWriteCount)
    }

    console.log(
      `[audit-trail] State recovered: seq=${this.seq} migrated=${this.migrated} dualWriteRemaining=${this.dualWriteRemaining}`,
    )
  }

  // ── Record methods ──────────────────────────────────────

  /** Append an intent phase record. Returns the assigned sequence number. (SDD §4.3) */
  async recordIntent(data: AuditRecordInput): Promise<number> {
    return this.appendRecord("intent", data)
  }

  /** Append a result phase record linked to an intent by intentSeq. (SDD §4.3) */
  async recordResult(intentSeq: number, data: AuditResultInput): Promise<number> {
    return this.appendRecord("result", data, intentSeq)
  }

  /** Append a denied phase record. (SDD §4.3) */
  async recordDenied(data: AuditRecordInput): Promise<number> {
    return this.appendRecord("denied", data)
  }

  /** Append a dry_run phase record. (SDD §4.3) */
  async recordDryRun(data: AuditRecordInput): Promise<number> {
    return this.appendRecord("dry_run", data)
  }

  // ── Chain verification ──────────────────────────────────

  /**
   * Read all records and verify hash chain integrity for legacy, bridge, and protocol_v1
   * records. Returns valid=true if every record's hash matches its canonical serialization
   * and every prevHash links to the prior record's hash. (SDD §4.3, §4.5, Task 3.7)
   */
  async verifyChain(): Promise<VerifyResult> {
    const errors: string[] = []
    let content: string
    try {
      content = await readFile(this.filePath, "utf-8")
    } catch {
      return { valid: true, errors: [] }
    }

    const lines = content.trim().split("\n").filter((l) => l.length > 0)
    if (lines.length === 0) return { valid: true, errors: [] }

    let expectedLegacyPrevHash = "genesis"
    let expectedProtocolPrevHash = PROTOCOL_GENESIS_HASH
    let seenBridge = false

    for (let i = 0; i < lines.length; i++) {
      let record: Record<string, unknown>
      try {
        record = JSON.parse(lines[i])
      } catch {
        errors.push(`Line ${i + 1}: invalid JSON`)
        continue
      }

      const format = record.format as string | undefined

      if (format === "bridge") {
        // Bridge entry verification
        const entry = record as unknown as BridgeEntry

        // Verify bridge links to legacy chain tip
        if (entry.legacy_chain_tip !== expectedLegacyPrevHash) {
          errors.push(
            `Line ${i + 1} (bridge seq ${entry.seq}): legacy_chain_tip mismatch — ` +
            `expected "${expectedLegacyPrevHash}", got "${entry.legacy_chain_tip}"`,
          )
        }

        // Verify bridge hash
        const expectedBridgeHash = computeBridgeHash(
          entry.legacy_chain_tip,
          entry.protocol_genesis,
          entry.ts,
          entry.seq,
        )
        if (expectedBridgeHash !== entry.bridge_hash) {
          errors.push(
            `Line ${i + 1} (bridge seq ${entry.seq}): bridge_hash mismatch — ` +
            `expected "${expectedBridgeHash}", got "${entry.bridge_hash}"`,
          )
        }

        seenBridge = true
        expectedLegacyPrevHash = entry.bridge_hash
        // Protocol chain starts fresh from genesis
        expectedProtocolPrevHash = PROTOCOL_GENESIS_HASH

      } else if (format === "protocol_v1") {
        // Protocol v1 envelope verification
        // Persisted record has: { ...envelope, seq, payload }
        const envelope = record as unknown as ProtocolEnvelope & { seq?: number; payload?: Record<string, unknown> }
        const recordSeq = record.seq as number

        // Verify protocol chain pointer
        if (envelope.prevHashProtocol !== expectedProtocolPrevHash) {
          errors.push(
            `Line ${i + 1} (protocol seq ${recordSeq}): prevHashProtocol mismatch — ` +
            `expected "${expectedProtocolPrevHash}", got "${envelope.prevHashProtocol}"`,
          )
        }

        // Verify legacy chain pointer during dual-write
        if (envelope.prevHashLegacy !== undefined) {
          if (envelope.prevHashLegacy !== expectedLegacyPrevHash) {
            errors.push(
              `Line ${i + 1} (protocol seq ${recordSeq}): prevHashLegacy mismatch — ` +
              `expected "${expectedLegacyPrevHash}", got "${envelope.prevHashLegacy}"`,
            )
          }
        }

        // Verify entry hash — use only SDD-specified canonical envelope fields
        const partial: Omit<ProtocolEnvelope, "entry_hash"> = {
          format: "protocol_v1",
          version: 1,
          algo: envelope.algo ?? "sha256" as const,
          timestamp: envelope.timestamp,
          action: envelope.action,
          payload_hash: envelope.payload_hash,
          prevHashProtocol: envelope.prevHashProtocol,
        }
        if (envelope.prevHashLegacy !== undefined) {
          partial.prevHashLegacy = envelope.prevHashLegacy
        }
        const expectedEntryHash = computeProtocolEntryHash(partial)
        if (expectedEntryHash !== envelope.entry_hash) {
          errors.push(
            `Line ${i + 1} (protocol seq ${recordSeq}): entry_hash mismatch — ` +
            `expected "${expectedEntryHash}", got "${envelope.entry_hash}"`,
          )
        }

        // Verify payload_hash if payload is embedded
        if (envelope.payload) {
          const expectedPayloadHash = computePayloadHash(envelope.payload)
          if (expectedPayloadHash !== envelope.payload_hash) {
            errors.push(
              `Line ${i + 1} (protocol seq ${recordSeq}): payload_hash mismatch`,
            )
          }
        }

        expectedProtocolPrevHash = envelope.entry_hash
        expectedLegacyPrevHash = envelope.entry_hash  // Legacy pointer advances through protocol entries

      } else {
        // Legacy record verification (existing logic)
        const legacyRecord = record as unknown as AuditRecord

        if (legacyRecord.prevHash !== expectedLegacyPrevHash) {
          errors.push(
            `Line ${i + 1} (seq ${legacyRecord.seq}): prevHash mismatch — ` +
            `expected "${expectedLegacyPrevHash}", got "${legacyRecord.prevHash}"`,
          )
        }

        const canonical_str = canonicalize(record)
        const expectedHash = createHash("sha256").update(canonical_str).digest("hex")

        if (legacyRecord.hash !== expectedHash) {
          errors.push(
            `Line ${i + 1} (seq ${legacyRecord.seq}): hash mismatch — ` +
            `expected "${expectedHash}", got "${legacyRecord.hash}"`,
          )
        }

        // Verify HMAC if present and key available
        if (legacyRecord.hmac && this.hmacKey) {
          const expectedHmac = createHmac("sha256", this.hmacKey).update(canonical_str).digest("hex")
          if (legacyRecord.hmac !== expectedHmac) {
            errors.push(`Line ${i + 1} (seq ${legacyRecord.seq}): HMAC mismatch`)
          }
        }

        expectedLegacyPrevHash = legacyRecord.hash
      }
    }

    return { valid: errors.length === 0, errors }
  }

  // ── Self-check ──────────────────────────────────────────

  /**
   * Append a self-check record and verify it can be read back. Useful as a
   * startup health check. (SDD §4.3)
   */
  async selfCheck(): Promise<boolean> {
    const savedContext = this.runContext
    this.runContext = {
      jobId: "_self_check",
      runUlid: "_self_check",
      templateId: "_self_check",
    }

    try {
      await this.appendRecord("intent", {
        action: "self_check",
        target: "self",
        params: {},
      })

      // Verify the chain still holds
      const result = await this.verifyChain()
      return result.valid
    } finally {
      this.runContext = savedContext
    }
  }

  // ── Shutdown ────────────────────────────────────────────

  /** Release single-writer lock and clean up resources. (SDD §4.3, §8.3) */
  async shutdown(): Promise<void> {
    await this.fileLock.release()
  }

  // ── File rotation ───────────────────────────────────────

  /** Check if the audit file exceeds the rotation threshold (10 MB). (SDD §4.3) */
  async shouldRotate(): Promise<boolean> {
    try {
      const st = await stat(this.filePath)
      return st.size > ROTATION_THRESHOLD_BYTES
    } catch {
      return false
    }
  }

  /** Rename the current file to a timestamped archive and reset chain state. (SDD §4.3) */
  async rotate(): Promise<string> {
    const ts = new Date(this.now()).toISOString().replace(/[:.]/g, "-")
    const rotatedPath = this.filePath.replace(/\.jsonl$/, `-${ts}.jsonl`)
    await rename(this.filePath, rotatedPath)
    this.seq = 0
    this.lastHash = "genesis"
    return rotatedPath
  }

  // ── Private helpers ─────────────────────────────────────

  /**
   * Core append logic: build a record, compute its hash (+ optional HMAC),
   * serialize to JSON, and append to the file. (SDD §4.3)
   * Post-migration: delegates to appendProtocolRecord() for protocol_v1 format.
   */
  private async appendRecord(
    phase: AuditPhase,
    data: AuditRecordInput | AuditResultInput,
    intentSeq?: number,
  ): Promise<number> {
    await this.mutex.acquire()
    try {
      if (this.quarantined) {
        throw new Error("[audit-trail] Write denied: trail is in quarantine mode (single-writer violation)")
      }

      // Check force-protocol-mode (SKP-002)
      if (this.migrated && !PROTOCOL_HASH_CHAIN_ENABLED) {
        console.error("[audit-trail] CRITICAL: PROTOCOL_HASH_CHAIN_ENABLED=false but migration already complete. Force-continuing in protocol mode.")
      }

      if (this.migrated) {
        return this.appendProtocolRecord(phase, data, intentSeq)
      }

      this.seq += 1
      const currentSeq = this.seq

      const redactedParams = redactSecrets(data.params)

      // Build the record object (hash and hmac will be computed below)
      const record: Record<string, unknown> = {
        seq: currentSeq,
        prevHash: this.lastHash,
        phase,
        ts: new Date(this.now()).toISOString(),
        jobId: this.runContext?.jobId ?? "",
        runUlid: this.runContext?.runUlid ?? "",
        templateId: this.runContext?.templateId ?? "",
        action: data.action,
        target: data.target,
        params: redactedParams,
        dryRun: data.dryRun ?? false,
      }

      if (intentSeq !== undefined) {
        record.intentSeq = intentSeq
      }
      if ("dedupeKey" in data && data.dedupeKey !== undefined) {
        record.dedupeKey = data.dedupeKey
      }
      if ("result" in data && data.result !== undefined) {
        record.result = data.result
      }
      if ("error" in data && data.error !== undefined) {
        record.error = data.error
      }
      if ("rateLimitRemaining" in data && data.rateLimitRemaining !== undefined) {
        record.rateLimitRemaining = data.rateLimitRemaining
      }

      // Compute hash from canonical serialization (excludes hash + hmac fields)
      const canonical = canonicalize(record)
      const hash = createHash("sha256").update(canonical).digest("hex")
      record.hash = hash

      // Compute HMAC if signing key is configured
      if (this.hmacKey) {
        record.hmac = createHmac("sha256", this.hmacKey).update(canonical).digest("hex")
      }

      // Append the JSON line to the file
      const line = JSON.stringify(record) + "\n"
      await appendFile(this.filePath, line, "utf-8")

      this.lastHash = hash
      return currentSeq
    } finally {
      this.mutex.release()
    }
  }

  /**
   * Append a protocol_v1 record (post-migration) (SDD §4.5, Task 3.5).
   * During dual-write: includes both prevHashProtocol and prevHashLegacy.
   * Post-dual-write: includes only prevHashProtocol.
   * NOTE: caller already holds mutex — do not re-acquire.
   */
  private async appendProtocolRecord(
    phase: AuditPhase,
    data: AuditRecordInput | AuditResultInput,
    intentSeq?: number,
  ): Promise<number> {
    this.seq += 1
    const currentSeq = this.seq
    const ts = new Date(this.now()).toISOString()

    const redactedParams = redactSecrets(data.params)

    // Build payload (same structure as legacy record body)
    const payload: Record<string, unknown> = {
      phase,
      jobId: this.runContext?.jobId ?? "",
      runUlid: this.runContext?.runUlid ?? "",
      templateId: this.runContext?.templateId ?? "",
      action: data.action,
      target: data.target,
      params: redactedParams,
      dryRun: data.dryRun ?? false,
    }
    if (intentSeq !== undefined) payload.intentSeq = intentSeq
    if ("dedupeKey" in data && data.dedupeKey !== undefined) payload.dedupeKey = data.dedupeKey
    if ("result" in data && data.result !== undefined) payload.result = data.result
    if ("error" in data && data.error !== undefined) payload.error = data.error
    if ("rateLimitRemaining" in data && data.rateLimitRemaining !== undefined) payload.rateLimitRemaining = data.rateLimitRemaining

    // Build envelope
    const prevHashLegacy = this.dualWriteRemaining > 0 ? this.lastHashLegacy : undefined
    const envelope = buildEnvelope(payload, data.action, this.lastHashProtocol, ts, prevHashLegacy)
    if (!envelope) {
      throw new Error("[audit-trail] Failed to build protocol_v1 envelope")
    }

    // Write envelope + seq (structural metadata) + embedded payload
    // seq is not part of the canonical envelope hash but is needed for state recovery
    const line = JSON.stringify({ ...envelope, seq: currentSeq, payload }) + "\n"
    await appendFile(this.filePath, line, "utf-8")

    // Update chain state
    this.lastHashProtocol = envelope.entry_hash
    this.lastHash = envelope.entry_hash
    if (this.dualWriteRemaining > 0) {
      this.lastHashLegacy = envelope.entry_hash
      this.dualWriteRemaining--
    }

    return currentSeq
  }
}
