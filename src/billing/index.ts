// src/billing/index.ts — Billing Module Exports (Sprint 1 Task 1.6)

// Core types
export {
  BillingState,
  BillingStateError,
  BILLING_WAL_SCHEMA_VERSION,
  BILLING_EVENT_TYPES,
  VALID_TRANSITIONS,
  parseBillingEntryId,
} from "./types.js"

export type {
  BillingEntry,
  BillingEntryId,
  BillingEventType,
  BillingWALEnvelope,
  BillingReservePayload,
  BillingCommitPayload,
  BillingReleasePayload,
  BillingVoidPayload,
  BillingFinalizeAckPayload,
  BillingFinalizeFailPayload,
  ExchangeRateSnapshot,
} from "./types.js"

// State machine
export { BillingStateMachine, crc32, createBillingWALEnvelope } from "./state-machine.js"
export type { BillingStateMachineDeps } from "./state-machine.js"

// Double-entry ledger
export {
  Ledger,
  LedgerError,
  creditMintPostings,
  billingReservePostings,
  billingCommitPostings,
  billingReleasePostings,
  billingVoidPostings,
  x402CreditNotePostings,
  userAvailableAccount,
  userHeldAccount,
  SYSTEM_REVENUE,
  SYSTEM_RESERVES,
  TREASURY_USDC_RECEIVED,
  SYSTEM_CREDIT_NOTES,
} from "./ledger.js"
export type { Posting, JournalEntry } from "./ledger.js"

// DLQ
export {
  DLQProcessor,
  DLQ_STREAM,
  DLQ_POISON_STREAM,
  DLQ_CONSUMER_GROUP,
  PENDING_COUNT_KEY,
  RESERVE_TTL_SECONDS as DLQ_RESERVE_TTL_SECONDS,
  MAX_DLQ_RETRIES,
  BACKOFF_SCHEDULE_MS as DLQ_BACKOFF_SCHEDULE_MS,
  ESCALATION_WINDOW_MS,
  MAX_PENDING_RISK_LIMIT_CU,
} from "./dlq.js"
export type { DLQEntry, DLQProcessorDeps, DLQReplayResult } from "./dlq.js"

// Circuit breaker
export {
  BillingCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "./circuit-breaker.js"
export type { CircuitState, CircuitBreakerConfig, CircuitBreakerMetrics } from "./circuit-breaker.js"

// WAL replay
export { replayBillingWAL, isSegmentOversized } from "./wal-replay.js"
export type { WALReplayResult, WALReplayDeps } from "./wal-replay.js"

// Reserve Lua scripts
export {
  atomicReserve,
  atomicRelease,
  atomicCommit,
  RESERVE_TTL_SECONDS,
} from "./reserve-lua.js"
export type { ReserveResult } from "./reserve-lua.js"

// Billing metrics
export { ConsoleBillingMetrics, noopBillingMetrics } from "./metrics.js"
export type { BillingMetrics } from "./metrics.js"
