// tests/finn/audit/s3-anchor.test.ts — S3AuditAnchor Tests (T-4.8)
//
// Tests: daily digest, KMS signing/verification, Object Lock params,
// integrity verification, digest computation determinism.

import { describe, it, expect, beforeEach } from "vitest"
import {
  S3AuditAnchor,
  computeDigest,
  type AuditS3Client,
  type AuditKMSClient,
  type AuditDigest,
  type PartitionHead,
} from "../../../src/hounfour/audit/s3-anchor.js"

// ---------------------------------------------------------------------------
// Mock S3 Client
// ---------------------------------------------------------------------------

class MockS3Client implements AuditS3Client {
  objects: Map<string, { body: string; params: Record<string, unknown> }> = new Map()

  async putObject(params: {
    Bucket: string
    Key: string
    Body: string
    ContentType: string
    ObjectLockMode?: string
    ObjectLockRetainUntilDate?: string
  }): Promise<void> {
    this.objects.set(`${params.Bucket}/${params.Key}`, {
      body: params.Body,
      params: { ...params },
    })
  }

  async getObject(params: {
    Bucket: string
    Key: string
  }): Promise<{ Body: string }> {
    const obj = this.objects.get(`${params.Bucket}/${params.Key}`)
    if (!obj) throw new Error("NoSuchKey")
    return { Body: obj.body }
  }
}

// ---------------------------------------------------------------------------
// Mock KMS Client
// ---------------------------------------------------------------------------

class MockKMSClient implements AuditKMSClient {
  signedMessages: Uint8Array[] = []

  async sign(params: {
    KeyId: string
    Message: Uint8Array
    MessageType: string
    SigningAlgorithm: string
  }): Promise<{ Signature: Uint8Array }> {
    this.signedMessages.push(params.Message)
    // Deterministic mock signature: reverse the message bytes
    const sig = new Uint8Array(params.Message.length)
    for (let i = 0; i < params.Message.length; i++) {
      sig[i] = params.Message[params.Message.length - 1 - i]
    }
    return { Signature: sig }
  }

  async verify(params: {
    KeyId: string
    Message: Uint8Array
    Signature: Uint8Array
    MessageType: string
    SigningAlgorithm: string
  }): Promise<{ SignatureValid: boolean }> {
    // Verify by re-computing the mock signature
    const expected = new Uint8Array(params.Message.length)
    for (let i = 0; i < params.Message.length; i++) {
      expected[i] = params.Message[params.Message.length - 1 - i]
    }
    const valid = params.Signature.length === expected.length &&
      params.Signature.every((b, i) => b === expected[i])
    return { SignatureValid: valid }
  }
}

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makePartitionHeads(): Map<string, PartitionHead> {
  const heads = new Map<string, PartitionHead>()
  heads.set("partition-a", { hash: "aaa111", sequenceNumber: 5 })
  heads.set("partition-b", { hash: "bbb222", sequenceNumber: 3 })
  heads.set("partition-c", { hash: "ccc333", sequenceNumber: 8 })
  return heads
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("S3AuditAnchor", () => {
  let s3: MockS3Client
  let kms: MockKMSClient
  let anchor: S3AuditAnchor

  beforeEach(() => {
    s3 = new MockS3Client()
    kms = new MockKMSClient()
    anchor = new S3AuditAnchor(s3, kms, "test-audit-bucket", "test-kms-key-id")
  })

  describe("writeDailyDigest", () => {
    it("should write digest to S3 with correct key format", async () => {
      const heads = makePartitionHeads()
      const digest = await anchor.writeDailyDigest(heads)

      const today = new Date().toISOString().split("T")[0]
      const s3Key = `test-audit-bucket/finn/audit/daily-digest/${today}.json`
      expect(s3.objects.has(s3Key)).toBe(true)

      const stored = JSON.parse(s3.objects.get(s3Key)!.body) as AuditDigest
      expect(stored.date).toBe(today)
      expect(stored.digest).toBe(digest.digest)
      expect(stored.signature).toBeTruthy()
    })

    it("should include COMPLIANCE Object Lock with 90-day retention", async () => {
      const heads = makePartitionHeads()
      await anchor.writeDailyDigest(heads)

      const today = new Date().toISOString().split("T")[0]
      const s3Key = `test-audit-bucket/finn/audit/daily-digest/${today}.json`
      const params = s3.objects.get(s3Key)!.params

      expect(params.ObjectLockMode).toBe("COMPLIANCE")
      expect(params.ObjectLockRetainUntilDate).toBeTruthy()

      // Verify retention is ~90 days from now
      const retainDate = new Date(params.ObjectLockRetainUntilDate as string)
      const daysFromNow = (retainDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      expect(daysFromNow).toBeGreaterThan(89)
      expect(daysFromNow).toBeLessThan(91)
    })

    it("should KMS-sign the digest", async () => {
      const heads = makePartitionHeads()
      await anchor.writeDailyDigest(heads)

      expect(kms.signedMessages).toHaveLength(1)
    })

    it("should sort partition heads deterministically", async () => {
      const heads1 = new Map<string, PartitionHead>()
      heads1.set("b", { hash: "h2", sequenceNumber: 2 })
      heads1.set("a", { hash: "h1", sequenceNumber: 1 })

      const heads2 = new Map<string, PartitionHead>()
      heads2.set("a", { hash: "h1", sequenceNumber: 1 })
      heads2.set("b", { hash: "h2", sequenceNumber: 2 })

      const anchor1 = new S3AuditAnchor(new MockS3Client(), new MockKMSClient(), "b", "k")
      const anchor2 = new S3AuditAnchor(new MockS3Client(), new MockKMSClient(), "b", "k")

      const d1 = await anchor1.writeDailyDigest(heads1)
      const d2 = await anchor2.writeDailyDigest(heads2)

      expect(d1.digest).toBe(d2.digest)
    })

    it("should include all partition heads in digest object", async () => {
      const heads = makePartitionHeads()
      const digest = await anchor.writeDailyDigest(heads)

      expect(Object.keys(digest.partitionHeads)).toHaveLength(3)
      expect(digest.partitionHeads["partition-a"]).toEqual({ hash: "aaa111", sequenceNumber: 5 })
      expect(digest.partitionHeads["partition-b"]).toEqual({ hash: "bbb222", sequenceNumber: 3 })
      expect(digest.partitionHeads["partition-c"]).toEqual({ hash: "ccc333", sequenceNumber: 8 })
    })
  })

  describe("verifyAuditTrailIntegrity", () => {
    it("should verify valid digest + matching heads", async () => {
      const heads = makePartitionHeads()
      await anchor.writeDailyDigest(heads)

      const today = new Date().toISOString().split("T")[0]
      const result = await anchor.verifyAuditTrailIntegrity(today, heads)
      expect(result.valid).toBe(true)
    })

    it("should detect tampered partition heads (digest mismatch)", async () => {
      const heads = makePartitionHeads()
      await anchor.writeDailyDigest(heads)

      // Tamper: change a partition head hash
      const tamperedHeads = makePartitionHeads()
      tamperedHeads.set("partition-a", { hash: "TAMPERED", sequenceNumber: 5 })

      const today = new Date().toISOString().split("T")[0]
      const result = await anchor.verifyAuditTrailIntegrity(today, tamperedHeads)
      expect(result.valid).toBe(false)
      expect(result.reason).toContain("Digest mismatch")
    })

    it("should detect tampered KMS signature", async () => {
      const heads = makePartitionHeads()
      await anchor.writeDailyDigest(heads)

      // Tamper the stored signature
      const today = new Date().toISOString().split("T")[0]
      const s3Key = `test-audit-bucket/finn/audit/daily-digest/${today}.json`
      const stored = JSON.parse(s3.objects.get(s3Key)!.body) as AuditDigest
      stored.signature = Buffer.from("invalid-signature").toString("base64")
      s3.objects.get(s3Key)!.body = JSON.stringify(stored)

      const result = await anchor.verifyAuditTrailIntegrity(today, heads)
      expect(result.valid).toBe(false)
      expect(result.reason).toContain("signature verification failed")
    })

    it("should handle missing digest gracefully", async () => {
      const heads = makePartitionHeads()
      const result = await anchor.verifyAuditTrailIntegrity("2020-01-01", heads)
      expect(result.valid).toBe(false)
      expect(result.reason).toContain("Failed to fetch digest")
    })
  })
})

describe("computeDigest", () => {
  it("should be deterministic for same input", () => {
    const heads = new Map<string, PartitionHead>()
    heads.set("a", { hash: "h1", sequenceNumber: 1 })
    heads.set("b", { hash: "h2", sequenceNumber: 2 })

    const d1 = computeDigest(heads)
    const d2 = computeDigest(heads)
    expect(d1).toBe(d2)
    expect(d1).toHaveLength(64)
  })

  it("should change when partition head changes", () => {
    const heads1 = new Map<string, PartitionHead>()
    heads1.set("a", { hash: "h1", sequenceNumber: 1 })

    const heads2 = new Map<string, PartitionHead>()
    heads2.set("a", { hash: "h1", sequenceNumber: 2 })

    expect(computeDigest(heads1)).not.toBe(computeDigest(heads2))
  })
})
