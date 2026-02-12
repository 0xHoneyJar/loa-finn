// src/hounfour/ensemble-cost-attribution.ts — Ensemble Cost Attribution (SDD §4.6, Task 3.8)
//
// Cancelled branch billing with 3-tier fallback, per-model ledger entries,
// ensemble_id linking. Works with both streaming and non-streaming ensemble results.

import type { LedgerEntryV2 } from "./types.js"
import type { StreamCostResult, BillingMethod } from "./stream-cost.js"
import type { EnsembleStreamingBranchResult, EnsembleStreamingFinalResult } from "./ensemble.js"
import type { MicroPricingEntry } from "./pricing.js"

// --- Types ---

/** Context for building ensemble ledger entries */
export interface EnsembleLedgerContext {
  tenantId: string
  projectId: string
  phaseId: string
  sprintId: string
  agent: string
  priceTableVersion: number
}

/** Per-branch ledger entry with billing method */
export interface EnsembleBranchLedgerEntry {
  entry: LedgerEntryV2
  branch_index: number
  billing_method: BillingMethod
}

// --- Functions ---

/**
 * Build per-model LedgerEntryV2 records from a streaming ensemble result.
 *
 * Each branch gets its own JSONL entry linked by ensemble_id.
 * Billing method per branch follows the 3-tier policy:
 *   1. provider_reported — provider sent terminal usage event
 *   2. observed_chunks_overcount — observed chunks + 10% margin
 *   3. prompt_only — no usage and no chunks (cancelled before any output)
 *
 * @param result - Streaming ensemble result with per-branch cost data
 * @param context - Tenant/project context for ledger fields
 * @param pricings - Per-pool pricing entries (same order as pools)
 * @returns Array of per-branch ledger entries
 */
export function buildStreamingEnsembleLedgerEntries(
  result: EnsembleStreamingFinalResult,
  context: EnsembleLedgerContext,
  pricings: Map<string, MicroPricingEntry>,
): EnsembleBranchLedgerEntry[] {
  const entries: EnsembleBranchLedgerEntry[] = []

  for (let i = 0; i < result.branches.length; i++) {
    const branch = result.branches[i]
    const cost = branch.cost
    const pricing = pricings.get(branch.pool)

    // Determine billing amounts from StreamCostResult
    let promptTokens = 0
    let completionTokens = 0
    let reasoningTokens = 0
    let totalCostMicro = 0n
    let billingMethod: BillingMethod = "prompt_only"

    if (cost) {
      promptTokens = cost.prompt_tokens
      completionTokens = cost.completion_tokens
      reasoningTokens = cost.reasoning_tokens
      totalCostMicro = cost.total_cost_micro
      billingMethod = cost.billing_method
    }

    // Compute input/output/reasoning cost breakdown
    let inputCostMicro = 0n
    let outputCostMicro = 0n
    let reasoningCostMicro = 0n

    if (pricing) {
      inputCostMicro = BigInt(promptTokens) * BigInt(pricing.input_micro_per_million) / 1_000_000n
      outputCostMicro = BigInt(completionTokens) * BigInt(pricing.output_micro_per_million) / 1_000_000n
      if (pricing.reasoning_micro_per_million) {
        reasoningCostMicro = BigInt(reasoningTokens) * BigInt(pricing.reasoning_micro_per_million) / 1_000_000n
      }
    }

    const entry: LedgerEntryV2 = {
      schema_version: 2,
      timestamp: new Date().toISOString(),
      trace_id: `${result.ensemble_id}-branch-${i}`,
      agent: context.agent,
      provider: branch.pool,
      model: branch.pool,
      project_id: context.projectId,
      phase_id: context.phaseId,
      sprint_id: context.sprintId,
      tenant_id: context.tenantId,
      ensemble_id: result.ensemble_id,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      reasoning_tokens: reasoningTokens,
      input_cost_micro: inputCostMicro.toString(),
      output_cost_micro: outputCostMicro.toString(),
      reasoning_cost_micro: reasoningCostMicro.toString(),
      total_cost_micro: totalCostMicro.toString(),
      price_table_version: context.priceTableVersion,
      billing_method: billingMethod,
      latency_ms: branch.latency_ms,
    }

    entries.push({
      entry,
      branch_index: i,
      billing_method: billingMethod,
    })
  }

  return entries
}

/**
 * Validate that all branches in an ensemble are properly billed.
 *
 * @param entries - Ledger entries to validate
 * @returns Validation result with any issues found
 */
export function validateEnsembleBilling(
  entries: EnsembleBranchLedgerEntry[],
): { valid: boolean; issues: string[] } {
  const issues: string[] = []

  if (entries.length === 0) {
    issues.push("No branch entries")
    return { valid: false, issues }
  }

  // Check all entries share the same ensemble_id
  const ensembleIds = new Set(entries.map((e) => e.entry.ensemble_id))
  if (ensembleIds.size > 1) {
    issues.push(`Multiple ensemble_ids: ${[...ensembleIds].join(", ")}`)
  }

  // Check billing method validity per branch status
  for (const { entry, billing_method } of entries) {
    const validMethods: BillingMethod[] = [
      "provider_reported",
      "byte_estimated",
      "observed_chunks_overcount",
      "prompt_only",
    ]
    if (!validMethods.includes(billing_method)) {
      issues.push(`Invalid billing_method "${billing_method}" for branch ${entry.trace_id}`)
    }

    // Validate cost is non-negative
    const totalCost = BigInt(entry.total_cost_micro)
    if (totalCost < 0n) {
      issues.push(`Negative total_cost_micro for branch ${entry.trace_id}`)
    }
  }

  return { valid: issues.length === 0, issues }
}

/**
 * Compute total ensemble cost from branch ledger entries.
 * Used for budget reconciliation.
 */
export function computeEnsembleTotalCost(entries: EnsembleBranchLedgerEntry[]): bigint {
  return entries.reduce((sum, e) => sum + BigInt(e.entry.total_cost_micro), 0n)
}
