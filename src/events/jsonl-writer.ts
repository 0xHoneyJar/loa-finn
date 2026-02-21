/**
 * JSONL EventWriter — Sprint 1 (GID 121), Task T1.3
 *
 * Append-only JSONL file backend for EventStore.
 * Reuses billing WAL's segment rotation pattern.
 *
 * Sequence authority: WAL-position. Sequence = previous max + 1,
 * assigned atomically on successful append. Gaps allowed on crash,
 * monotonicity and uniqueness guaranteed.
 *
 * Segment rotation: new file when current exceeds max size (default 1GB).
 * Torn-write recovery: skip last incomplete line on init.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ulid } from "ulid"
import type { EventWriter } from "./writer.js"
import type { EventEnvelope, EventStream } from "./types.js"
import { assertRegisteredStream, computePayloadChecksum, EVENT_ENVELOPE_SCHEMA_VERSION } from "./types.js"

const DEFAULT_MAX_SEGMENT_BYTES = 1024 * 1024 * 1024 // 1GB (Flatline IMP-004)
const SEGMENT_PREFIX = "events-"
const SEGMENT_SUFFIX = ".jsonl"

export interface JsonlEventWriterOptions {
  /** Directory for JSONL segments */
  dir: string
  /** Max segment size in bytes before rotation (default: 1GB) */
  maxSegmentBytes?: number
}

export class JsonlEventWriter implements EventWriter {
  private readonly dir: string
  private readonly maxSegmentBytes: number
  /** Per-stream sequence counters — initialized from last event on first append */
  private readonly sequences = new Map<string, number>()
  private closed = false

  /** Exposed for compaction (Sprint 2, T2.2) */
  get dataDir(): string {
    return this.dir
  }

  constructor(options: JsonlEventWriterOptions) {
    this.dir = options.dir
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES

    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true })
    }

    this.initSequences()
  }

  async append<T>(
    stream: EventStream,
    event_type: string,
    payload: T,
    correlation_id: string,
  ): Promise<EventEnvelope<T>> {
    if (this.closed) {
      throw new Error("JsonlEventWriter is closed")
    }
    assertRegisteredStream(stream)

    const sequence = this.nextSequence(stream)
    const envelope: EventEnvelope<T> = {
      event_id: ulid(),
      stream,
      event_type,
      timestamp: Date.now(),
      correlation_id,
      sequence,
      checksum: computePayloadChecksum(payload),
      schema_version: EVENT_ENVELOPE_SCHEMA_VERSION,
      payload,
    }

    const line = JSON.stringify(envelope) + "\n"
    const segmentPath = this.currentSegmentPath(stream)
    appendFileSync(segmentPath, line, "utf-8")

    return envelope
  }

  async close(): Promise<void> {
    this.closed = true
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private initSequences(): void {
    const segments = this.listSegments()
    for (const seg of segments) {
      const fullPath = join(this.dir, seg)
      const content = readFileSync(fullPath, "utf-8")
      const lines = content.split("\n").filter((l) => l.trim().length > 0)

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as EventEnvelope
          const stream = parsed.stream
          const current = this.sequences.get(stream) ?? 0
          if (parsed.sequence > current) {
            this.sequences.set(stream, parsed.sequence)
          }
        } catch {
          // Torn write on last line — skip (recovery)
          if (i === lines.length - 1) continue
          // Mid-file corruption — skip with warning
          continue
        }
      }
    }
  }

  private nextSequence(stream: string): number {
    const current = this.sequences.get(stream) ?? 0
    const next = current + 1
    this.sequences.set(stream, next)
    return next
  }

  private currentSegmentPath(stream: string): string {
    const segments = this.listSegmentsForStream(stream)
    if (segments.length > 0) {
      const latest = segments[segments.length - 1]
      const fullPath = join(this.dir, latest)
      try {
        const stats = statSync(fullPath)
        if (stats.size < this.maxSegmentBytes) {
          return fullPath
        }
      } catch {
        // File disappeared — create new
      }
    }

    // Create new segment
    const segmentName = `${SEGMENT_PREFIX}${stream}-${ulid()}${SEGMENT_SUFFIX}`
    const fullPath = join(this.dir, segmentName)
    appendFileSync(fullPath, "", "utf-8") // touch
    return fullPath
  }

  private listSegments(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_SUFFIX))
        .sort()
    } catch {
      return []
    }
  }

  private listSegmentsForStream(stream: string): string[] {
    return this.listSegments().filter((f) => f.startsWith(`${SEGMENT_PREFIX}${stream}-`))
  }
}
