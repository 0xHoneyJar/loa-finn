// tests/finn/typebox-formats.test.ts — TypeBox Format Registration Verification (Sprint 134 Task 3.3)
//
// Verifies that FormatRegistry has uuid and date-time registered via the setup file,
// validates format correctness, and tests the guard from T-3.2.

import { describe, it, expect, vi } from "vitest"
import { FormatRegistry } from "@sinclair/typebox"
import "../../src/hounfour/typebox-formats.js" // Ensure formats registered

describe("TypeBox Format Registration (AC11)", () => {
  // --- Format registration verification ---

  it("FormatRegistry.Has('uuid') returns true after setup", () => {
    expect(FormatRegistry.Has("uuid")).toBe(true)
  })

  it("FormatRegistry.Has('date-time') returns true after setup", () => {
    expect(FormatRegistry.Has("date-time")).toBe(true)
  })

  // --- UUID format correctness ---

  it("uuid format accepts valid UUIDs", () => {
    const check = FormatRegistry.Get("uuid")!
    expect(check("550e8400-e29b-41d4-a716-446655440000")).toBe(true)
    expect(check("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true)
    expect(check("00000000-0000-0000-0000-000000000000")).toBe(true)
  })

  it("uuid format rejects invalid strings", () => {
    const check = FormatRegistry.Get("uuid")!
    expect(check("not-a-uuid")).toBe(false)
    expect(check("")).toBe(false)
    expect(check("550e8400-e29b-41d4-a716")).toBe(false) // truncated
    expect(check("550e8400e29b41d4a716446655440000")).toBe(false) // no dashes
  })

  // --- date-time format correctness ---

  it("date-time format accepts ISO 8601 strings", () => {
    const check = FormatRegistry.Get("date-time")!
    expect(check("2026-01-15T12:00:00.000Z")).toBe(true)
    expect(check("2026-02-25T10:30:00Z")).toBe(true)
    expect(check("2024-12-31T23:59:59.999Z")).toBe(true)
  })

  it("date-time format rejects garbage strings", () => {
    const check = FormatRegistry.Get("date-time")!
    expect(check("not-a-date")).toBe(false)
    expect(check("")).toBe(false)
    expect(check("yesterday")).toBe(false)
  })

  // --- FormatRegistry guard test (T-3.2) ---

  it("normalizer throws explicit error if uuid format not registered", async () => {
    // Temporarily clear the uuid format to test the guard
    const originalCheck = FormatRegistry.Get("uuid")!
    FormatRegistry.Delete("uuid")

    try {
      const { normalizeReputationEvent } = await import(
        "../../src/hounfour/reputation-event-normalizer.js"
      )
      expect(() =>
        normalizeReputationEvent({
          event_id: "550e8400-e29b-41d4-a716-446655440000",
          agent_id: "agent-001",
          collection_id: "collection-001",
          timestamp: "2026-01-15T12:00:00.000Z",
          type: "quality_signal",
          score: 0.85,
        }),
      ).toThrow("TypeBox formats not registered: uuid — import typebox-formats.js")
    } finally {
      // Restore format registration for subsequent tests
      FormatRegistry.Set("uuid", originalCheck)
    }
  })

  it("normalizer throws explicit error if date-time format not registered", async () => {
    const originalCheck = FormatRegistry.Get("date-time")!
    FormatRegistry.Delete("date-time")

    try {
      const { normalizeReputationEvent } = await import(
        "../../src/hounfour/reputation-event-normalizer.js"
      )
      expect(() =>
        normalizeReputationEvent({
          event_id: "550e8400-e29b-41d4-a716-446655440000",
          agent_id: "agent-001",
          collection_id: "collection-001",
          timestamp: "2026-01-15T12:00:00.000Z",
          type: "quality_signal",
          score: 0.85,
        }),
      ).toThrow("TypeBox formats not registered: date-time — import typebox-formats.js")
    } finally {
      FormatRegistry.Set("date-time", originalCheck)
    }
  })
})
