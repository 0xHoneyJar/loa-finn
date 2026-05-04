// tests/finn/hounfour/audit-timestamp-fixtures.test.ts — T-2.2
// Validates hounfour v8.3.0 validateAuditTimestamp() against fixture data.

import { describe, it, expect } from "vitest"
import { validateAuditTimestamp } from "../../../src/hounfour/protocol-types.js"
import fixtures from "./audit-timestamp-fixtures.json"

describe("validateAuditTimestamp — fixture validation", () => {
  describe("valid timestamps", () => {
    for (const { input, note } of fixtures.valid) {
      it(`accepts: ${note} (${input})`, () => {
        const result = validateAuditTimestamp(input)
        expect(result.valid).toBe(true)
        expect(result.normalized).toBeTruthy()
        expect(result.error).toBeUndefined()
      })
    }
  })

  describe("invalid timestamps", () => {
    for (const { input, note } of fixtures.invalid) {
      it(`rejects: ${note} (${input || "<empty>"})`, () => {
        const result = validateAuditTimestamp(input)
        expect(result.valid).toBe(false)
        expect(result.error).toBeTruthy()
      })
    }
  })

  it("has >=20 valid fixtures", () => {
    expect(fixtures.valid.length).toBeGreaterThanOrEqual(20)
  })

  it("has >=10 invalid fixtures", () => {
    expect(fixtures.invalid.length).toBeGreaterThanOrEqual(10)
  })

  describe("pre-validation: existing audit trail timestamps", () => {
    // Timestamps extracted from existing test fixtures and production audit entries.
    // These MUST pass canonical validation — if any fail, compatibility policy applies.
    const existingTimestamps = [
      new Date().toISOString(),                // Current runtime
      "2026-02-28T15:04:00.000Z",             // Session timestamp
      "2026-01-15T10:30:00.000Z",             // Recent production
      "2025-12-01T00:00:00.000Z",             // Older production
    ]

    for (const ts of existingTimestamps) {
      it(`existing timestamp passes canonical: ${ts}`, () => {
        const result = validateAuditTimestamp(ts)
        expect(result.valid).toBe(true)
      })
    }
  })
})
