// tests/finn/goodhart/reputation-adapter.test.ts — Reputation Adapter + Dixie Transport Tests (T-2.8, cycle-034)

import { describe, it, expect, vi } from "vitest"
import { ReputationAdapter, type ReputationAdapterConfig } from "../../../src/hounfour/goodhart/reputation-adapter.js"
import { DixieStubTransport, type DixieTransport } from "../../../src/hounfour/goodhart/dixie-transport.js"
import { normalizeResponse, wrapBareNumber } from "../../../src/hounfour/goodhart/reputation-response.js"
import type { TemporalDecayEngine, EMAState } from "../../../src/hounfour/goodhart/temporal-decay.js"
import type { CalibrationEngine, CalibrationEntry } from "../../../src/hounfour/goodhart/calibration.js"
import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../../../src/hounfour/nft-routing-config.js"

// --- Mock Factories ---

const POOL_A = "pool-alpha" as PoolId

function mockDecay(overrides?: Partial<TemporalDecayEngine>): TemporalDecayEngine {
  return {
    updateEMA: vi.fn().mockResolvedValue({ ema: 0.8, lastTimestamp: Date.now(), sampleCount: 5, lastEventHash: "h" }),
    getDecayedScore: vi.fn().mockResolvedValue({ score: 0.75, decay: "applied" as const }),
    getRawState: vi.fn().mockResolvedValue({ ema: 0.8, lastTimestamp: Date.now(), sampleCount: 5, lastEventHash: "h" } satisfies EMAState),
    ...overrides,
  } as unknown as TemporalDecayEngine
}

function mockCalibration(overrides?: Partial<CalibrationEngine>): CalibrationEngine {
  return {
    getCalibration: vi.fn().mockReturnValue([]),
    blendWithDecay: vi.fn().mockImplementation((decayed: number) => decayed),
    ...overrides,
  } as unknown as CalibrationEngine
}

// --- ReputationResponse Tests ---

describe("ReputationResponse normalization", () => {
  it("normalizes full v1 response", () => {
    const result = normalizeResponse({ version: 1, score: 0.85, asOfTimestamp: "2026-01-01T00:00:00Z", sampleCount: 42 })
    expect(result).toEqual({ version: 1, score: 0.85, asOfTimestamp: "2026-01-01T00:00:00Z", sampleCount: 42 })
  })

  it("wraps bare number (degraded mode)", () => {
    const result = normalizeResponse(0.7)
    expect(result).toEqual({ version: 1, score: 0.7, asOfTimestamp: "unknown", sampleCount: 0 })
  })

  it("clamps out-of-range scores", () => {
    expect(wrapBareNumber(1.5).score).toBe(1)
    expect(wrapBareNumber(-0.5).score).toBe(0)
  })

  it("returns null for null/undefined", () => {
    expect(normalizeResponse(null)).toBeNull()
    expect(normalizeResponse(undefined)).toBeNull()
  })

  it("handles version > 1 (forward-compat)", () => {
    const result = normalizeResponse({ version: 2, score: 0.6, unknownField: "hi" })
    expect(result).not.toBeNull()
    expect(result!.score).toBe(0.6)
    expect(result!.version).toBe(1) // Normalized to known version
  })

  it("returns null for non-object, non-number", () => {
    expect(normalizeResponse("bad")).toBeNull()
    expect(normalizeResponse(true)).toBeNull()
  })
})

// --- DixieStubTransport ---

describe("DixieStubTransport", () => {
  it("always returns null", async () => {
    const stub = new DixieStubTransport()
    expect(await stub.getReputation("nft-001")).toBeNull()
  })
})

// --- ReputationAdapter ---

describe("ReputationAdapter", () => {
  it("returns decayed + calibration-blended score when EMA exists (AC13)", async () => {
    const adapter = new ReputationAdapter({
      decay: mockDecay(),
      calibration: mockCalibration(),
      transport: new DixieStubTransport(),
    })

    const result = await adapter.query({ nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey })
    expect(result).toBeCloseTo(0.75) // From mock decay
  })

  it("different nftIds get different scores for same pool (AC11a)", async () => {
    let callCount = 0
    const decay = mockDecay({
      getDecayedScore: vi.fn().mockImplementation(async () => {
        callCount++
        return { score: callCount === 1 ? 0.6 : 0.9, decay: "applied" as const }
      }),
    })

    const adapter = new ReputationAdapter({
      decay,
      calibration: mockCalibration(),
      transport: new DixieStubTransport(),
    })

    const score1 = await adapter.query({ nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey })
    const score2 = await adapter.query({ nftId: "nft-002", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey })

    expect(score1).not.toBe(score2)
  })

  it("returns null when dixie unreachable and no EMA (AC12)", async () => {
    const adapter = new ReputationAdapter({
      decay: mockDecay({ getDecayedScore: vi.fn().mockResolvedValue(null) }),
      calibration: mockCalibration(),
      transport: new DixieStubTransport(), // Always returns null
    })

    const result = await adapter.query({ nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey })
    expect(result).toBeNull()
  })

  it("bootstraps from dixie when no EMA exists", async () => {
    const mockTransport: DixieTransport = {
      getReputation: vi.fn().mockResolvedValue({ version: 1, score: 0.65, asOfTimestamp: "2026-01-01T00:00:00Z", sampleCount: 10 }),
    }

    const adapter = new ReputationAdapter({
      decay: mockDecay({ getDecayedScore: vi.fn().mockResolvedValue(null) }),
      calibration: mockCalibration(),
      transport: mockTransport,
    })

    const result = await adapter.query({ nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey })
    expect(result).toBeCloseTo(0.65)
  })

  it("applies calibration blending when entries exist", async () => {
    const calibrationEntries: CalibrationEntry[] = [
      { nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey, score: 0.95, evaluator: "human", timestamp: "2026-01-01" },
    ]

    const adapter = new ReputationAdapter({
      decay: mockDecay(),
      calibration: mockCalibration({
        getCalibration: vi.fn().mockReturnValue(calibrationEntries),
        blendWithDecay: vi.fn().mockReturnValue(0.88),
      }),
      transport: new DixieStubTransport(),
    })

    const result = await adapter.query({ nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey })
    expect(result).toBeCloseTo(0.88)
  })

  it("toQueryFn() returns a compatible function", async () => {
    const adapter = new ReputationAdapter({
      decay: mockDecay(),
      calibration: mockCalibration(),
      transport: new DixieStubTransport(),
    })

    const fn = adapter.toQueryFn()
    const result = await fn({ nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey })
    expect(typeof result).toBe("number")
  })
})
