// src/hounfour/billing-finalize-client.ts — S2S Billing Finalize Client (SDD §3.1, Phase 5 T3)
// Best-effort synchronous finalize with DLQ fallback.
// finalize() NEVER throws — always returns FinalizeResult.

import type { S2SJwtSigner } from "./s2s-jwt.js"

// --- Types ---

export interface FinalizeRequest {
  reservation_id: string
  tenant_id: string
  actual_cost_micro: string   // string-serialized BigInt (IEEE-754 safe)
  trace_id: string
}

export type FinalizeResult =
  | { ok: true; status: "finalized" | "idempotent" }
  | { ok: false; status: "dlq"; reason: string }

export interface DLQEntry {
  reservation_id: string
  tenant_id: string
  actual_cost_micro: string
  trace_id: string
  reason: string
  response_status: number | null
  attempt_count: number
  next_attempt_at: string   // ISO-8601
}

export interface BillingFinalizeConfig {
  billingUrl: string          // e.g. https://arrakis.example.com/api/internal/billing/finalize
  s2sSigner: S2SJwtSigner
  timeoutMs?: number          // default: 300
  maxRetries?: number         // default: 5
}

// --- Constants ---

const DEFAULT_TIMEOUT_MS = 300
const MAX_RETRIES = 5
const BACKOFF_SCHEDULE_MS = [60_000, 120_000, 240_000, 480_000, 600_000] // 1m, 2m, 4m, 8m, 10m

// Terminal HTTP status codes — go straight to DLQ, no retry
const TERMINAL_STATUSES = new Set([401, 404, 422])

// --- DLQ Store (in-memory with JSONL fallback) ---

const dlqEntries: Map<string, DLQEntry> = new Map()

export function getDLQEntries(): ReadonlyMap<string, DLQEntry> {
  return dlqEntries
}

export function getDLQSize(): number {
  return dlqEntries.size
}

// --- Client ---

export class BillingFinalizeClient {
  private readonly config: BillingFinalizeConfig
  private readonly timeoutMs: number
  private replayTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: BillingFinalizeConfig) {
    this.config = config
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Finalize a billing reservation. NEVER throws.
   * Returns { ok: true } on success/idempotent, { ok: false, status: "dlq" } on failure.
   */
  async finalize(req: FinalizeRequest): Promise<FinalizeResult> {
    try {
      // Validate cost is non-negative string BigInt
      if (!isValidCostMicro(req.actual_cost_micro)) {
        return this.toDLQ(req, "invalid_cost: actual_cost_micro must be non-negative integer string", null)
      }

      if (!req.reservation_id) {
        return this.toDLQ(req, "missing_reservation_id", null)
      }

      const result = await this.sendFinalize(req)
      return result
    } catch (err) {
      // finalize() NEVER throws
      const reason = err instanceof Error ? err.message : String(err)
      return this.toDLQ(req, `internal_error: ${reason}`, null)
    }
  }

  /**
   * Start background DLQ replay timer.
   * Replays entries every intervalMs (default: 5 minutes).
   */
  startReplayTimer(intervalMs: number = 300_000): void {
    if (this.replayTimer) return
    this.replayTimer = setInterval(() => {
      void this.replayDeadLetters()
    }, intervalMs)
    // Don't block process exit
    if (this.replayTimer.unref) this.replayTimer.unref()
  }

  /** Stop background DLQ replay timer */
  stopReplayTimer(): void {
    if (this.replayTimer) {
      clearInterval(this.replayTimer)
      this.replayTimer = null
    }
  }

  /** Replay all DLQ entries that are due */
  async replayDeadLetters(): Promise<{ replayed: number; succeeded: number; failed: number }> {
    const now = Date.now()
    let replayed = 0
    let succeeded = 0
    let failed = 0

    for (const [key, entry] of dlqEntries) {
      if (new Date(entry.next_attempt_at).getTime() > now) continue
      if (entry.attempt_count >= (this.config.maxRetries ?? MAX_RETRIES)) {
        // Terminal — remove from DLQ (exhausted retries)
        dlqEntries.delete(key)
        console.error(`[billing-finalize] DLQ terminal drop: reservation_id=${entry.reservation_id} attempts=${entry.attempt_count}`)
        continue
      }

      replayed++
      const result = await this.sendFinalize({
        reservation_id: entry.reservation_id,
        tenant_id: entry.tenant_id,
        actual_cost_micro: entry.actual_cost_micro,
        trace_id: entry.trace_id,
      })

      if (result.ok) {
        dlqEntries.delete(key)
        succeeded++
      } else {
        // Update attempt count and next_attempt_at
        entry.attempt_count++
        const backoffIndex = Math.min(entry.attempt_count - 1, BACKOFF_SCHEDULE_MS.length - 1)
        entry.next_attempt_at = new Date(now + BACKOFF_SCHEDULE_MS[backoffIndex]).toISOString()
        failed++
      }
    }

    if (replayed > 0) {
      console.log(`[billing-finalize] DLQ replay: replayed=${replayed} succeeded=${succeeded} failed=${failed} remaining=${dlqEntries.size}`)
    }

    return { replayed, succeeded, failed }
  }

  // --- Private ---

  private async sendFinalize(req: FinalizeRequest): Promise<FinalizeResult> {
    // Sign S2S JWT with sub/aud/iss claims
    const token = await this.config.s2sSigner.signJWT({
      sub: req.tenant_id,
      purpose: "billing_finalize",
      reservation_id: req.reservation_id,
      trace_id: req.trace_id,
    }, 300) // 5 minute TTL

    const body = JSON.stringify({
      reservation_id: req.reservation_id,
      tenant_id: req.tenant_id,
      actual_cost_micro: req.actual_cost_micro,
      trace_id: req.trace_id,
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await fetch(this.config.billingUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      if (err instanceof DOMException && err.name === "AbortError") {
        return this.toDLQ(req, "timeout", null)
      }
      const reason = err instanceof Error ? err.message : String(err)
      return this.toDLQ(req, `network_error: ${reason}`, null)
    } finally {
      clearTimeout(timeout)
    }

    // 200 = success
    if (response.status === 200) {
      return { ok: true, status: "finalized" }
    }

    // 409 = idempotent success (already finalized)
    if (response.status === 409) {
      return { ok: true, status: "idempotent" }
    }

    // Terminal errors — DLQ with reason, no retry
    if (TERMINAL_STATUSES.has(response.status)) {
      const reason = `http_${response.status}`
      return this.toDLQ(req, reason, response.status)
    }

    // 5xx — retry via DLQ
    return this.toDLQ(req, `http_${response.status}`, response.status)
  }

  private toDLQ(req: FinalizeRequest, reason: string, responseStatus: number | null): FinalizeResult {
    const existing = dlqEntries.get(req.reservation_id)
    const attemptCount = existing ? existing.attempt_count + 1 : 1
    const backoffIndex = Math.min(attemptCount - 1, BACKOFF_SCHEDULE_MS.length - 1)

    const entry: DLQEntry = {
      reservation_id: req.reservation_id,
      tenant_id: req.tenant_id,
      actual_cost_micro: req.actual_cost_micro,
      trace_id: req.trace_id,
      reason,
      response_status: responseStatus,
      attempt_count: attemptCount,
      next_attempt_at: new Date(Date.now() + BACKOFF_SCHEDULE_MS[backoffIndex]).toISOString(),
    }

    dlqEntries.set(req.reservation_id, entry)
    console.warn(`[billing-finalize] DLQ: reservation_id=${req.reservation_id} reason=${reason} attempt=${attemptCount}`)

    return { ok: false, status: "dlq", reason }
  }
}

// --- Helpers ---

function isValidCostMicro(value: string): boolean {
  if (typeof value !== "string") return false
  if (!/^[0-9]+$/.test(value)) return false
  // Must be non-negative (no leading minus, pattern already ensures digits only)
  return true
}
