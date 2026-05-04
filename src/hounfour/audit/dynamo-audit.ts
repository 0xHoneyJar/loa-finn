// src/hounfour/audit/dynamo-audit.ts — DynamoDB Per-Partition Hash Chain (SDD §4.6.1, T-4.1/T-4.2/T-4.3)
//
// Table: finn-scoring-path-log
// PK: partitionId (ECS task ID), SK: sequenceNumber
// Hash chain: SHA-256(prevHash + ':' + payloadHash + ':' + timestamp)
// Conditional write: attribute_not_exists(sequenceNumber) for exactly-once.

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  partitionId: string
  sequenceNumber: number
  hash: string
  prevHash: string
  timestamp: string
  action: string
  payloadHash: string
}

export type AuditChainState = "uninitialized" | "ready" | "degraded"

/** Minimal DynamoDB document client interface. */
export interface AuditDynamoClient {
  put(params: {
    TableName: string
    Item: Record<string, unknown>
    ConditionExpression?: string
  }): Promise<void>
  query(params: {
    TableName: string
    KeyConditionExpression: string
    ExpressionAttributeValues: Record<string, unknown>
    ScanIndexForward?: boolean
    Limit?: number
    ProjectionExpression?: string
  }): Promise<{ Items?: Record<string, unknown>[] }>
  scan(params: {
    TableName: string
    ProjectionExpression: string
    ExclusiveStartKey?: Record<string, unknown>
    Select?: string
  }): Promise<{ Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENESIS_HASH = "0"
const MAX_CONSECUTIVE_FAILURES = 3

// ---------------------------------------------------------------------------
// DynamoAuditChain (T-4.1, T-4.2, T-4.3)
// ---------------------------------------------------------------------------

export class DynamoAuditChain {
  private readonly client: AuditDynamoClient
  private readonly tableName: string
  private partitionId: string = ""
  private sequenceNumber: number = 0
  private lastHash: string = GENESIS_HASH
  private state: AuditChainState = "uninitialized"
  private consecutiveFailures = 0

  constructor(client: AuditDynamoClient, tableName: string = "finn-scoring-path-log") {
    this.client = client
    this.tableName = tableName
  }

  // === LIFECYCLE ===

  /**
   * Extract stable ECS Task ID from container metadata (AC-NFR2d).
   * Falls back to hostname + boot timestamp for local dev.
   */
  async extractTaskId(): Promise<string> {
    const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4
    if (metadataUri) {
      try {
        const resp = await fetch(`${metadataUri}/task`)
        const data = await resp.json() as { TaskARN?: string }
        if (data.TaskARN) {
          // ARN format: arn:aws:ecs:region:account:task/cluster/task-id
          const parts = data.TaskARN.split("/")
          return parts[parts.length - 1] ?? data.TaskARN
        }
      } catch {
        // Fall through to fallback
      }
    }
    // Local dev fallback
    const hostname = process.env.HOSTNAME ?? "local"
    return `${hostname}-${Date.now()}`
  }

  /**
   * Initialize chain state by recovering from DynamoDB.
   * MUST be called before first append (AC-NFR2a).
   */
  async init(partitionIdOverride?: string): Promise<void> {
    this.partitionId = partitionIdOverride ?? await this.extractTaskId()

    // Query latest entry in partition
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "partitionId = :pid",
      ExpressionAttributeValues: { ":pid": this.partitionId },
      ScanIndexForward: false,
      Limit: 1,
    })

    if (result.Items && result.Items.length > 0) {
      const latest = result.Items[0]
      this.sequenceNumber = Number(latest.sequenceNumber)
      this.lastHash = String(latest.hash)
      console.log(JSON.stringify({
        metric: "audit.chain.recovered",
        partition_id: this.partitionId,
        seq: this.sequenceNumber,
        hash: this.lastHash.slice(0, 12) + "...",
        timestamp: Date.now(),
      }))
    } else {
      // New partition — genesis
      this.sequenceNumber = 0
      this.lastHash = GENESIS_HASH
      console.log(JSON.stringify({
        metric: "audit.chain.genesis",
        partition_id: this.partitionId,
        timestamp: Date.now(),
      }))
    }

    this.state = "ready"
    this.consecutiveFailures = 0
  }

  // === APPEND (T-4.1) ===

  /**
   * Append an entry to the audit chain (atomic via conditional write).
   * Returns the hash of the appended entry.
   */
  async append(action: string, payload: Record<string, unknown>): Promise<string | null> {
    if (this.state === "uninitialized") {
      throw new Error("DynamoAuditChain not initialized — call init() first")
    }

    if (this.state === "degraded") {
      // In degraded mode, return null (caller should use CloudWatch fallback)
      return null
    }

    const timestamp = new Date().toISOString()
    const payloadHash = computeHash(JSON.stringify(payload))
    const nextSeq = this.sequenceNumber + 1
    const hash = computeHash(`${this.lastHash}:${payloadHash}:${timestamp}`)

    const entry: AuditEntry = {
      partitionId: this.partitionId,
      sequenceNumber: nextSeq,
      hash,
      prevHash: this.lastHash,
      timestamp,
      action,
      payloadHash,
    }

    try {
      await this.client.put({
        TableName: this.tableName,
        Item: entry as unknown as Record<string, unknown>,
        ConditionExpression: "attribute_not_exists(sequenceNumber)",
      })

      // Success — update local state
      this.sequenceNumber = nextSeq
      this.lastHash = hash
      this.consecutiveFailures = 0
      return hash
    } catch (err: unknown) {
      return this.handleConditionalWriteFailure(err, entry)
    }
  }

  // === CONDITIONAL WRITE FAILURE RECOVERY (T-4.2) ===

  private async handleConditionalWriteFailure(err: unknown, attemptedEntry: AuditEntry): Promise<string | null> {
    if (!isConditionalCheckFailed(err)) {
      // Not a conditional failure — unexpected error
      this.consecutiveFailures++
      this.checkDegraded()
      console.error(JSON.stringify({
        metric: "audit.chain.write_error",
        partition_id: this.partitionId,
        error: err instanceof Error ? err.message : String(err),
        consecutive_failures: this.consecutiveFailures,
        timestamp: Date.now(),
      }))
      return null
    }

    // Conditional check failed — PK+SK already exists
    this.consecutiveFailures++

    // Re-read the existing entry at that sequence number
    const existingResult = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "partitionId = :pid AND sequenceNumber = :seq",
      ExpressionAttributeValues: {
        ":pid": this.partitionId,
        ":seq": attemptedEntry.sequenceNumber,
      },
      Limit: 1,
    })

    if (existingResult.Items && existingResult.Items.length > 0) {
      const existing = existingResult.Items[0]

      if (String(existing.payloadHash) === attemptedEntry.payloadHash) {
        // (a) Idempotent duplicate — no-op
        this.sequenceNumber = attemptedEntry.sequenceNumber
        this.lastHash = String(existing.hash)
        this.consecutiveFailures = 0
        return String(existing.hash)
      }

      // (b) Genuine collision — resync and retry
      console.error(JSON.stringify({
        metric: "audit.chain.collision",
        partition_id: this.partitionId,
        seq: attemptedEntry.sequenceNumber,
        existing_payload_hash: String(existing.payloadHash),
        attempted_payload_hash: attemptedEntry.payloadHash,
        timestamp: Date.now(),
      }))

      // Resync: re-query partition head
      await this.resyncPartitionHead()

      // Retry once with corrected sequence number
      if (this.consecutiveFailures <= MAX_CONSECUTIVE_FAILURES) {
        return this.append(attemptedEntry.action, { resync_retry: true })
      }
    }

    this.checkDegraded()
    return null
  }

  private async resyncPartitionHead(): Promise<void> {
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "partitionId = :pid",
      ExpressionAttributeValues: { ":pid": this.partitionId },
      ScanIndexForward: false,
      Limit: 1,
    })

    if (result.Items && result.Items.length > 0) {
      this.sequenceNumber = Number(result.Items[0].sequenceNumber)
      this.lastHash = String(result.Items[0].hash)
    }
  }

  private checkDegraded(): void {
    if (this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      this.state = "degraded"
      console.error(JSON.stringify({
        metric: "audit.chain.degraded",
        partition_id: this.partitionId,
        consecutive_failures: this.consecutiveFailures,
        timestamp: Date.now(),
      }))
    }
  }

  // === VERIFICATION (T-4.5) ===

  /**
   * Verify partition integrity by replaying the hash chain (AC-NFR2a, AC-NFR2c).
   * Returns null if all hashes match, or the first broken entry.
   */
  async verifyPartitionIntegrity(partitionId?: string): Promise<{ valid: boolean; brokenAtSeq?: number }> {
    const pid = partitionId ?? this.partitionId
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "partitionId = :pid",
      ExpressionAttributeValues: { ":pid": pid },
      ScanIndexForward: true,
    })

    if (!result.Items || result.Items.length === 0) {
      return { valid: true } // Empty partition is valid
    }

    let prevHash = GENESIS_HASH
    for (const item of result.Items) {
      const entry = item as unknown as AuditEntry
      const expectedHash = computeHash(`${prevHash}:${entry.payloadHash}:${entry.timestamp}`)

      if (entry.hash !== expectedHash) {
        return { valid: false, brokenAtSeq: entry.sequenceNumber }
      }
      if (entry.prevHash !== prevHash) {
        return { valid: false, brokenAtSeq: entry.sequenceNumber }
      }

      prevHash = entry.hash
    }

    return { valid: true }
  }

  // === PARTITION ENUMERATION (T-4.3) ===

  /**
   * Enumerate all active partitions via paginated Scan.
   * Low cardinality (~1-10 partitions per ECS service).
   */
  async enumeratePartitions(): Promise<string[]> {
    const partitionIds = new Set<string>()
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
      const result = await this.client.scan({
        TableName: this.tableName,
        ProjectionExpression: "partitionId",
        Select: "SPECIFIC_ATTRIBUTES",
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })

      for (const item of result.Items ?? []) {
        partitionIds.add(String(item.partitionId))
      }

      exclusiveStartKey = result.LastEvaluatedKey
    } while (exclusiveStartKey)

    return [...partitionIds]
  }

  /**
   * Get partition head (latest entry) for a partition.
   */
  async getPartitionHead(partitionId?: string): Promise<{ hash: string; sequenceNumber: number } | null> {
    const pid = partitionId ?? this.partitionId
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "partitionId = :pid",
      ExpressionAttributeValues: { ":pid": pid },
      ScanIndexForward: false,
      Limit: 1,
    })

    if (!result.Items || result.Items.length === 0) return null

    return {
      hash: String(result.Items[0].hash),
      sequenceNumber: Number(result.Items[0].sequenceNumber),
    }
  }

  // === ACCESSORS ===

  get currentState(): AuditChainState { return this.state }
  get currentPartitionId(): string { return this.partitionId }
  get currentSequenceNumber(): number { return this.sequenceNumber }
  get currentHash(): string { return this.lastHash }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function computeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err) {
    return err.name === "ConditionalCheckFailedException"
  }
  return false
}
