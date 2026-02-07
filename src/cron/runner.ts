// src/cron/runner.ts — JobRunner: spawn isolated agent sessions per item (SDD §5.2, Flatline IMP-004)

import type { BashPolicy, NetworkPolicy } from "./sandbox-policies.js"
import { CRON_BASH_POLICIES, CRON_NETWORK_POLICY } from "./sandbox-policies.js"
import type { CronJob, CronRunRecord } from "./types.js"

// ── Default resource limits (Flatline IMP-004) ─────────────

const DEFAULT_MAX_TOOL_CALLS = 200
const DEFAULT_MAX_RUNTIME_MINUTES = 30
const DEFAULT_MAX_ITEMS = 50

// ── Dependency interfaces ──────────────────────────────────

/** A resolved template definition. */
export interface Template {
  id: string
  resolveItems(): Promise<TemplateItem[]>
  actionPolicy?: TemplatePolicy
}

/** A single item produced by a template's resolveItems(). */
export interface TemplateItem {
  key: string
  hash: string
  data: Record<string, unknown>
}

/** Template-specific tool access policy. */
export interface TemplatePolicy {
  allowedTools?: string[]
  deniedTools?: string[]
}

/** Job context store for change detection. */
export interface JobContext {
  hasChanged(key: string, hash: string, reReviewHours?: number): boolean
  update(key: string, hash: string): void
  save(): Promise<void>
  load(): Promise<void>
}

/** Options passed to the session factory for each item. */
export interface SessionOptions {
  templateId: string
  item: TemplateItem
  bashPolicies: BashPolicy[]
  networkPolicy: NetworkPolicy
  toolWrapper?: (tools: unknown[]) => unknown[]
}

/** Result returned from a single session execution. */
export interface SessionResult {
  toolCalls: number
  success: boolean
  error?: string
}

/** Factory that creates isolated agent sessions. */
export interface SessionFactory {
  createSession(opts: SessionOptions): Promise<SessionResult>
}

/** Audit trail run context manager. */
export interface AuditContextManager {
  setRunContext(ctx: { jobId: string; runUlid: string; templateId: string }): void
  clearRunContext(): void
}

/** Resolves a template ID to a Template instance. */
export type TemplateResolver = (templateId: string) => Promise<Template | null>

/** Creates a JobContext for a given job ID. */
export type ContextFactory = (jobId: string) => JobContext

// ── JobRunner ──────────────────────────────────────────────

export interface JobRunnerDeps {
  resolveTemplate: TemplateResolver
  createContext: ContextFactory
  sessionFactory: SessionFactory
  auditContext: AuditContextManager
  now?: () => number
}

/**
 * Executes a cron job: resolves template, loads context, filters changed items,
 * spawns isolated sessions per item, and enforces per-run resource limits.
 */
export class JobRunner {
  private readonly resolveTemplate: TemplateResolver
  private readonly createContext: ContextFactory
  private readonly sessionFactory: SessionFactory
  private readonly auditContext: AuditContextManager
  private readonly now: () => number

  constructor(deps: JobRunnerDeps) {
    this.resolveTemplate = deps.resolveTemplate
    this.createContext = deps.createContext
    this.sessionFactory = deps.sessionFactory
    this.auditContext = deps.auditContext
    this.now = deps.now ?? Date.now
  }

  /** Execute a job run: resolve items, filter changes, spawn sessions. */
  async run(job: CronJob, runUlid: string): Promise<CronRunRecord> {
    const startMs = this.now()
    const maxToolCalls = job.config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
    const maxRuntimeMs = (job.config.maxRuntimeMinutes ?? DEFAULT_MAX_RUNTIME_MINUTES) * 60_000
    const maxItems = job.config.maxItems ?? DEFAULT_MAX_ITEMS

    const record: CronRunRecord = {
      jobId: job.id,
      runUlid,
      startedAt: new Date(startMs).toISOString(),
      status: "running",
      itemsProcessed: 0,
      toolCalls: 0,
    }

    // Set audit context for the duration of this run
    this.auditContext.setRunContext({
      jobId: job.id,
      runUlid,
      templateId: job.templateId,
    })

    try {
      // Step 1: Resolve template
      const template = await this.resolveTemplate(job.templateId)
      if (!template) {
        return this.finalize(record, startMs, "failure", `Template "${job.templateId}" not found`)
      }

      // Step 2: Load job context for change detection
      const ctx = this.createContext(job.id)
      await ctx.load()

      // Step 3: Resolve items from template
      const allItems = await template.resolveItems()

      // Step 4: Filter to changed items only
      const changedItems = allItems.filter((item) => ctx.hasChanged(item.key, item.hash))

      // Step 5: Enforce max items limit — process first N, skip rest
      const items = changedItems.slice(0, maxItems)
      if (changedItems.length > maxItems) {
        // Warning: items beyond maxItems are skipped this run
      }

      // Step 6: Handle empty items case
      if (items.length === 0) {
        await ctx.save()
        return this.finalize(record, startMs, "success")
      }

      // Step 7: Process each item in an isolated session
      let totalToolCalls = 0
      let aborted = false

      for (const item of items) {
        // Runtime limit check
        const elapsed = this.now() - startMs
        if (elapsed >= maxRuntimeMs) {
          record.status = "timeout"
          record.error = `Runtime limit exceeded: ${Math.round(elapsed / 60_000)}m >= ${job.config.maxRuntimeMinutes ?? DEFAULT_MAX_RUNTIME_MINUTES}m`
          aborted = true
          break
        }

        // Tool call limit check (pre-session)
        if (totalToolCalls >= maxToolCalls) {
          record.status = "aborted"
          record.error = `Tool call limit exceeded: ${totalToolCalls} >= ${maxToolCalls}`
          aborted = true
          break
        }

        // Build session options with sandbox policies
        const sessionOpts: SessionOptions = {
          templateId: job.templateId,
          item,
          bashPolicies: CRON_BASH_POLICIES,
          networkPolicy: CRON_NETWORK_POLICY,
          toolWrapper: template.actionPolicy
            ? (tools) => tools // Placeholder — real wrapping in Sprint 3
            : undefined,
        }

        const result = await this.sessionFactory.createSession(sessionOpts)

        totalToolCalls += result.toolCalls
        record.itemsProcessed++
        record.toolCalls = totalToolCalls

        // Update context on successful processing
        if (result.success) {
          ctx.update(item.key, item.hash)
        } else {
          // Session failure: record error but continue to next item
          if (result.error) {
            record.error = result.error
          }
        }

        // Tool call limit check (post-session)
        if (totalToolCalls >= maxToolCalls) {
          record.status = "aborted"
          record.error = `Tool call limit exceeded: ${totalToolCalls} >= ${maxToolCalls}`
          aborted = true
          break
        }
      }

      // Save context (persists change detection state)
      await ctx.save()

      if (!aborted) {
        record.status = record.error ? "failure" : "success"
      }

      return this.finalize(record, startMs)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return this.finalize(record, startMs, "failure", msg)
    } finally {
      this.auditContext.clearRunContext()
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  /** Finalize a run record with completion time and optional status/error overrides. */
  private finalize(
    record: CronRunRecord,
    startMs: number,
    status?: CronRunRecord["status"],
    error?: string,
  ): CronRunRecord {
    const endMs = this.now()
    record.completedAt = new Date(endMs).toISOString()
    record.durationMs = endMs - startMs
    if (status) record.status = status
    if (error) record.error = error
    return record
  }
}
