// tests/finn/boot/secrets.test.ts — SecretsLoader tests (cycle-035 T-1.9)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SecretsLoader } from "../../../src/boot/secrets.js"
import type { SecretsManagerClient, FinnSecrets } from "../../../src/config/aws-secrets.js"

// --- Mock Secrets Manager client ---

function createMockClient(secrets: Partial<Record<string, string>> = {}): SecretsManagerClient {
  return {
    getSecretValue: vi.fn(async ({ SecretId }: { SecretId: string }) => {
      const value = secrets[SecretId]
      if (value === undefined) throw new Error(`Secret not found: ${SecretId}`)
      return { SecretString: value }
    }),
  }
}

// Suppress console.log/error during tests
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

  // Set env vars for loadSecrets dev fallback
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key"
  process.env.FINN_AUTH_TOKEN = "test-auth-token"
  process.env.FINN_S2S_PRIVATE_KEY = "test-s2s-key"
  process.env.REDIS_URL = "redis://localhost:6379"
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.FINN_AUTH_TOKEN
  delete process.env.FINN_S2S_PRIVATE_KEY
  delete process.env.REDIS_URL
  delete process.env.NODE_ENV
})

describe("SecretsLoader", () => {
  describe("load()", () => {
    it("loads secrets from env vars in dev mode", async () => {
      const loader = new SecretsLoader({
        required: ["anthropicApiKey", "finnAuthToken"],
      })

      const secrets = await loader.load()

      expect(secrets.anthropicApiKey).toBe("test-anthropic-key")
      expect(secrets.finnAuthToken).toBe("test-auth-token")
      expect(loader.isLoaded).toBe(true)
    })

    it("throws when required secrets missing", async () => {
      delete process.env.ANTHROPIC_API_KEY

      const loader = new SecretsLoader({
        required: ["anthropicApiKey"],
      })

      await expect(loader.load()).rejects.toThrow("missing required secrets: anthropicApiKey")
    })

    it("sets isLoaded and cacheAgeMs after load", async () => {
      const loader = new SecretsLoader()

      expect(loader.isLoaded).toBe(false)
      expect(loader.cacheAgeMs).toBe(-1)

      await loader.load()

      expect(loader.isLoaded).toBe(true)
      expect(loader.cacheAgeMs).toBeGreaterThanOrEqual(0)
      expect(loader.cacheAgeMs).toBeLessThan(1000)
    })
  })

  describe("getSecrets()", () => {
    it("loads on first call if cache empty", async () => {
      const loader = new SecretsLoader()

      const secrets = await loader.getSecrets()

      expect(secrets.anthropicApiKey).toBe("test-anthropic-key")
      expect(loader.isLoaded).toBe(true)
    })

    it("returns cached value within TTL", async () => {
      const loader = new SecretsLoader({ ttlMs: 60_000 })

      const first = await loader.getSecrets()
      const second = await loader.getSecrets()

      // Same reference — no re-fetch
      expect(first).toBe(second)
    })

    it("triggers background refresh when TTL expired", async () => {
      const loader = new SecretsLoader({ ttlMs: 1 })

      await loader.getSecrets()

      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 10))

      // Should return stale cache immediately (background refresh)
      const result = await loader.getSecrets()
      expect(result.anthropicApiKey).toBe("test-anthropic-key")
    })

    it("keeps serving stale cache on background refresh failure", async () => {
      const loader = new SecretsLoader({ ttlMs: 1 })

      const first = await loader.getSecrets()

      // Delete the required env vars so refresh fails
      delete process.env.ANTHROPIC_API_KEY

      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 10))

      // Should return stale cache
      const second = await loader.getSecrets()
      expect(second).toBe(first)

      // Wait for background refresh to complete and log error
      await new Promise(r => setTimeout(r, 50))
    })
  })

  describe("refresh()", () => {
    it("clears cache and reloads", async () => {
      const loader = new SecretsLoader()

      const first = await loader.getSecrets()
      const refreshed = await loader.refresh()

      // Both should have the same values but be different loads
      expect(refreshed.anthropicApiKey).toBe(first.anthropicApiKey)
      expect(loader.cacheAgeMs).toBeLessThan(100)
    })
  })

  describe("loadAdminJWKS()", () => {
    it("returns null when no client provided", async () => {
      const loader = new SecretsLoader()

      const result = await loader.loadAdminJWKS()

      expect(result).toBeNull()
    })

    it("fetches and caches JWKS from Secrets Manager", async () => {
      const jwks = JSON.stringify({ keys: [{ kty: "RSA", kid: "key-1" }] })
      const client = createMockClient({ "finn/admin-jwks": jwks })

      const loader = new SecretsLoader({ client })

      const result = await loader.loadAdminJWKS()

      expect(result).toBe(jwks)
      expect(client.getSecretValue).toHaveBeenCalledWith({ SecretId: "finn/admin-jwks" })
    })

    it("returns cached JWKS within TTL", async () => {
      const jwks = JSON.stringify({ keys: [{ kty: "RSA", kid: "key-1" }] })
      const client = createMockClient({ "finn/admin-jwks": jwks })

      const loader = new SecretsLoader({ client, ttlMs: 60_000 })

      await loader.loadAdminJWKS()
      await loader.loadAdminJWKS()

      // Only one fetch
      expect(client.getSecretValue).toHaveBeenCalledTimes(1)
    })

    it("rejects JWKS without keys array", async () => {
      const badJwks = JSON.stringify({ notkeys: [] })
      const client = createMockClient({ "finn/admin-jwks": badJwks })

      const loader = new SecretsLoader({ client })

      const result = await loader.loadAdminJWKS()

      // Should return null (error caught)
      expect(result).toBeNull()
      expect(errorSpy).toHaveBeenCalled()
    })

    it("returns stale cache on fetch failure", async () => {
      const jwks = JSON.stringify({ keys: [{ kty: "RSA", kid: "key-1" }] })
      const client = createMockClient({ "finn/admin-jwks": jwks })

      const loader = new SecretsLoader({ client, ttlMs: 1 })

      // First fetch succeeds
      const first = await loader.loadAdminJWKS()
      expect(first).toBe(jwks)

      // Make subsequent fetch fail
      ;(client.getSecretValue as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Service unavailable"),
      )

      // Wait for cache to expire
      await new Promise(r => setTimeout(r, 10))

      // Should return stale cache
      const second = await loader.loadAdminJWKS()
      expect(second).toBe(jwks)
    })
  })
})
