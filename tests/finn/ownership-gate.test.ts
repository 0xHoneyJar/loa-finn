// tests/finn/ownership-gate.test.ts — Ownership Gate Tests (Cycle 040, Sprint 1 T-1.9)

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  verifyOwnership,
  invalidateOwnershipCache,
} from "../../src/nft/ownership-gate.js"
import type { OwnershipGateConfig } from "../../src/nft/ownership-gate.js"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store = new Map<string, string>()
  return {
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return "OK" }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => { store.delete(key); return 1 }),
    _store: store,
  }
}

const OWNER_ADDRESS = "0xABcDeF1234567890AbCdEf1234567890AbCdEf12"
const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111"

function createConfig(overrides: Partial<OwnershipGateConfig> = {}): OwnershipGateConfig {
  return {
    redis: createMockRedis() as any,
    readOwner: vi.fn(async () => OWNER_ADDRESS),
    ownerCacheTtlSeconds: 60,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// verifyOwnership
// ---------------------------------------------------------------------------

describe("verifyOwnership", () => {
  describe("happy path — owner matches", () => {
    it("verifies ownership from on-chain read", async () => {
      const config = createConfig()
      const result = await verifyOwnership(config, "42", OWNER_ADDRESS)

      expect(result.verified).toBe(true)
      expect(result.owner).toBe(OWNER_ADDRESS)
      expect(result.fromCache).toBe(false)
      expect(config.readOwner).toHaveBeenCalledWith("42")
    })

    it("verifies ownership case-insensitively", async () => {
      const config = createConfig()
      const result = await verifyOwnership(config, "42", OWNER_ADDRESS.toLowerCase())

      expect(result.verified).toBe(true)
    })

    it("returns cached result on subsequent calls", async () => {
      const config = createConfig()

      // First call — on-chain
      await verifyOwnership(config, "42", OWNER_ADDRESS)
      expect(config.readOwner).toHaveBeenCalledTimes(1)

      // Second call — cached
      const result = await verifyOwnership(config, "42", OWNER_ADDRESS)
      expect(result.verified).toBe(true)
      expect(result.fromCache).toBe(true)
      expect(config.readOwner).toHaveBeenCalledTimes(1) // Not called again
    })
  })

  describe("non-owner — 403 OWNERSHIP_REQUIRED", () => {
    it("rejects when wallet does not match on-chain owner", async () => {
      const config = createConfig()
      const result = await verifyOwnership(config, "42", OTHER_ADDRESS)

      expect(result.verified).toBe(false)
      expect(result.code).toBe("OWNERSHIP_REQUIRED")
      expect(result.message).toContain("not your wallet")
    })

    it("rejects from cache when owner doesn't match", async () => {
      const config = createConfig()

      // Populate cache
      await verifyOwnership(config, "42", OWNER_ADDRESS)

      // Different wallet — should fail from cache
      const result = await verifyOwnership(config, "42", OTHER_ADDRESS)
      expect(result.verified).toBe(false)
      expect(result.fromCache).toBe(true)
      expect(result.code).toBe("OWNERSHIP_REQUIRED")
    })
  })

  describe("on-chain read failure", () => {
    it("rejects when on-chain read fails", async () => {
      const config = createConfig({
        readOwner: vi.fn().mockRejectedValue(new Error("RPC timeout")),
      })

      const result = await verifyOwnership(config, "42", OWNER_ADDRESS)

      expect(result.verified).toBe(false)
      expect(result.code).toBe("OWNERSHIP_REQUIRED")
      expect(result.message).toContain("on-chain read failed")
    })
  })

  describe("allowlist (soft launch)", () => {
    it("rejects non-allowlisted wallet before on-chain check", async () => {
      const config = createConfig({
        allowedAddresses: new Set(["0xallowed"]),
      })

      const result = await verifyOwnership(config, "42", OTHER_ADDRESS)

      expect(result.verified).toBe(false)
      expect(result.code).toBe("ALLOWLIST_DENIED")
      expect(config.readOwner).not.toHaveBeenCalled() // Short-circuits
    })

    it("allows allowlisted wallet to proceed to ownership check", async () => {
      const config = createConfig({
        allowedAddresses: new Set([OWNER_ADDRESS.toLowerCase()]),
      })

      const result = await verifyOwnership(config, "42", OWNER_ADDRESS)

      expect(result.verified).toBe(true)
      expect(config.readOwner).toHaveBeenCalled()
    })

    it("skips allowlist check when no allowlist configured", async () => {
      const config = createConfig({ allowedAddresses: undefined })
      const result = await verifyOwnership(config, "42", OWNER_ADDRESS)
      expect(result.verified).toBe(true)
    })

    it("skips allowlist check when allowlist is empty", async () => {
      const config = createConfig({ allowedAddresses: new Set() })
      const result = await verifyOwnership(config, "42", OWNER_ADDRESS)
      expect(result.verified).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// invalidateOwnershipCache
// ---------------------------------------------------------------------------

describe("invalidateOwnershipCache", () => {
  it("removes cached owner for tokenId", async () => {
    const redis = createMockRedis()

    // Populate cache
    const config = createConfig({ redis: redis as any })
    await verifyOwnership(config, "42", OWNER_ADDRESS)
    expect(redis._store.has("finn:auth-owner:42")).toBe(true)

    // Invalidate
    await invalidateOwnershipCache(redis as any, "42")
    expect(redis._store.has("finn:auth-owner:42")).toBe(false)
  })

  it("is idempotent — no error when key doesn't exist", async () => {
    const redis = createMockRedis()
    await expect(invalidateOwnershipCache(redis as any, "999")).resolves.toBeUndefined()
  })
})
