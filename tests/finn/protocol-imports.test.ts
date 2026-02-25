// tests/finn/protocol-imports.test.ts — Import Surface Test (Sprint 132 Task 1.4)
//
// Verifies all re-exports from protocol-types.ts resolve without errors.
// Catches broken import paths, missing subpackage exports, and stale re-exports.

import { describe, it, expect } from "vitest"

describe("Protocol Import Surface", () => {
  it("resolves all re-exports from protocol-types hub", async () => {
    // Dynamic import to get actual runtime resolution
    const hub = await import("../../src/hounfour/protocol-types.js")
    const exports = Object.keys(hub)

    // Should have a meaningful number of runtime exports (type-only re-exports are erased)
    expect(exports.length).toBeGreaterThan(40)

    // Spot-check existing exports still present
    expect(hub.microUSDC).toBeDefined()
    expect(hub.JwtClaimsSchema).toBeDefined()
    expect(hub.EconomicBoundarySchema).toBeDefined()
    expect(hub.REPUTATION_STATES).toBeDefined()
    expect(hub.evaluateAccessPolicy).toBeDefined()
  })

  it("resolves v8.2.0 governance re-exports", async () => {
    const hub = await import("../../src/hounfour/protocol-types.js")

    // ReputationEvent (v8.2.0)
    expect(hub.ReputationEventSchema).toBeDefined()
    expect(hub.ModelPerformanceEventSchema).toBeDefined()

    // QualityObservation (v8.2.0)
    expect(hub.QualityObservationSchema).toBeDefined()

    // TaskType vocabulary (v8.2.0)
    expect(hub.TaskTypeSchema).toBeDefined()
    expect(hub.TASK_TYPES).toBeDefined()
    expect(Array.isArray(hub.TASK_TYPES)).toBe(true)
    expect(hub.TASK_TYPES).toContain("unspecified")
  })

  it("resolves v8.0.0 commons re-exports", async () => {
    const hub = await import("../../src/hounfour/protocol-types.js")

    // Commons module (v8.0.0)
    expect(hub.GovernanceMutationSchema).toBeDefined()
    expect(hub.evaluateGovernanceMutation).toBeDefined()
    expect(hub.InvariantSchema).toBeDefined()
    expect(hub.InvariantViolationSchema).toBeDefined()
    expect(hub.ProtocolCapabilitySchema).toBeDefined()
    expect(hub.ProtocolSurfaceSchema).toBeDefined()
    expect(hub.QuarantineRecordSchema).toBeDefined()
    expect(hub.QuarantineStatusSchema).toBeDefined()
  })

  it("commons entrypoint resolves directly", async () => {
    const commons = await import("@0xhoneyjar/loa-hounfour/commons")
    expect(Object.keys(commons).length).toBeGreaterThan(30)
  })

  it("governance entrypoint resolves directly", async () => {
    const governance = await import("@0xhoneyjar/loa-hounfour/governance")
    expect(Object.keys(governance).length).toBeGreaterThan(100)
  })
})
