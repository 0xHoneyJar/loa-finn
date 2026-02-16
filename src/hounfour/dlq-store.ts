// src/hounfour/dlq-store.ts — DLQStore port interface + InMemoryDLQStore (SDD §3.1, Sprint 1 T1)
//
// Port interface for DLQ persistence. Two adapters: InMemoryDLQStore (fallback)
// and RedisDLQStore (durable, in redis/dlq.ts). The interface is the seam that
// lets BillingFinalizeClient work identically in both modes.

import type { DLQEntry } from "./billing-finalize-client.js"

// --- Port Interface ---

export interface DLQStore {
  put(entry: DLQEntry): Promise<void>
  get(reservationId: string): Promise<DLQEntry | null>
  getReady(before: Date): Promise<DLQEntry[]>
  delete(reservationId: string): Promise<void>
  count(): Promise<number>
  oldestEntryAgeMs(): Promise<number | null>
  /** Acquire claim lock for replay. Returns true if lock acquired (SETNX semantics). */
  claimForReplay(reservationId: string): Promise<boolean>
  /** Release claim lock after replay attempt. */
  releaseClaim(reservationId: string): Promise<void>
  /** Atomically increment attempt count and reschedule. Returns new attempt_count or null if missing. */
  incrementAttempt(reservationId: string, nextAttemptAt: string, nextAttemptMs: number): Promise<number | null>
  /** Move entry to terminal keyspace (Redis) or delete (InMemory). For audit trail. */
  terminalDrop(reservationId: string): Promise<void>
  /** Whether the store provides durable persistence */
  readonly durable: boolean
}

// --- InMemory Adapter ---

export class InMemoryDLQStore implements DLQStore {
  private readonly entries: Map<string, DLQEntry> = new Map()
  private readonly claims: Set<string> = new Set()
  readonly durable = false
  private readonly batchLimit: number

  constructor(options?: { batchLimit?: number }) {
    this.batchLimit = options?.batchLimit ?? 50
  }

  async put(entry: DLQEntry): Promise<void> {
    const existing = this.entries.get(entry.reservation_id)
    if (existing) {
      // Atomic upsert: increment attempt, preserve created_at
      existing.attempt_count += 1
      existing.next_attempt_at = entry.next_attempt_at
      existing.reason = entry.reason
      existing.response_status = entry.response_status
    } else {
      this.entries.set(entry.reservation_id, entry)
    }
  }

  async get(reservationId: string): Promise<DLQEntry | null> {
    return this.entries.get(reservationId) ?? null
  }

  async getReady(before: Date): Promise<DLQEntry[]> {
    const cutoff = before.getTime()
    return [...this.entries.values()]
      .filter(e => new Date(e.next_attempt_at).getTime() <= cutoff)
      .slice(0, this.batchLimit)
  }

  async delete(reservationId: string): Promise<void> {
    this.entries.delete(reservationId)
  }

  async count(): Promise<number> {
    return this.entries.size
  }

  async oldestEntryAgeMs(): Promise<number | null> {
    if (this.entries.size === 0) return null
    let oldestCreated = Infinity
    for (const e of this.entries.values()) {
      if (!e.created_at) continue
      const created = new Date(e.created_at).getTime()
      if (created < oldestCreated) oldestCreated = created
    }
    return oldestCreated === Infinity ? null : Date.now() - oldestCreated
  }

  async claimForReplay(reservationId: string): Promise<boolean> {
    if (this.claims.has(reservationId)) return false
    this.claims.add(reservationId)
    return true
  }

  async releaseClaim(reservationId: string): Promise<void> {
    this.claims.delete(reservationId)
  }

  async incrementAttempt(reservationId: string, nextAttemptAt: string, _nextAttemptMs: number): Promise<number | null> {
    const entry = this.entries.get(reservationId)
    if (!entry) return null
    entry.attempt_count += 1
    entry.next_attempt_at = nextAttemptAt
    return entry.attempt_count
  }

  async terminalDrop(reservationId: string): Promise<void> {
    // InMemory: no terminal keyspace, just delete
    this.entries.delete(reservationId)
  }
}
