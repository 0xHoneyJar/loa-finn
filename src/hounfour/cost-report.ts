// src/hounfour/cost-report.ts — Cost report generator (T-16.7)
// Reads JSONL ledger files, generates per-agent per-model per-provider spend breakdown.

import { readFile } from "node:fs/promises"
import type { LedgerEntry } from "./types.js"

export interface CostReportOptions {
  ledgerFiles: string[]
}

interface AgentBreakdown {
  agent: string
  provider: string
  model: string
  request_count: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_reasoning_tokens: number
  total_cost_usd: number
}

interface PhaseBreakdown {
  phase_id: string
  sprint_id: string
  request_count: number
  total_cost_usd: number
}

export interface CostReport {
  generated_at: string
  total_requests: number
  total_cost_usd: number
  avg_cost_per_request: number
  by_agent: AgentBreakdown[]
  by_phase: PhaseBreakdown[]
}

/** Parse all ledger files and aggregate into a cost report */
export async function generateCostReport(opts: CostReportOptions): Promise<CostReport> {
  const entries: LedgerEntry[] = []

  for (const file of opts.ledgerFiles) {
    try {
      const content = await readFile(file, "utf8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        try {
          entries.push(JSON.parse(line) as LedgerEntry)
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Aggregate by agent+provider+model
  const agentMap = new Map<string, AgentBreakdown>()
  for (const e of entries) {
    const key = `${e.agent}|${e.provider}|${e.model}`
    const existing = agentMap.get(key) ?? {
      agent: e.agent,
      provider: e.provider,
      model: e.model,
      request_count: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_reasoning_tokens: 0,
      total_cost_usd: 0,
    }
    existing.request_count++
    existing.total_prompt_tokens += e.prompt_tokens
    existing.total_completion_tokens += e.completion_tokens
    existing.total_reasoning_tokens += e.reasoning_tokens
    existing.total_cost_usd += e.total_cost_usd
    agentMap.set(key, existing)
  }

  // Aggregate by phase+sprint
  const phaseMap = new Map<string, PhaseBreakdown>()
  for (const e of entries) {
    const key = `${e.phase_id}|${e.sprint_id}`
    const existing = phaseMap.get(key) ?? {
      phase_id: e.phase_id,
      sprint_id: e.sprint_id,
      request_count: 0,
      total_cost_usd: 0,
    }
    existing.request_count++
    existing.total_cost_usd += e.total_cost_usd
    phaseMap.set(key, existing)
  }

  const totalCost = entries.reduce((sum, e) => sum + e.total_cost_usd, 0)

  return {
    generated_at: new Date().toISOString(),
    total_requests: entries.length,
    total_cost_usd: totalCost,
    avg_cost_per_request: entries.length > 0 ? totalCost / entries.length : 0,
    by_agent: Array.from(agentMap.values()).sort((a, b) => b.total_cost_usd - a.total_cost_usd),
    by_phase: Array.from(phaseMap.values()).sort((a, b) => a.phase_id.localeCompare(b.phase_id)),
  }
}

/** Format a cost report as markdown for embedding in sprint reports */
export function formatCostReportMarkdown(report: CostReport): string {
  const lines: string[] = [
    `# Cost Report`,
    ``,
    `> Generated: ${report.generated_at}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Requests | ${report.total_requests} |`,
    `| Total Cost | $${report.total_cost_usd.toFixed(4)} |`,
    `| Avg Cost/Request | $${report.avg_cost_per_request.toFixed(6)} |`,
    ``,
    `## By Agent`,
    ``,
    `| Agent | Provider | Model | Requests | Cost |`,
    `|-------|----------|-------|----------|------|`,
  ]

  for (const a of report.by_agent) {
    lines.push(`| ${a.agent} | ${a.provider} | ${a.model} | ${a.request_count} | $${a.total_cost_usd.toFixed(4)} |`)
  }

  lines.push(``, `## By Phase`, ``, `| Phase | Sprint | Requests | Cost |`, `|-------|--------|----------|------|`)
  for (const p of report.by_phase) {
    lines.push(`| ${p.phase_id} | ${p.sprint_id} | ${p.request_count} | $${p.total_cost_usd.toFixed(4)} |`)
  }

  return lines.join("\n")
}
