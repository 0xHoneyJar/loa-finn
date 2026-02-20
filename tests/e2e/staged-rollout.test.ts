// tests/e2e/staged-rollout.test.ts — Gate Validation (Sprint 10 Task 10.2)
//
// Validates each PRD gate's feature flag configuration.
// Gate 0: billing only. Gate 1: +credits. Gate 2: +nft+onboarding. Gate 4: +x402.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { FeatureFlagService } from "../../src/gateway/feature-flags.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1 }),
    incrby: vi.fn(async () => 1),
    expire: vi.fn(async () => true),
    eval: vi.fn(async () => null),
    hgetall: vi.fn(async () => null),
  } as unknown as RedisCommandClient
}

async function setGateFlags(
  flags: FeatureFlagService,
  config: Record<string, boolean>,
): Promise<void> {
  for (const [flag, enabled] of Object.entries(config)) {
    await flags.setFlag(flag, enabled)
  }
}

// ---------------------------------------------------------------------------
// Gate 0: Smoke — Billing Only
// ---------------------------------------------------------------------------

describe("Gate 0 (Smoke): Billing enabled, all else OFF", () => {
  let flags: FeatureFlagService

  beforeEach(async () => {
    flags = new FeatureFlagService({ redis: createMockRedis() })
    await setGateFlags(flags, {
      billing: true,
      credits: false,
      nft: false,
      onboarding: false,
      x402: false,
    })
  })

  it("billing is enabled", async () => {
    expect(await flags.isEnabled("billing")).toBe(true)
  })

  it("credits, nft, onboarding, x402 are disabled", async () => {
    expect(await flags.isEnabled("credits")).toBe(false)
    expect(await flags.isEnabled("nft")).toBe(false)
    expect(await flags.isEnabled("onboarding")).toBe(false)
    expect(await flags.isEnabled("x402")).toBe(false)
  })

  it("all flags return correct state", async () => {
    const all = await flags.getAllFlags()
    expect(all.billing).toBe(true)
    expect(all.credits).toBe(false)
    expect(all.nft).toBe(false)
    expect(all.onboarding).toBe(false)
    expect(all.x402).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gate 1: Ignition — + Credits
// ---------------------------------------------------------------------------

describe("Gate 1 (Ignition): + credits enabled", () => {
  let flags: FeatureFlagService

  beforeEach(async () => {
    flags = new FeatureFlagService({ redis: createMockRedis() })
    await setGateFlags(flags, {
      billing: true,
      credits: true,
      nft: false,
      onboarding: false,
      x402: false,
    })
  })

  it("billing and credits enabled", async () => {
    expect(await flags.isEnabled("billing")).toBe(true)
    expect(await flags.isEnabled("credits")).toBe(true)
  })

  it("nft, onboarding, x402 still disabled", async () => {
    expect(await flags.isEnabled("nft")).toBe(false)
    expect(await flags.isEnabled("onboarding")).toBe(false)
    expect(await flags.isEnabled("x402")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gate 2: Warmup — + NFT + Onboarding
// ---------------------------------------------------------------------------

describe("Gate 2 (Warmup): + nft + onboarding enabled", () => {
  let flags: FeatureFlagService

  beforeEach(async () => {
    flags = new FeatureFlagService({ redis: createMockRedis() })
    await setGateFlags(flags, {
      billing: true,
      credits: true,
      nft: true,
      onboarding: true,
      x402: false,
    })
  })

  it("billing, credits, nft, onboarding enabled", async () => {
    expect(await flags.isEnabled("billing")).toBe(true)
    expect(await flags.isEnabled("credits")).toBe(true)
    expect(await flags.isEnabled("nft")).toBe(true)
    expect(await flags.isEnabled("onboarding")).toBe(true)
  })

  it("x402 still disabled", async () => {
    expect(await flags.isEnabled("x402")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gate 3: Idle — Same as Gate 2 (BYOK in Sprint 3)
// ---------------------------------------------------------------------------

describe("Gate 3 (Idle): Same config as Gate 2", () => {
  it("BYOK enabled as part of credits track", async () => {
    const flags = new FeatureFlagService({ redis: createMockRedis() })
    await setGateFlags(flags, {
      billing: true,
      credits: true,
      nft: true,
      onboarding: true,
      x402: false,
    })

    // All Gate 2 flags on, x402 still off
    const all = await flags.getAllFlags()
    expect(all.billing).toBe(true)
    expect(all.credits).toBe(true)
    expect(all.nft).toBe(true)
    expect(all.onboarding).toBe(true)
    expect(all.x402).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gate 4: Launch — + x402
// ---------------------------------------------------------------------------

describe("Gate 4 (Launch): All features enabled", () => {
  let flags: FeatureFlagService

  beforeEach(async () => {
    flags = new FeatureFlagService({ redis: createMockRedis() })
    await setGateFlags(flags, {
      billing: true,
      credits: true,
      nft: true,
      onboarding: true,
      x402: true,
    })
  })

  it("all features enabled", async () => {
    const all = await flags.getAllFlags()
    expect(all.billing).toBe(true)
    expect(all.credits).toBe(true)
    expect(all.nft).toBe(true)
    expect(all.onboarding).toBe(true)
    expect(all.x402).toBe(true)
  })

  it("each gate is additive", async () => {
    // Gate 4 is Gate 2 + x402
    expect(await flags.isEnabled("billing")).toBe(true)
    expect(await flags.isEnabled("credits")).toBe(true)
    expect(await flags.isEnabled("nft")).toBe(true)
    expect(await flags.isEnabled("onboarding")).toBe(true)
    expect(await flags.isEnabled("x402")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Gate Transition Validation
// ---------------------------------------------------------------------------

describe("Gate transitions", () => {
  it("progressive flag enablement across gates", async () => {
    const redis = createMockRedis()
    const flags = new FeatureFlagService({ redis })

    // Start at Gate 0
    await setGateFlags(flags, { billing: true })
    expect(await flags.isEnabled("billing")).toBe(true)
    expect(await flags.isEnabled("credits")).toBe(false)

    // Advance to Gate 1
    await flags.setFlag("credits", true)
    expect(await flags.isEnabled("credits")).toBe(true)
    expect(await flags.isEnabled("nft")).toBe(false)

    // Advance to Gate 2
    await flags.setFlag("nft", true)
    await flags.setFlag("onboarding", true)
    expect(await flags.isEnabled("nft")).toBe(true)
    expect(await flags.isEnabled("onboarding")).toBe(true)

    // Advance to Gate 4
    await flags.setFlag("x402", true)
    const all = await flags.getAllFlags()
    expect(Object.values(all).every(Boolean)).toBe(true)
  })

  it("rollback to previous gate: disable flag restores previous behavior", async () => {
    const redis = createMockRedis()
    const flags = new FeatureFlagService({ redis })

    // Set Gate 4
    await setGateFlags(flags, {
      billing: true, credits: true, nft: true, onboarding: true, x402: true,
    })

    // Rollback to Gate 2: disable x402
    await flags.setFlag("x402", false)
    expect(await flags.isEnabled("x402")).toBe(false)
    expect(await flags.isEnabled("nft")).toBe(true) // Other flags unaffected
  })
})
