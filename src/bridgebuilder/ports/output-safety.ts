// src/bridgebuilder/ports/output-safety.ts

export interface SanitizationResult {
  safe: boolean
  sanitizedContent: string
  redactedPatterns: string[] // descriptions of what was found (not the secrets themselves)
}

/**
 * Scans LLM output for sensitive content before posting to GitHub.
 * Defends against prompt injection attacks that coerce the model
 * to echo secrets from PR diffs.
 */
export interface IOutputSanitizer {
  /** Scan content for secret patterns. Returns sanitized version if unsafe. */
  sanitize(content: string): SanitizationResult
}
