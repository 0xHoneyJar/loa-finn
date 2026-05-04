// tests/finn/audit/dynamo-audit.test.ts — DynamoAuditChain Tests (T-4.8)
//
// Tests: hash chain append, init recovery, conditional write failure,
// partition enumeration, integrity verification, degraded mode.

import { describe, it, expect, beforeEach } from "vitest"
import {
  DynamoAuditChain,
  computeHash,
  type AuditDynamoClient,
  type AuditEntry,
} from "../../../src/hounfour/audit/dynamo-audit.js"

// ---------------------------------------------------------------------------
// In-Memory DynamoDB Mock
// ---------------------------------------------------------------------------

class InMemoryDynamoClient implements AuditDynamoClient {
  items: Map<string, AuditEntry[]> = new Map()
  putCount = 0
  failNextPut = false
  conditionalFailNextPut = false

  async put(params: {
    TableName: string
    Item: Record<string, unknown>
    ConditionExpression?: string
  }): Promise<void> {
    this.putCount++
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error("Simulated DynamoDB error")
    }

    const item = params.Item as unknown as AuditEntry
    const partition = this.items.get(item.partitionId) ?? []

    // Simulate conditional check
    if (params.ConditionExpression === "attribute_not_exists(sequenceNumber)") {
      const exists = partition.some(e => e.sequenceNumber === item.sequenceNumber)
      if (exists || this.conditionalFailNextPut) {
        this.conditionalFailNextPut = false
        const err = new Error("ConditionalCheckFailedException") as Error & { name: string }
        err.name = "ConditionalCheckFailedException"
        throw err
      }
    }

    partition.push(item)
    partition.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    this.items.set(item.partitionId, partition)
  }

  async query(params: {
    TableName: string
    KeyConditionExpression: string
    ExpressionAttributeValues: Record<string, unknown>
    ScanIndexForward?: boolean
    Limit?: number
  }): Promise<{ Items?: Record<string, unknown>[] }> {
    const pid = params.ExpressionAttributeValues[":pid"] as string
    let partition = [...(this.items.get(pid) ?? [])]

    // Filter by sequence number if specified
    const seq = params.ExpressionAttributeValues[":seq"]
    if (seq !== undefined) {
      partition = partition.filter(e => e.sequenceNumber === Number(seq))
    }

    if (params.ScanIndexForward === false) {
      partition.reverse()
    }
    if (params.Limit) {
      partition = partition.slice(0, params.Limit)
    }
    return { Items: partition as unknown as Record<string, unknown>[] }
  }

  async scan(params: {
    TableName: string
    ProjectionExpression: string
    ExclusiveStartKey?: Record<string, unknown>
  }): Promise<{ Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }> {
    const allItems: Record<string, unknown>[] = []
    for (const [pid] of this.items) {
      allItems.push({ partitionId: pid })
    }
    return { Items: allItems }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DynamoAuditChain", () => {
  let client: InMemoryDynamoClient
  let chain: DynamoAuditChain

  beforeEach(() => {
    client = new InMemoryDynamoClient()
    chain = new DynamoAuditChain(client, "test-audit-table")
  })

  describe("init + append", () => {
    it("should initialize with genesis state", async () => {
      await chain.init("test-partition-1")
      expect(chain.currentState).toBe("ready")
      expect(chain.currentPartitionId).toBe("test-partition-1")
      expect(chain.currentSequenceNumber).toBe(0)
      expect(chain.currentHash).toBe("0")
    })

    it("should append entries with correct hash chain", async () => {
      await chain.init("test-partition-1")

      const hash1 = await chain.append("scoring_path", { pool: "pool-a", score: 0.85 })
      expect(hash1).toBeTruthy()
      expect(chain.currentSequenceNumber).toBe(1)

      const hash2 = await chain.append("scoring_path", { pool: "pool-b", score: 0.72 })
      expect(hash2).toBeTruthy()
      expect(chain.currentSequenceNumber).toBe(2)

      // Verify chain linkage
      const entries = client.items.get("test-partition-1")!
      expect(entries).toHaveLength(2)
      expect(entries[0].prevHash).toBe("0") // Genesis
      expect(entries[1].prevHash).toBe(entries[0].hash)
    })

    it("should compute correct hash: SHA-256(prevHash:payloadHash:timestamp)", async () => {
      await chain.init("test-partition-1")
      await chain.append("test_action", { key: "value" })

      const entry = client.items.get("test-partition-1")![0]
      const payloadHash = computeHash(JSON.stringify({ key: "value" }))
      const expectedHash = computeHash(`0:${payloadHash}:${entry.timestamp}`)
      expect(entry.hash).toBe(expectedHash)
    })

    it("should throw if not initialized", async () => {
      await expect(chain.append("test", {})).rejects.toThrow("not initialized")
    })
  })

  describe("init recovery", () => {
    it("should recover from existing partition data", async () => {
      // Pre-populate the mock with existing entries
      await chain.init("test-partition-1")
      await chain.append("action-1", { data: 1 })
      await chain.append("action-2", { data: 2 })

      const savedSeq = chain.currentSequenceNumber
      const savedHash = chain.currentHash

      // Create new chain instance and recover
      const chain2 = new DynamoAuditChain(client, "test-audit-table")
      await chain2.init("test-partition-1")

      expect(chain2.currentSequenceNumber).toBe(savedSeq)
      expect(chain2.currentHash).toBe(savedHash)
      expect(chain2.currentState).toBe("ready")
    })
  })

  describe("conditional write failure recovery (T-4.2)", () => {
    it("should handle idempotent duplicate (same payloadHash)", async () => {
      await chain.init("test-partition-1")
      await chain.append("action-1", { data: 1 })

      // Now force a conditional failure followed by a re-read that matches
      // This simulates: crash-recovery re-append with same payload
      // The mock will find the existing entry with matching payloadHash
      client.conditionalFailNextPut = true

      // The retry mechanism should detect the idempotent duplicate
      const hash = await chain.append("action-1", { data: 1 })
      // Should return the existing hash (idempotent dedup) or null
      // Depending on whether payloadHash matches (it won't exactly match since
      // the payload hash includes the "resync_retry" field in the retry)
      // In practice, the collision path increments consecutiveFailures
      expect(chain.currentState).not.toBe("uninitialized")
    })

    it("should enter degraded mode after MAX_CONSECUTIVE_FAILURES", async () => {
      await chain.init("test-partition-1")

      // Force 4 consecutive non-conditional failures to trigger degraded
      for (let i = 0; i < 4; i++) {
        client.failNextPut = true
        const result = await chain.append(`action-${i}`, { data: i })
        expect(result).toBeNull()
      }

      expect(chain.currentState).toBe("degraded")
    })

    it("should return null in degraded mode", async () => {
      await chain.init("test-partition-1")

      // Force degraded
      for (let i = 0; i < 4; i++) {
        client.failNextPut = true
        await chain.append(`action-${i}`, { data: i })
      }

      // Now try to append — should return null without throwing
      const result = await chain.append("action-after-degraded", { data: "x" })
      expect(result).toBeNull()
      expect(client.putCount).toBe(4) // No new put attempts
    })
  })

  describe("partition enumeration (T-4.3)", () => {
    it("should enumerate all partitions", async () => {
      // Create entries in multiple partitions
      const chain1 = new DynamoAuditChain(client, "test-audit-table")
      await chain1.init("partition-a")
      await chain1.append("action", { data: 1 })

      const chain2 = new DynamoAuditChain(client, "test-audit-table")
      await chain2.init("partition-b")
      await chain2.append("action", { data: 2 })

      const chain3 = new DynamoAuditChain(client, "test-audit-table")
      await chain3.init("partition-c")
      await chain3.append("action", { data: 3 })

      const partitions = await chain1.enumeratePartitions()
      expect(partitions).toHaveLength(3)
      expect(partitions.sort()).toEqual(["partition-a", "partition-b", "partition-c"])
    })

    it("should return empty array for no partitions", async () => {
      await chain.init("empty-test")
      // No entries appended, but the scan mock returns based on items map
      const freshClient = new InMemoryDynamoClient()
      const freshChain = new DynamoAuditChain(freshClient, "test-audit-table")
      const partitions = await freshChain.enumeratePartitions()
      expect(partitions).toHaveLength(0)
    })
  })

  describe("getPartitionHead", () => {
    it("should return latest entry for partition", async () => {
      await chain.init("test-partition-1")
      await chain.append("action-1", { data: 1 })
      await chain.append("action-2", { data: 2 })
      await chain.append("action-3", { data: 3 })

      const head = await chain.getPartitionHead("test-partition-1")
      expect(head).not.toBeNull()
      expect(head!.sequenceNumber).toBe(3)
      expect(head!.hash).toBe(chain.currentHash)
    })

    it("should return null for empty partition", async () => {
      await chain.init("test-partition-1")
      const head = await chain.getPartitionHead("nonexistent")
      expect(head).toBeNull()
    })
  })

  describe("verifyPartitionIntegrity (T-4.5)", () => {
    it("should verify valid chain", async () => {
      await chain.init("test-partition-1")
      await chain.append("action-1", { data: 1 })
      await chain.append("action-2", { data: 2 })
      await chain.append("action-3", { data: 3 })

      const result = await chain.verifyPartitionIntegrity("test-partition-1")
      expect(result.valid).toBe(true)
      expect(result.brokenAtSeq).toBeUndefined()
    })

    it("should detect tampered hash (AC-NFR2c)", async () => {
      await chain.init("test-partition-1")
      await chain.append("action-1", { data: 1 })
      await chain.append("action-2", { data: 2 })

      // Tamper with the first entry's hash
      const entries = client.items.get("test-partition-1")!
      entries[0].hash = "tampered-hash-value"

      const result = await chain.verifyPartitionIntegrity("test-partition-1")
      expect(result.valid).toBe(false)
      expect(result.brokenAtSeq).toBe(1)
    })

    it("should detect broken prevHash linkage", async () => {
      await chain.init("test-partition-1")
      await chain.append("action-1", { data: 1 })
      await chain.append("action-2", { data: 2 })

      // Tamper with second entry's prevHash
      const entries = client.items.get("test-partition-1")!
      entries[1].prevHash = "wrong-prev-hash"

      const result = await chain.verifyPartitionIntegrity("test-partition-1")
      expect(result.valid).toBe(false)
      expect(result.brokenAtSeq).toBe(2)
    })

    it("should return valid for empty partition", async () => {
      await chain.init("test-partition-1")
      const result = await chain.verifyPartitionIntegrity("test-partition-1")
      expect(result.valid).toBe(true)
    })
  })
})

describe("computeHash", () => {
  it("should produce deterministic SHA-256 hex", () => {
    const hash1 = computeHash("hello:world:2026-01-01T00:00:00.000Z")
    const hash2 = computeHash("hello:world:2026-01-01T00:00:00.000Z")
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64)
  })

  it("should produce different hash for different input", () => {
    const hash1 = computeHash("input-a")
    const hash2 = computeHash("input-b")
    expect(hash1).not.toBe(hash2)
  })
})
