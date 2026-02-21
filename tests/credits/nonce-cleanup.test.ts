// tests/credits/nonce-cleanup.test.ts — T2.4: Nonce cleanup scheduling (Bridge medium-5)
//
// Periodic cleanup of expired nonces prevents unbounded table growth.
// The NonceCleanupService wraps cleanupExpiredNonces in a cron job.

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock credit-persistence module
vi.mock("../../src/credits/credit-persistence.js", () => ({
  cleanupExpiredNonces: vi.fn(async () => 42),
}))

import { NonceCleanupService, type NonceCleanupResult } from "../../src/credits/nonce-cleanup.js"
import { cleanupExpiredNonces } from "../../src/credits/credit-persistence.js"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NonceCleanupService (Bridge medium-5)", () => {
  const mockDb = {} as import("../../src/credits/credit-persistence.js").DrizzleDB

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("runs cleanup with default config", async () => {
    const svc = new NonceCleanupService(mockDb)
    const result = await svc.runCleanup()

    expect(cleanupExpiredNonces).toHaveBeenCalledWith(mockDb, 24 * 60 * 60 * 1000)
    expect(result.deletedCount).toBe(42)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.timestamp).toBeGreaterThan(0)
  })

  it("uses custom maxAgeMs", async () => {
    const svc = new NonceCleanupService(mockDb, { maxAgeMs: 60_000 })
    await svc.runCleanup()

    expect(cleanupExpiredNonces).toHaveBeenCalledWith(mockDb, 60_000)
  })

  it("calls onCleanup callback with result", async () => {
    const onCleanup = vi.fn()
    const svc = new NonceCleanupService(mockDb, { onCleanup })

    const result = await svc.runCleanup()

    expect(onCleanup).toHaveBeenCalledOnce()
    expect(onCleanup).toHaveBeenCalledWith(result)
  })

  it("start/stop lifecycle", () => {
    const svc = new NonceCleanupService(mockDb)

    expect(svc.isRunning()).toBe(false)

    svc.start()
    expect(svc.isRunning()).toBe(true)

    // Calling start again is idempotent
    svc.start()
    expect(svc.isRunning()).toBe(true)

    svc.stop()
    expect(svc.isRunning()).toBe(false)

    // Calling stop again is safe
    svc.stop()
    expect(svc.isRunning()).toBe(false)
  })

  it("handles cleanup errors gracefully (cron resilience)", async () => {
    const mockCleanup = vi.mocked(cleanupExpiredNonces)
    mockCleanup.mockRejectedValueOnce(new Error("DB connection failed"))

    const svc = new NonceCleanupService(mockDb)

    // runCleanup should propagate the error (cron wrapper catches it)
    await expect(svc.runCleanup()).rejects.toThrow("DB connection failed")
  })

  it("reports metrics via onCleanup callback", async () => {
    const results: NonceCleanupResult[] = []
    const svc = new NonceCleanupService(mockDb, {
      onCleanup: (r) => results.push(r),
    })

    await svc.runCleanup()
    await svc.runCleanup()

    expect(results).toHaveLength(2)
    expect(results[0].deletedCount).toBe(42)
    expect(results[1].deletedCount).toBe(42)
  })
})
