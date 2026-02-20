/**
 * Postgres EventWriter — Sprint 1 (GID 121), Task T1.4
 *
 * Append-only Postgres backend for EventStore.
 * Uses Drizzle ORM with the finn_events table.
 *
 * Sequence authority: atomic MAX+1 inside INSERT transaction.
 * Postgres serialization guarantees uniqueness and monotonicity.
 */

import { eq, sql } from "drizzle-orm"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { ulid } from "ulid"
import type { EventWriter } from "./writer.js"
import type { EventEnvelope, EventStream } from "./types.js"
import { assertRegisteredStream, computePayloadChecksum, EVENT_ENVELOPE_SCHEMA_VERSION } from "./types.js"
import { finnEvents } from "../drizzle/schema.js"

export type DrizzleDB = PostgresJsDatabase<Record<string, never>>

export interface PostgresEventWriterOptions {
  db: DrizzleDB
}

export class PostgresEventWriter implements EventWriter {
  private readonly db: DrizzleDB
  private closed = false

  constructor(options: PostgresEventWriterOptions) {
    this.db = options.db
  }

  async append<T>(
    stream: EventStream,
    event_type: string,
    payload: T,
    correlation_id: string,
  ): Promise<EventEnvelope<T>> {
    if (this.closed) {
      throw new Error("PostgresEventWriter is closed")
    }
    assertRegisteredStream(stream)

    const event_id = ulid()
    const timestamp = Date.now()
    const checksum = computePayloadChecksum(payload)

    // Atomic sequence assignment: MAX+1 inside the transaction
    const result = await this.db.transaction(async (tx) => {
      const seqResult = await tx
        .select({ maxSeq: sql<number>`COALESCE(MAX(${finnEvents.sequence}), 0)` })
        .from(finnEvents)
        .where(eq(finnEvents.stream, stream))

      const sequence = (seqResult[0]?.maxSeq ?? 0) + 1

      await tx.insert(finnEvents).values({
        eventId: event_id,
        stream,
        eventType: event_type,
        sequence,
        timestamp,
        correlationId: correlation_id,
        checksum,
        schemaVersion: EVENT_ENVELOPE_SCHEMA_VERSION,
        payload,
      })

      return sequence
    })

    const envelope: EventEnvelope<T> = {
      event_id,
      stream,
      event_type,
      timestamp,
      correlation_id,
      sequence: result,
      checksum,
      schema_version: EVENT_ENVELOPE_SCHEMA_VERSION,
      payload,
    }

    return envelope
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
