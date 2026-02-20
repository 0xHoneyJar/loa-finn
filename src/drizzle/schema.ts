// src/drizzle/schema.ts — Finn database schema (Sprint 1 T1.3, SDD §6)
// All tables live in the `finn` schema, isolated from other services.

import { pgSchema, text, timestamp, bigint, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core"

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
