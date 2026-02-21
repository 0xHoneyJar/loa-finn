// src/drizzle/schema.ts — Finn database schema (Sprint 1 T1.3, SDD §6)
// All tables live in the `finn` schema, isolated from other services.

import { pgSchema, text, timestamp, bigint, integer, jsonb, boolean, index, uniqueIndex, serial } from "drizzle-orm/pg-core"

export const finnSchema = pgSchema("finn")

// --- finn_api_keys ---
// API key records for developer key authentication (SDD §3.3.2)
export const finnApiKeys = finnSchema.table("finn_api_keys", {
  id: text("id").primaryKey(),                               // ULID
  tenantId: text("tenant_id").notNull(),                     // wallet address or tenant identifier
  lookupHash: text("lookup_hash").notNull(),                 // HMAC-SHA256 of key for O(1) lookup
  secretHash: text("secret_hash").notNull(),                 // bcrypt hash for final verification
  label: text("label").notNull().default(""),                // human-readable label
  balanceMicro: bigint("balance_micro", { mode: "number" }).notNull().default(0),  // credit balance in micro-USDC
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_api_keys_lookup_hash").on(table.lookupHash),
  index("idx_api_keys_tenant").on(table.tenantId),
])

// --- finn_billing_events ---
// Append-only billing event ledger (SDD §3.3.3)
export const finnBillingEvents = finnSchema.table("finn_billing_events", {
  id: text("id").primaryKey(),                               // ULID
  apiKeyId: text("api_key_id").notNull(),                    // FK to finn_api_keys
  requestId: text("request_id").notNull(),                   // idempotency key
  amountMicro: bigint("amount_micro", { mode: "number" }).notNull(),  // debit amount in micro-USDC
  balanceAfter: bigint("balance_after", { mode: "number" }).notNull(), // balance snapshot after debit
  eventType: text("event_type").notNull().default("debit"),  // debit | credit | refund
  metadata: jsonb("metadata"),                                // request context (model, token_id, etc.)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_billing_events_request_id").on(table.requestId),
  index("idx_billing_events_api_key").on(table.apiKeyId),
  index("idx_billing_events_created").on(table.createdAt),
])

// --- finn_verification_failures ---
// Failed x402 receipt verifications for debugging and alerting (SDD §3.2.4)
export const finnVerificationFailures = finnSchema.table("finn_verification_failures", {
  id: text("id").primaryKey(),                               // ULID
  txHash: text("tx_hash"),                                   // on-chain transaction hash (if available)
  reason: text("reason").notNull(),                          // failure reason code
  metadata: jsonb("metadata"),                                // full context: challenge, receipt, error details
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_verification_failures_created").on(table.createdAt),
  index("idx_verification_failures_reason").on(table.reason),
])

// --- finn_personalities ---
// Personality records keyed by NFT tokenId (Sprint 5 T5.3, SDD §4.3)
export const finnPersonalities = finnSchema.table("finn_personalities", {
  id: text("id").primaryKey(),                               // ULID
  tokenId: text("token_id").notNull(),                       // NFT token ID
  archetype: text("archetype").notNull(),                    // freetekno | milady | chicago_detroit | acidhouse
  currentVersionId: text("current_version_id"),              // FK to finn_personality_versions (null until first version)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_personalities_token_id").on(table.tokenId),
  index("idx_personalities_archetype").on(table.archetype),
])

// --- finn_personality_versions ---
// Immutable version records for personality evolution (Sprint 5 T5.3)
export const finnPersonalityVersions = finnSchema.table("finn_personality_versions", {
  id: text("id").primaryKey(),                               // ULID
  personalityId: text("personality_id").notNull(),            // FK to finn_personalities
  versionNumber: integer("version_number").notNull(),         // monotonically increasing per personality
  beauvoirTemplate: text("beauvoir_template").notNull(),      // system prompt template
  dampFingerprint: jsonb("damp_fingerprint"),                 // 96-dial DAMP values (null for static/v1)
  epochNumber: integer("epoch_number").notNull().default(0),  // epoch for signal-based derivation
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_personality_versions_personality").on(table.personalityId),
  uniqueIndex("idx_personality_versions_epoch").on(table.personalityId, table.epochNumber),
])

// --- finn_credit_accounts ---
// Rektdrop credit accounts persisted to Postgres (Bridge high-1 fix).
// Conservation invariant: allocated + unlocked + reserved + consumed + expired = initial_allocation
export const finnCreditAccounts = finnSchema.table("finn_credit_accounts", {
  accountId: text("account_id").primaryKey(),                    // lowercased Ethereum address
  initialAllocation: bigint("initial_allocation", { mode: "bigint" }).notNull(),
  allocated: bigint("allocated", { mode: "bigint" }).notNull().default(0n),
  unlocked: bigint("unlocked", { mode: "bigint" }).notNull().default(0n),
  reserved: bigint("reserved", { mode: "bigint" }).notNull().default(0n),
  consumed: bigint("consumed", { mode: "bigint" }).notNull().default(0n),
  expired: bigint("expired", { mode: "bigint" }).notNull().default(0n),
  tier: text("tier").notNull(),                                  // OG | CONTRIBUTOR | COMMUNITY | PARTNER
  expiresAt: bigint("expires_at", { mode: "bigint" }).notNull(), // Unix ms
  createdAt: bigint("created_at", { mode: "bigint" }).notNull(), // Unix ms
  updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(), // Unix ms
}, (table) => [
  index("idx_credit_accounts_tier").on(table.tier),
])

// --- finn_credit_transactions ---
// Append-only journal for credit state transitions (double-entry).
// Every row is a debit+credit pair preserving the conservation invariant.
export const finnCreditTransactions = finnSchema.table("finn_credit_transactions", {
  id: serial("id").primaryKey(),                                 // auto-increment for ordering
  txId: text("tx_id").notNull(),                                 // generated credit transaction ID
  accountId: text("account_id").notNull(),                       // FK to finn_credit_accounts
  eventType: text("event_type").notNull(),                       // rektdrop_allocate | usdc_unlock | credit_reserve | ...
  debitState: text("debit_state").notNull(),                     // state losing credits
  creditState: text("credit_state").notNull(),                   // state receiving credits
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  correlationId: text("correlation_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  metadata: jsonb("metadata"),                                    // extra context
  timestamp: bigint("timestamp", { mode: "bigint" }).notNull(),  // Unix ms
}, (table) => [
  uniqueIndex("idx_credit_transactions_idempotency").on(table.idempotencyKey),
  index("idx_credit_transactions_account").on(table.accountId),
  index("idx_credit_transactions_tx_id").on(table.txId),
])

// --- finn_used_nonces ---
// Nonce replay protection for USDC unlock flow (Bridge high-1 + medium-5).
// TTL-based cleanup prevents unbounded growth.
export const finnUsedNonces = finnSchema.table("finn_used_nonces", {
  nonceKey: text("nonce_key").primaryKey(),                       // SHA-256 of auth params
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// --- finn_events ---
// Unified EventStore table (Sprint 1 T1.4, cycle-030 EventStore Abstraction).
// Backend-agnostic event storage — Postgres implementation of EventWriter/EventReader.
// Sequence is per-stream, monotonic, assigned atomically on INSERT.
export const finnEvents = finnSchema.table("finn_events", {
  eventId: text("event_id").primaryKey(),                           // ULID
  stream: text("stream").notNull(),                                 // branded EventStream name
  eventType: text("event_type").notNull(),                          // application-level event type
  sequence: bigint("sequence", { mode: "number" }).notNull(),       // monotonic per stream
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),     // Unix ms
  correlationId: text("correlation_id").notNull(),                   // trace correlation
  checksum: text("checksum").notNull(),                              // CRC32 of payload
  schemaVersion: integer("schema_version").notNull().default(1),     // envelope schema version
  payload: jsonb("payload").notNull(),                               // event data (T)
}, (table) => [
  uniqueIndex("idx_events_stream_sequence").on(table.stream, table.sequence),
  index("idx_events_stream_timestamp").on(table.stream, table.timestamp),
  index("idx_events_correlation").on(table.correlationId),
])
