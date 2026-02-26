// src/hounfour/audit/s3-anchor.ts — S3 Object Lock Immutable Anchor (SDD §4.6.2, T-4.4)
//
// Daily KMS-signed digest of all partition head hashes.
// Written to S3 with COMPLIANCE Object Lock (90-day retention).
// Verification: re-read digest, verify KMS signature, compare against live partition heads.

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditDigest {
  date: string
  digest: string
  signature: string
  partitionHeads: Record<string, { hash: string; sequenceNumber: number }>
  generatedAt: string
}

export interface PartitionHead {
  hash: string
  sequenceNumber: number
}

/** Minimal S3 client interface (injectable for testing). */
export interface AuditS3Client {
  putObject(params: {
    Bucket: string
    Key: string
    Body: string
    ContentType: string
    ObjectLockMode?: string
    ObjectLockRetainUntilDate?: string
  }): Promise<void>
  getObject(params: {
    Bucket: string
    Key: string
  }): Promise<{ Body: string }>
}

/** Minimal KMS client interface (injectable for testing). */
export interface AuditKMSClient {
  sign(params: {
    KeyId: string
    Message: Uint8Array
    MessageType: string
    SigningAlgorithm: string
  }): Promise<{ Signature: Uint8Array }>
  verify(params: {
    KeyId: string
    Message: Uint8Array
    Signature: Uint8Array
    MessageType: string
    SigningAlgorithm: string
  }): Promise<{ SignatureValid: boolean }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIGNING_ALGORITHM = "RSASSA_PKCS1_V1_5_SHA_256"
const RETENTION_DAYS = 90
const DIGEST_PREFIX = "finn/audit/daily-digest"

// ---------------------------------------------------------------------------
// S3AuditAnchor (T-4.4)
// ---------------------------------------------------------------------------

export class S3AuditAnchor {
  private readonly s3: AuditS3Client
  private readonly kms: AuditKMSClient
  private readonly bucketName: string
  private readonly kmsKeyId: string

  constructor(
    s3: AuditS3Client,
    kms: AuditKMSClient,
    bucketName: string,
    kmsKeyId: string,
  ) {
    this.s3 = s3
    this.kms = kms
    this.bucketName = bucketName
    this.kmsKeyId = kmsKeyId
  }

  // === DAILY DIGEST (AC-NFR2b) ===

  /**
   * Compute daily digest from partition heads, KMS-sign it, and write to S3 Object Lock.
   * Returns the signed digest object.
   */
  async writeDailyDigest(
    partitionHeads: Map<string, PartitionHead>,
  ): Promise<AuditDigest> {
    const date = new Date().toISOString().split("T")[0] // YYYY-MM-DD

    // 1. Compute digest: sort partitions deterministically, then SHA-256
    const sorted = [...partitionHeads.entries()].sort(([a], [b]) => a.localeCompare(b))
    const digestInput = sorted
      .map(([pid, head]) => `${pid}:${head.hash}:${head.sequenceNumber}`)
      .join("|")
    const digest = createHash("sha256").update(digestInput).digest("hex")

    // 2. KMS sign the digest
    const signResult = await this.kms.sign({
      KeyId: this.kmsKeyId,
      Message: new TextEncoder().encode(digest),
      MessageType: "RAW",
      SigningAlgorithm: SIGNING_ALGORITHM,
    })

    const signature = Buffer.from(signResult.Signature).toString("base64")

    // 3. Build digest object
    const digestObj: AuditDigest = {
      date,
      digest,
      signature,
      partitionHeads: Object.fromEntries(
        sorted.map(([pid, head]) => [pid, { hash: head.hash, sequenceNumber: head.sequenceNumber }]),
      ),
      generatedAt: new Date().toISOString(),
    }

    // 4. Write to S3 with Object Lock COMPLIANCE retention
    const retainUntil = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const key = `${DIGEST_PREFIX}/${date}.json`

    await this.s3.putObject({
      Bucket: this.bucketName,
      Key: key,
      Body: JSON.stringify(digestObj),
      ContentType: "application/json",
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: retainUntil.toISOString(),
    })

    console.log(JSON.stringify({
      metric: "audit.s3.digest_written",
      date,
      digest: digest.slice(0, 12) + "...",
      partition_count: sorted.length,
      key,
      retention_until: retainUntil.toISOString(),
      timestamp: Date.now(),
    }))

    return digestObj
  }

  // === VERIFICATION (T-4.5, AC-NFR2a, AC-NFR2c) ===

  /**
   * Verify audit trail integrity against a stored S3 digest.
   *
   * Steps:
   * 1. Fetch digest from S3
   * 2. Verify KMS signature
   * 3. Compare partition heads against live data
   *
   * Returns { valid: true } or { valid: false, reason }.
   */
  async verifyAuditTrailIntegrity(
    date: string,
    livePartitionHeads: Map<string, PartitionHead>,
  ): Promise<{ valid: boolean; reason?: string }> {
    // 1. Fetch stored digest
    const key = `${DIGEST_PREFIX}/${date}.json`
    let storedDigest: AuditDigest

    try {
      const response = await this.s3.getObject({
        Bucket: this.bucketName,
        Key: key,
      })
      storedDigest = JSON.parse(response.Body) as AuditDigest
    } catch (err) {
      return {
        valid: false,
        reason: `Failed to fetch digest: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // 2. Verify KMS signature
    const signatureValid = await this.kms.verify({
      KeyId: this.kmsKeyId,
      Message: new TextEncoder().encode(storedDigest.digest),
      Signature: Buffer.from(storedDigest.signature, "base64"),
      MessageType: "RAW",
      SigningAlgorithm: SIGNING_ALGORITHM,
    })

    if (!signatureValid.SignatureValid) {
      return { valid: false, reason: "KMS signature verification failed — digest tampered" }
    }

    // 3. Recompute digest from live partition heads
    const sorted = [...livePartitionHeads.entries()].sort(([a], [b]) => a.localeCompare(b))
    const digestInput = sorted
      .map(([pid, head]) => `${pid}:${head.hash}:${head.sequenceNumber}`)
      .join("|")
    const recomputedDigest = createHash("sha256").update(digestInput).digest("hex")

    if (recomputedDigest !== storedDigest.digest) {
      return {
        valid: false,
        reason: `Digest mismatch: stored=${storedDigest.digest.slice(0, 12)}... recomputed=${recomputedDigest.slice(0, 12)}...`,
      }
    }

    return { valid: true }
  }

  // === ACCESSORS ===

  get bucket(): string { return this.bucketName }
  get keyPrefix(): string { return DIGEST_PREFIX }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute deterministic digest from partition heads (exported for testing). */
export function computeDigest(partitionHeads: Map<string, PartitionHead>): string {
  const sorted = [...partitionHeads.entries()].sort(([a], [b]) => a.localeCompare(b))
  const digestInput = sorted
    .map(([pid, head]) => `${pid}:${head.hash}:${head.sequenceNumber}`)
    .join("|")
  return createHash("sha256").update(digestInput).digest("hex")
}
