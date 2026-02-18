// src/hounfour/types.ts — Hounfour shared types (SDD §4.2, T-14.4)
// All interfaces for the multi-model provider abstraction layer.
//
// Canonical branded types re-exported from @0xhoneyjar/loa-hounfour (v7.0.0).
// Use wire-boundary.ts parse functions to construct branded values.

export type { MicroUSD, BasisPoints, AccountId } from "@0xhoneyjar/loa-hounfour"
export type { PoolId } from "@0xhoneyjar/loa-hounfour"

// --- Provider & Model ---

export interface ProviderEntry {
  name: string                          // e.g., "openai"
  type: "claude-code" | "openai" | "openai-compatible"
  options: ProviderOptions
  models: Map<string, ModelEntry>
  retryPolicy?: RetryPolicy
}

export interface ProviderOptions {
  baseURL?: string                      // Includes /v1
  apiKey?: string                       // Resolved from {env:VAR}
  connectTimeoutMs?: number             // Default: 5000
  readTimeoutMs?: number                // Default: 60000
  totalTimeoutMs?: number               // Default: 300000
}

export interface ModelEntry {
  id: string                            // e.g., "gpt-4o"
  name: string                          // Display name
  capabilities: ModelCapabilities
  limit: { context: number; output: number }
  defaults?: { temperature?: number; top_p?: number }
}

export interface ModelCapabilities {
  tool_calling: boolean
  thinking_traces: boolean
  vision: boolean
  streaming: boolean
}

export interface RetryPolicy {
  maxRetries: number                    // Default: 3
  baseDelayMs: number                   // Default: 1000
  maxDelayMs: number                    // Default: 30000
  jitterPercent: number                 // Default: 25
  retryableStatusCodes: number[]        // Default: [429, 500, 502, 503, 504]
  retryableErrors: string[]             // Default: ["timeout", "network_error"]
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterPercent: 25,
  retryableStatusCodes: [429, 500, 502, 503, 504],
  retryableErrors: ["timeout", "network_error"],
}

// --- Agent Binding ---

export interface AgentBinding {
  agent: string                         // e.g., "reviewing-code"
  model: string                         // Alias or canonical "provider:model"
  temperature?: number
  persona?: string                      // Path to persona.md
  requires: AgentRequirements
  knowledge?: KnowledgeConfig           // Oracle knowledge enrichment config
}

/** Per-agent knowledge configuration (re-exported from knowledge-types) */
export interface KnowledgeConfig {
  enabled: boolean
  sources: string[]                     // Source IDs or ["*"] for all
  maxTokensBudgetRatio: number          // Default 0.15
}

export interface AgentRequirements {
  native_runtime?: boolean
  tool_calling?: boolean | "optional"
  thinking_traces?: "required" | "optional" | false
  min_context_window?: number            // Minimum context window for oracle enrichment
}

// --- Resolved Model ---

export interface ResolvedModel {
  provider: string                      // e.g., "openai"
  modelId: string                       // e.g., "gpt-4o"
}

// --- Completion Request/Result ---

export interface CompletionRequest {
  messages: CanonicalMessage[]
  tools?: ToolDefinition[]
  options: CompletionOptions
  metadata: RequestMetadata
}

export interface CompletionOptions {
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string[]
  tool_choice?: "auto" | "required" | "none"
}

export interface RequestMetadata {
  agent: string
  tenant_id: string                     // "local" for Phase 0-2
  nft_id: string                        // "" for Phase 0-3
  trace_id: string                      // UUID per request
  reservation_id?: string               // billing reservation from arrakis JWT (Phase 5)
}

export interface CompletionResult {
  content: string
  thinking: string | null               // null for non-thinking models (never fabricated)
  tool_calls: ToolCall[] | null
  usage: UsageInfo
  metadata: ResultMetadata
}

export interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number              // 0 if unavailable
}

export interface ResultMetadata {
  model: string
  provider_request_id?: string
  latency_ms: number
  trace_id: string
  /** Billing finalize result — set when finalize was attempted (Sprint B T4) */
  billing_finalize_status?: "finalized" | "idempotent" | "dlq"
  /** Billing trace ID — echoes the trace_id used in finalize call */
  billing_trace_id?: string
  /** Total cost in micro-USD (string-serialized BigInt) — set after cost recording */
  cost_micro?: string
  /** Oracle knowledge enrichment metadata — set when enrichment was applied */
  knowledge?: EnrichmentMetadata
}

/** Metadata about the knowledge enrichment process (re-exported from knowledge-types) */
export interface EnrichmentMetadata {
  sources_used: string[]
  tokens_used: number
  budget: number
  mode: "full" | "reduced" | "none"
  tags_matched: string[]
  classification: string[]
}

// --- Tool Call ---

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string                   // Always JSON string
  }
}

export interface ToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>  // JSON Schema
  }
}

// --- Canonical Message ---

export type MessageRole = "system" | "user" | "assistant" | "tool"

export interface CanonicalMessage {
  role: MessageRole
  content: string | null                // null on tool-call turns
  tool_calls?: ToolCall[]               // Present when assistant requests tool calls
  tool_call_id?: string                 // Present for tool result messages
  name?: string                         // Tool name for tool result messages
}

// --- Execution Context ---

export interface ScopeMeta {
  project_id: string
  phase_id: string
  sprint_id: string
}

export interface ExecutionContext {
  resolved: ResolvedModel
  scopeMeta: ScopeMeta
  binding: AgentBinding
  pricing: PricingEntry
}

/**
 * Runtime validation for ExecutionContext (SKP-002).
 * Throws if any required field is empty/undefined.
 * MUST run before: budget operations, health recording, ledger append.
 */
export function validateExecutionContext(ctx: ExecutionContext): void {
  if (!ctx.resolved?.provider || !ctx.resolved?.modelId) {
    throw new Error("ExecutionContext.resolved is incomplete")
  }
  if (!ctx.scopeMeta?.project_id || !ctx.scopeMeta?.phase_id || !ctx.scopeMeta?.sprint_id) {
    throw new Error("ExecutionContext.scopeMeta is incomplete")
  }
  if (!ctx.binding) {
    throw new Error("ExecutionContext.binding is missing")
  }
  if (!ctx.pricing) {
    throw new Error("ExecutionContext.pricing is missing")
  }
}

// --- Pricing ---

export interface PricingEntry {
  provider: string
  model: string
  input_per_1m: number                  // USD per 1M input tokens
  output_per_1m: number                 // USD per 1M output tokens
  reasoning_per_1m?: number             // USD per 1M reasoning tokens (if applicable)
}

// --- Health ---

export interface HealthStatus {
  healthy: boolean
  latency_ms: number
}

export interface ProviderHealthSnapshot {
  providers: Record<string, {
    healthy: boolean
    models: Record<string, { healthy: boolean; latency_ms: number }>
  }>
}

// --- Model Port ---

export interface ModelPortBase {
  complete(request: CompletionRequest): Promise<CompletionResult>
  capabilities(): ModelCapabilities
  healthCheck(): Promise<HealthStatus>
}

// --- Budget ---

export interface BudgetSnapshot {
  scope: string
  spent_usd: number
  limit_usd: number
  percent_used: number
  warning: boolean
  exceeded: boolean
}

// --- Ledger Entry (16 fields per SDD §5.2) ---

export interface LedgerEntry {
  timestamp: string                     // ISO 8601
  trace_id: string
  agent: string
  provider: string
  model: string
  project_id: string
  phase_id: string
  sprint_id: string
  tenant_id: string
  nft_id?: string                       // Per-NFT cost attribution (Phase 5)
  pool_id?: string                      // Pool used for routing (Phase 5)
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
  input_cost_usd: number
  output_cost_usd: number
  total_cost_usd: number
  latency_ms: number
  ensemble_id?: string                  // Shared across ensemble model invocations
}

// --- Ledger Entry V2 (integer micro-USD, string serialization) ---

export interface LedgerEntryV2 {
  schema_version: 2
  timestamp: string                     // ISO 8601
  trace_id: string
  agent: string
  provider: string
  model: string
  project_id: string
  phase_id: string
  sprint_id: string
  tenant_id: string
  nft_id?: string
  pool_id?: string
  ensemble_id?: string
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
  input_cost_micro: string              // String-serialized BigInt micro-USD
  output_cost_micro: string             // String-serialized BigInt micro-USD
  reasoning_cost_micro: string          // String-serialized BigInt micro-USD
  total_cost_micro: string              // String-serialized BigInt micro-USD
  price_table_version: number
  billing_method: "provider_reported" | "byte_estimated" | "observed_chunks_overcount" | "prompt_only" | "reconciled"
  crc32?: string                        // CRC32 of the entry (corruption detection)
  latency_ms: number
}

// --- Budget Snapshot V2 (integer micro-USD) ---

export interface BudgetSnapshotMicro {
  scope: string
  spent_micro: string                   // String-serialized BigInt micro-USD
  limit_micro: string                   // String-serialized BigInt micro-USD
  percent_used: number
  warning: boolean
  exceeded: boolean
}

// --- Routing Config ---

export interface RoutingConfig {
  default_model: string
  on_budget_exceeded: "block" | "downgrade"
  fallback: Record<string, string[]>    // canonical → [fallback candidates]
  downgrade: Record<string, string[]>   // canonical → [downgrade candidates]
  disabled_providers: string[]
  health: HealthProbeConfig
}

export interface HealthProbeConfig {
  interval_ms: number                   // Default: 60000
  timeout_ms: number                    // Default: 5000
  failure_threshold: number             // Default: 3
  recovery_interval_ms: number          // Default: 30000
}

// --- Cheval Request (machine mode) ---

export interface ChevalRequest {
  schema_version: 1
  provider: {
    name: string
    type: "openai" | "openai-compatible"
    base_url: string
    api_key: string
    connect_timeout_ms: number
    read_timeout_ms: number
    total_timeout_ms: number
  }
  model: string
  messages: CanonicalMessage[]
  tools?: ToolDefinition[]
  options: CompletionOptions
  metadata: RequestMetadata
  retry: {
    max_retries: number
    base_delay_ms: number
    max_delay_ms: number
    jitter_percent: number
    retryable_status_codes: number[]
  }
  hmac: {
    signature: string
    nonce: string
    issued_at: string                   // ISO 8601
  }
}

// --- Validation Result ---

export interface ValidationResult {
  valid: boolean
  agent: string
  model: string
  errors: string[]
}

// --- Resolved Execution ---

export interface ResolvedExecution {
  mode: "native_runtime" | "remote_model"
  model: ResolvedModel
  provider: ProviderEntry
}

// --- Invoke Options ---

export interface InvokeOptions {
  scopeMeta?: ScopeMeta
  temperature?: number
  max_tokens?: number
}

// --- Tool-Call Loop Config ---

export interface ToolCallConfig {
  maxIterations: number                 // Default: 20
  abortOnConsecutiveFailures: number    // Default: 3
  maxWallTimeMs: number                 // Default: 120000
  maxTotalToolCalls: number             // Default: 50
}

export const DEFAULT_TOOL_CALL_CONFIG: ToolCallConfig = {
  maxIterations: 20,
  abortOnConsecutiveFailures: 3,
  maxWallTimeMs: 120_000,
  maxTotalToolCalls: 50,
}

// --- Streaming (Phase 3 Sprint 2, SDD §4.4) ---

export interface ModelPortStreaming extends ModelPortBase {
  stream(request: CompletionRequest, options?: { signal?: AbortSignal }): AsyncGenerator<StreamChunk>
}

export type ModelPort = ModelPortBase | ModelPortStreaming

export function isStreamingPort(port: ModelPort): port is ModelPortStreaming {
  return "stream" in port && typeof (port as ModelPortStreaming).stream === "function"
}

export type StreamEventType = "chunk" | "tool_call" | "usage" | "done" | "error"

export type StreamChunk =
  | { event: "chunk"; data: StreamChunkData }
  | { event: "tool_call"; data: StreamToolCallData }
  | { event: "usage"; data: StreamUsageData }
  | { event: "done"; data: StreamDoneData }
  | { event: "error"; data: StreamErrorData }

export interface StreamChunkData {
  delta: string
  tool_calls: null
}

export interface StreamToolCallData {
  index: number
  id?: string
  function: {
    name?: string
    arguments: string
  }
}

export interface StreamUsageData {
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
}

export interface StreamDoneData {
  finish_reason: "stop" | "tool_calls" | "length"
}

export interface StreamErrorData {
  code: string
  message: string
}
