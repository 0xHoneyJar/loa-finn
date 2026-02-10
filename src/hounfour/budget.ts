// src/hounfour/budget.ts — Cost Ledger & Budget Enforcer (SDD §4.6, T-14.7)

import { writeFile, appendFile, readFile, rename, mkdir, stat, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, basename } from "node:path"
import { HounfourError } from "./errors.js"
import type {
  ScopeMeta,
  UsageInfo,
  PricingEntry,
  LedgerEntry,
  BudgetSnapshot,
} from "./types.js"

// --- Scope Key Derivation ---

export interface ScopeKeys {
  project: string
  phase: string
  sprint: string
}

/**
 * Canonical budget scope key derivation.
 * ALL budget operations (check, record, snapshot) use this function.
 */
export function deriveScopeKey(meta: ScopeMeta): ScopeKeys {
  return {
    project: `project:${meta.project_id}`,
    phase: `project:${meta.project_id}:phase:${meta.phase_id}`,
    sprint: `project:${meta.project_id}:phase:${meta.phase_id}:sprint:${meta.sprint_id}`,
  }
}

// --- Cost Calculation ---

/** Deterministic cost calculation from token usage and pricing */
export function calculateCost(usage: UsageInfo, pricing: PricingEntry): number {
  const inputCost = (usage.prompt_tokens * pricing.input_per_1m) / 1_000_000
  const outputCost = (usage.completion_tokens * pricing.output_per_1m) / 1_000_000
  const reasoningCost = pricing.reasoning_per_1m
    ? (usage.reasoning_tokens * pricing.reasoning_per_1m) / 1_000_000
    : 0
  return inputCost + outputCost + reasoningCost
}

// --- Budget Config ---

export interface BudgetConfig {
  ledgerPath: string                    // e.g., "data/hounfour/cost-ledger.jsonl"
  checkpointPath: string                // e.g., "data/hounfour/budget-checkpoint.json"
  onLedgerFailure: "fail-open" | "fail-closed"
  warnPercent: number                   // Default: 80
  budgets: Record<string, number>       // scope key → limit in USD
  rotation?: LedgerRotationConfig
}

export interface LedgerRotationConfig {
  maxSizeMb: number                     // Default: 50
  maxAgeDays: number                    // Default: 30
  archivePath: string                   // Default: "grimoires/loa/a2a/archive/cost-ledger/"
}

interface CheckpointFile {
  schema_version: 1
  updated_at: string
  counters: Record<string, number>
  ledger_head_line: number
}

// --- Budget Enforcer ---

export class BudgetEnforcer {
  private counters = new Map<string, number>()
  private commitMutex: Promise<void> = Promise.resolve()
  private ledgerLineCount = 0
  private config: BudgetConfig
  private ledgerFailureStart: number | null = null
  private ledgerFailureCount = 0
  private budgetStateUnknown = false

  constructor(config: BudgetConfig) {
    this.config = config
  }

  /** Initialize from checkpoint file (O(1) startup) */
  async initFromCheckpoint(): Promise<void> {
    if (!existsSync(this.config.checkpointPath)) return

    try {
      const raw = await readFile(this.config.checkpointPath, "utf8")
      const checkpoint: CheckpointFile = JSON.parse(raw)

      if (checkpoint.schema_version !== 1) {
        console.warn("[budget] Unknown checkpoint schema version, starting fresh")
        return
      }

      for (const [key, value] of Object.entries(checkpoint.counters)) {
        this.counters.set(key, value)
      }
      this.ledgerLineCount = checkpoint.ledger_head_line
      console.log(`[budget] Restored ${this.counters.size} counters from checkpoint (ledger line ${this.ledgerLineCount})`)
    } catch (err) {
      console.warn("[budget] Failed to read checkpoint, starting fresh:", err)
    }
  }

  /**
   * Record cost after successful model invocation.
   * Write-ahead commit: ledger append → checkpoint write → counter update (SKP-005)
   */
  async recordCost(
    scopeMeta: ScopeMeta,
    usage: UsageInfo,
    pricing: PricingEntry,
    extraFields: { trace_id: string; agent: string; provider: string; model: string; tenant_id: string; nft_id?: string; pool_id?: string; latency_ms: number },
  ): Promise<void> {
    const costUsd = calculateCost(usage, pricing)
    const keys = deriveScopeKey(scopeMeta)

    const inputCostUsd = (usage.prompt_tokens * pricing.input_per_1m) / 1_000_000
    const outputCostUsd = (usage.completion_tokens * pricing.output_per_1m) / 1_000_000

    const entry: LedgerEntry = {
      timestamp: new Date().toISOString(),
      trace_id: extraFields.trace_id,
      agent: extraFields.agent,
      provider: extraFields.provider,
      model: extraFields.model,
      project_id: scopeMeta.project_id,
      phase_id: scopeMeta.phase_id,
      sprint_id: scopeMeta.sprint_id,
      tenant_id: extraFields.tenant_id,
      nft_id: extraFields.nft_id,
      pool_id: extraFields.pool_id,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      reasoning_tokens: usage.reasoning_tokens,
      input_cost_usd: inputCostUsd,
      output_cost_usd: outputCostUsd,
      total_cost_usd: costUsd,
      latency_ms: extraFields.latency_ms,
    }

    this.commitMutex = this.commitMutex.then(async () => {
      try {
        // Step 1: Append JSONL ledger entry
        await this.appendLedgerLine(entry)

        // Step 2: Write checkpoint atomically
        this.ledgerLineCount++
        const checkpointCounters: Record<string, number> = {}
        for (const key of [keys.project, keys.phase, keys.sprint]) {
          checkpointCounters[key] = (this.counters.get(key) ?? 0) + costUsd
        }
        // Merge existing counters not in this scope
        for (const [k, v] of this.counters) {
          if (!(k in checkpointCounters)) {
            checkpointCounters[k] = v
          }
        }
        await this.writeCheckpoint({
          schema_version: 1,
          updated_at: new Date().toISOString(),
          counters: checkpointCounters,
          ledger_head_line: this.ledgerLineCount,
        })

        // Step 3: Update in-memory counters
        this.increment(keys.project, costUsd)
        this.increment(keys.phase, costUsd)
        this.increment(keys.sprint, costUsd)

        // Clear failure tracking on success
        this.ledgerFailureStart = null
        this.ledgerFailureCount = 0
        this.budgetStateUnknown = false
      } catch (err) {
        this.ledgerFailureCount++
        if (this.ledgerFailureStart === null) {
          this.ledgerFailureStart = Date.now()
        }

        // Check for >5min consecutive failures → health degradation
        const failureDuration = Date.now() - this.ledgerFailureStart
        if (failureDuration > 5 * 60 * 1000) {
          console.error(`[budget] HEALTH DEGRADATION: Ledger writes failing for ${Math.round(failureDuration / 1000)}s (${this.ledgerFailureCount} failures)`)
        }

        this.budgetStateUnknown = true

        if (this.config.onLedgerFailure === "fail-open") {
          console.error("[budget] Ledger write failed (fail-open), counters NOT updated:", err)
          return
        }

        // fail-closed: throw to reject the request
        throw new HounfourError("METERING_UNAVAILABLE", "Ledger write failed (fail-closed mode)", {
          error: String(err),
          failureCount: this.ledgerFailureCount,
        })
      }
    })

    await this.commitMutex
  }

  /** Check if any budget scope is exceeded */
  isExceeded(scopeMeta: ScopeMeta): boolean {
    const keys = deriveScopeKey(scopeMeta)
    return this.checkThreshold(keys.project, 100)
      || this.checkThreshold(keys.phase, 100)
      || this.checkThreshold(keys.sprint, 100)
  }

  /** Check if any budget scope is at warning level */
  isWarning(scopeMeta: ScopeMeta): boolean {
    const keys = deriveScopeKey(scopeMeta)
    return this.checkThreshold(keys.project, this.config.warnPercent)
      || this.checkThreshold(keys.phase, this.config.warnPercent)
      || this.checkThreshold(keys.sprint, this.config.warnPercent)
  }

  /** Get budget snapshot for dashboard/health */
  getBudgetSnapshot(scopeMeta: ScopeMeta): BudgetSnapshot {
    const keys = deriveScopeKey(scopeMeta)
    // Use the most specific scope (sprint) for the snapshot
    const scopeKey = keys.sprint
    const spent = this.counters.get(scopeKey) ?? 0
    const limit = this.config.budgets[scopeKey] ?? this.config.budgets[keys.phase] ?? this.config.budgets[keys.project] ?? 0

    const percentUsed = limit > 0 ? (spent / limit) * 100 : 0

    return {
      scope: scopeKey,
      spent_usd: spent,
      limit_usd: limit,
      percent_used: percentUsed,
      warning: limit > 0 && percentUsed >= this.config.warnPercent,
      exceeded: limit > 0 && percentUsed >= 100,
    }
  }

  /** Whether budget state is unknown due to ledger failures */
  isStateUnknown(): boolean {
    return this.budgetStateUnknown
  }

  /**
   * Rotate ledger if size or age thresholds exceeded (T-16.5).
   * Called automatically during appendLedgerLine, or manually.
   * Returns the archive path if rotated, undefined otherwise.
   */
  async rotateLedgerIfNeeded(): Promise<string | undefined> {
    const rotation = this.config.rotation
    if (!rotation) return undefined
    if (!existsSync(this.config.ledgerPath)) return undefined

    try {
      const fileStat = await stat(this.config.ledgerPath)
      const sizeMb = fileStat.size / (1024 * 1024)
      const ageDays = (Date.now() - fileStat.mtimeMs) / (1000 * 60 * 60 * 24)

      const needsRotation = sizeMb >= rotation.maxSizeMb || ageDays >= rotation.maxAgeDays
      if (!needsRotation) return undefined

      // Generate archive filename: cost-ledger-{date}-{seq}.jsonl
      const archiveDir = rotation.archivePath
      if (!existsSync(archiveDir)) {
        await mkdir(archiveDir, { recursive: true })
      }

      const dateStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
      const seq = await this.nextArchiveSeq(archiveDir, dateStr)
      const archiveName = `cost-ledger-${dateStr}-${String(seq).padStart(3, "0")}.jsonl`
      const archivePath = join(archiveDir, archiveName)

      await rename(this.config.ledgerPath, archivePath)
      console.log(`[budget] Ledger rotated: ${archivePath} (${sizeMb.toFixed(1)}MB, ${ageDays.toFixed(0)} days old)`)
      return archivePath
    } catch (err) {
      console.error("[budget] Ledger rotation failed:", err)
      return undefined
    }
  }

  /**
   * List all ledger files (current + rotated archives).
   * Used by /cost-report to aggregate across all ledger files.
   */
  async listAllLedgerFiles(): Promise<string[]> {
    const files: string[] = []

    // Current ledger
    if (existsSync(this.config.ledgerPath)) {
      files.push(this.config.ledgerPath)
    }

    // Archives
    const rotation = this.config.rotation
    if (rotation && existsSync(rotation.archivePath)) {
      const entries = await readdir(rotation.archivePath)
      const archives = entries
        .filter(f => f.startsWith("cost-ledger-") && f.endsWith(".jsonl"))
        .sort()
        .map(f => join(rotation.archivePath, f))
      files.push(...archives)
    }

    return files
  }

  // --- Private helpers ---

  private increment(key: string, amount: number): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount)
  }

  private checkThreshold(scopeKey: string, thresholdPercent: number): boolean {
    const spent = this.counters.get(scopeKey) ?? 0
    const limit = this.config.budgets[scopeKey]
    if (!limit || limit <= 0) return false
    return (spent / limit) * 100 >= thresholdPercent
  }

  private async appendLedgerLine(entry: LedgerEntry): Promise<void> {
    const dir = dirname(this.config.ledgerPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    // Check rotation before appending
    await this.rotateLedgerIfNeeded()

    const line = JSON.stringify(entry) + "\n"
    await appendFile(this.config.ledgerPath, line, "utf8")
  }

  private async nextArchiveSeq(archiveDir: string, dateStr: string): Promise<number> {
    try {
      const entries = await readdir(archiveDir)
      const prefix = `cost-ledger-${dateStr}-`
      const seqs = entries
        .filter(f => f.startsWith(prefix) && f.endsWith(".jsonl"))
        .map(f => {
          const seqStr = f.slice(prefix.length, f.length - ".jsonl".length)
          return parseInt(seqStr, 10)
        })
        .filter(n => !isNaN(n))
      return seqs.length > 0 ? Math.max(...seqs) + 1 : 1
    } catch {
      return 1
    }
  }

  private async writeCheckpoint(checkpoint: CheckpointFile): Promise<void> {
    const dir = dirname(this.config.checkpointPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
    const tempPath = this.config.checkpointPath + ".tmp"
    await writeFile(tempPath, JSON.stringify(checkpoint, null, 2), "utf8")
    await rename(tempPath, this.config.checkpointPath)
  }
}
