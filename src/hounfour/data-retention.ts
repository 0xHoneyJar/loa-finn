// src/hounfour/data-retention.ts — Data Retention & Redaction (SDD §8, T-3.7)

// --- Config ---

export interface RetentionConfig {
  prompts: boolean                    // Default: false
  responses: boolean                  // Default: false
  thinking_traces: boolean            // Default: false
  redaction_patterns: string[]        // Regex patterns to redact
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  prompts: false,
  responses: false,
  thinking_traces: false,
  redaction_patterns: [],
}

// --- Per-Provider/Agent Config ---

export interface RetentionOverride {
  provider?: string
  agent?: string
  config: Partial<RetentionConfig>
}

// --- Redaction Engine ---

export class DataRedactor {
  private patterns: RegExp[]
  private config: RetentionConfig

  constructor(config: RetentionConfig) {
    this.config = config
    this.patterns = config.redaction_patterns.map(p => {
      try {
        return new RegExp(p, "g")
      } catch {
        console.warn(`[data-retention] Invalid redaction pattern: ${p}`)
        return null
      }
    }).filter((p): p is RegExp => p !== null)
  }

  /**
   * Apply redaction patterns to text content.
   * Returns redacted text with matches replaced by [REDACTED].
   */
  redact(text: string): string {
    if (this.patterns.length === 0) return text

    let result = text
    for (const pattern of this.patterns) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0
      result = result.replace(pattern, "[REDACTED]")
    }
    return result
  }

  /**
   * Filter a ledger entry based on retention config.
   * Returns a copy with non-retained fields stripped.
   */
  filterLedgerEntry(entry: Record<string, unknown>): Record<string, unknown> {
    const filtered = { ...entry }

    // Always retain: timestamp, trace_id, agent, provider, model, cost fields, scope fields
    // Conditionally retain: prompt content, response content, thinking traces

    if (!this.config.prompts) {
      delete filtered.prompt_content
      delete filtered.messages
    }

    if (!this.config.responses) {
      delete filtered.response_content
      delete filtered.completion_content
    }

    if (!this.config.thinking_traces) {
      delete filtered.thinking
      delete filtered.reasoning_content
    }

    // Apply deep redaction to all string fields (including nested objects/arrays)
    return this.deepRedact(filtered) as Record<string, unknown>
  }

  /** Recursively redact all string values in nested objects/arrays. */
  private deepRedact(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value)
    if (Array.isArray(value)) return value.map(v => this.deepRedact(v))
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) {
        out[k] = this.deepRedact(v)
      }
      return out
    }
    return value
  }

  /** Whether any content is retained (prompts, responses, or traces) */
  retainsContent(): boolean {
    return this.config.prompts || this.config.responses || this.config.thinking_traces
  }
}

// --- Factory ---

/**
 * Resolve retention config for a specific provider/agent combination.
 * Specificity order: agent override > provider override > global default.
 */
export function resolveRetentionConfig(
  globalConfig: RetentionConfig,
  overrides: RetentionOverride[],
  provider?: string,
  agent?: string,
): RetentionConfig {
  let config = { ...globalConfig }

  // Apply provider override
  const providerOverride = overrides.find(
    o => o.provider === provider && !o.agent,
  )
  if (providerOverride) {
    config = { ...config, ...providerOverride.config }
  }

  // Apply agent override (higher specificity — prefer agent+provider match)
  const agentOverride =
    overrides.find(o => o.agent === agent && o.provider === provider) ??
    overrides.find(o => o.agent === agent && !o.provider)
  if (agentOverride) {
    config = { ...config, ...agentOverride.config }
  }

  return config
}
