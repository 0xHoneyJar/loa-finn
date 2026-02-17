// src/hounfour/errors.ts — Hounfour typed error classes (SDD §4.2, T-14.4)

/** Error codes for Hounfour operations */
export type HounfourErrorCode =
  | "NATIVE_RUNTIME_REQUIRED"
  | "PROVIDER_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "METERING_UNAVAILABLE"
  | "CAPABILITY_MISMATCH"
  | "CONFIG_INVALID"
  | "BINDING_INVALID"
  | "STREAMING_NOT_SUPPORTED"
  | "TOOL_CALL_MAX_ITERATIONS"
  | "TOOL_CALL_CONSECUTIVE_FAILURES"
  | "TOOL_CALL_WALL_TIME_EXCEEDED"
  | "TOOL_CALL_LIMIT_EXCEEDED"
  | "TOOL_CALL_VALIDATION_FAILED"
  | "STREAM_ERROR"
  | "CONTEXT_OVERFLOW"
  | "EXECUTION_CONTEXT_INVALID"
  | "PERSONA_INJECTION"
  | "RATE_LIMITED"
  | "TIER_UNAUTHORIZED"
  | "UNKNOWN_POOL"
  | "POOL_ACCESS_DENIED"
  | "BYOK_PROXY_UNAVAILABLE"
  | "BUDGET_CIRCUIT_OPEN"
  | "JTI_REPLAY_DETECTED"
  | "ORACLE_MODEL_UNAVAILABLE"
  | "ORACLE_KNOWLEDGE_UNAVAILABLE"
  | "KNOWLEDGE_INJECTION"

/** Typed error for all Hounfour operations */
export class HounfourError extends Error {
  readonly name = "HounfourError"
  readonly code: HounfourErrorCode
  readonly context: Record<string, unknown>

  constructor(code: HounfourErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(`[hounfour] ${code}: ${message}`)
    this.code = code
    this.context = context
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    }
  }
}

/** Error codes for Cheval subprocess operations */
export type ChevalErrorCode =
  | "cheval_timeout"
  | "cheval_crash"
  | "cheval_invalid_response"
  | "provider_error"
  | "auth_error"
  | "rate_limited"
  | "network_error"
  | "hmac_invalid"

/**
 * Error from cheval.py subprocess.
 * Maps to exit codes 1-5 per SDD §6.1.1.
 */
export class ChevalError extends Error {
  readonly name = "ChevalError"
  readonly code: ChevalErrorCode
  readonly providerCode?: string
  readonly statusCode?: number
  readonly retryable: boolean

  constructor(opts: {
    code: ChevalErrorCode
    message: string
    providerCode?: string
    statusCode?: number
    retryable?: boolean
  }) {
    super(`[cheval] ${opts.code}: ${opts.message}`)
    this.code = opts.code
    this.providerCode = opts.providerCode
    this.statusCode = opts.statusCode
    this.retryable = opts.retryable ?? false
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      provider_code: this.providerCode,
      status_code: this.statusCode,
      retryable: this.retryable,
    }
  }
}

/**
 * Parse cheval.py exit code into a ChevalError.
 * Exit codes per SDD §6.1.1:
 *   0 = success
 *   1 = provider returned error (4xx/5xx)
 *   2 = network/timeout error
 *   3 = HMAC validation failed
 *   4 = invalid request (schema violation)
 *   5 = internal cheval error
 */
export function chevalExitCodeToError(exitCode: number, stderr: string): ChevalError {
  switch (exitCode) {
    case 1:
      return new ChevalError({
        code: "provider_error",
        message: stderr || "Provider returned an error",
        retryable: false,
      })
    case 2:
      return new ChevalError({
        code: "network_error",
        message: stderr || "Network or timeout error",
        retryable: true,
      })
    case 3:
      return new ChevalError({
        code: "hmac_invalid",
        message: stderr || "HMAC validation failed",
        retryable: false,
      })
    case 4:
      return new ChevalError({
        code: "cheval_invalid_response",
        message: stderr || "Invalid request schema",
        retryable: false,
      })
    case 5:
      return new ChevalError({
        code: "cheval_crash",
        message: stderr || "Internal cheval error",
        retryable: false,
      })
    default:
      return new ChevalError({
        code: "cheval_crash",
        message: `Unexpected exit code ${exitCode}: ${stderr}`,
        retryable: false,
      })
  }
}
