// tests/finn/goodhart/resolve.test.ts — resolveWithGoodhart Tests (T-1.4, cycle-036)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { resolveWithGoodhart } from "../../../src/hounfour/goodhart/resolve.js"
import type { MechanismConfig } from "../../../src/hounfour/goodhart/mechanism-interaction.js"
import type { PoolId, Tier } from "@0xhoneyjar/loa-hounfour"
import { GraduationMetrics } from "../../../src/hounfour/graduation-metrics.js"

// --- Mock MechanismConfig ---

const POOL_A = "pool-alpha" as PoolId
const POOL_B = "pool-beta" as PoolId

function createMockConfig(overrides?: Partial<MechanismConfig>): MechanismConfig {
  return {
    decay: {
      getDecayedScore: vi.fn().mockResolvedValue({ score: 0.8, decayed: true }),
      getRawState: vi.fn().mockResolvedValue({ sampleCount: 10 }),
      updateEMA: vi.fn().mockResolvedValue(undefined),
    } as any,
    exploration: {
      decide: vi.fn().mockReturnValue({
        explore: false,
        candidateSetSize: 0,
        randomValue: 0.5,
      }),
      recordExploration: vi.fn().mockResolvedValue(undefined),
    } as any,
    calibration: {
      getCalibration: vi.fn().mockReturnValue([]),
      blendWithDecay: vi.fn().mockReturnValue(0.8),
    } as any,
    killSwitch: {
      isDisabled: vi.fn().mockResolvedValue(false),
      getState: vi.fn().mockResolvedValue("enabled"),
    } as any,
    explorationFeedbackWeight: 0.5,
    ...overrides,
  }
}

describe("resolveWithGoodhart", () => {
  let metrics: GraduationMetrics

  beforeEach(() => {
    metrics = new GraduationMetrics()
  })

  it("returns GoodhartResult on successful scoring", async () => {
    const config = createMockConfig()
    const result = await resolveWithGoodhart(
      config,
      "standard" as Tier,
      "nft-001",
      "coding",
      undefined,
      [POOL_A, POOL_B],
      new Map(),
      new Map(),
      1.0,
      new Map(),
      { mode: "enabled", seed: "test-seed", allowWrites: true },
      metrics,
    )

    expect(result).not.toBeNull()
    expect(result!.pool).toBeDefined()
    expect(result!.path).toBeDefined()
  })

  it("returns null and increments timeout counter on timeout", async () => {
    const config = createMockConfig({
      killSwitch: {
        isDisabled: vi.fn().mockResolvedValue(false),
        getState: vi.fn().mockImplementation(() =>
          new Promise((resolve) => setTimeout(resolve, 500, "enabled"))
        ),
      } as any,
    })

    const result = await resolveWithGoodhart(
      config,
      "standard" as Tier,
      "nft-001",
      "coding",
      undefined,
      [POOL_A],
      new Map(),
      new Map(),
      1.0,
      new Map(),
      { mode: "enabled", seed: "test-seed", allowWrites: true },
      metrics,
    )

    expect(result).toBeNull()
    expect(metrics.goodhartTimeoutTotal.get()).toBe(1)
  })

  it("propagates TypeError (programmer error)", async () => {
    const config = createMockConfig({
      killSwitch: {
        isDisabled: vi.fn().mockRejectedValue(new TypeError("bad type")),
        getState: vi.fn().mockRejectedValue(new TypeError("bad type")),
      } as any,
    })

    await expect(
      resolveWithGoodhart(
        config,
        "standard" as Tier,
        "nft-001",
        "coding",
        undefined,
        [POOL_A],
        new Map(),
        new Map(),
        1.0,
        new Map(),
        { mode: "enabled", seed: "test-seed", allowWrites: true },
        metrics,
      ),
    ).rejects.toThrow(TypeError)
  })

  it("catches operational errors and returns null", async () => {
    const config = createMockConfig({
      killSwitch: {
        isDisabled: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
        getState: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
      } as any,
    })

    const result = await resolveWithGoodhart(
      config,
      "standard" as Tier,
      "nft-001",
      "coding",
      undefined,
      [POOL_A],
      new Map(),
      new Map(),
      1.0,
      new Map(),
      { mode: "enabled", seed: "test-seed", allowWrites: true },
      metrics,
    )

    expect(result).toBeNull()
  })
})
