// src/safety/github-firewall.ts — GitHub Mutation Firewall (SDD §4.2)
//
// Centralized enforcement layer wrapping all MCP tools with a 9-step pipeline:
// capability check → param validation → dry-run → policy → constraints →
// rate limit → audit intent → dedupe → execute + audit result.

import { getToolCapability, isKnownTool, validateParams } from "../safety/tool-registry.js"
import type { AuditRecordInput, AuditResultInput } from "../safety/audit-trail.js"
import { DedupeIndex } from "../cron/idempotency.js"

// ── Types ───────────────────────────────────────────────────

/** A tool definition as provided by the MCP SDK. (SDD §4.2) */
export interface ToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
  execute: (params: Record<string, unknown>) => Promise<unknown>
}

/** Template-specific policy for tool access. (SDD §4.2) */
export interface TemplatePolicy {
  allowedTools?: string[]
  deniedTools?: string[]
}

/** Configuration for the GitHubFirewall. (SDD §4.2) */
export interface FirewallConfig {
  dryRun?: boolean
  templatePolicy?: TemplatePolicy
  jobId?: string
  runUlid?: string
  templateId?: string
}

/** Error thrown when the firewall denies a tool invocation. (SDD §4.2) */
export class FirewallDeniedError extends Error {
  public readonly toolName: string
  public readonly reason: string
  public readonly step: number

  constructor(toolName: string, reason: string, step: number) {
    super(`Firewall denied "${toolName}": ${reason}`)
    this.name = "FirewallDeniedError"
    this.toolName = toolName
    this.reason = reason
    this.step = step
  }
}

// ── Dependency interfaces (duck-typed for testability) ──────

/** Subset of AuditTrail used by the firewall. */
export interface FirewallAuditTrail {
  recordIntent(data: AuditRecordInput): Promise<number>
  recordResult(intentSeq: number, data: AuditResultInput): Promise<number>
  recordDenied(data: AuditRecordInput): Promise<number>
  recordDryRun(data: AuditRecordInput): Promise<number>
}

/** Subset of RateLimiter used by the firewall. */
export interface FirewallRateLimiter {
  tryConsume(toolName: string, jobId?: string): boolean
  getRemainingTokens(jobId?: string): { global: number; job?: number }
}

/** Subset of DedupeIndex used by the firewall. */
export interface FirewallDedupeIndex {
  isDuplicate(key: string): boolean
  recordPending(key: string, intentSeq: number): Promise<void>
  record(key: string, intentSeq: number): Promise<void>
}

/** Subset of AlertService used by the firewall. */
export interface FirewallAlertService {
  fire(severity: string, triggerType: string, context: { jobId?: string; message: string }): Promise<boolean>
}

// ── GitHubFirewall ──────────────────────────────────────────

/**
 * Centralized enforcement layer for all GitHub MCP tool invocations. (SDD §4.2)
 *
 * Every tool call passes through a 9-step pipeline before reaching the
 * underlying MCP execute() function. Denied calls are audited and alerted.
 */
export class GitHubFirewall {
  private auditTrail: FirewallAuditTrail
  private rateLimiter: FirewallRateLimiter
  private dedupeIndex: FirewallDedupeIndex
  private alertService: FirewallAlertService
  private config: FirewallConfig

  constructor(deps: {
    auditTrail: FirewallAuditTrail
    rateLimiter: FirewallRateLimiter
    dedupeIndex: FirewallDedupeIndex
    alertService: FirewallAlertService
    config: FirewallConfig
  }) {
    this.auditTrail = deps.auditTrail
    this.rateLimiter = deps.rateLimiter
    this.dedupeIndex = deps.dedupeIndex
    this.alertService = deps.alertService
    this.config = deps.config
  }

  /**
   * Wrap an array of MCP tools with the firewall enforcement pipeline.
   * Returns a new array with intercepted execute() methods.
   */
  wrapTools(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.map((tool) => ({
      ...tool,
      execute: (params: Record<string, unknown>) =>
        this.enforce(tool.name, params, tool.execute.bind(tool)),
    }))
  }

  /**
   * The 9-step enforcement pipeline. (SDD §4.2)
   */
  private async enforce(
    toolName: string,
    params: Record<string, unknown>,
    originalExecute: (params: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown> {
    const auditInput: AuditRecordInput = {
      action: toolName,
      target: this.buildTarget(toolName, params),
      params,
      dryRun: this.config.dryRun,
    }

    // Step 0: Unknown tool check
    if (!isKnownTool(toolName)) {
      await this.auditTrail.recordDenied(auditInput)
      throw new FirewallDeniedError(toolName, "Unknown tool — not in registry", 0)
    }

    const capability = getToolCapability(toolName)!

    // Step 1: Admin capability → always denied + alert + audit
    if (capability === "admin") {
      await this.alertService.fire("critical", "admin_tool_denied", {
        jobId: this.config.jobId,
        message: `Admin tool "${toolName}" invocation denied`,
      })
      await this.auditTrail.recordDenied(auditInput)
      throw new FirewallDeniedError(toolName, "Admin tools are always denied", 1)
    }

    // Step 2: Deep param validation (must_be, pattern, allowlist)
    const paramResult = validateParams(toolName, params)
    if (!paramResult.valid) {
      await this.auditTrail.recordDenied(auditInput)
      throw new FirewallDeniedError(
        toolName,
        `Param constraint violation: ${paramResult.violations.join("; ")}`,
        2,
      )
    }

    // Step 3: Dry-run interception for write-capability tools
    if (this.config.dryRun && capability === "write") {
      await this.auditTrail.recordDryRun(auditInput)
      return { dryRun: true, tool: toolName, params, message: "Write intercepted in dry-run mode" }
    }

    // Step 4: Template-specific policy check (allow/deny lists)
    const policy = this.config.templatePolicy
    if (policy) {
      if (policy.deniedTools?.includes(toolName)) {
        await this.auditTrail.recordDenied(auditInput)
        throw new FirewallDeniedError(toolName, "Denied by template policy", 4)
      }
      if (policy.allowedTools && !policy.allowedTools.includes(toolName)) {
        await this.auditTrail.recordDenied(auditInput)
        throw new FirewallDeniedError(toolName, "Not in template allowed list", 4)
      }
    }

    // Step 5: Constraint application — enforced by step 2 (param validation covers must_be/pattern)
    // Intentional pass-through; constraints are already applied above.

    // Step 6: Rate limit check via RateLimiter
    const allowed = this.rateLimiter.tryConsume(toolName, this.config.jobId)
    if (!allowed) {
      await this.auditTrail.recordDenied(auditInput)
      throw new FirewallDeniedError(toolName, "Rate limit exceeded", 6)
    }

    // Step 7: Write-ahead audit intent
    const dedupeKey = DedupeIndex.buildKey(toolName, params)
    auditInput.dedupeKey = dedupeKey
    const intentSeq = await this.auditTrail.recordIntent(auditInput)

    // Step 8: Mutation-level dedupe via DedupeIndex (write tools only)
    if (capability === "write") {
      if (this.dedupeIndex.isDuplicate(dedupeKey)) {
        await this.auditTrail.recordResult(intentSeq, {
          action: toolName,
          target: auditInput.target,
          params,
          result: { deduplicated: true },
        })
        return { deduplicated: true, tool: toolName, dedupeKey }
      }
      await this.dedupeIndex.recordPending(dedupeKey, intentSeq)
    }

    // Step 9: Execute → audit result (or error)
    try {
      const result = await originalExecute(params)

      const resultInput: AuditResultInput = {
        action: toolName,
        target: auditInput.target,
        params,
        result,
        rateLimitRemaining: this.rateLimiter.getRemainingTokens(this.config.jobId).global,
      }
      await this.auditTrail.recordResult(intentSeq, resultInput)

      // Record successful completion in dedupe index (write tools only)
      if (capability === "write") {
        await this.dedupeIndex.record(dedupeKey, intentSeq)
      }

      return result
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await this.auditTrail.recordResult(intentSeq, {
        action: toolName,
        target: auditInput.target,
        params,
        error: errorMessage,
      })
      throw err
    }
  }

  /** Build a human-readable target string for audit records. */
  private buildTarget(toolName: string, params: Record<string, unknown>): string {
    const owner = params.owner ?? "_"
    const repo = params.repo ?? "_"
    const pr = params.pull_number ?? params.issue_number ?? params.path ?? "_"
    return `${owner}/${repo}#${pr}`
  }
}
