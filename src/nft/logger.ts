// src/nft/logger.ts — Structured Identity Logger (Sprint 16 Task 16.2)
//
// Simple structured JSON logger for identity pipeline operations.
// Outputs timestamped JSON lines to console for observability.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical identity pipeline operations */
export type IdentityOperation =
  | "signal_build"
  | "damp_derive"
  | "graph_resolve"
  | "synthesis"
  | "version_create"
  | "ownership_check"

/** Structured log entry shape */
export interface IdentityLogEntry {
  timestamp: string
  operation: IdentityOperation
  personality_id: string
  latency_ms?: number
  [key: string]: unknown
}

/** Structured error log entry shape */
export interface IdentityErrorLogEntry {
  timestamp: string
  operation: IdentityOperation
  personality_id: string
  error: string
  error_name?: string
  [key: string]: unknown
}

/** Logger interface for identity pipeline observability */
export interface IdentityLogger {
  /** Log an identity pipeline operation with optional metadata and latency */
  log(
    operation: IdentityOperation,
    personalityId: string,
    metadata?: Record<string, unknown>,
    latencyMs?: number,
  ): void

  /** Log an error during an identity pipeline operation */
  logError(
    operation: IdentityOperation,
    personalityId: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ): void
}

// ---------------------------------------------------------------------------
// Default Implementation
// ---------------------------------------------------------------------------

class ConsoleIdentityLogger implements IdentityLogger {
  log(
    operation: IdentityOperation,
    personalityId: string,
    metadata?: Record<string, unknown>,
    latencyMs?: number,
  ): void {
    const entry: IdentityLogEntry = {
      timestamp: new Date().toISOString(),
      operation,
      personality_id: personalityId,
      ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
      ...(metadata ?? {}),
    }
    console.log(JSON.stringify(entry))
  }

  logError(
    operation: IdentityOperation,
    personalityId: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ): void {
    const entry: IdentityErrorLogEntry = {
      timestamp: new Date().toISOString(),
      operation,
      personality_id: personalityId,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error ? { error_name: error.name } : {}),
      ...(metadata ?? {}),
    }
    console.log(JSON.stringify(entry))
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an IdentityLogger instance.
 * Default implementation writes JSON lines to console.log.
 */
export function createIdentityLogger(): IdentityLogger {
  return new ConsoleIdentityLogger()
}
