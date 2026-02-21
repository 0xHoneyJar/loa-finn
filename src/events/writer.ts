/**
 * EventWriter Interface — Sprint 1 (GID 121), Task T1.2
 *
 * Backend-agnostic interface for appending events to streams.
 * Sequence is assigned by the writer on successful append (WAL-position authority).
 * Implementations: JsonlEventWriter (T1.3), PostgresEventWriter (T1.4).
 */

import type { EventEnvelope, EventStream } from "./types.js"

export interface EventWriter {
  /**
   * Append an event to a stream.
   *
   * The writer auto-assigns: event_id (ULID), checksum (CRC32), timestamp, sequence.
   * Sequence is WAL-position-authoritative: assigned on successful append,
   * monotonic per stream, gaps allowed on crash.
   *
   * @param stream - The target stream (must be registered)
   * @param event_type - Application-level event type
   * @param payload - The event data
   * @param correlation_id - Trace correlation ID
   * @returns The fully-formed EventEnvelope with all fields populated
   */
  append<T>(
    stream: EventStream,
    event_type: string,
    payload: T,
    correlation_id: string,
  ): Promise<EventEnvelope<T>>

  /**
   * Close the writer and release resources.
   */
  close(): Promise<void>
}
