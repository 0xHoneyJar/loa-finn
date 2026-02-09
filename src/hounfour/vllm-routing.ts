// src/hounfour/vllm-routing.ts — vLLM Fallback Routing (SDD §4.11, T-3.2)
// Health-based downgrade: 7B circuit OPEN → route to 1.5B automatically.

import type { FullHealthProber } from "./health.js"
import type { ResolvedModel, ProviderEntry, ModelEntry, ModelCapabilities } from "./types.js"

// --- Config ---

export interface VllmRoutingConfig {
  primaryEndpoint: string         // Default: http://vllm-7b:8000/v1
  fallbackEndpoint: string        // Default: http://vllm-1.5b:8001/v1
  primaryModel: string            // Default: Qwen/Qwen2.5-Coder-7B-Instruct
  fallbackModel: string           // Default: Qwen/Qwen2.5-Coder-1.5B-Instruct
}

export const DEFAULT_VLLM_CONFIG: VllmRoutingConfig = {
  primaryEndpoint: process.env.VLLM_PRIMARY_ENDPOINT ?? "http://vllm-7b:8000/v1",
  fallbackEndpoint: process.env.VLLM_FALLBACK_ENDPOINT ?? "http://vllm-1.5b:8001/v1",
  primaryModel: "Qwen/Qwen2.5-Coder-7B-Instruct",
  fallbackModel: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
}

// --- Provider Name ---

export const VLLM_PROVIDER_NAME = "local-vllm"

// --- vLLM Provider Entry Factory ---

/**
 * Build a ProviderEntry for the local-vllm provider with 7B and 1.5B models.
 */
export function buildVllmProviderEntry(config: VllmRoutingConfig): ProviderEntry {
  const models = new Map<string, ModelEntry>()

  models.set("qwen-7b", {
    id: "qwen-7b",
    name: "Qwen2.5-Coder-7B-Instruct (AWQ)",
    capabilities: {
      tool_calling: true,
      thinking_traces: false,
      vision: false,
      streaming: true,
    },
    limit: { context: 32768, output: 8192 },
    defaults: { temperature: 0.1 },
  })

  models.set("qwen-1.5b", {
    id: "qwen-1.5b",
    name: "Qwen2.5-Coder-1.5B-Instruct (FP16)",
    capabilities: {
      tool_calling: true,
      thinking_traces: false,
      vision: false,
      streaming: true,
    },
    limit: { context: 32768, output: 4096 },
    defaults: { temperature: 0.1 },
  })

  return {
    name: VLLM_PROVIDER_NAME,
    type: "openai-compatible",
    options: {
      baseURL: config.primaryEndpoint,
      connectTimeoutMs: 5000,
      readTimeoutMs: 120_000,
      totalTimeoutMs: 300_000,
    },
    models,
  }
}

// --- Fallback Router ---

/**
 * Resolves the best available vLLM model based on circuit breaker health.
 * Priority: qwen-7b (primary) → qwen-1.5b (fallback).
 */
export class VllmFallbackRouter {
  constructor(
    private config: VllmRoutingConfig,
    private health: FullHealthProber,
  ) {}

  /**
   * Resolve which vLLM model+endpoint to use based on health.
   * Returns the resolved model and the appropriate base URL.
   */
  resolve(): { resolved: ResolvedModel; baseUrl: string } | null {
    const primary: ResolvedModel = { provider: VLLM_PROVIDER_NAME, modelId: "qwen-7b" }
    const fallback: ResolvedModel = { provider: VLLM_PROVIDER_NAME, modelId: "qwen-1.5b" }

    // Try primary (7B) first
    if (this.health.isHealthy(primary)) {
      return {
        resolved: primary,
        baseUrl: this.config.primaryEndpoint,
      }
    }

    // Fallback to 1.5B
    if (this.health.isHealthy(fallback)) {
      console.warn("[vllm-routing] Primary qwen-7b unhealthy, falling back to qwen-1.5b")
      return {
        resolved: fallback,
        baseUrl: this.config.fallbackEndpoint,
      }
    }

    // Both unhealthy
    console.error("[vllm-routing] All vLLM models unhealthy, no route available")
    return null
  }

  /** Get the real model ID for the vLLM API (not our short alias) */
  getApiModelId(modelId: string): string {
    if (modelId === "qwen-7b") return this.config.primaryModel
    if (modelId === "qwen-1.5b") return this.config.fallbackModel
    return modelId
  }

  /** Get base URL for a specific model alias */
  getBaseUrl(modelId: string): string {
    if (modelId === "qwen-1.5b") return this.config.fallbackEndpoint
    return this.config.primaryEndpoint
  }
}
