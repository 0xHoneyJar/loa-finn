// src/x402/settlement-store.ts — DynamoDB Settlement State (SDD §4.4.1, T-3.3)
//
// Table: finn-x402-settlements
// PK: idempotencyKey ({chainId}:{token}:{from}:{nonce})
// GSI: status-updated-index (PK: status, SK: updatedAt)
// TTL: 24h after updatedAt for terminal states.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettlementStatus = "pending" | "submitted" | "confirmed" | "reverted" | "gas_failed" | "expired"

export interface SettlementRecord {
  idempotencyKey: string
  status: SettlementStatus
  txHash?: string
  quoteId: string
  createdAt: string   // ISO 8601
  updatedAt: string   // ISO 8601
  revertReason?: string
  /** TTL epoch seconds — DynamoDB auto-deletes after this time */
  ttl?: number
}

export interface SettlementStoreConfig {
  tableName?: string
  ttlSeconds?: number  // Default: 86400 (24h) for terminal states
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SettlementStore {
  /** Get settlement by idempotency key. Returns null if not found. */
  get(idempotencyKey: string): Promise<SettlementRecord | null>

  /** Claim a pending slot. Returns true if claimed, false if key already exists. */
  claimPending(idempotencyKey: string, quoteId: string): Promise<boolean>

  /** Update settlement status. */
  update(idempotencyKey: string, fields: Partial<Pick<SettlementRecord, "status" | "txHash" | "revertReason">>): Promise<void>

  /** Query non-terminal records older than cutoffISO via GSI. */
  queryStaleByStatus(status: SettlementStatus, cutoffISO: string): Promise<SettlementRecord[]>
}

// ---------------------------------------------------------------------------
// DynamoDB Implementation
// ---------------------------------------------------------------------------

/** Minimal DynamoDB document client interface (avoids SDK dependency in types). */
export interface DynamoDocClient {
  get(params: { TableName: string; Key: Record<string, unknown> }): Promise<{ Item?: Record<string, unknown> }>
  put(params: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string }): Promise<void>
  update(params: {
    TableName: string
    Key: Record<string, unknown>
    UpdateExpression: string
    ExpressionAttributeValues: Record<string, unknown>
    ExpressionAttributeNames?: Record<string, string>
  }): Promise<void>
  query(params: {
    TableName: string
    IndexName: string
    KeyConditionExpression: string
    ExpressionAttributeValues: Record<string, unknown>
  }): Promise<{ Items?: Record<string, unknown>[] }>
}

const TERMINAL_STATUSES = new Set<SettlementStatus>(["confirmed", "reverted", "gas_failed", "expired"])

export class DynamoSettlementStore implements SettlementStore {
  private readonly tableName: string
  private readonly ttlSeconds: number
  private readonly client: DynamoDocClient

  constructor(client: DynamoDocClient, config?: SettlementStoreConfig) {
    this.client = client
    this.tableName = config?.tableName ?? "finn-x402-settlements"
    this.ttlSeconds = config?.ttlSeconds ?? 86400
  }

  async get(idempotencyKey: string): Promise<SettlementRecord | null> {
    const result = await this.client.get({
      TableName: this.tableName,
      Key: { idempotencyKey },
    })
    return result.Item ? this.toRecord(result.Item) : null
  }

  async claimPending(idempotencyKey: string, quoteId: string): Promise<boolean> {
    const now = new Date().toISOString()
    try {
      await this.client.put({
        TableName: this.tableName,
        Item: {
          idempotencyKey,
          status: "pending",
          quoteId,
          createdAt: now,
          updatedAt: now,
          // No TTL for non-terminal states — reconciliation handles them
        },
        ConditionExpression: "attribute_not_exists(idempotencyKey)",
      })
      return true
    } catch (err: unknown) {
      // ConditionalCheckFailedException = key already exists
      if (err && typeof err === "object" && "name" in err && err.name === "ConditionalCheckFailedException") {
        return false
      }
      throw err
    }
  }

  async update(idempotencyKey: string, fields: Partial<Pick<SettlementRecord, "status" | "txHash" | "revertReason">>): Promise<void> {
    const now = new Date().toISOString()
    const updates: string[] = ["#updatedAt = :updatedAt"]
    const values: Record<string, unknown> = { ":updatedAt": now }
    const names: Record<string, string> = { "#updatedAt": "updatedAt" }

    if (fields.status !== undefined) {
      updates.push("#status = :status")
      values[":status"] = fields.status
      names["#status"] = "status"

      // Add TTL for terminal states
      if (TERMINAL_STATUSES.has(fields.status)) {
        const ttlEpoch = Math.floor(Date.now() / 1000) + this.ttlSeconds
        updates.push("#ttl = :ttl")
        values[":ttl"] = ttlEpoch
        names["#ttl"] = "ttl"
      }
    }

    if (fields.txHash !== undefined) {
      updates.push("txHash = :txHash")
      values[":txHash"] = fields.txHash
    }

    if (fields.revertReason !== undefined) {
      updates.push("revertReason = :revertReason")
      values[":revertReason"] = fields.revertReason
    }

    await this.client.update({
      TableName: this.tableName,
      Key: { idempotencyKey },
      UpdateExpression: `SET ${updates.join(", ")}`,
      ExpressionAttributeValues: values,
      ExpressionAttributeNames: names,
    })
  }

  async queryStaleByStatus(status: SettlementStatus, cutoffISO: string): Promise<SettlementRecord[]> {
    const result = await this.client.query({
      TableName: this.tableName,
      IndexName: "status-updated-index",
      KeyConditionExpression: "#status = :status AND updatedAt < :cutoff",
      ExpressionAttributeValues: {
        ":status": status,
        ":cutoff": cutoffISO,
      },
    })
    return (result.Items ?? []).map(item => this.toRecord(item))
  }

  private toRecord(item: Record<string, unknown>): SettlementRecord {
    return {
      idempotencyKey: String(item.idempotencyKey),
      status: String(item.status) as SettlementStatus,
      txHash: item.txHash ? String(item.txHash) : undefined,
      quoteId: String(item.quoteId ?? ""),
      createdAt: String(item.createdAt ?? ""),
      updatedAt: String(item.updatedAt ?? ""),
      revertReason: item.revertReason ? String(item.revertReason) : undefined,
      ttl: typeof item.ttl === "number" ? item.ttl : undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// In-Memory Implementation (for testing)
// ---------------------------------------------------------------------------

export class InMemorySettlementStore implements SettlementStore {
  private readonly records = new Map<string, SettlementRecord>()

  async get(idempotencyKey: string): Promise<SettlementRecord | null> {
    return this.records.get(idempotencyKey) ?? null
  }

  async claimPending(idempotencyKey: string, quoteId: string): Promise<boolean> {
    if (this.records.has(idempotencyKey)) return false
    const now = new Date().toISOString()
    this.records.set(idempotencyKey, {
      idempotencyKey,
      status: "pending",
      quoteId,
      createdAt: now,
      updatedAt: now,
    })
    return true
  }

  async update(idempotencyKey: string, fields: Partial<Pick<SettlementRecord, "status" | "txHash" | "revertReason">>): Promise<void> {
    const record = this.records.get(idempotencyKey)
    if (!record) throw new Error(`Settlement not found: ${idempotencyKey}`)
    if (fields.status !== undefined) record.status = fields.status
    if (fields.txHash !== undefined) record.txHash = fields.txHash
    if (fields.revertReason !== undefined) record.revertReason = fields.revertReason
    record.updatedAt = new Date().toISOString()
  }

  async queryStaleByStatus(status: SettlementStatus, cutoffISO: string): Promise<SettlementRecord[]> {
    const result: SettlementRecord[] = []
    for (const record of this.records.values()) {
      if (record.status === status && record.updatedAt < cutoffISO) {
        result.push(record)
      }
    }
    return result
  }

  /** Test helper: get all records. */
  getAll(): SettlementRecord[] {
    return [...this.records.values()]
  }

  /** Test helper: clear all records. */
  clear(): void {
    this.records.clear()
  }
}

// ---------------------------------------------------------------------------
// Idempotency Key Builder
// ---------------------------------------------------------------------------

/**
 * Build idempotency key from EIP-3009 authorization fields.
 * Format: {chainId}:{tokenContract}:{from}:{nonce}
 */
export function buildIdempotencyKey(chainId: number, tokenContract: string, from: string, nonce: string): string {
  return `${chainId}:${tokenContract.toLowerCase()}:${from.toLowerCase()}:${nonce}`
}
