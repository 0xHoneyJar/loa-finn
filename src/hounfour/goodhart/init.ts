// src/hounfour/goodhart/init.ts — Goodhart Init + Recovery Scheduler (cycle-036 T-4.3)
//
// Extracts Goodhart initialization into a testable function with recovery probe.
// On init_failed, GoodhartRecoveryScheduler retries with exponential backoff
// (60s, 120s, 240s, 480s, 960s — max 5 retries). Recovery updates GoodhartRuntime
// atomically so the router picks up the new config on the next request.

import type { MechanismConfig } from "./mechanism-interaction.js"
import type { GraduationMetrics } from "../graduation-metrics.js"

// --- GoodhartRuntime (mutable holder) ---

export type RoutingState = "disabled" | "shadow" | "enabled" | "init_failed"

/**
 * Mutable runtime holder shared between index.ts and the router.
 * The router reads from this reference; recovery updates it atomically.
 */
export interface GoodhartRuntime {
  goodhartConfig: MechanismConfig | undefined
  routingState: RoutingState
  goodhartMetrics: GraduationMetrics | undefined
}

// --- Init Function ---

export interface GoodhartInitDeps {
  /** Redis client (from main boot), or null if unavailable */
  redisClient: unknown | null
  /** Redis prefix for key isolation */
  redisPrefix: string
  /** Redis logical DB index */
  redisDb: number
  /** Requested routing mode from env */
  requestedMode: string
}

/**
 * Initialize the Goodhart protection stack.
 * Returns a GoodhartRuntime ready for the router.
 * Throws on init failure (caller catches and sets init_failed).
 */
export async function initGoodhartStack(deps: GoodhartInitDeps): Promise<GoodhartRuntime> {
  const { createDixieTransport } = await import("./transport-factory.js")
  const { TemporalDecayEngine } = await import("./temporal-decay.js")
  const { ExplorationEngine } = await import("./exploration.js")
  const { CalibrationEngine } = await import("./calibration.js")
  const { KillSwitch } = await import("./kill-switch.js")
  const { RuntimeConfig } = await import("../runtime-config.js")
  const { GraduationMetrics } = await import("../graduation-metrics.js")
  const { createPrefixedRedisClient } = await import("../infra/prefixed-redis.js")

  const transport = createDixieTransport(process.env.DIXIE_BASE_URL)

  const prefixedRedis = deps.redisClient
    ? createPrefixedRedisClient(deps.redisClient as any, deps.redisPrefix, deps.redisDb)
    : null

  const decay = prefixedRedis ? new TemporalDecayEngine({
    redis: prefixedRedis,
    halfLifeMs: 7 * 24 * 60 * 60 * 1000,
    aggregateHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
  }) : undefined

  const exploration = prefixedRedis ? new ExplorationEngine({
    redis: prefixedRedis,
    defaultEpsilon: parseFloat(process.env.FINN_EXPLORATION_EPSILON ?? "0.05"),
    epsilonByTier: {},
    blocklist: new Set(),
    costCeiling: 2.0,
  }) : undefined

  const calibBucket = process.env.FINN_CALIBRATION_BUCKET_NAME
  const calibHmac = process.env.FINN_CALIBRATION_HMAC_KEY
  let calibration: import("./calibration.js").CalibrationEngine
  if (calibBucket && calibHmac) {
    calibration = new CalibrationEngine({
      s3Bucket: calibBucket,
      s3Key: "finn/calibration.jsonl",
      pollIntervalMs: 60_000,
      calibrationWeight: 3.0,
      hmacSecret: calibHmac,
    })
  } else {
    calibration = new CalibrationEngine({
      s3Bucket: "",
      s3Key: "",
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
      calibrationWeight: 0,
      hmacSecret: "",
    })
  }

  const runtimeConfig = new RuntimeConfig(prefixedRedis)
  const killSwitch = new KillSwitch(runtimeConfig)
  const goodhartMetrics = new GraduationMetrics()

  if (decay && exploration) {
    const goodhartConfig: MechanismConfig = {
      decay,
      exploration,
      calibration,
      killSwitch,
      explorationFeedbackWeight: 0.5,
      metrics: goodhartMetrics,
    }
    const routingState = deps.requestedMode as "shadow" | "enabled"
    goodhartMetrics.setRoutingMode(routingState)
    return { goodhartConfig, routingState, goodhartMetrics }
  }

  // Redis unavailable — not init_failed (known condition)
  console.warn("[finn] goodhart: redis unavailable, degrading to deterministic")
  goodhartMetrics.setRoutingMode("disabled")
  return { goodhartConfig: undefined, routingState: "disabled", goodhartMetrics }
}

// --- Recovery Scheduler ---

const BACKOFF_BASE_MS = 60_000
const MAX_RETRIES = 5

/**
 * Exponential backoff recovery scheduler for Goodhart init_failed state.
 * Retries at 60s, 120s, 240s, 480s, 960s then stops.
 * On success, atomically updates the GoodhartRuntime holder.
 */
export class GoodhartRecoveryScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = false

  constructor(
    private readonly runtime: GoodhartRuntime,
    private readonly initDeps: GoodhartInitDeps,
    private readonly onRecovery?: (runtime: GoodhartRuntime) => void,
  ) {}

  /** Start the recovery schedule. Call once after init_failed. */
  start(): void {
    if (this.stopped) return
    this.scheduleNext()
  }

  /** Stop the scheduler (e.g. on SIGTERM). Idempotent. */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (this.stopped || this.attempt >= MAX_RETRIES) {
      if (this.attempt >= MAX_RETRIES) {
        console.warn(JSON.stringify({
          component: "goodhart-recovery",
          event: "max_retries_reached",
          attempts: this.attempt,
          timestamp: new Date().toISOString(),
        }))
      }
      return
    }

    const delayMs = BACKOFF_BASE_MS * Math.pow(2, this.attempt)
    this.timer = setTimeout(() => void this.attemptRecovery(), delayMs)
    this.timer.unref() // Don't block process exit
  }

  private async attemptRecovery(): Promise<void> {
    if (this.stopped) return
    this.attempt++
    this.runtime.goodhartMetrics?.recoveryAttemptTotal.inc()

    console.log(JSON.stringify({
      component: "goodhart-recovery",
      event: "recovery_attempt",
      attempt: this.attempt,
      maxRetries: MAX_RETRIES,
      timestamp: new Date().toISOString(),
    }))

    try {
      const recovered = await initGoodhartStack(this.initDeps)

      // Only update if init actually produced a working config
      if (recovered.goodhartConfig && recovered.routingState !== "disabled") {
        // Emit state transition event (T-4.6)
        const { emitRoutingStateTransition } = await import("./routing-events.js")
        const prevState = this.runtime.routingState
        // Atomic update of the mutable holder
        this.runtime.goodhartConfig = recovered.goodhartConfig
        this.runtime.routingState = recovered.routingState
        this.runtime.goodhartMetrics = recovered.goodhartMetrics
        this.runtime.goodhartMetrics?.recoverySuccessTotal.inc()
        this.runtime.goodhartMetrics?.setRoutingMode(recovered.routingState)
        emitRoutingStateTransition(prevState, recovered.routingState, "recovery_success")

        console.log(JSON.stringify({
          component: "goodhart-recovery",
          event: "recovery_success",
          attempt: this.attempt,
          routingState: recovered.routingState,
          timestamp: new Date().toISOString(),
        }))

        this.onRecovery?.(this.runtime)
        return // Success — stop scheduling
      }

      // Init succeeded but no config (e.g. Redis still down) — retry
      console.warn(JSON.stringify({
        component: "goodhart-recovery",
        event: "recovery_no_config",
        attempt: this.attempt,
        routingState: recovered.routingState,
        timestamp: new Date().toISOString(),
      }))
    } catch (err) {
      console.warn(JSON.stringify({
        component: "goodhart-recovery",
        event: "recovery_failed",
        attempt: this.attempt,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }))
    }

    this.scheduleNext()
  }
}
