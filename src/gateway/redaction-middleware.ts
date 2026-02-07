// src/gateway/redaction-middleware.ts — Secret Redaction for API Responses (TASK-6.8)
//
// Framework-agnostic ResponseRedactor that deep-redacts sensitive fields from
// response objects. Composes SecretRedactor (TASK-3.4) for token pattern matching
// and adds field-name-based redaction on top.

import { SecretRedactor } from "../safety/secret-redactor.js"

export interface RedactionConfig {
  /** Field name patterns that trigger redaction (case-insensitive) */
  sensitiveFieldPatterns?: RegExp
  /** Replacement string for redacted fields */
  replacement?: string
}

const DEFAULT_FIELD_PATTERN = /secret|token|password|key|credential|authorization/i
const DEFAULT_REPLACEMENT = "[REDACTED]"

export class ResponseRedactor {
  private fieldPattern: RegExp
  private replacement: string
  private secretRedactor: SecretRedactor

  constructor(config?: RedactionConfig, secretRedactor?: SecretRedactor) {
    this.fieldPattern = config?.sensitiveFieldPatterns ?? DEFAULT_FIELD_PATTERN
    this.replacement = config?.replacement ?? DEFAULT_REPLACEMENT
    this.secretRedactor = secretRedactor ?? new SecretRedactor()
  }

  /** Deep-redact an object, returning a new redacted copy (never mutates the original) */
  redact<T>(obj: T): T {
    return this.walk(obj) as T
  }

  private walk(value: unknown, fieldName?: string): unknown {
    // Null / undefined / boolean / number pass through
    if (value === null || value === undefined) return value
    if (typeof value === "boolean" || typeof value === "number") return value

    // If the parent field name matched a sensitive pattern, replace the whole value
    if (fieldName && this.fieldPattern.test(fieldName)) return this.replacement

    // Strings: scan for embedded token patterns via SecretRedactor
    if (typeof value === "string") return this.secretRedactor.redact(value)

    // Arrays: map each element
    if (Array.isArray(value)) return value.map((el) => this.walk(el))

    // Plain objects: recurse key-by-key
    if (typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Skip prototype pollution vectors
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue
        out[k] = this.walk(v, k)
      }
      return out
    }

    return value
  }
}
