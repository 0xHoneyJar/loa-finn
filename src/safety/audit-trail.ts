// src/safety/audit-trail.ts — Write-Ahead Audit Trail with hash-chained JSONL (SDD §4.3)
//
// Append-only JSONL audit trail with SHA-256 hash chaining, canonical serialization,
// optional HMAC-SHA256 signing, and intent-result pairing. Every GitHub mutation is
// logged before (intent) and after (result) execution. The hash chain provides tamper
// detection; HMAC provides authenticity when a signing key is configured.

import { createHmac, createHash } from "node:crypto"
import { appendFile, readFile, stat, rename } from "node:fs/promises"

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
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
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

  constructor(filePath: string, options?: AuditTrailOptions) {
    this.filePath = filePath
    this.hmacKey = options?.hmacKey
    this.now = options?.now ?? Date.now
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
   * Read all records and verify hash chain integrity. Returns valid=true if every
   * record's hash matches its canonical serialization and every prevHash links to
   * the prior record's hash. (SDD §4.3)
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

    let expectedPrevHash = "genesis"

    for (let i = 0; i < lines.length; i++) {
      let record: AuditRecord
      try {
        record = JSON.parse(lines[i])
      } catch {
        errors.push(`Line ${i + 1}: invalid JSON`)
        continue
      }

      // Verify prevHash linkage
      if (record.prevHash !== expectedPrevHash) {
        errors.push(
          `Line ${i + 1} (seq ${record.seq}): prevHash mismatch — ` +
          `expected "${expectedPrevHash}", got "${record.prevHash}"`,
        )
      }

      // Recompute hash from canonical serialization
      const canonical = canonicalize(record as unknown as Record<string, unknown>)
      const expectedHash = createHash("sha256").update(canonical).digest("hex")

      if (record.hash !== expectedHash) {
        errors.push(
          `Line ${i + 1} (seq ${record.seq}): hash mismatch — ` +
          `expected "${expectedHash}", got "${record.hash}"`,
        )
      }

      // Verify HMAC if present and key available
      if (record.hmac && this.hmacKey) {
        const expectedHmac = createHmac("sha256", this.hmacKey).update(canonical).digest("hex")
        if (record.hmac !== expectedHmac) {
          errors.push(
            `Line ${i + 1} (seq ${record.seq}): HMAC mismatch`,
          )
        }
      }

      expectedPrevHash = record.hash
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

  /** No-op — we use appendFile (no persistent fd to close). (SDD §4.3) */
  async shutdown(): Promise<void> {
    // Intentionally empty: appendFile opens/closes per write
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
   */
  private async appendRecord(
    phase: AuditPhase,
    data: AuditRecordInput | AuditResultInput,
    intentSeq?: number,
  ): Promise<number> {
    await this.mutex.acquire()
    try {
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
}
