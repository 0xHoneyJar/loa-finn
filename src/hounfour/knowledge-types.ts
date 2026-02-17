// src/hounfour/knowledge-types.ts — Knowledge subsystem types (SDD §3.1)
// All interfaces for the Oracle knowledge enrichment pipeline.

// --- Knowledge Source ---

/** Configuration for a single knowledge source in sources.json */
export interface KnowledgeSource {
  id: string
  type: "local"
  path: string
  format: "markdown"
  tags: string[]
  priority: number                      // Higher = loaded first
  maxTokens: number                     // Per-source token cap
  required: boolean                     // Fail if missing
  max_age_days?: number                 // Staleness threshold
}

/** A knowledge source after loading from disk */
export interface LoadedKnowledgeSource {
  source: KnowledgeSource
  content: string
  tokenCount: number
  loadedAt: Date
  stale: boolean                        // true when max_age_days exceeded
}

// --- Agent Knowledge Config ---

/** Per-agent knowledge configuration (stored on AgentBinding) */
export interface KnowledgeConfig {
  enabled: boolean
  sources: string[]                     // Source IDs or ["*"] for all
  maxTokensBudgetRatio: number          // Default 0.15
}

// --- Enrichment ---

/** Result of knowledge enrichment */
export interface EnrichmentResult {
  enrichedPrompt: string
  metadata: EnrichmentMetadata
}

/** Metadata about the enrichment process */
export interface EnrichmentMetadata {
  sources_used: string[]                // IDs of sources included
  tokens_used: number                   // Total tokens injected
  budget: number                        // Token budget for this enrichment
  mode: "full" | "reduced" | "none"     // Enrichment mode selected
  tags_matched: string[]                // Tags that matched the query
  classification: string[]              // Query classification labels
}

// --- Sources Config ---

/** Top-level sources.json configuration schema */
export interface KnowledgeSourcesConfig {
  version: number
  default_budget_tokens: number
  sources: KnowledgeSource[]
  glossary_terms?: Record<string, string[]>  // Term -> tag expansions
}
