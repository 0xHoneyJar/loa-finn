// src/scheduler/health.ts — Health aggregator (SDD §3.4.3, T-4.3, T-7.10)
// Uses upstream WALManager status and disk pressure types.

import type { Scheduler, TaskStatus } from "./scheduler.js"
import type { WALManager } from "../persistence/upstream.js"
import type { DiskPressureStatus, RecoveryState } from "../persistence/upstream.js"
import type { ObjectStoreSync } from "../persistence/r2-sync.js"
import type { GitSync } from "../persistence/git-sync.js"
import type { FinnConfig } from "../config.js"
import type { WorkerPoolStats } from "../agent/worker-pool.js"
import type { GuardHealth } from "../hounfour/billing-conservation-guard.js"

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy"
  uptime: number
  timestamp: number
  ready_for_billing: boolean
  checks: {
    agent: {
      status: string
      model: string
      sessionCount: number
    }
    wal: {
      status: string
      segmentCount: number
      totalSize: number
      diskPressure: DiskPressureStatus
    }
    recovery: {
      state: RecoveryState | "UNKNOWN"
      source: string
    }
    identity: {
      checksum: string
      watching: boolean
    }
    learnings: {
      total: number
      active: number
    }
    r2Sync: {
      status: string
      lastError?: string
    }
    gitSync: {
      status: string
      lastError?: string
    }
    beads: {
      status: string
      available: boolean
    }
    scheduler: {
      status: string
      tasks: TaskStatus[]
    }
    workerPool: {
      status: string
      stats?: WorkerPoolStats
    }
    hounfour?: {
      status: string
      providers?: Record<string, { healthy: boolean; models: Record<string, { healthy: boolean }> }>
      budget?: { spent_usd: number; limit_usd: number; percent_used: number }
    }
    billing_evaluator?: GuardHealth
    oracle?: {
      status: string
      healthy: boolean
      sources_loaded: number
      total_tokens: number
      missing: string[]
      // Phase 1 additions (SDD §3.7)
      rate_limiter_healthy?: boolean
      oracle_status?: "healthy" | "degraded" | "unavailable"
      daily_usage?: {
        requests: number
        cost_cents: number
        ceiling_cents: number
        ceiling_percent: number
      } | null
      dixie_ref?: string
      error_counts?: {
        redis_timeouts: number
        model_errors: number
        rate_limited: number
      }
    }
  }
}

export interface HealthDeps {
  config: FinnConfig
  wal: WALManager
  r2Sync: ObjectStoreSync
  gitSync: GitSync
  scheduler: Scheduler
  getSessionCount: () => number
  getBeadsAvailable: () => boolean
  getRecoveryState: () => { state: RecoveryState | "UNKNOWN"; source: string }
  getIdentityStatus: () => { checksum: string; watching: boolean }
  getLearningCounts: () => { total: number; active: number }
  getWorkerPoolStats: () => WorkerPoolStats | undefined
  getProviderHealth?: () => Record<string, { healthy: boolean; models: Record<string, { healthy: boolean }> }> | undefined
  getBudgetSnapshot?: () => { spent_usd: number; limit_usd: number; percent_used: number } | undefined
  getRedisHealth?: () => Promise<{ connected: boolean; latencyMs: number }>
  getBillingGuardHealth?: () => GuardHealth
  getOracleHealth?: () => { healthy: boolean; sources_loaded: number; total_tokens: number; missing: string[] } | undefined
  // Phase 1 additions (SDD §3.7)
  getOracleRateLimiterHealth?: () => Promise<boolean>
  getOracleDailyUsage?: () => Promise<{ globalCount: number; costCents: number } | null>
  oracleDixieRef?: string
  oracleCostCeilingCents?: number
  oracleErrorCounts?: { redis_timeouts: number; model_errors: number; rate_limited: number }
}

export class HealthAggregator {
  private bootTime = Date.now()

  constructor(private deps: HealthDeps) {}

  check(): HealthStatus {
    const {
      config, wal, r2Sync, gitSync, scheduler,
      getSessionCount, getBeadsAvailable,
      getRecoveryState, getIdentityStatus, getLearningCounts,
      getWorkerPoolStats,
    } = this.deps

    const schedulerTasks = scheduler.getStatus()
    const beadsAvailable = getBeadsAvailable()
    const poolStats = getWorkerPoolStats()
    const walStatus = wal.getStatus()
    const diskPressure = wal.getDiskPressure()
    const recoveryInfo = getRecoveryState()
    const identityInfo = getIdentityStatus()
    const learningCounts = getLearningCounts()

    const checks: HealthStatus["checks"] = {
      agent: {
        status: "ok",
        model: config.model,
        sessionCount: getSessionCount(),
      },
      wal: {
        status: diskPressure === "critical" ? "disk_pressure" : "ok",
        segmentCount: walStatus.segmentCount,
        totalSize: walStatus.totalSize,
        diskPressure,
      },
      recovery: recoveryInfo,
      identity: identityInfo,
      learnings: learningCounts,
      r2Sync: {
        status: r2Sync.isConfigured ? "ok" : "disabled",
      },
      gitSync: {
        status: gitSync.isConfigured
          ? gitSync.currentStatus
          : "disabled",
      },
      beads: {
        status: beadsAvailable ? "ok" : "unavailable",
        available: beadsAvailable,
      },
      scheduler: {
        status: schedulerTasks.some((t) => t.circuitBreakerState === "OPEN") ? "partial" : "ok",
        tasks: schedulerTasks,
      },
      workerPool: {
        status: poolStats ? "ok" : "disabled",
        stats: poolStats,
      },
    }

    // Optional: Billing evaluator guard health (SDD §4.2)
    const guardHealth = this.deps.getBillingGuardHealth?.()
    if (guardHealth) {
      checks.billing_evaluator = guardHealth
    }

    // Optional: Hounfour provider health
    const providerHealth = this.deps.getProviderHealth?.()
    const budgetSnapshot = this.deps.getBudgetSnapshot?.()
    if (providerHealth || budgetSnapshot) {
      checks.hounfour = {
        status: "ok",
        providers: providerHealth,
        budget: budgetSnapshot,
      }
    }

    // Optional: Oracle knowledge registry health
    const oracleHealth = this.deps.getOracleHealth?.()
    if (oracleHealth) {
      checks.oracle = {
        status: oracleHealth.healthy ? "ok" : "degraded",
        healthy: oracleHealth.healthy,
        sources_loaded: oracleHealth.sources_loaded,
        total_tokens: oracleHealth.total_tokens,
        missing: oracleHealth.missing,
        // Phase 1 sync fields (SDD §3.7)
        dixie_ref: this.deps.oracleDixieRef,
        error_counts: this.deps.oracleErrorCounts,
      }
    }

    // Compute ready_for_billing: true only when guard is ready or bypassed (SDD §6.2)
    const readyForBilling = guardHealth
      ? guardHealth.billing === "ready"
      : true // No guard configured — billing proceeds (backward compatible)

    // Compute overall status
    let overall: HealthStatus["status"] = "healthy"

    if (
      diskPressure === "critical" ||
      checks.agent.status !== "ok" ||
      recoveryInfo.state === "LOOP_DETECTED"
    ) {
      overall = "unhealthy"
    } else if (
      diskPressure === "warning" ||
      recoveryInfo.state === "DEGRADED" ||
      checks.r2Sync.status === "timeout" ||
      checks.gitSync.status === "conflict" ||
      checks.scheduler.status === "partial" ||
      !beadsAvailable ||
      (guardHealth && guardHealth.billing === "degraded")
    ) {
      overall = "degraded"
    }

    return {
      status: overall,
      uptime: Date.now() - this.bootTime,
      timestamp: Date.now(),
      ready_for_billing: readyForBilling,
      checks,
    }
  }

  /** Async enrichment for Oracle Phase 1 fields (rate limiter health, daily usage) */
  async enrichOracleHealth(health: HealthStatus): Promise<HealthStatus> {
    if (!health.checks.oracle) return health

    try {
      const [rateLimiterHealthy, dailyUsage] = await Promise.all([
        this.deps.getOracleRateLimiterHealth?.() ?? Promise.resolve(false),
        this.deps.getOracleDailyUsage?.() ?? Promise.resolve(null),
      ])

      const costCeiling = this.deps.oracleCostCeilingCents ?? 2000
      health.checks.oracle.rate_limiter_healthy = rateLimiterHealthy
      health.checks.oracle.daily_usage = dailyUsage ? {
        requests: dailyUsage.globalCount,
        cost_cents: dailyUsage.costCents,
        ceiling_cents: costCeiling,
        ceiling_percent: costCeiling > 0 ? Math.round((dailyUsage.costCents / costCeiling) * 100) : 0,
      } : null

      // Compute oracle_status from combined signals
      if (!rateLimiterHealthy) {
        health.checks.oracle.oracle_status = "unavailable"
      } else if (!health.checks.oracle.healthy) {
        health.checks.oracle.oracle_status = "degraded"
      } else {
        health.checks.oracle.oracle_status = "healthy"
      }

      // Structured log for cost ceiling proximity (Flatline IMP-002)
      if (dailyUsage && costCeiling > 0) {
        const percent = (dailyUsage.costCents / costCeiling) * 100
        if (percent > 80) {
          console.warn(JSON.stringify({
            level: "warn",
            event: "oracle.cost_ceiling_proximity",
            cost_cents: dailyUsage.costCents,
            ceiling_cents: costCeiling,
            percent: Math.round(percent),
          }))
        }
      }
    } catch {
      // Best-effort enrichment — don't fail the health check
    }

    return health
  }
}
