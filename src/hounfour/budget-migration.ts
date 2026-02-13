// src/hounfour/budget-migration.ts — Budget Migration v1→v2 (SDD §4.3, Task 2.3)
//
// Migrates from floating-point USD to integer micro-USD across JSONL and Redis.
// Supports dual-write during migration, verification, and rollback documentation.

import { readFile, writeFile, rename } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { LedgerEntry, LedgerEntryV2 } from "./types.js"
import { stampCrc32, LedgerV2 } from "./ledger-v2.js"
import type { RedisStateBackend } from "./redis/client.js"

// --- Types ---

/** Result of converting a single v1 entry to v2. */
export interface ConversionResult {
  v2Entry: LedgerEntryV2
  originalCostUsd: number
  convertedMicro: bigint
  roundingErrorMicro: number
}

/** Result of a full migration run. */
export interface MigrationResult {
  status: "success" | "verification_failed" | "error"
  entriesConverted: number
  entriesSkipped: number
  totalV1CostUsd: number
  totalV2CostMicro: bigint
  maxRoundingErrorMicro: number
  verificationPassed: boolean
  v2LedgerPath: string
  backupPath: string
  errors: string[]
}

/** Options for migration. */
export interface MigrationOptions {
  /** V1 ledger file path (source). */
  v1LedgerPath: string
  /** V2 ledger base directory. */
  v2BaseDir: string
  /** Redis backend for counter migration (optional). */
  redis?: RedisStateBackend
  /** Whether to keep the v1 file after migration. Default: true (rename to .bak). */
  keepBackup?: boolean
  /** Dry run — convert but don't write. Default: false. */
  dryRun?: boolean
}

// --- Conversion ---

/**
 * Convert a v1 ledger entry (float USD) to v2 (integer micro-USD).
 *
 * Conversion: total_cost_usd * 1_000_000 with Math.round()
 * Rounding error is at most 0.5 micro-USD per entry.
 */
export function convertV1ToV2(v1: LedgerEntry): ConversionResult {
  const inputMicro = Math.round((v1.input_cost_usd ?? 0) * 1_000_000)
  const outputMicro = Math.round((v1.output_cost_usd ?? 0) * 1_000_000)
  // V1 has no separate reasoning cost — it's folded into output
  const reasoningMicro = 0
  const totalMicro = Math.round(v1.total_cost_usd * 1_000_000)

  // Compute rounding error: |v1_usd * 1M - rounded_micro|
  const exactMicro = v1.total_cost_usd * 1_000_000
  const roundingErrorMicro = Math.abs(exactMicro - totalMicro)

  const v2Entry: LedgerEntryV2 = {
    schema_version: 2,
    timestamp: v1.timestamp,
    trace_id: v1.trace_id,
    agent: v1.agent,
    provider: v1.provider,
    model: v1.model,
    project_id: v1.project_id,
    phase_id: v1.phase_id,
    sprint_id: v1.sprint_id,
    tenant_id: v1.tenant_id,
    nft_id: v1.nft_id,
    pool_id: v1.pool_id,
    ensemble_id: v1.ensemble_id,
    prompt_tokens: v1.prompt_tokens,
    completion_tokens: v1.completion_tokens,
    reasoning_tokens: v1.reasoning_tokens,
    input_cost_micro: String(inputMicro),
    output_cost_micro: String(outputMicro),
    reasoning_cost_micro: String(reasoningMicro),
    total_cost_micro: String(totalMicro),
    price_table_version: 1,
    billing_method: "reconciled",
    latency_ms: v1.latency_ms,
  }

  return {
    v2Entry,
    originalCostUsd: v1.total_cost_usd,
    convertedMicro: BigInt(totalMicro),
    roundingErrorMicro,
  }
}

/**
 * Verify migration accuracy: compare v1 total (USD) vs v2 total (micro-USD).
 * Passes if difference ≤ 1 micro-USD per entry (rounding tolerance).
 */
export function verifyMigration(
  totalV1Usd: number,
  totalV2Micro: bigint,
  entryCount: number,
): { passed: boolean; driftMicro: bigint; maxAllowedDriftMicro: bigint } {
  // BB-063-012: Guard against precision loss when totalV1Usd * 1_000_000
  // exceeds Number.MAX_SAFE_INTEGER (~$9.007B). Beyond that boundary,
  // Math.round silently loses precision, making drift verification unreliable.
  if (totalV1Usd * 1_000_000 > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `BUDGET_MIGRATION_PRECISION: totalV1Usd ${totalV1Usd} exceeds safe integer boundary for micro-USD conversion`,
    )
  }
  const expectedMicro = BigInt(Math.round(totalV1Usd * 1_000_000))
  const drift = totalV2Micro > expectedMicro
    ? totalV2Micro - expectedMicro
    : expectedMicro - totalV2Micro

  // Allow 1 micro-USD per entry (rounding accumulation tolerance)
  const maxAllowedDriftMicro = BigInt(entryCount)

  return {
    passed: drift <= maxAllowedDriftMicro,
    driftMicro: drift,
    maxAllowedDriftMicro,
  }
}

// --- Migration ---

/**
 * Migrate a v1 JSONL ledger file to v2 format.
 *
 * Process:
 *   1. Read all v1 entries from source file
 *   2. Convert each to v2 format (micro-USD)
 *   3. Verify totals are within tolerance
 *   4. Write v2 entries to per-tenant v2 ledger files
 *   5. Optionally migrate Redis counters (INCRBYFLOAT → INCRBY)
 *   6. Back up original v1 file
 */
export async function migrateV1ToV2(options: MigrationOptions): Promise<MigrationResult> {
  const errors: string[] = []
  const result: MigrationResult = {
    status: "success",
    entriesConverted: 0,
    entriesSkipped: 0,
    totalV1CostUsd: 0,
    totalV2CostMicro: 0n,
    maxRoundingErrorMicro: 0,
    verificationPassed: false,
    v2LedgerPath: options.v2BaseDir,
    backupPath: `${options.v1LedgerPath}.v1.bak`,
    errors,
  }

  // --- Step 1: Read v1 ledger ---
  if (!existsSync(options.v1LedgerPath)) {
    result.status = "error"
    errors.push(`V1 ledger not found: ${options.v1LedgerPath}`)
    return result
  }

  const raw = await readFile(options.v1LedgerPath, "utf8")
  const lines = raw.split("\n").filter(l => l.trim() !== "")

  // --- Step 2: Convert entries ---
  const v2Ledger = new LedgerV2({ baseDir: options.v2BaseDir, fsync: false })
  const tenantTotals = new Map<string, bigint>()

  for (let i = 0; i < lines.length; i++) {
    try {
      const v1Entry = JSON.parse(lines[i]) as LedgerEntry

      // Skip entries that are already v2 (dual-write scenario)
      if ((v1Entry as any).schema_version === 2) {
        result.entriesSkipped++
        continue
      }

      const conversion = convertV1ToV2(v1Entry)
      result.totalV1CostUsd += conversion.originalCostUsd
      result.totalV2CostMicro += conversion.convertedMicro
      result.maxRoundingErrorMicro = Math.max(
        result.maxRoundingErrorMicro,
        conversion.roundingErrorMicro,
      )

      if (!options.dryRun) {
        const tenantId = v1Entry.tenant_id || "local"
        await v2Ledger.append(tenantId, conversion.v2Entry)

        // Track per-tenant totals for Redis migration
        const prev = tenantTotals.get(tenantId) ?? 0n
        tenantTotals.set(tenantId, prev + conversion.convertedMicro)
      }

      result.entriesConverted++
    } catch (err) {
      result.entriesSkipped++
      errors.push(`Line ${i + 1}: ${err}`)
    }
  }

  // --- Step 3: Verify totals ---
  const verification = verifyMigration(
    result.totalV1CostUsd,
    result.totalV2CostMicro,
    result.entriesConverted,
  )
  result.verificationPassed = verification.passed

  if (!verification.passed) {
    result.status = "verification_failed"
    errors.push(
      `Verification failed: drift ${verification.driftMicro} micro-USD exceeds max ${verification.maxAllowedDriftMicro} micro-USD`
    )
    return result
  }

  if (options.dryRun) return result

  // --- Step 4: Migrate Redis counters ---
  if (options.redis?.isConnected()) {
    try {
      await migrateRedisCounters(options.redis, tenantTotals)
    } catch (err) {
      errors.push(`Redis migration warning: ${err}`)
      // Non-fatal — JSONL is authoritative, Redis can be recomputed
    }
  }

  // --- Step 5: Back up v1 file ---
  if (options.keepBackup !== false) {
    try {
      await rename(options.v1LedgerPath, result.backupPath)
    } catch (err) {
      errors.push(`Backup rename failed: ${err}`)
    }
  }

  return result
}

/**
 * Migrate Redis budget counters from float to integer.
 * Sets each tenant's spent_micro key to the v2 total from JSONL conversion.
 */
async function migrateRedisCounters(
  redis: RedisStateBackend,
  tenantTotals: Map<string, bigint>,
): Promise<void> {
  const client = redis.getClient()

  for (const [tenantId, totalMicro] of tenantTotals) {
    const key = redis.key("budget", `${tenantId}:spent_micro`)
    await client.set(key, totalMicro.toString())
  }
}

// --- Dual-Write Helper ---

/**
 * Create a v2 entry from a v1 entry for dual-write during migration period.
 * Used by the budget enforcer to write both formats simultaneously.
 */
export function dualWriteV2(v1: LedgerEntry): LedgerEntryV2 {
  return convertV1ToV2(v1).v2Entry
}

// --- Rollback Documentation ---

/**
 * Rollback procedure (for documentation/manual execution):
 *
 * 1. Stop loa-finn service
 * 2. Restore v1 ledger:
 *    mv data/hounfour/cost-ledger.jsonl.v1.bak data/hounfour/cost-ledger.jsonl
 * 3. Revert Redis counters:
 *    For each tenant: DEL finn:hounfour:budget:{tenant}:spent_micro
 *    Then restart service — counters rebuild from v1 checkpoint
 * 4. Remove v2 ledger files:
 *    rm -rf data/ledger/{tenant_id}/
 * 5. Restart loa-finn service
 *
 * The rollback is safe because:
 * - v1 .bak file preserves original data
 * - Redis counters are derived (recomputed from checkpoint on startup)
 * - v2 ledger files are independent (removing them doesn't affect v1)
 */
