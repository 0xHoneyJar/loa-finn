// src/hounfour/sidecar-client.ts — HTTP client for Cheval sidecar (SDD §4.3, T-1.4)

import { signRequest } from "./hmac.js"
import type { HmacConfig } from "./hmac.js"
import { ChevalError } from "./errors.js"
import type { ChevalErrorCode } from "./errors.js"
import type {
  CompletionRequest,
  CompletionResult,
  ChevalRequest,
  ProviderEntry,
  ResolvedModel,
  RetryPolicy,
  ModelCapabilities,
  HealthStatus,
  ModelPortBase,
} from "./types.js"
import { DEFAULT_RETRY_POLICY } from "./types.js"

// --- SidecarClient ---

export interface SidecarClientConfig {
  baseUrl: string                      // e.g., "http://127.0.0.1:3001"
  hmac: HmacConfig
  timeoutMs: number                    // Default: 300_000
}

/**
 * HTTP client for the Cheval sidecar.
 *
 * Signs requests with Phase 3 HMAC and sends them to the sidecar's /invoke endpoint.
 * Uses native fetch (Node 18+) — no external HTTP dependency on the TypeScript side.
 */
export class SidecarClient {
  private config: SidecarClientConfig

  constructor(config: Partial<SidecarClientConfig> & { baseUrl: string; hmac: HmacConfig }) {
    this.config = {
      baseUrl: config.baseUrl,
      hmac: config.hmac,
      timeoutMs: config.timeoutMs ?? 300_000,
    }
  }

  /**
   * Send a ChevalRequest to the sidecar's /invoke endpoint.
   *
   * 1. Serialize request to JSON
   * 2. Sign with Phase 3 HMAC (method + path bound)
   * 3. POST to sidecar with HMAC headers
   * 4. Parse CompletionResult from response
   */
  async invoke(request: ChevalRequest): Promise<CompletionResult> {
    const url = `${this.config.baseUrl}/invoke`
    const body = JSON.stringify(request)

    const hmacHeaders = signRequest(
      "POST",
      "/invoke",
      body,
      request.metadata.trace_id,
      this.config.hmac.secret,
    )

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...hmacHeaders,
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = JSON.parse(errorBody)
      } catch {
        // Not JSON
      }

      if (parsed && parsed.error === "ChevalError") {
        throw new ChevalError({
          code: (parsed.code as ChevalErrorCode) ?? "cheval_crash",
          message: (parsed.message as string) ?? "Unknown sidecar error",
          providerCode: parsed.provider_code as string | undefined,
          statusCode: parsed.status_code as number | undefined,
          retryable: (parsed.retryable as boolean) ?? false,
        })
      }

      throw new ChevalError({
        code: response.status === 502 ? "network_error" : "provider_error",
        message: `Sidecar HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        statusCode: response.status,
        retryable: response.status >= 500,
      })
    }

    const result = await response.json() as CompletionResult
    return result
  }

  /** Health check — GET /healthz */
  async healthCheck(): Promise<{ status: string; uptime_s: number }> {
    const response = await fetch(`${this.config.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      throw new Error(`Sidecar healthz returned ${response.status}`)
    }
    return response.json() as Promise<{ status: string; uptime_s: number }>
  }

  /** Readiness check — GET /readyz */
  async readyCheck(): Promise<{ status: string }> {
    const response = await fetch(`${this.config.baseUrl}/readyz`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      throw new Error(`Sidecar readyz returned ${response.status}`)
    }
    return response.json() as Promise<{ status: string }>
  }
}

// --- SidecarModelAdapter ---

/**
 * ModelPortBase adapter that routes through the Cheval sidecar.
 *
 * Replaces ChevalModelAdapter (subprocess) with HTTP-based communication.
 * Retry logic is handled by the sidecar — this adapter does a single invoke.
 */
export class SidecarModelAdapter implements ModelPortBase {
  constructor(
    private client: SidecarClient,
    private resolvedModel: ResolvedModel,
    private providerConfig: ProviderEntry,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const chevalReq = this.buildChevalRequest(request)
    return this.client.invoke(chevalReq)
  }

  capabilities(): ModelCapabilities {
    const model = this.providerConfig.models.get(this.resolvedModel.modelId)
    if (!model) {
      throw new Error(
        `Model ${this.resolvedModel.modelId} not found in provider ${this.resolvedModel.provider}`,
      )
    }
    return model.capabilities
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const result = await this.client.healthCheck()
      return { healthy: result.status === "alive", latency_ms: 0 }
    } catch {
      return { healthy: false, latency_ms: 0 }
    }
  }

  private buildChevalRequest(request: CompletionRequest): ChevalRequest {
    const options = this.providerConfig.options
    const retryPolicy = this.providerConfig.retryPolicy ?? DEFAULT_RETRY_POLICY

    return {
      schema_version: 1,
      provider: {
        name: this.providerConfig.name,
        type: this.providerConfig.type as "openai" | "openai-compatible",
        base_url: options?.baseURL ?? "",
        api_key: options?.apiKey ?? "",
        connect_timeout_ms: options?.connectTimeoutMs ?? 5000,
        read_timeout_ms: options?.readTimeoutMs ?? 60000,
        total_timeout_ms: options?.totalTimeoutMs ?? 300000,
      },
      model: this.resolvedModel.modelId,
      messages: request.messages,
      tools: request.tools,
      options: request.options,
      metadata: request.metadata,
      retry: {
        max_retries: retryPolicy.maxRetries,
        base_delay_ms: retryPolicy.baseDelayMs,
        max_delay_ms: retryPolicy.maxDelayMs,
        jitter_percent: retryPolicy.jitterPercent,
        retryable_status_codes: retryPolicy.retryableStatusCodes,
      },
      hmac: { signature: "", nonce: "", issued_at: "" }, // Filled by SidecarClient
    }
  }
}
