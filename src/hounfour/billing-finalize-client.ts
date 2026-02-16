// src/hounfour/billing-finalize-client.ts — S2S Billing Finalize Client (SDD §3.1, Phase 5 T3)
// Best-effort synchronous finalize with DLQ fallback.
// finalize() NEVER throws — always returns FinalizeResult.

import type { S2SJwtSigner } from "./s2s-jwt.js"
import type { DLQStore } from "./dlq-store.js"

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
  created_at: string        // ISO-8601, set once on first enqueue, never updated
}

export interface BillingFinalizeConfig {
  billingUrl: string          // Base URL, e.g. https://arrakis.example.com — path appended in sendFinalize()
  s2sSigner: S2SJwtSigner
  dlqStore: DLQStore          // DLQ persistence backend (InMemory or Redis)
  timeoutMs?: number          // default: 1000
  maxRetries?: number         // default: 5
  /** JWT subject mode: "service" (sub="loa-finn") or "tenant" (sub=tenant_id, legacy).
   *  Default: "tenant" until arrakis compatibility confirmed.
   *  See Bridgebuilder Finding #10 (PR #68). */
  s2sSubjectMode?: "service" | "tenant"
  /** AOF check result from bootstrap validatePersistence(). Set once at startup. */
  aofVerified?: boolean
}

// --- Constants ---

// WHY: Amazon p99.9 headroom — timeout should be 5-10x p50 or 2-3x p99.
// PRD target: p50 <20ms, p99 <100ms. At 1000ms we get 10x p99 headroom,
// catching p99.9 spikes without DLQ churn. See Bridgebuilder Finding #7 (PR #68).
const DEFAULT_TIMEOUT_MS = 1000
const MAX_RETRIES = 5
const BACKOFF_SCHEDULE_MS = [60_000, 120_000, 240_000, 480_000, 600_000] // 1m, 2m, 4m, 8m, 10m

// Terminal HTTP status codes — go straight to DLQ, no retry
const TERMINAL_STATUSES = new Set([401, 404, 422])

// --- Client ---

export class BillingFinalizeClient {
  private readonly dlqStore: DLQStore
  private readonly config: BillingFinalizeConfig
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly _aofVerified: boolean
  private replayTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: BillingFinalizeConfig) {
    this.config = config
    this.dlqStore = config.dlqStore
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = config.maxRetries ?? MAX_RETRIES
    this._aofVerified = config.aofVerified ?? false
  }

  /** Get count of entries in the DLQ */
  async getDLQSize(): Promise<number> {
    return this.dlqStore.count()
  }

  /** Get age in ms of oldest DLQ entry (by created_at). Returns null if empty. */
  async getDLQOldestAgeMs(): Promise<number | null> {
    return this.dlqStore.oldestEntryAgeMs()
  }

  /** Whether the DLQ store provides durable persistence */
  isDurable(): boolean {
    return this.dlqStore.durable
  }

  /** AOF verification result from bootstrap. */
  isAofVerified(): boolean {
    return this._aofVerified
  }

  /** Get the underlying DLQ store (for health endpoint / testing) */
  getDLQStore(): DLQStore {
    return this.dlqStore
  }

  /**
   * Finalize a billing reservation. NEVER throws.
   * Returns { ok: true } on success/idempotent, { ok: false, status: "dlq" } on failure.
   */
  async finalize(req: FinalizeRequest): Promise<FinalizeResult> {
    try {
      // Validate cost is non-negative string BigInt
      if (!isValidCostMicro(req.actual_cost_micro)) {
        return await this.toDLQ(req, "invalid_cost: actual_cost_micro must be non-negative integer string", null)
      }

      if (!req.reservation_id) {
        return await this.toDLQ(req, "missing_reservation_id", null)
      }

      const result = await this.sendFinalize(req)
      return result
    } catch (err) {
      // finalize() NEVER throws
      const reason = err instanceof Error ? err.message : String(err)
      return await this.toDLQ(req, `internal_error: ${reason}`, null)
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

  /**
   * Replay DLQ entries that are due. NEVER throws (outer try/catch).
   * Per-entry flow: terminal check → claim → try { finalize → delete/increment } finally { release }
   */
  async replayDeadLetters(): Promise<{ replayed: number; succeeded: number; failed: number; terminal: number }> {
    try {
      const candidates = await this.dlqStore.getReady(new Date())
      let replayed = 0
      let succeeded = 0
      let failed = 0
      let terminal = 0

      for (const entry of candidates) {
        const rid = entry.reservation_id

        // Step 5: Terminal drop runs before claim — no lock needed
        if (entry.attempt_count >= this.maxRetries) {
          await this.dlqStore.terminalDrop(rid)
          console.error(`[billing-finalize] DLQ terminal drop: rid=${rid} tenant_id=${entry.tenant_id} actual_cost_micro=${entry.actual_cost_micro} created_at=${entry.created_at} attempts=${entry.attempt_count}`)
          terminal++
          continue
        }

        // Step 2: Claim lock (SETNX) — if false, skip (another instance owns it)
        const claimed = await this.dlqStore.claimForReplay(rid)
        if (!claimed) continue

        // Step 3: try/finally for leak-safe claim lifecycle
        replayed++
        try {
          // Use sendHTTPFinalize (no DLQ side effects) — replay handles its own state
          const result = await this.sendHTTPFinalize({
            reservation_id: rid,
            tenant_id: entry.tenant_id,
            actual_cost_micro: entry.actual_cost_micro,
            trace_id: entry.trace_id,
          })

          if (result.ok) {
            await this.dlqStore.delete(rid)
            succeeded++
          } else {
            const backoffIndex = Math.min(entry.attempt_count, BACKOFF_SCHEDULE_MS.length - 1)
            const nextMs = Date.now() + BACKOFF_SCHEDULE_MS[backoffIndex]
            const nextAt = new Date(nextMs).toISOString()
            await this.dlqStore.incrementAttempt(rid, nextAt, nextMs)
            failed++
          }
        } finally {
          await this.dlqStore.releaseClaim(rid)
        }
      }

      if (replayed > 0 || terminal > 0) {
        console.log(`[billing-finalize] DLQ replay: replayed=${replayed} succeeded=${succeeded} failed=${failed} terminal=${terminal}`)
      }

      return { replayed, succeeded, failed, terminal }
    } catch (err) {
      // NEVER-throws contract: swallow error, return zero-state
      console.error(`[billing-finalize] DLQ replay error (swallowed): ${err instanceof Error ? err.message : String(err)}`)
      return { replayed: 0, succeeded: 0, failed: 0, terminal: 0 }
    }
  }

  // --- Private ---

  /**
   * Send HTTP finalize and route failures to DLQ.
   * Used by finalize() for initial attempts.
   */
  private async sendFinalize(req: FinalizeRequest): Promise<FinalizeResult> {
    const httpResult = await this.sendHTTPFinalize(req)
    if (httpResult.ok) return httpResult
    return await this.toDLQ(req, httpResult.reason, httpResult.responseStatus)
  }

  /**
   * Raw HTTP call to arrakis. No DLQ side effects.
   * Returns success result or failure reason for caller to handle.
   */
  private async sendHTTPFinalize(req: FinalizeRequest): Promise<
    | { ok: true; status: "finalized" | "idempotent" }
    | { ok: false; reason: string; responseStatus: number | null }
  > {
    // WHY: Google Service Account convention — `sub` identifies the calling service,
    // not the delegated tenant. `tenant_id` as a custom claim preserves the delegation
    // chain for audit trails. Gated by s2sSubjectMode until arrakis compatibility
    // confirmed. See Bridgebuilder Finding #10 (PR #68).
    const sub = this.config.s2sSubjectMode === "service" ? "loa-finn" : req.tenant_id
    const token = await this.config.s2sSigner.signJWT({
      sub,
      tenant_id: req.tenant_id,
      purpose: "billing_finalize",
      reservation_id: req.reservation_id,
      trace_id: req.trace_id,
    }, 300) // 5 minute TTL

    // Wire contract: snake_case internal → camelCase at boundary.
    // tenant_id → accountId (arrakis identity field mapping).
    const body = JSON.stringify({
      reservationId: req.reservation_id,
      accountId: req.tenant_id,       // arrakis expects accountId, mapped from tenant_id
      actualCostMicro: req.actual_cost_micro,
      traceId: req.trace_id,
    })

    // Base URL + path (no /billing/ segment — arrakis uses /api/internal/finalize)
    const base = this.config.billingUrl.replace(/\/+$/, "")
    const finalizeUrl = `${base}/api/internal/finalize`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await fetch(finalizeUrl, {
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
        return { ok: false, reason: "timeout", responseStatus: null }
      }
      const reason = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: `network_error: ${reason}`, responseStatus: null }
    } finally {
      clearTimeout(timeout)
    }

    // 200 = success
    if (response.status === 200) {
      return { ok: true, status: "finalized" }
    }

    // WHY: 409 Conflict means "already finalized" — the reservation was billed by a
    // previous attempt (DLQ replay, duplicate request, or race). Treating 409 as
    // idempotent success prevents infinite DLQ cycling. See Finding #9 (PR #68).
    if (response.status === 409) {
      return { ok: true, status: "idempotent" }
    }

    // All other statuses — failure reason for caller
    return { ok: false, reason: `http_${response.status}`, responseStatus: response.status }
  }

  private async toDLQ(req: FinalizeRequest, reason: string, responseStatus: number | null): Promise<FinalizeResult> {
    // Atomic upsert via store.put() — no get-then-put.
    // Store handles attempt_count increment for existing entries (DLQ_UPSERT Lua).
    // created_at set once on first enqueue, preserved by upsert.
    const entry: DLQEntry = {
      reservation_id: req.reservation_id,
      tenant_id: req.tenant_id,
      actual_cost_micro: req.actual_cost_micro,
      trace_id: req.trace_id,
      reason,
      response_status: responseStatus,
      attempt_count: 1,
      next_attempt_at: new Date(Date.now() + BACKOFF_SCHEDULE_MS[0]).toISOString(),
      created_at: new Date().toISOString(),
    }

    await this.dlqStore.put(entry)
    console.warn(`[billing-finalize] DLQ: reservation_id=${req.reservation_id} reason=${reason}`)

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
