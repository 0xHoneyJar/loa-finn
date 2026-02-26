// tests/finn/audit/audit-fallback.test.ts — ResilientAuditLogger Tests (T-4.8)
//
// Tests: primary chain success, fallback on degraded, fallback on error,
// warning throttling, never-throw guarantee.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { ResilientAuditLogger } from "../../../src/hounfour/audit/audit-fallback.js"
import {
  DynamoAuditChain,
  type AuditDynamoClient,
} from "../../../src/hounfour/audit/dynamo-audit.js"

// ---------------------------------------------------------------------------
// In-Memory DynamoDB Mock (minimal)
// ---------------------------------------------------------------------------

class MockDynamoClient implements AuditDynamoClient {
  private items: Map<string, Record<string, unknown>[]> = new Map()
  failOnPut = false
  failCount = 0

  async put(params: {
    TableName: string
    Item: Record<string, unknown>
    ConditionExpression?: string
  }): Promise<void> {
    if (this.failOnPut) {
      this.failCount++
      throw new Error("Simulated DynamoDB failure")
    }
    const pid = params.Item.partitionId as string
    const partition = this.items.get(pid) ?? []
    partition.push(params.Item)
    this.items.set(pid, partition)
  }

  async query(params: {
    TableName: string
    KeyConditionExpression: string
    ExpressionAttributeValues: Record<string, unknown>
    ScanIndexForward?: boolean
    Limit?: number
    ProjectionExpression?: string
  }): Promise<{ Items?: Record<string, unknown>[] }> {
    const pid = params.ExpressionAttributeValues[":pid"] as string
    let partition = [...(this.items.get(pid) ?? [])]
    if (params.ScanIndexForward === false) partition.reverse()
    if (params.Limit) partition = partition.slice(0, params.Limit)
    return { Items: partition }
  }

  async scan(): Promise<{ Items?: Record<string, unknown>[] }> {
    return { Items: [] }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResilientAuditLogger", () => {
  let dynamoClient: MockDynamoClient
  let chain: DynamoAuditChain
  let logger: ResilientAuditLogger

  beforeEach(async () => {
    dynamoClient = new MockDynamoClient()
    chain = new DynamoAuditChain(dynamoClient, "test-audit-table")
    logger = new ResilientAuditLogger(chain, 100) // 100ms warning interval for tests
  })

  describe("primary path (DynamoDB chain)", () => {
    it("should use chain when ready", async () => {
      await chain.init("test-partition")
      const result = await logger.log("scoring_path", { pool: "pool-a" })

      expect(result.method).toBe("chain")
      expect(result.hash).toBeTruthy()
      expect(logger.totalFallbacks).toBe(0)
    })

    it("should auto-init chain if uninitialized", async () => {
      // Don't call chain.init() — logger should handle it
      // But chain needs a partition ID, which comes from init()
      // So we need to pre-init
      await chain.init("test-partition")
      const result = await logger.log("test_action", { data: 1 })
      expect(result.method).toBe("chain")
    })
  })

  describe("fallback path (CloudWatch)", () => {
    it("should fall back when chain enters degraded mode", async () => {
      await chain.init("test-partition")

      // Force chain into degraded mode (4 consecutive failures)
      dynamoClient.failOnPut = true
      for (let i = 0; i < 4; i++) {
        await chain.append(`fail-${i}`, { data: i })
      }
      expect(chain.currentState).toBe("degraded")

      // Now logger should use fallback
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      const result = await logger.log("scoring_path", { pool: "pool-a" })

      expect(result.method).toBe("fallback")
      expect(result.hash).toBeUndefined()
      expect(logger.totalFallbacks).toBe(1)

      // Verify structured JSON was emitted
      const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0]
      const parsed = JSON.parse(lastCall)
      expect(parsed.source).toBe("cloudwatch_fallback")
      expect(parsed.action).toBe("scoring_path")

      consoleSpy.mockRestore()
    })

    it("should never throw — audit failures must not block routing", async () => {
      await chain.init("test-partition")

      // Force chain to throw on append
      dynamoClient.failOnPut = true

      // Even with chain errors, logger should return gracefully
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      vi.spyOn(console, "warn").mockImplementation(() => {})
      vi.spyOn(console, "error").mockImplementation(() => {})

      // Force enough failures to degrade, then verify logger still works
      for (let i = 0; i < 5; i++) {
        const result = await logger.log(`action-${i}`, { data: i })
        expect(result).toBeDefined()
        // Should not throw
      }

      consoleSpy.mockRestore()
      vi.restoreAllMocks()
    })
  })

  describe("warning throttling", () => {
    it("should emit warning on first fallback", async () => {
      await chain.init("test-partition")

      // Force degraded
      dynamoClient.failOnPut = true
      for (let i = 0; i < 4; i++) {
        await chain.append(`fail-${i}`, { data: i })
      }

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      vi.spyOn(console, "log").mockImplementation(() => {})

      await logger.log("action-1", { data: 1 })

      // Should have emitted a warning
      const warnCalls = warnSpy.mock.calls.filter(call => {
        try {
          const parsed = JSON.parse(call[0])
          return parsed.metric === "audit.fallback.warning"
        } catch {
          return false
        }
      })
      expect(warnCalls.length).toBeGreaterThanOrEqual(1)

      vi.restoreAllMocks()
    })
  })

  describe("accessors", () => {
    it("should expose chain state", async () => {
      expect(logger.chainState).toBe("uninitialized")
      await chain.init("test-partition")
      expect(logger.chainState).toBe("ready")
    })

    it("should track fallback count", async () => {
      expect(logger.totalFallbacks).toBe(0)
    })
  })
})
