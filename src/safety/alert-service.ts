// src/safety/alert-service.ts — OOB Alert Service for safety notifications (SDD §4.7)
//
// Routes alerts to configured channels (GitHub Issues, webhooks, console log)
// based on severity level. Deduplication prevents alert storms using a
// time-windowed cache keyed on {severity}:{triggerType}:{jobId}.

// ── Types ───────────────────────────────────────────────────

/** Alert severity levels, from most to least urgent. (SDD §4.7) */
export type AlertSeverity = "critical" | "error" | "warning" | "info"

/** Available notification channels. (SDD §4.7) */
export type AlertChannel = "github_issue" | "webhook" | "log"

/** Context payload attached to every alert. (SDD §4.7) */
export interface AlertContext {
  jobId?: string
  runId?: string
  templateId?: string
  message: string
  details?: Record<string, unknown>
}

/** GitHub Issues channel configuration. (SDD §4.7) */
export interface GitHubIssueChannelConfig {
  owner: string
  repo: string
  token: string
  onCallTeam?: string
}

/** Webhook channel configuration. (SDD §4.7) */
export interface WebhookChannelConfig {
  url: string
}

/** Top-level alert service configuration. (SDD §4.7) */
export interface AlertServiceConfig {
  channels: {
    github_issue?: GitHubIssueChannelConfig
    webhook?: WebhookChannelConfig
  }
  routing: Record<AlertSeverity, AlertChannel[]>
  deduplicationWindowMs?: number
}

// ── Default routing ─────────────────────────────────────────

/** Default routing: critical→all, error→[github_issue,log], warning→[webhook,log], info→[log]. (SDD §4.7) */
export const DEFAULT_ROUTING: Record<AlertSeverity, AlertChannel[]> = {
  critical: ["github_issue", "webhook", "log"],
  error: ["github_issue", "log"],
  warning: ["webhook", "log"],
  info: ["log"],
}

/** Default deduplication window: 15 minutes. (SDD §4.7) */
const DEFAULT_DEDUP_WINDOW_MS = 15 * 60 * 1000

// ── AlertService ────────────────────────────────────────────

/**
 * OOB Alert Service — fires notifications to configured channels. (SDD §4.7)
 *
 * Designed as a safety net: fire() never throws. All channel errors are caught
 * and logged to stderr so the caller's control flow is never disrupted.
 */
export class AlertService {
  private readonly config: AlertServiceConfig
  private readonly dedupCache: Map<string, number> = new Map()
  private readonly dedupWindowMs: number

  // Injectable fetch for testing — defaults to global fetch. (SDD §4.7)
  private readonly fetchFn: typeof globalThis.fetch

  // Injectable clock for testing — defaults to Date.now. (SDD §4.7)
  private readonly now: () => number

  constructor(
    config: AlertServiceConfig,
    deps?: { fetch?: typeof globalThis.fetch; now?: () => number },
  ) {
    this.config = config
    this.dedupWindowMs = config.deduplicationWindowMs ?? DEFAULT_DEDUP_WINDOW_MS
    this.fetchFn = deps?.fetch ?? globalThis.fetch
    this.now = deps?.now ?? Date.now
  }

  /**
   * Fire an alert to all channels configured for the given severity. (SDD §4.7)
   *
   * Deduplication: if an alert with the same {severity}:{triggerType}:{jobId}
   * was fired within the dedup window, the duplicate is suppressed.
   *
   * Returns true if the alert was dispatched (not deduplicated).
   */
  async fire(
    severity: AlertSeverity,
    triggerType: string,
    context: AlertContext,
  ): Promise<boolean> {
    try {
      // Clean stale dedup entries before checking
      this.cleanupDedupCache()

      // Build dedup key
      const dedupKey = `${severity}:${triggerType}:${context.jobId ?? "_"}`
      const lastFired = this.dedupCache.get(dedupKey)
      const currentTime = this.now()

      if (lastFired !== undefined && currentTime - lastFired < this.dedupWindowMs) {
        return false // Suppressed — duplicate within window
      }

      // Record this alert in the dedup cache
      this.dedupCache.set(dedupKey, currentTime)

      // Resolve channels for this severity
      const channels = this.config.routing[severity] ?? []

      // Dispatch to each channel — errors are caught per-channel
      const dispatches = channels.map((channel) =>
        this.dispatch(channel, severity, triggerType, context),
      )
      await Promise.allSettled(dispatches)

      return true
    } catch (err) {
      // fire() is a safety net — never throw
      console.error("[AlertService] unexpected error in fire():", err)
      return false
    }
  }

  // ── Private helpers ─────────────────────────────────────

  /** Dispatch a single alert to one channel. (SDD §4.7) */
  private async dispatch(
    channel: AlertChannel,
    severity: AlertSeverity,
    triggerType: string,
    context: AlertContext,
  ): Promise<void> {
    try {
      switch (channel) {
        case "log":
          this.sendLog(severity, triggerType, context)
          break
        case "github_issue":
          await this.sendGitHubIssue(severity, triggerType, context)
          break
        case "webhook":
          await this.sendWebhook(severity, triggerType, context)
          break
      }
    } catch (err) {
      // Per-channel errors are logged but never propagated
      console.error(`[AlertService] channel "${channel}" failed:`, err)
    }
  }

  /** Log channel — always available, routes to appropriate console method. (SDD §4.7) */
  private sendLog(
    severity: AlertSeverity,
    triggerType: string,
    context: AlertContext,
  ): void {
    const prefix = `[Alert:${severity}] ${triggerType}`
    const payload = { ...context, timestamp: new Date(this.now()).toISOString() }

    switch (severity) {
      case "critical":
      case "error":
        console.error(prefix, payload)
        break
      case "warning":
        console.warn(prefix, payload)
        break
      case "info":
        console.info(prefix, payload)
        break
    }
  }

  /** GitHub Issues channel — creates an issue via the REST API. (SDD §4.7) */
  private async sendGitHubIssue(
    severity: AlertSeverity,
    triggerType: string,
    context: AlertContext,
  ): Promise<void> {
    const ghConfig = this.config.channels.github_issue
    if (!ghConfig) return

    const labels = [`alert:${severity}`]
    if (ghConfig.onCallTeam) {
      labels.push(`team:${ghConfig.onCallTeam}`)
    }

    const title = `[${severity.toUpperCase()}] ${triggerType}: ${context.message}`
    const body = [
      `## Alert: ${triggerType}`,
      "",
      `**Severity:** ${severity}`,
      `**Timestamp:** ${new Date(this.now()).toISOString()}`,
      context.jobId ? `**Job ID:** ${context.jobId}` : null,
      context.runId ? `**Run ID:** ${context.runId}` : null,
      context.templateId ? `**Template ID:** ${context.templateId}` : null,
      "",
      `### Message`,
      "",
      context.message,
      context.details
        ? `\n### Details\n\n\`\`\`json\n${JSON.stringify(context.details, null, 2)}\n\`\`\``
        : null,
    ]
      .filter((line) => line !== null)
      .join("\n")

    const url = `https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/issues`

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghConfig.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ title, body, labels }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`GitHub API ${response.status}: ${text}`)
    }
  }

  /** Webhook channel — sends structured JSON (Slack/PagerDuty compatible). (SDD §4.7) */
  private async sendWebhook(
    severity: AlertSeverity,
    triggerType: string,
    context: AlertContext,
  ): Promise<void> {
    const whConfig = this.config.channels.webhook
    if (!whConfig) return

    const payload = {
      severity,
      triggerType,
      timestamp: new Date(this.now()).toISOString(),
      context: {
        jobId: context.jobId ?? null,
        runId: context.runId ?? null,
        templateId: context.templateId ?? null,
        message: context.message,
        details: context.details ?? null,
      },
    }

    const response = await this.fetchFn(whConfig.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Webhook ${response.status}: ${text}`)
    }
  }

  /** Remove dedup entries older than the window. (SDD §4.7) */
  private cleanupDedupCache(): void {
    const cutoff = this.now() - this.dedupWindowMs
    for (const [key, ts] of this.dedupCache) {
      if (ts < cutoff) {
        this.dedupCache.delete(key)
      }
    }
  }
}
