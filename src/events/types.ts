/**
 * EventStore Type Definitions — Sprint 1 (GID 121), Task T1.1
 *
 * Unified event envelope generalizing 4 append-only streams:
 * billing WAL, credit journal, reconciliation audit, personality versions.
 *
 * dAMP vocabulary: events are the epigenetic record of agent experience.
 * The EventStore is the substrate for agent memory.
 */

import { crc32 } from "../billing/state-machine.js"
import type { BillingWALEnvelope } from "../billing/types.js"

// ---------------------------------------------------------------------------
// Branded EventStream type — open registry (GPT-5.2 fix #2)
// ---------------------------------------------------------------------------

declare const _eventStreamBrand: unique symbol
export type EventStream = string & { readonly [_eventStreamBrand]: true }

const _registeredStreams = new Set<string>()

export function registerEventStream(name: string): EventStream {
  if (!name || typeof name !== "string" || name.length === 0) {
    throw new Error(`Invalid stream name: ${String(name)}`)
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `Stream name must match /^[a-z][a-z0-9_]*$/: ${name}`,
    )
  }
  _registeredStreams.add(name)
  return name as EventStream
}

export function isRegisteredStream(name: string): name is EventStream {
  return _registeredStreams.has(name)
}

export function assertRegisteredStream(name: string): EventStream {
  if (!isRegisteredStream(name)) {
    throw new Error(`Unknown event stream: ${name}. Register it first via registerEventStream().`)
  }
  return name as EventStream
}

export function getRegisteredStreams(): ReadonlySet<string> {
  return _registeredStreams
}

// Pre-register the 5 known streams
export const STREAM_BILLING = registerEventStream("billing")
export const STREAM_CREDIT = registerEventStream("credit")
export const STREAM_RECONCILIATION = registerEventStream("reconciliation")
export const STREAM_PERSONALITY = registerEventStream("personality")
export const STREAM_ROUTING_QUALITY = registerEventStream("routing_quality")

// ---------------------------------------------------------------------------
// EventEnvelope<T> — the universal event container
// ---------------------------------------------------------------------------

export interface EventEnvelope<T = unknown> {
  /** ULID — globally unique event identifier */
  readonly event_id: string
  /** Branded stream name — determines backend routing */
  readonly stream: EventStream
  /** Application-level event type (e.g. "billing_reserve", "credit_consume") */
  readonly event_type: string
  /** Unix milliseconds */
  readonly timestamp: number
  /** Trace correlation — links events across subsystems */
  readonly correlation_id: string
  /** Monotonic per-stream, assigned by writer on successful append. Gaps allowed on crash. */
  readonly sequence: number
  /** CRC32 hex of JSON.stringify(payload) */
  readonly checksum: string
  /** Envelope schema version for forward compat */
  readonly schema_version: number
  /** The event data */
  readonly payload: T
}

/** Current envelope schema version */
export const EVENT_ENVELOPE_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// EventCursor — replay position (sequence-based)
// ---------------------------------------------------------------------------

export interface EventCursor {
  /** Stream to resume from */
  readonly stream: EventStream
  /** Last processed sequence number — replay starts AFTER this */
  readonly last_sequence: number
}

// ---------------------------------------------------------------------------
// Mapping: BillingWALEnvelope <-> EventEnvelope
// ---------------------------------------------------------------------------

/**
 * Convert a BillingWALEnvelope to an EventEnvelope.
 * The billing_entry_id becomes the event_id (both are ULIDs).
 */
export function fromBillingEnvelope<T>(
  billing: BillingWALEnvelope<T>,
): EventEnvelope<T> {
  return {
    event_id: billing.billing_entry_id,
    stream: STREAM_BILLING,
    event_type: billing.event_type,
    timestamp: billing.timestamp,
    correlation_id: billing.correlation_id,
    sequence: billing.wal_sequence ?? 0,
    checksum: billing.checksum,
    schema_version: billing.schema_version,
    payload: billing.payload,
  }
}

/**
 * Convert an EventEnvelope back to BillingWALEnvelope format.
 * Used for backward compatibility with wal-replay.ts.
 */
export function toBillingEnvelope<T>(
  event: EventEnvelope<T>,
): BillingWALEnvelope<T> {
  return {
    schema_version: event.schema_version,
    event_type: event.event_type,
    timestamp: event.timestamp,
    billing_entry_id: event.event_id as BillingWALEnvelope<T>["billing_entry_id"],
    correlation_id: event.correlation_id,
    checksum: event.checksum,
    wal_sequence: event.sequence,
    payload: event.payload,
  }
}

// ---------------------------------------------------------------------------
// CRC32 helper — re-export from billing for unified use
// ---------------------------------------------------------------------------

export { crc32 }

/**
 * Compute CRC32 checksum for an event payload.
 */
export function computePayloadChecksum<T>(payload: T): string {
  return crc32(JSON.stringify(payload))
}
