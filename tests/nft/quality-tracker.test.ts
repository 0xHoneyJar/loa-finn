// tests/nft/quality-tracker.test.ts — Quality Tracker Tests (Sprint 27 Task 27.4)
//
// Tests: logging to sink, score clamping, matrix generation, deterministic ordering.

import { describe, it, expect, vi } from "vitest"
import {
  QualityTracker,
  InMemoryQualityLogSink,
  generateQualityMatrix,
  createQualityTracker,
} from "../../src/nft/quality-tracker.js"
import type { QualityEntry, QualityLogSink } from "../../src/nft/quality-tracker.js"

// ---------------------------------------------------------------------------
// Basic Logging
// ---------------------------------------------------------------------------

describe("QualityTracker basic logging", () => {
  it("records an entry to the sink", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-abc", "claude-sonnet-4", 0.85, "bears:42")

    const entries = sink.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].fingerprint_hash).toBe("hash-abc")
    expect(entries[0].model).toBe("claude-sonnet-4")
    expect(entries[0].quality_score).toBe(0.85)
    expect(entries[0].personality_id).toBe("bears:42")
    expect(entries[0].timestamp).toBeTruthy()
  })

  it("records multiple entries", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-1", "claude-sonnet-4", 0.9, "p:1")
    tracker.record("hash-2", "gpt-4.1", 0.7, "p:2")
    tracker.record("hash-1", "claude-sonnet-4", 0.8, "p:1")

    expect(sink.size).toBe(3)
  })

  it("includes metadata when provided", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-x", "gpt-4.1", 0.6, "p:5", { latency_ms: 150, eval_provider: "internal" })

    const entries = sink.getEntries()
    expect(entries[0].metadata).toEqual({ latency_ms: 150, eval_provider: "internal" })
  })

  it("omits metadata field when not provided", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-y", "claude-haiku-4", 0.5, "p:6")

    const entries = sink.getEntries()
    expect(entries[0].metadata).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Score Clamping
// ---------------------------------------------------------------------------

describe("QualityTracker score clamping", () => {
  it("clamps scores above 1.0 to 1.0", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-a", "model-a", 1.5, "p:1")

    expect(sink.getEntries()[0].quality_score).toBe(1.0)
  })

  it("clamps scores below 0.0 to 0.0", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-b", "model-b", -0.3, "p:2")

    expect(sink.getEntries()[0].quality_score).toBe(0.0)
  })

  it("does not clamp scores within [0, 1]", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-c", "model-c", 0.0, "p:3")
    tracker.record("hash-d", "model-d", 1.0, "p:4")
    tracker.record("hash-e", "model-e", 0.5, "p:5")

    const entries = sink.getEntries()
    expect(entries[0].quality_score).toBe(0.0)
    expect(entries[1].quality_score).toBe(1.0)
    expect(entries[2].quality_score).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// Console Sink (default)
// ---------------------------------------------------------------------------

describe("QualityTracker default console sink", () => {
  it("logs to console.log as JSON", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const tracker = createQualityTracker()

    tracker.record("hash-console", "model-x", 0.75, "p:console")

    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(logged.type).toBe("quality_observation")
    expect(logged.fingerprint_hash).toBe("hash-console")
    expect(logged.model).toBe("model-x")
    expect(logged.quality_score).toBe(0.75)

    logSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// InMemoryQualityLogSink
// ---------------------------------------------------------------------------

describe("InMemoryQualityLogSink", () => {
  it("getEntries returns defensive copy", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-1", "model-1", 0.5, "p:1")
    const entries1 = sink.getEntries()
    tracker.record("hash-2", "model-2", 0.6, "p:2")
    const entries2 = sink.getEntries()

    // First snapshot should not be mutated
    expect(entries1).toHaveLength(1)
    expect(entries2).toHaveLength(2)
  })

  it("size reflects total entries", () => {
    const sink = new InMemoryQualityLogSink()
    expect(sink.size).toBe(0)

    const tracker = new QualityTracker(sink)
    tracker.record("h", "m", 0.5, "p")
    expect(sink.size).toBe(1)

    tracker.record("h", "m", 0.6, "p")
    expect(sink.size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Quality Matrix Generation
// ---------------------------------------------------------------------------

describe("Quality matrix generation", () => {
  it("generates matrix from entries", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-A", "claude-sonnet-4", 0.9, "p:1")
    tracker.record("hash-A", "claude-sonnet-4", 0.8, "p:1")
    tracker.record("hash-A", "gpt-4.1", 0.7, "p:1")
    tracker.record("hash-B", "claude-sonnet-4", 0.6, "p:2")

    const matrix = generateQualityMatrix(sink)

    expect(matrix.total_entries).toBe(4)
    expect(matrix.cells).toHaveLength(3)
    expect(matrix.generated_at).toBeTruthy()
  })

  it("computes correct aggregates per (hash, model) pair", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-X", "model-1", 0.4, "p:1")
    tracker.record("hash-X", "model-1", 0.6, "p:1")
    tracker.record("hash-X", "model-1", 0.8, "p:1")

    const matrix = generateQualityMatrix(sink)

    expect(matrix.cells).toHaveLength(1)
    const cell = matrix.cells[0]
    expect(cell.fingerprint_hash).toBe("hash-X")
    expect(cell.model).toBe("model-1")
    expect(cell.count).toBe(3)
    expect(cell.mean_score).toBeCloseTo(0.6, 5)
    expect(cell.min_score).toBe(0.4)
    expect(cell.max_score).toBe(0.8)
  })

  it("returns empty matrix for empty sink", () => {
    const sink = new InMemoryQualityLogSink()
    const matrix = generateQualityMatrix(sink)

    expect(matrix.total_entries).toBe(0)
    expect(matrix.cells).toHaveLength(0)
  })

  it("matrix cells are sorted by fingerprint_hash then model", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-B", "model-2", 0.5, "p:1")
    tracker.record("hash-A", "model-2", 0.5, "p:1")
    tracker.record("hash-B", "model-1", 0.5, "p:1")
    tracker.record("hash-A", "model-1", 0.5, "p:1")

    const matrix = generateQualityMatrix(sink)

    expect(matrix.cells[0].fingerprint_hash).toBe("hash-A")
    expect(matrix.cells[0].model).toBe("model-1")
    expect(matrix.cells[1].fingerprint_hash).toBe("hash-A")
    expect(matrix.cells[1].model).toBe("model-2")
    expect(matrix.cells[2].fingerprint_hash).toBe("hash-B")
    expect(matrix.cells[2].model).toBe("model-1")
    expect(matrix.cells[3].fingerprint_hash).toBe("hash-B")
    expect(matrix.cells[3].model).toBe("model-2")
  })

  it("single entry produces correct cell", () => {
    const sink = new InMemoryQualityLogSink()
    const tracker = new QualityTracker(sink)

    tracker.record("hash-solo", "model-solo", 0.42, "p:solo")

    const matrix = generateQualityMatrix(sink)

    expect(matrix.cells).toHaveLength(1)
    expect(matrix.cells[0].count).toBe(1)
    expect(matrix.cells[0].mean_score).toBe(0.42)
    expect(matrix.cells[0].min_score).toBe(0.42)
    expect(matrix.cells[0].max_score).toBe(0.42)
  })
})

// ---------------------------------------------------------------------------
// Custom Sink
// ---------------------------------------------------------------------------

describe("Custom sink integration", () => {
  it("accepts a custom QualityLogSink", () => {
    const appendedEntries: QualityEntry[] = []
    const customSink: QualityLogSink = {
      append(entry: QualityEntry) {
        appendedEntries.push(entry)
      },
    }

    const tracker = new QualityTracker(customSink)
    tracker.record("hash-custom", "model-custom", 0.99, "p:custom")

    expect(appendedEntries).toHaveLength(1)
    expect(appendedEntries[0].quality_score).toBe(0.99)
  })
})
