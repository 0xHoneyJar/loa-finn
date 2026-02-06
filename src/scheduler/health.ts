// src/scheduler/health.ts — Health aggregator (SDD §3.4.3, T-4.3)

import type { Scheduler, TaskStatus } from "./scheduler.js"
import type { WAL } from "../persistence/wal.js"
import type { ObjectStoreSync } from "../persistence/r2-sync.js"
import type { GitSync } from "../persistence/git-sync.js"
import type { FinnConfig } from "../config.js"

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
  }
}

export interface HealthDeps {
  config: FinnConfig
  wal: WAL
  r2Sync: ObjectStoreSync
  gitSync: GitSync
  scheduler: Scheduler
  getSessionCount: () => number
  getBeadsAvailable: () => boolean
}

export class HealthAggregator {
  private bootTime = Date.now()

  constructor(private deps: HealthDeps) {}

  check(): HealthStatus {
    const { config, wal, r2Sync, gitSync, scheduler, getSessionCount, getBeadsAvailable } =
      this.deps

    const schedulerTasks = scheduler.getStatus()
    const beadsAvailable = getBeadsAvailable()

    const checks: HealthStatus["checks"] = {
      agent: {
        status: "ok",
        model: config.model,
        sessionCount: getSessionCount(),
      },
      wal: {
        status: wal.isDiskPressure ? "disk_pressure" : "ok",
        segmentCount: wal.getSegments().length,
      },
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
        status: schedulerTasks.some((t) => t.circuitBreakerState === "open") ? "partial" : "ok",
        tasks: schedulerTasks,
      },
    }

    // Compute overall status
    const statuses = [
      checks.agent.status,
      checks.wal.status,
      checks.scheduler.status,
    ]
    let overall: HealthStatus["status"] = "healthy"

    if (statuses.includes("disk_pressure") || checks.agent.status !== "ok") {
      overall = "unhealthy"
    } else if (
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
