// src/cron/dry-run.ts — Dry-Run Interceptor for agent jobs (SDD §4.2, Layer 4)
//
// Wraps tool calls during job execution: read tools pass through normally
// (needed for item resolution), write tools are intercepted and return
// simulated success. All intercepted calls are tracked for audit.

import { getToolCapability } from "../safety/tool-registry.js"
import type { ToolCapability } from "../safety/tool-registry.js"

// ── Types ───────────────────────────────────────────────────

/** Record of a single intercepted write-tool call. */
export interface InterceptedCall {
  toolName: string
  params: Record<string, unknown>
  capability: ToolCapability
  timestamp: string
}

/** Simulated success response returned for intercepted write tools. */
export interface DryRunResult {
  dryRun: true
  tool: string
  params: Record<string, unknown>
  message: string
}

// ── DryRunInterceptor ───────────────────────────────────────

/**
 * Intercepts write-capability tool calls during dry-run mode.
 *
 * Read tools execute normally (required for PR/issue resolution).
 * Write tools return a simulated success without calling the GitHub API.
 * All intercepted calls are recorded for audit verification.
 */
export class DryRunInterceptor {
  private readonly interceptedCalls: InterceptedCall[] = []
  private readonly now: () => number

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now
  }

  /**
   * Intercept a tool call. Read tools pass through (returns undefined),
   * write/admin tools return a simulated DryRunResult.
   */
  intercept(toolName: string, params: Record<string, unknown>): DryRunResult | undefined {
    const capability = getToolCapability(toolName)

    // Unknown tools: let the firewall handle denial (don't intercept)
    if (!capability) return undefined

    // Read tools: pass through for normal execution
    if (capability === "read") return undefined

    // Write and admin tools: record and return simulated success
    this.interceptedCalls.push({
      toolName,
      params,
      capability,
      timestamp: new Date(this.now()).toISOString(),
    })

    return {
      dryRun: true,
      tool: toolName,
      params,
      message: `Write intercepted in dry-run mode`,
    }
  }

  /** Returns all calls that were intercepted (write/admin tools only). */
  getInterceptedCalls(): readonly InterceptedCall[] {
    return this.interceptedCalls
  }

  /** Returns the count of intercepted calls. */
  get count(): number {
    return this.interceptedCalls.length
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** Classify whether a tool is a write tool based on the registry. */
export function isWriteTool(toolName: string): boolean {
  const cap = getToolCapability(toolName)
  return cap === "write" || cap === "admin"
}

/**
 * Assert that an audit trail contains zero actual write executions.
 * Checks that every write-capability action in the trail has dryRun: true.
 */
export function assertZeroWrites(
  auditRecords: Array<{ action: string; dryRun: boolean; phase?: string }>,
): { pass: boolean; violations: string[] } {
  const violations: string[] = []

  for (const record of auditRecords) {
    if (!isWriteTool(record.action)) continue
    // Intent/result phases for write tools should not exist in dry-run mode;
    // only dry_run phase records are expected
    if (record.phase === "intent" || record.phase === "result") {
      if (!record.dryRun) {
        violations.push(
          `Write tool "${record.action}" executed without dryRun flag (phase: ${record.phase})`,
        )
      }
    }
  }

  return { pass: violations.length === 0, violations }
}
