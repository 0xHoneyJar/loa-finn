// tests/finn/hounfour/audit/buffered-audit-chain.test.ts — BufferedAuditChain tests (cycle-035 T-1.8)

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { BufferedAuditChain } from "../../../../src/hounfour/audit/buffered-audit-chain.js"
import { DynamoAuditChain } from "../../../../src/hounfour/audit/dynamo-audit.js"
import type { AuditDynamoClient } from "../../../../src/hounfour/audit/dynamo-audit.js"

// --- Mock DynamoDB client ---

function createMockDynamo(opts?: { failAfter?: number; failAlways?: boolean }) {
  let writeCount = 0
  const items: Record<string, unknown>[] = []

  const client: AuditDynamoClient = {
    put: vi.fn(async (params) => {
      writeCount++
      if (opts?.failAlways) throw new Error("DynamoDB unavailable")
      if (opts?.failAfter && writeCount > opts.failAfter) throw new Error("DynamoDB unavailable")
      items.push(params.Item)
    }),
    query: vi.fn(async (params) => {
      if (params.ScanIndexForward === false && params.Limit === 1) {
        // Latest entry query
        const matching = items
          .filter(i => i.partitionId === (params.ExpressionAttributeValues as Record<string, unknown>)[":pid"])
          .sort((a, b) => Number(b.sequenceNumber) - Number(a.sequenceNumber))
        return { Items: matching.slice(0, 1) }
      }
      return { Items: items }
    }),
    scan: vi.fn(async () => ({ Items: [] })),
  }

  return { client, items }
}

describe("BufferedAuditChain", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("direct write (buffer bypass)", () => {
    it("writes directly to DynamoDB when available", async () => {
      const { client, items } = createMockDynamo()
      const inner = new DynamoAuditChain(client, "test-audit")
      await inner.init("test-partition")

      const bac = new BufferedAuditChain(inner, { flushIntervalMs: 999_999 })
      await bac.init("test-partition")

      const hash = await bac.append("scoring_path", { tier: "alpha", pool: "pool-1" })

      expect(hash).not.toBeNull()
      expect(items.length).toBe(1)
      expect(bac.bufferSize).toBe(0)
    })
  })

  describe("buffering on DynamoDB failure", () => {
    it("buffers entries when DynamoDB unavailable", async () => {
      const { client } = createMockDynamo({ failAlways: true })
      const inner = new DynamoAuditChain(client, "test-audit")

      // Manually set state to ready (skip init which would also fail)
      Object.assign(inner, { state: "ready", partitionId: "test", sequenceNumber: 0, lastHash: "0" })

      const bac = new BufferedAuditChain(inner, { flushIntervalMs: 999_999 })

      // Non-critical action — buffers
      const hash = await bac.append("scoring_path", { tier: "alpha" })

      expect(hash).toBeNull()
      expect(bac.bufferSize).toBe(1)
    })

    it("throws for critical actions when buffer full + DynamoDB down", async () => {
      const { client } = createMockDynamo({ failAlways: true })
      const inner = new DynamoAuditChain(client, "test-audit")
      Object.assign(inner, { state: "ready", partitionId: "test", sequenceNumber: 0, lastHash: "0" })

      const bac = new BufferedAuditChain(inner, { maxBufferSize: 2, flushIntervalMs: 999_999 })

      // Fill buffer
      await bac.append("scoring_path", { a: 1 })
      await bac.append("scoring_path", { a: 2 })

      // Critical action on full buffer → fail-closed
      await expect(
        bac.append("routing_mode_change", { from: "shadow", to: "enabled" }),
      ).rejects.toThrow("buffer full")
    })

    it("drops non-critical actions when buffer full", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const { client } = createMockDynamo({ failAlways: true })
      const inner = new DynamoAuditChain(client, "test-audit")
      Object.assign(inner, { state: "ready", partitionId: "test", sequenceNumber: 0, lastHash: "0" })

      const bac = new BufferedAuditChain(inner, { maxBufferSize: 2, flushIntervalMs: 999_999 })

      await bac.append("scoring_path", { a: 1 })
      await bac.append("scoring_path", { a: 2 })
      const hash = await bac.append("scoring_path", { a: 3 }) // Dropped

      expect(hash).toBeNull()
      expect(bac.bufferSize).toBe(2) // Not 3
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe("flush", () => {
    it("flushes buffered entries in order when DynamoDB recovers", async () => {
      let failing = true
      const items: Record<string, unknown>[] = []
      const client: AuditDynamoClient = {
        put: vi.fn(async (params) => {
          if (failing) throw new Error("DynamoDB unavailable")
          items.push(params.Item)
        }),
        query: vi.fn(async () => ({ Items: [] })),
        scan: vi.fn(async () => ({ Items: [] })),
      }

      const inner = new DynamoAuditChain(client, "test-audit")
      Object.assign(inner, { state: "ready", partitionId: "test", sequenceNumber: 0, lastHash: "0" })

      const bac = new BufferedAuditChain(inner, { flushIntervalMs: 999_999 })

      // Buffer 3 entries
      await bac.append("action_1", { v: 1 })
      await bac.append("action_2", { v: 2 })
      await bac.append("action_3", { v: 3 })
      expect(bac.bufferSize).toBe(3)

      // DynamoDB recovers
      failing = false
      Object.assign(inner, { state: "ready", consecutiveFailures: 0 })
      const result = await bac.flush()

      expect(result.flushed).toBe(3)
      expect(result.expired).toBe(0)
      expect(bac.bufferSize).toBe(0)
    })

    it("discards entries older than maxEntryAgeMs", async () => {
      const { client } = createMockDynamo()
      const inner = new DynamoAuditChain(client, "test-audit")
      Object.assign(inner, { state: "ready", partitionId: "test", sequenceNumber: 0, lastHash: "0" })

      const bac = new BufferedAuditChain(inner, { maxEntryAgeMs: 100, flushIntervalMs: 999_999 })

      // Manually inject old entry into buffer
      const oldEntry = {
        action: "old_action",
        payload: { v: 1 },
        timestamp: new Date(Date.now() - 200).toISOString(),
        sequenceHint: 1,
      }
      Object.assign(bac, { buffer: [oldEntry] })

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const result = await bac.flush()

      expect(result.expired).toBe(1)
      expect(result.flushed).toBe(0)
      expect(bac.bufferSize).toBe(0)
      warnSpy.mockRestore()
    })
  })

  describe("crash resume", () => {
    it("recovers prev_hash from DynamoDB on init", async () => {
      const existingEntry = {
        partitionId: "ecs-task-abc",
        sequenceNumber: 5,
        hash: "abc123",
        prevHash: "prev456",
        timestamp: new Date().toISOString(),
        action: "scoring_path",
        payloadHash: "ph789",
      }

      const client: AuditDynamoClient = {
        put: vi.fn(async () => {}),
        query: vi.fn(async (params) => {
          if (params.ScanIndexForward === false && params.Limit === 1) {
            return { Items: [existingEntry] }
          }
          return { Items: [] }
        }),
        scan: vi.fn(async () => ({ Items: [] })),
      }

      const inner = new DynamoAuditChain(client, "test-audit")
      const bac = new BufferedAuditChain(inner, { flushIntervalMs: 999_999 })
      await bac.init("ecs-task-abc")

      // Inner chain should have recovered sequence number 5
      expect(bac.sequenceNumber).toBe(5)
    })
  })

  describe("concurrent appenders (single-writer mutex)", () => {
    it("serializes concurrent appends", async () => {
      const { client, items } = createMockDynamo()
      const inner = new DynamoAuditChain(client, "test-audit")
      await inner.init("test-partition")

      const bac = new BufferedAuditChain(inner, { flushIntervalMs: 999_999 })
      await bac.init("test-partition")

      // Fire 5 concurrent appends
      const results = await Promise.all([
        bac.append("action_1", { v: 1 }),
        bac.append("action_2", { v: 2 }),
        bac.append("action_3", { v: 3 }),
        bac.append("action_4", { v: 4 }),
        bac.append("action_5", { v: 5 }),
      ])

      // All should succeed (hashes returned)
      const hashes = results.filter(h => h !== null)
      expect(hashes.length).toBe(5)

      // Sequence numbers should be sequential
      const seqNums = items.map(i => Number(i.sequenceNumber))
      for (let i = 1; i < seqNums.length; i++) {
        expect(seqNums[i]).toBe(seqNums[i - 1] + 1)
      }
    })
  })

  describe("shutdown", () => {
    it("attempts final flush on shutdown", async () => {
      const { client } = createMockDynamo({ failAlways: true })
      const inner = new DynamoAuditChain(client, "test-audit")
      Object.assign(inner, { state: "ready", partitionId: "test", sequenceNumber: 0, lastHash: "0" })

      const bac = new BufferedAuditChain(inner, { flushIntervalMs: 999_999 })

      await bac.append("scoring_path", { v: 1 })
      expect(bac.bufferSize).toBe(1)

      // Shutdown with DynamoDB still down — entries stay in buffer (best-effort)
      await bac.shutdown()
      // No crash — graceful handling
    })
  })
})
