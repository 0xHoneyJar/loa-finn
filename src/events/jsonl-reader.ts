/**
 * JSONL EventReader — Sprint 1 (GID 121), Task T1.3
 *
 * Reads events from JSONL segment files in order.
 * Validates CRC32 checksums — skips corrupt entries with warning.
 * Supports cursor-based replay (resume from last processed sequence).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { EventReader } from "./reader.js"
import type { EventCursor, EventEnvelope, EventStream } from "./types.js"
import { computePayloadChecksum } from "./types.js"

const SEGMENT_PREFIX = "events-"
const SEGMENT_SUFFIX = ".jsonl"

export interface JsonlEventReaderOptions {
  /** Directory containing JSONL segments */
  dir: string
}

export class JsonlEventReader implements EventReader {
  private readonly dir: string
  private closed = false

  /** Exposed for compaction (Sprint 2, T2.2) */
  get dataDir(): string {
    return this.dir
  }

  constructor(options: JsonlEventReaderOptions) {
    this.dir = options.dir
  }

  async *replay<T = unknown>(
    stream: EventStream,
    cursor?: EventCursor,
  ): AsyncIterable<EventEnvelope<T>> {
    if (this.closed) {
      throw new Error("JsonlEventReader is closed")
    }

    const afterSequence = cursor?.last_sequence ?? 0
    const segments = this.listSegmentsForStream(stream)

    for (const seg of segments) {
      const fullPath = join(this.dir, seg)
      if (!existsSync(fullPath)) continue

      const content = readFileSync(fullPath, "utf-8")
      const lines = content.split("\n")

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line.length === 0) continue

        let envelope: EventEnvelope<T>
        try {
          envelope = JSON.parse(line) as EventEnvelope<T>
        } catch {
          // Torn write or corruption
          if (i === lines.length - 1) {
            // Last line — likely torn write, skip silently
            continue
          }
          console.warn(`[JsonlEventReader] Corrupt entry in ${seg} line ${i + 1}, skipping`)
          continue
        }

        // Filter by stream (segment may contain mixed streams in future)
        if (envelope.stream !== stream) continue

        // Skip entries before cursor
        if (envelope.sequence <= afterSequence) continue

        // CRC32 validation
        const expectedChecksum = computePayloadChecksum(envelope.payload)
        if (envelope.checksum !== expectedChecksum) {
          console.warn(
            `[JsonlEventReader] CRC32 mismatch in ${seg} line ${i + 1}: ` +
            `expected=${expectedChecksum}, got=${envelope.checksum}. Skipping.`,
          )
          continue
        }

        yield envelope
      }
    }
  }

  async getLatestSequence(stream: EventStream): Promise<number> {
    if (this.closed) {
      throw new Error("JsonlEventReader is closed")
    }

    let maxSequence = 0
    const segments = this.listSegmentsForStream(stream)

    // Read from last segment backward for efficiency
    for (let s = segments.length - 1; s >= 0; s--) {
      const fullPath = join(this.dir, segments[s])
      if (!existsSync(fullPath)) continue

      const content = readFileSync(fullPath, "utf-8")
      const lines = content.split("\n").filter((l) => l.trim().length > 0)

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as EventEnvelope
          if (parsed.stream === stream && parsed.sequence > maxSequence) {
            maxSequence = parsed.sequence
            return maxSequence // Found the latest in the last segment
          }
        } catch {
          continue
        }
      }
    }

    return maxSequence
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private listSegmentsForStream(stream: string): string[] {
    try {
      return readdirSync(this.dir)
        .filter(
          (f) =>
            f.startsWith(`${SEGMENT_PREFIX}${stream}-`) &&
            f.endsWith(SEGMENT_SUFFIX),
        )
        .sort()
    } catch {
      return []
    }
  }
}
