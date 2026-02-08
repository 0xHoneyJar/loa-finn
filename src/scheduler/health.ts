// src/scheduler/health.ts — Health aggregator (SDD §3.4.3, T-4.3, T-7.10)
// Uses upstream WALManager status and disk pressure types.

import type { Scheduler, TaskStatus } from "./scheduler.js"
import type { WALManager } from "../persistence/upstream.js"
import type { DiskPressureStatus, RecoveryState } from "../persistence/upstream.js"
import type { ObjectStoreSync } from "../persistence/r2-sync.js"
import type { GitSync } from "../persistence/git-sync.js"
import type { FinnConfig } from "../config.js"
import type { WorkerPoolStats } from "../agent/worker-pool.js"

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy"
  uptime: number
  timestamp: number
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
      !beadsAvailable
    ) {
      overall = "degraded"
    }

    return {
      status: overall,
      uptime: Date.now() - this.bootTime,
      timestamp: Date.now(),
      checks,
    }
  }
}
