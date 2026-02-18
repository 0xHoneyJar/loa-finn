// tests/finn/allowlist.test.ts — Allowlist + Feature Flags Test Suite (Sprint 6 Task 6.5)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { AllowlistService, normalizeAddress } from "../../src/gateway/allowlist.js"
import { FeatureFlagService, adminRoutes } from "../../src/gateway/feature-flags.js"
import { OnboardingService, OnboardingError } from "../../src/nft/onboarding.js"
import { waitlistRoutes } from "../../src/gateway/waitlist.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. Address Normalization
// ---------------------------------------------------------------------------

describe("normalizeAddress", () => {
  it("normalizes valid address with 0x prefix", () => {
    const result = normalizeAddress("0xAbCdEf1234567890abcdef1234567890AbCdEf12")
    expect(result).toBe("0xabcdef1234567890abcdef1234567890abcdef12")
  })

  it("normalizes valid address with 0X prefix", () => {
    const result = normalizeAddress("0XAbCdEf1234567890abcdef1234567890AbCdEf12")
    expect(result).toBe("0xabcdef1234567890abcdef1234567890abcdef12")
  })

  it("normalizes address without prefix", () => {
    const result = normalizeAddress("abcdef1234567890abcdef1234567890abcdef12")
    expect(result).toBe("0xabcdef1234567890abcdef1234567890abcdef12")
  })

  it("returns null for too-short address", () => {
    expect(normalizeAddress("0xabc")).toBeNull()
  })

  it("returns null for too-long address", () => {
    expect(normalizeAddress("0x" + "a".repeat(41))).toBeNull()
  })

  it("returns null for invalid hex chars", () => {
    expect(normalizeAddress("0xgggggg1234567890abcdef1234567890abcdef12")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(normalizeAddress("")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Allowlist Service
// ---------------------------------------------------------------------------

describe("AllowlistService", () => {
  let service: AllowlistService
  let redis: RedisCommandClient

  beforeEach(() => {
    redis = createMockRedis()
    service = new AllowlistService({ redis })
  })

  it("non-allowlisted address returns false", async () => {
    const result = await service.isAllowed("0xAbCdEf1234567890abcdef1234567890AbCdEf12")
    expect(result).toBe(false)
  })

  it("allowlisted address returns true", async () => {
    await service.addAddresses(["0xAbCdEf1234567890abcdef1234567890AbCdEf12"])
    const result = await service.isAllowed("0xAbCdEf1234567890abcdef1234567890AbCdEf12")
    expect(result).toBe(true)
  })

  it("mixed-case address matches lowercase entry", async () => {
    await service.addAddresses(["0xabcdef1234567890abcdef1234567890abcdef12"])
    // Query with uppercase
    const result = await service.isAllowed("0xABCDEF1234567890ABCDEF1234567890ABCDEF12")
    expect(result).toBe(true)
  })

  it("invalid address returns false", async () => {
    const result = await service.isAllowed("not-an-address")
    expect(result).toBe(false)
  })

  it("add returns added and invalid lists", async () => {
    const result = await service.addAddresses([
      "0xAbCdEf1234567890abcdef1234567890AbCdEf12",
      "invalid",
      "0x1111111111111111111111111111111111111111",
    ])
    expect(result.added).toHaveLength(2)
    expect(result.invalid).toEqual(["invalid"])
  })

  it("remove makes address no longer allowed", async () => {
    const addr = "0xAbCdEf1234567890abcdef1234567890AbCdEf12"
    await service.addAddresses([addr])
    expect(await service.isAllowed(addr)).toBe(true)

    await service.removeAddresses([addr])
    expect(await service.isAllowed(addr)).toBe(false)
  })

  it("remove returns removed and invalid lists", async () => {
    const result = await service.removeAddresses([
      "0xAbCdEf1234567890abcdef1234567890AbCdEf12",
      "bad",
    ])
    expect(result.removed).toHaveLength(1)
    expect(result.invalid).toEqual(["bad"])
  })

  it("WAL audit on add", async () => {
    const walEntries: Array<{ op: string }> = []
    const audited = new AllowlistService({
      redis,
      walAppend: (_ns, op) => { walEntries.push({ op }); return "id" },
    })

    await audited.addAddresses(["0xAbCdEf1234567890abcdef1234567890AbCdEf12"])
    expect(walEntries).toHaveLength(1)
    expect(walEntries[0].op).toBe("allowlist_add")
  })

  it("WAL audit on remove", async () => {
    const walEntries: Array<{ op: string }> = []
    const audited = new AllowlistService({
      redis,
      walAppend: (_ns, op) => { walEntries.push({ op }); return "id" },
    })

    await audited.removeAddresses(["0xAbCdEf1234567890abcdef1234567890AbCdEf12"])
    expect(walEntries).toHaveLength(1)
    expect(walEntries[0].op).toBe("allowlist_remove")
  })
})

// ---------------------------------------------------------------------------
// 3. Bypass Addresses
// ---------------------------------------------------------------------------

describe("AllowlistService: bypass", () => {
  it("bypass addresses always pass regardless of allowlist state", async () => {
    const addr = "0xAbCdEf1234567890abcdef1234567890AbCdEf12"
    const original = process.env.BETA_BYPASS_ADDRESSES
    process.env.BETA_BYPASS_ADDRESSES = addr

    try {
      const service = new AllowlistService({ redis: createMockRedis() })
      // Not on allowlist, but on bypass
      const result = await service.isAllowed(addr)
      expect(result).toBe(true)
    } finally {
      if (original !== undefined) {
        process.env.BETA_BYPASS_ADDRESSES = original
      } else {
        delete process.env.BETA_BYPASS_ADDRESSES
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Feature Flag Service
// ---------------------------------------------------------------------------

describe("FeatureFlagService", () => {
  let service: FeatureFlagService
  let redis: RedisCommandClient

  beforeEach(() => {
    redis = createMockRedis()
    service = new FeatureFlagService({ redis })
  })

  it("unset flag returns false", async () => {
    const result = await service.isEnabled("billing")
    expect(result).toBe(false)
  })

  it("set flag to true returns true", async () => {
    await service.setFlag("billing", true)
    const result = await service.isEnabled("billing")
    expect(result).toBe(true)
  })

  it("set flag to false returns false", async () => {
    await service.setFlag("billing", true)
    await service.setFlag("billing", false)
    const result = await service.isEnabled("billing")
    expect(result).toBe(false)
  })

  it("getAllFlags returns default flag states", async () => {
    await service.setFlag("billing", true)
    await service.setFlag("credits", true)

    const flags = await service.getAllFlags()
    expect(flags.billing).toBe(true)
    expect(flags.credits).toBe(true)
    expect(flags.nft).toBe(false)
    expect(flags.onboarding).toBe(false)
    expect(flags.x402).toBe(false)
  })

  it("WAL audit on flag toggle", async () => {
    const walEntries: Array<{ op: string }> = []
    const audited = new FeatureFlagService({
      redis,
      walAppend: (_ns, op) => { walEntries.push({ op }); return "id" },
    })

    await audited.setFlag("billing", true)
    expect(walEntries).toHaveLength(1)
    expect(walEntries[0].op).toBe("feature_flag_toggle")
  })
})

// ---------------------------------------------------------------------------
// 5. Admin Routes
// ---------------------------------------------------------------------------

describe("adminRoutes", () => {
  it("rejects request without admin token", async () => {
    const redis = createMockRedis()
    const app = adminRoutes({
      allowlistService: new AllowlistService({ redis }),
      featureFlagService: new FeatureFlagService({ redis }),
      validateAdminToken: async () => true,
    })

    const resp = await app.request("/feature-flags", { method: "GET" })
    expect(resp.status).toBe(401)
    const body = await resp.json()
    expect(body.code).toBe("ADMIN_AUTH_REQUIRED")
  })

  it("rejects non-admin token", async () => {
    const redis = createMockRedis()
    const app = adminRoutes({
      allowlistService: new AllowlistService({ redis }),
      featureFlagService: new FeatureFlagService({ redis }),
      validateAdminToken: async () => false,
    })

    const resp = await app.request("/feature-flags", {
      method: "GET",
      headers: { Authorization: "Bearer some-token" },
    })
    expect(resp.status).toBe(403)
    const body = await resp.json()
    expect(body.code).toBe("ADMIN_ROLE_REQUIRED")
  })

  it("GET /feature-flags returns all flags with valid admin token", async () => {
    const redis = createMockRedis()
    const flagService = new FeatureFlagService({ redis })
    await flagService.setFlag("billing", true)

    const app = adminRoutes({
      allowlistService: new AllowlistService({ redis }),
      featureFlagService: flagService,
      validateAdminToken: async () => true,
    })

    const resp = await app.request("/feature-flags", {
      method: "GET",
      headers: { Authorization: "Bearer admin-token" },
    })
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.flags.billing).toBe(true)
  })

  it("POST /feature-flags toggles flag", async () => {
    const redis = createMockRedis()
    const flagService = new FeatureFlagService({ redis })

    const app = adminRoutes({
      allowlistService: new AllowlistService({ redis }),
      featureFlagService: flagService,
      validateAdminToken: async () => true,
    })

    const resp = await app.request("/feature-flags", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ flag: "nft", enabled: true }),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.flag).toBe("nft")
    expect(body.enabled).toBe(true)

    // Verify it persisted
    const enabled = await flagService.isEnabled("nft")
    expect(enabled).toBe(true)
  })

  it("POST /allowlist adds addresses", async () => {
    const redis = createMockRedis()
    const allowlistService = new AllowlistService({ redis })

    const app = adminRoutes({
      allowlistService,
      featureFlagService: new FeatureFlagService({ redis }),
      validateAdminToken: async () => true,
    })

    const resp = await app.request("/allowlist", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "add",
        addresses: ["0xAbCdEf1234567890abcdef1234567890AbCdEf12"],
      }),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.added).toHaveLength(1)

    // Verify reflected immediately
    const allowed = await allowlistService.isAllowed("0xAbCdEf1234567890abcdef1234567890AbCdEf12")
    expect(allowed).toBe(true)
  })

  it("admin add/remove reflected immediately", async () => {
    const redis = createMockRedis()
    const allowlistService = new AllowlistService({ redis })
    const addr = "0xAbCdEf1234567890abcdef1234567890AbCdEf12"

    const app = adminRoutes({
      allowlistService,
      featureFlagService: new FeatureFlagService({ redis }),
      validateAdminToken: async () => true,
    })

    // Add
    await app.request("/allowlist", {
      method: "POST",
      headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", addresses: [addr] }),
    })
    expect(await allowlistService.isAllowed(addr)).toBe(true)

    // Remove
    await app.request("/allowlist", {
      method: "POST",
      headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", addresses: [addr] }),
    })
    expect(await allowlistService.isAllowed(addr)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. Waitlist Page
// ---------------------------------------------------------------------------

describe("waitlistRoutes", () => {
  it("serves HTML with CSP headers", async () => {
    const app = waitlistRoutes({
      projectName: "TestProject",
      projectDescription: "A test project",
    })

    const resp = await app.request("/")
    expect(resp.status).toBe(200)
    expect(resp.headers.get("content-security-policy")).toBeTruthy()
    expect(resp.headers.get("x-frame-options")).toBe("DENY")

    const html = await resp.text()
    expect(html).toContain("TestProject")
    expect(html).toContain("Closed Beta")
  })

  it("escapes HTML in project name", async () => {
    const app = waitlistRoutes({
      projectName: "<script>alert('xss')</script>",
      projectDescription: "safe",
    })

    const resp = await app.request("/")
    const html = await resp.text()
    expect(html).not.toContain("<script>alert")
    expect(html).toContain("&lt;script&gt;")
  })

  it("includes contact email when provided", async () => {
    const app = waitlistRoutes({
      projectName: "Test",
      projectDescription: "Test",
      contactEmail: "access@example.com",
    })

    const resp = await app.request("/")
    const html = await resp.text()
    expect(html).toContain("access@example.com")
  })
})

// ---------------------------------------------------------------------------
// 7. Onboarding Service
// ---------------------------------------------------------------------------

describe("OnboardingService", () => {
  let redis: RedisCommandClient
  let onboarding: OnboardingService
  let idCounter: number

  function createMockOwnership() {
    return {
      verifyOwnership: vi.fn(async () => true),
      invalidateCache: vi.fn(),
      clearCache: vi.fn(),
    }
  }

  function createMockPersonality() {
    return {
      create: vi.fn(async () => ({ id: "p1" })),
      get: vi.fn(async () => { throw new Error("not found") }),
      update: vi.fn(async () => ({ id: "p1" })),
      getBeauvoirMd: vi.fn(async () => "# Default"),
    }
  }

  beforeEach(() => {
    idCounter = 0
    redis = createMockRedis()
    const allowlist = new AllowlistService({ redis })
    const featureFlags = new FeatureFlagService({ redis })

    onboarding = new OnboardingService({
      redis,
      ownershipService: createMockOwnership() as any,
      personalityService: createMockPersonality() as any,
      allowlistService: allowlist,
      featureFlagService: featureFlags,
      generateId: () => { idCounter++; return `onb_${idCounter}` },
    })

    // Pre-setup: enable onboarding flag and add a test address
    return (async () => {
      await featureFlags.setFlag("onboarding", true)
      await allowlist.addAddresses(["0xAbCdEf1234567890abcdef1234567890AbCdEf12"])
    })()
  })

  it("starts onboarding for allowlisted wallet", async () => {
    const state = await onboarding.startOnboarding("0xAbCdEf1234567890abcdef1234567890AbCdEf12")
    expect(state.session_id).toBe("onb_1")
    expect(state.current_step).toBe("nft_detect")
    expect(state.completed_steps).toEqual(["wallet_connect"])
    expect(state.step_index).toBe(1)
  })

  it("rejects non-allowlisted wallet", async () => {
    await expect(
      onboarding.startOnboarding("0x1111111111111111111111111111111111111111"),
    ).rejects.toThrow("not on allowlist")
  })

  it("rejects when onboarding feature disabled", async () => {
    const flags = new FeatureFlagService({ redis })
    await flags.setFlag("onboarding", false)
    const allowlist = new AllowlistService({ redis })
    await allowlist.addAddresses(["0x2222222222222222222222222222222222222222"])

    const svc = new OnboardingService({
      redis,
      ownershipService: createMockOwnership() as any,
      personalityService: createMockPersonality() as any,
      allowlistService: allowlist,
      featureFlagService: flags,
      generateId: () => "onb_test",
    })

    await expect(
      svc.startOnboarding("0x2222222222222222222222222222222222222222"),
    ).rejects.toThrow("disabled")
  })

  it("completes full onboarding flow", async () => {
    const state = await onboarding.startOnboarding("0xAbCdEf1234567890abcdef1234567890AbCdEf12")
    const sid = state.session_id

    // Step 2: detect NFTs
    await onboarding.detectNfts(sid, [{ address: "0xCOLL", name: "TestColl" }])

    // Step 3: select NFT
    const afterSelect = await onboarding.selectNft(sid, "0xCOLL", "42")
    expect(afterSelect.selected_nft).toEqual({ collection: "0xCOLL", token_id: "42" })
    expect(afterSelect.current_step).toBe("personality_config")

    // Step 4: configure personality (skip)
    const afterPersonality = await onboarding.configurePersonality(sid, null)
    expect(afterPersonality.current_step).toBe("credit_purchase")

    // Step 5: credits
    const afterCredits = await onboarding.acknowledgeCreditPurchase(sid)
    expect(afterCredits.current_step).toBe("agent_live")

    // Step 6: complete
    const result = await onboarding.completeOnboarding(sid)
    expect(result.redirect_url).toBe("/agent/0xCOLL/42")
    expect(result.state.completed_steps).toContain("agent_live")
  })

  it("rejects out-of-order step", async () => {
    const state = await onboarding.startOnboarding("0xAbCdEf1234567890abcdef1234567890AbCdEf12")

    // Try to skip to credit_purchase from nft_detect
    await expect(
      onboarding.acknowledgeCreditPurchase(state.session_id),
    ).rejects.toThrow("Expected step")
  })

  it("rejects expired/missing session", async () => {
    await expect(
      onboarding.getState("nonexistent"),
    ).rejects.toThrow("not found")
  })

  it("WAL audit on start and complete", async () => {
    const walEntries: Array<{ op: string }> = []
    const allowlist = new AllowlistService({ redis })
    const flags = new FeatureFlagService({ redis })
    await flags.setFlag("onboarding", true)
    await allowlist.addAddresses(["0xAbCdEf1234567890abcdef1234567890AbCdEf12"])

    const svc = new OnboardingService({
      redis,
      ownershipService: createMockOwnership() as any,
      personalityService: createMockPersonality() as any,
      allowlistService: allowlist,
      featureFlagService: flags,
      walAppend: (_ns, op) => { walEntries.push({ op }); return "id" },
      generateId: () => "onb_wal",
    })

    const state = await svc.startOnboarding("0xAbCdEf1234567890abcdef1234567890AbCdEf12")
    expect(walEntries[0].op).toBe("onboarding_start")

    // Complete flow
    await svc.detectNfts(state.session_id, [{ address: "0xCOLL", name: "TestColl" }])
    await svc.selectNft(state.session_id, "0xCOLL", "1")
    await svc.configurePersonality(state.session_id, null)
    await svc.acknowledgeCreditPurchase(state.session_id)
    await svc.completeOnboarding(state.session_id)
    expect(walEntries[walEntries.length - 1].op).toBe("onboarding_complete")
  })
})

// ---------------------------------------------------------------------------
// 8. Module Exports
// ---------------------------------------------------------------------------

describe("Module exports", () => {
  it("AllowlistService exports", async () => {
    const mod = await import("../../src/gateway/allowlist.js")
    expect(mod.AllowlistService).toBeDefined()
    expect(mod.normalizeAddress).toBeDefined()
  })

  it("FeatureFlagService exports", async () => {
    const mod = await import("../../src/gateway/feature-flags.js")
    expect(mod.FeatureFlagService).toBeDefined()
    expect(mod.adminRoutes).toBeDefined()
  })

  it("OnboardingService exports", async () => {
    const mod = await import("../../src/nft/onboarding.js")
    expect(mod.OnboardingService).toBeDefined()
    expect(mod.OnboardingError).toBeDefined()
    expect(mod.onboardingRoutes).toBeDefined()
  })

  it("waitlistRoutes exports", async () => {
    const mod = await import("../../src/gateway/waitlist.js")
    expect(mod.waitlistRoutes).toBeDefined()
  })
})
