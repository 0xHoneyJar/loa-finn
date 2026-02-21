/**
 * Postgres EventReader — Sprint 1 (GID 121), Task T1.4
 *
 * Reads events from finn_events table via Drizzle.
 * Cursor-based replay ordered by sequence.
 * CRC32 validation with corrupt entry skipping.
 */

import { and, eq, gt, sql } from "drizzle-orm"
import { asc } from "drizzle-orm"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import type { EventReader } from "./reader.js"
import type { EventCursor, EventEnvelope, EventStream } from "./types.js"
import { computePayloadChecksum, EVENT_ENVELOPE_SCHEMA_VERSION } from "./types.js"
import { finnEvents } from "../drizzle/schema.js"

export type DrizzleDB = PostgresJsDatabase<Record<string, never>>

export interface PostgresEventReaderOptions {
  db: DrizzleDB
  /** Batch size for pagination (default: 500) */
  batchSize?: number
}

export class PostgresEventReader implements EventReader {
  private readonly db: DrizzleDB
  private readonly batchSize: number
  private closed = false

  constructor(options: PostgresEventReaderOptions) {
    this.db = options.db
    this.batchSize = options.batchSize ?? 500
  }

  async *replay<T = unknown>(
    stream: EventStream,
    cursor?: EventCursor,
  ): AsyncIterable<EventEnvelope<T>> {
    if (this.closed) {
      throw new Error("PostgresEventReader is closed")
    }

    const afterSequence = cursor?.last_sequence ?? 0
    let lastSeq = afterSequence

    while (true) {
      const rows = await this.db
        .select()
        .from(finnEvents)
        .where(
          and(
            eq(finnEvents.stream, stream),
            gt(finnEvents.sequence, lastSeq),
          ),
        )
        .orderBy(asc(finnEvents.sequence))
        .limit(this.batchSize)

      if (rows.length === 0) break

      for (const row of rows) {
        const envelope: EventEnvelope<T> = {
          event_id: row.eventId,
          stream: row.stream as EventStream,
          event_type: row.eventType,
          timestamp: row.timestamp,
          correlation_id: row.correlationId,
          sequence: row.sequence,
          checksum: row.checksum,
          schema_version: row.schemaVersion,
          payload: row.payload as T,
        }

        // CRC32 validation
        const expectedChecksum = computePayloadChecksum(envelope.payload)
        if (envelope.checksum !== expectedChecksum) {
          console.warn(
            `[PostgresEventReader] CRC32 mismatch for event ${row.eventId}: ` +
            `expected=${expectedChecksum}, got=${row.checksum}. Skipping.`,
          )
          lastSeq = row.sequence
          continue
        }

        yield envelope
        lastSeq = row.sequence
      }

      if (rows.length < this.batchSize) break
    }
  }

  async getLatestSequence(stream: EventStream): Promise<number> {
    if (this.closed) {
      throw new Error("PostgresEventReader is closed")
    }

    const result = await this.db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${finnEvents.sequence}), 0)` })
      .from(finnEvents)
      .where(eq(finnEvents.stream, stream))

    return result[0]?.maxSeq ?? 0
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
