/**
 * EventReader Interface — Sprint 1 (GID 121), Task T1.2
 *
 * Backend-agnostic interface for replaying events from streams.
 * Supports cursor-based replay (resume from last processed sequence).
 * Implementations: JsonlEventReader (T1.3), PostgresEventReader (T1.4).
 */

import type { EventCursor, EventEnvelope, EventStream } from "./types.js"

export interface EventReader {
  /**
   * Replay events from a stream, optionally starting after a cursor position.
   *
   * Returns an async iterable that yields events in sequence order.
   * If cursor is provided, only events with sequence > cursor.last_sequence are yielded.
   * If cursor is omitted, replay starts from the beginning of the stream.
   *
   * CRC32 validation: implementations SHOULD validate checksums and skip
   * corrupt entries with a warning (not throw).
   *
   * @param stream - The target stream
   * @param cursor - Optional resume position
   */
  replay<T = unknown>(
    stream: EventStream,
    cursor?: EventCursor,
  ): AsyncIterable<EventEnvelope<T>>

  /**
   * Get the latest sequence number for a stream.
   * Returns 0 if the stream has no events.
   */
  getLatestSequence(stream: EventStream): Promise<number>

  /**
   * Close the reader and release resources.
   */
  close(): Promise<void>
}
