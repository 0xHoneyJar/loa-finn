// src/cron/types.ts — CronJob data types (SDD §5.2)

export interface CronSchedule {
  kind: "cron" | "at" | "every"
  expression: string
}

export type JobStatus = "enabled" | "disabled" | "armed" | "running" | "stuck"
export type ConcurrencyPolicy = "skip" | "queue" | "replace"

export interface CircuitBreakerState {
  state: "closed" | "open" | "half_open"
  failures: number
  successes: number
  lastFailureAt?: number
  openedAt?: number
  halfOpenAt?: number
}

export interface CronJob {
  id: string
  name: string
  templateId: string
  schedule: CronSchedule
  status: JobStatus
  concurrencyPolicy: ConcurrencyPolicy
  enabled: boolean
  oneShot: boolean
  config: {
    maxToolCalls?: number
    maxRuntimeMinutes?: number
    maxItems?: number
  }
  // State fields
  nextRunAtMs?: number
  currentRunUlid?: string  // CAS token
  lastRunAtMs?: number
  lastStatus?: "success" | "failure" | "timeout" | "aborted"
  lastError?: string
  lastDurationMs?: number
  circuitBreaker: CircuitBreakerState
  createdAt: number
  updatedAt: number
}

export interface CronJobRegistry {
  version: 1
  jobs: CronJob[]
  killSwitch: boolean
  lastModified: number
}

export interface CronRunRecord {
  jobId: string
  runUlid: string
  startedAt: string
  completedAt?: string
  status: "running" | "success" | "failure" | "timeout" | "aborted"
  itemsProcessed: number
  toolCalls: number
  durationMs?: number
  error?: string
}
