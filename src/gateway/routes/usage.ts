// src/gateway/routes/usage.ts — Usage endpoint handler (SDD §3.1, cycle-024 T2)
// Streaming JSONL ledger query that returns pre-settlement usage data for the
// authenticated tenant. Uses readline for line-by-line parsing (never readFile).

import { createReadStream, existsSync } from "node:fs"
import { createInterface } from "node:readline"
import type { Context } from "hono"
import type { TenantContext } from "../../hounfour/jwt-auth.js"

const MAX_DAYS = 90
const DEFAULT_DAYS = 7

interface ByModelEntry {
  provider: string
  model: string
  requests: number
  total_cost_micro: bigint
  prompt_tokens: number
  completion_tokens: number
}

/**
 * Create the GET /api/v1/usage handler.
 *
 * Reads the JSONL cost ledger line-by-line, filtering by tenant_id and date range.
 * Aggregates cost by provider:model. All cost values returned as string (BigInt safety).
 */
export function createUsageHandler(ledgerPath: string) {
  return async (c: Context) => {
    const tenant = c.get("tenant") as TenantContext | undefined
    if (!tenant) {
      return c.json({ error: "Unauthorized", code: "TENANT_CONTEXT_MISSING" }, 401)
    }

    const tenantId = tenant.claims.tenant_id

    // Parse and validate days parameter
    const daysParam = c.req.query("days")
    let days = DEFAULT_DAYS
    if (daysParam !== undefined) {
      const parsed = parseInt(daysParam, 10)
      if (Number.isNaN(parsed) || parsed < 1) {
        return c.json({ error: "days must be a positive integer", code: "INVALID_REQUEST" }, 400)
      }
      days = Math.min(parsed, MAX_DAYS)
    }

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffIso = cutoff.toISOString()
    const cutoffMs = cutoff.getTime()

    // Handle missing or empty ledger gracefully
    if (!existsSync(ledgerPath)) {
      return c.json({
        tenant_id: tenantId,
        period: { days, from: cutoffIso, to: new Date().toISOString() },
        total_cost_micro: "0",
        total_requests: 0,
        by_model: [],
        settlement_status: "pre_settlement",
      })
    }

    // Stream-parse ledger line by line
    const byModel = new Map<string, ByModelEntry>()
    let totalCostMicro = 0n
    let totalRequests = 0

    const stream = createReadStream(ledgerPath, { encoding: "utf-8" })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    try {
      for await (const line of rl) {
        if (!line.trim()) continue

        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line)
        } catch {
          continue // skip corrupt lines
        }

        // Tenant isolation: only show this tenant's data
        if (entry.tenant_id !== tenantId) continue

        // Date filter — parse timestamp robustly, skip invalid entries
        const timestamp = entry.timestamp
        const tsMs = typeof timestamp === "number" ? timestamp : Date.parse(String(timestamp ?? ""))
        if (!Number.isFinite(tsMs)) continue
        if (tsMs < cutoffMs) continue

        // Extract cost — support both V1 (float USD) and V2 (string micro-USD)
        let costMicro: bigint
        if (entry.schema_version === 2 && typeof entry.total_cost_micro === "string") {
          try {
            costMicro = BigInt(entry.total_cost_micro)
          } catch {
            costMicro = 0n
          }
        } else if (typeof entry.total_cost_usd === "number") {
          // V1: convert float USD to micro-USD (best-effort)
          costMicro = BigInt(Math.round(entry.total_cost_usd * 1_000_000))
        } else {
          costMicro = 0n
        }

        const provider = (entry.provider as string) ?? "unknown"
        const model = (entry.model as string) ?? "unknown"
        const key = `${provider}:${model}`

        // Safe token extraction — ensure numeric values
        const promptTokens = Number(entry.prompt_tokens)
        const completionTokens = Number(entry.completion_tokens)
        const safePrompt = Number.isFinite(promptTokens) ? promptTokens : 0
        const safeCompletion = Number.isFinite(completionTokens) ? completionTokens : 0

        const existing = byModel.get(key)
        if (existing) {
          existing.requests++
          existing.total_cost_micro += costMicro
          existing.prompt_tokens += safePrompt
          existing.completion_tokens += safeCompletion
        } else {
          byModel.set(key, {
            provider,
            model,
            requests: 1,
            total_cost_micro: costMicro,
            prompt_tokens: safePrompt,
            completion_tokens: safeCompletion,
          })
        }

        totalCostMicro += costMicro
        totalRequests++
      }
    } catch (err) {
      console.error("[usage] ledger read error:", err)
      return c.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500)
    } finally {
      rl.close()
      stream.destroy()
    }

    return c.json({
      tenant_id: tenantId,
      period: { days, from: cutoffIso, to: new Date().toISOString() },
      total_cost_micro: totalCostMicro.toString(),
      total_requests: totalRequests,
      by_model: Array.from(byModel.values()).map((e) => ({
        provider: e.provider,
        model: e.model,
        requests: e.requests,
        total_cost_micro: e.total_cost_micro.toString(),
        prompt_tokens: e.prompt_tokens,
        completion_tokens: e.completion_tokens,
      })),
      settlement_status: "pre_settlement",
    })
  }
}
