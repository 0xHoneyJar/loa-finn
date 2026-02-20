// src/billing/state-machine.ts — Billing State Machine (SDD §6.3, Sprint 1 Task 1.1)
//
// WAL-authoritative commit model:
//   1. WAL append (authoritative)
//   2. Redis update (derived cache)
//   3. Finalize enqueue (async side-effect)

import { createHash } from "node:crypto"
import type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"
import { parseMicroUSD, serializeMicroUSD } from "../hounfour/wire-boundary.js"
import {
  type BillingEntry,
  type BillingEntryId,
  type BillingCommitPayload,
  type BillingFinalizeAckPayload,
  type BillingFinalizeFailPayload,
  type BillingReleasePayload,
  type BillingReservePayload,
  type BillingVoidPayload,
  type BillingWALEnvelope,
  type BillingEventType,
  type ExchangeRateSnapshot,
  BillingState,
  BillingStateError,
  BILLING_WAL_SCHEMA_VERSION,
  VALID_TRANSITIONS,
  parseBillingEntryId,
} from "./types.js"

// ---------------------------------------------------------------------------
// CRC32 — lightweight checksum for WAL records (Flatline SKP-001)
// ---------------------------------------------------------------------------

const CRC32_TABLE = new Int32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC32_TABLE[i] = c
}

export function crc32(data: string): string {
  let crc = ~0
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data.charCodeAt(i)) & 0xff] ^ (crc >>> 8)
  }
  return ((crc ^ ~0) >>> 0).toString(16).padStart(8, "0")
}

// ---------------------------------------------------------------------------
// WAL Sequence Counter (Bridge high-4: monotonic ordering across processes)
// ---------------------------------------------------------------------------

/** Global monotonic WAL sequence counter.
 *  Guarantees strict total ordering within a single process.
 *  For multi-process deployments, each process gets a unique sequence space
 *  and the replay engine uses sequence numbers for correct ordering. */
let _walSequence = 0

/** Get next monotonic WAL sequence number. */
export function nextWALSequence(): number {
  return ++_walSequence
}

/** Set WAL sequence to a known value (startup recovery from Redis/DB). */
export function setWALSequence(seq: number): void {
  _walSequence = seq
}

/** Reset WAL sequence counter (testing only). */
export function _resetWALSequence(): void {
  _walSequence = 0
}

// ---------------------------------------------------------------------------
// WAL Envelope Factory
// ---------------------------------------------------------------------------

export function createBillingWALEnvelope<T>(
  eventType: BillingEventType,
  billingEntryId: BillingEntryId,
  correlationId: string,
  payload: T,
): BillingWALEnvelope<T> {
  const payloadStr = JSON.stringify(payload)
  return {
    schema_version: BILLING_WAL_SCHEMA_VERSION,
    event_type: eventType,
    timestamp: Date.now(),
    billing_entry_id: billingEntryId,
    correlation_id: correlationId,
    checksum: crc32(payloadStr),
    wal_sequence: nextWALSequence(),
    payload,
  }
}

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

export interface BillingStateMachineDeps {
  /** Append a billing WAL envelope. Returns the WAL entry ID (offset). */
  walAppend: (envelope: BillingWALEnvelope) => string
  /** Update Redis-derived billing state (idempotent on billing_entry_id). */
  redisUpdate: (entry: BillingEntry) => Promise<void>
  /** Enqueue finalize to DLQ for async processing. */
  enqueueFinalze: (billingEntryId: BillingEntryId, accountId: string, actualCost: MicroUSD, correlationId: string) => Promise<void>
  /** Generate a new ULID for billing_entry_id. */
  generateId: () => BillingEntryId
  /** Log a state transition for observability. */
  onTransition?: (billingEntryId: BillingEntryId, from: BillingState, to: BillingState, costMicroUsd?: string) => void
}

export class BillingStateMachine {
  private readonly deps: BillingStateMachineDeps

  constructor(deps: BillingStateMachineDeps) {
    this.deps = deps
  }

  // === RESERVE ===

  /**
   * Create a new billing entry in RESERVE_HELD state.
   * Transition: IDLE → RESERVE_HELD
   *
   * 1. WAL append billing_reserve (authoritative)
   * 2. Redis update (derived)
   */
  async reserve(
    accountId: string,
    estimatedCost: MicroUSD,
    correlationId: string,
    rateSnapshot: ExchangeRateSnapshot,
  ): Promise<BillingEntry> {
    const billingEntryId = this.deps.generateId()
    const now = Date.now()

    const payload: BillingReservePayload = {
      account_id: accountId,
      estimated_cost: serializeMicroUSD(estimatedCost),
      exchange_rate_snapshot: rateSnapshot,
    }

    const envelope = createBillingWALEnvelope("billing_reserve", billingEntryId, correlationId, payload)
    const walOffset = this.deps.walAppend(envelope)

    const entry: BillingEntry = {
      billing_entry_id: billingEntryId,
      correlation_id: correlationId,
      state: BillingState.RESERVE_HELD,
      account_id: accountId,
      estimated_cost: estimatedCost,
      actual_cost: null,
      exchange_rate_snapshot: rateSnapshot,
      created_at: now,
      updated_at: now,
      wal_offset: walOffset,
      finalize_attempts: 0,
    }

    await this.deps.redisUpdate(entry)
    this.deps.onTransition?.(billingEntryId, BillingState.IDLE, BillingState.RESERVE_HELD, serializeMicroUSD(estimatedCost))

    return entry
  }

  // === COMMIT ===

  /**
   * Commit a reserved billing entry.
   * Transition: RESERVE_HELD → COMMITTED → FINALIZE_PENDING
   *
   * 1. WAL append billing_commit (authoritative)
   * 2. Redis update (derived, idempotent on billing_entry_id)
   * 3. Enqueue finalize (async)
   */
  async commit(entry: BillingEntry, actualCost: MicroUSD): Promise<BillingEntry> {
    this.validateTransition(entry.state, BillingState.COMMITTED)

    const payload: BillingCommitPayload = {
      actual_cost: serializeMicroUSD(actualCost),
    }

    const envelope = createBillingWALEnvelope("billing_commit", entry.billing_entry_id, entry.correlation_id, payload)
    const walOffset = this.deps.walAppend(envelope)

    const updated: BillingEntry = {
      ...entry,
      state: BillingState.FINALIZE_PENDING,
      actual_cost: actualCost,
      updated_at: Date.now(),
      wal_offset: walOffset,
    }

    await this.deps.redisUpdate(updated)
    this.deps.onTransition?.(entry.billing_entry_id, BillingState.RESERVE_HELD, BillingState.FINALIZE_PENDING, serializeMicroUSD(actualCost))

    // Enqueue async finalize (best-effort — DLQ handles failures)
    await this.deps.enqueueFinalze(entry.billing_entry_id, entry.account_id, actualCost, entry.correlation_id)

    return updated
  }

  // === RELEASE ===

  /**
   * Release a reserved billing entry (pre-stream failure, TTL expiry, user cancel).
   * Transition: RESERVE_HELD → RELEASED
   *
   * 1. WAL append billing_release (authoritative)
   * 2. Redis update (derived)
   */
  async release(entry: BillingEntry, reason: BillingReleasePayload["reason"]): Promise<BillingEntry> {
    this.validateTransition(entry.state, BillingState.RELEASED)

    const payload: BillingReleasePayload = { reason }
    const envelope = createBillingWALEnvelope("billing_release", entry.billing_entry_id, entry.correlation_id, payload)
    const walOffset = this.deps.walAppend(envelope)

    const updated: BillingEntry = {
      ...entry,
      state: BillingState.RELEASED,
      updated_at: Date.now(),
      wal_offset: walOffset,
    }

    await this.deps.redisUpdate(updated)
    this.deps.onTransition?.(entry.billing_entry_id, BillingState.RESERVE_HELD, BillingState.RELEASED)

    return updated
  }

  // === VOID ===

  /**
   * Void a billing entry (admin action on COMMITTED or FINALIZE_FAILED).
   * Transition: COMMITTED → VOIDED or FINALIZE_FAILED → VOIDED
   */
  async void_(entry: BillingEntry, reason: string, adminId?: string): Promise<BillingEntry> {
    this.validateTransition(entry.state, BillingState.VOIDED)

    const payload: BillingVoidPayload = { reason, admin_id: adminId }
    const envelope = createBillingWALEnvelope("billing_void", entry.billing_entry_id, entry.correlation_id, payload)
    const walOffset = this.deps.walAppend(envelope)

    const updated: BillingEntry = {
      ...entry,
      state: BillingState.VOIDED,
      updated_at: Date.now(),
      wal_offset: walOffset,
    }

    await this.deps.redisUpdate(updated)
    this.deps.onTransition?.(entry.billing_entry_id, entry.state, BillingState.VOIDED)

    return updated
  }

  // === FINALIZE ACK ===

  /**
   * Mark finalize as acknowledged by arrakis.
   * Transition: FINALIZE_PENDING → FINALIZE_ACKED or FINALIZE_FAILED → FINALIZE_ACKED
   */
  async finalizeAck(entry: BillingEntry, arrakisResponseStatus: number): Promise<BillingEntry> {
    this.validateTransition(entry.state, BillingState.FINALIZE_ACKED)

    const payload: BillingFinalizeAckPayload = { arrakis_response_status: arrakisResponseStatus }
    const envelope = createBillingWALEnvelope("billing_finalize_ack", entry.billing_entry_id, entry.correlation_id, payload)
    const walOffset = this.deps.walAppend(envelope)

    const updated: BillingEntry = {
      ...entry,
      state: BillingState.FINALIZE_ACKED,
      updated_at: Date.now(),
      wal_offset: walOffset,
    }

    await this.deps.redisUpdate(updated)
    this.deps.onTransition?.(entry.billing_entry_id, entry.state, BillingState.FINALIZE_ACKED)

    return updated
  }

  // === FINALIZE FAIL ===

  /**
   * Mark finalize as failed (DLQ retry exhausted or explicit failure).
   * Transition: FINALIZE_PENDING → FINALIZE_FAILED
   */
  async finalizeFail(entry: BillingEntry, attempt: number, reason: string): Promise<BillingEntry> {
    this.validateTransition(entry.state, BillingState.FINALIZE_FAILED)

    const payload: BillingFinalizeFailPayload = { attempt, reason }
    const envelope = createBillingWALEnvelope("billing_finalize_fail", entry.billing_entry_id, entry.correlation_id, payload)
    const walOffset = this.deps.walAppend(envelope)

    const updated: BillingEntry = {
      ...entry,
      state: BillingState.FINALIZE_FAILED,
      updated_at: Date.now(),
      wal_offset: walOffset,
      finalize_attempts: attempt,
    }

    await this.deps.redisUpdate(updated)
    this.deps.onTransition?.(entry.billing_entry_id, entry.state, BillingState.FINALIZE_FAILED)

    return updated
  }

  // === VALIDATION ===

  private validateTransition(currentState: BillingState, targetState: BillingState): void {
    const validTargets = VALID_TRANSITIONS[currentState]
    if (!validTargets.includes(targetState)) {
      throw new BillingStateError(currentState, targetState)
    }
  }
}
