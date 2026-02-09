// src/hounfour/byok-proxy-client.ts — BYOK Proxy ModelPort Adapter (SDD §3.9, T-C.2)
// Delegates inference to arrakis BYOK proxy endpoint.
// loa-finn never sees plaintext BYOK keys — arrakis decrypts in-memory and calls provider.

import type {
  ModelPortBase,
  ModelPortStreaming,
  CompletionRequest,
  CompletionResult,
  CompletionOptions,
  ModelCapabilities,
  HealthStatus,
  StreamChunk,
  UsageInfo,
} from "./types.js"
import type { S2SJwtSigner } from "./s2s-jwt.js"

// --- Proxy Request/Response Types ---

interface ProxyInferenceRequest {
  trace_id: string
  tenant_id: string
  nft_id?: string
  user_id: string
  provider: string
  model: string
  messages: unknown[]
  tools?: unknown[]
  stream: boolean
  max_tokens?: number
  temperature?: number
}

interface ProxyInferenceResponse {
  content: string
  thinking: string | null
  tool_calls: unknown[] | null
  usage: UsageInfo
  metadata: {
    model: string
    provider_request_id?: string
    latency_ms: number
    trace_id: string
  }
}

// --- SSE Event for Streaming ---

interface ProxySSEEvent {
  event: string
  data: unknown
}

// --- BYOKProxyClient ---

export class BYOKProxyClient implements ModelPortBase, ModelPortStreaming {
  private arrakisBaseUrl: string
  private signer: S2SJwtSigner
  private defaultProvider: string
  private defaultModel: string

  constructor(
    arrakisBaseUrl: string,
    signer: S2SJwtSigner,
    defaultProvider: string = "openai",
    defaultModel: string = "gpt-4o",
  ) {
    this.arrakisBaseUrl = arrakisBaseUrl.replace(/\/+$/, "")
    this.signer = signer
    this.defaultProvider = defaultProvider
    this.defaultModel = defaultModel
  }

  capabilities(): ModelCapabilities {
    return {
      tool_calling: true,
      thinking_traces: false,
      vision: true,
      streaming: true,
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now()
    try {
      const authToken = await this.signer.signJWT({ purpose: "health-check" })
      const res = await fetch(`${this.arrakisBaseUrl}/internal/byok-proxy/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${authToken}` },
      })
      return {
        healthy: res.ok || res.status === 404, // 404 = endpoint exists but no key for this user
        latency_ms: Date.now() - start,
      }
    } catch {
      return { healthy: false, latency_ms: Date.now() - start }
    }
  }

  /**
   * Non-streaming completion via arrakis BYOK proxy.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const proxyReq = this.buildProxyRequest(request, false)
    const authToken = await this.signer.signJWT({
      purpose: "byok-proxy",
      trace_id: request.metadata.trace_id,
    })

    const res = await fetch(`${this.arrakisBaseUrl}/internal/byok-proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(proxyReq),
    })

    if (res.status === 404) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      if (body.error === "no_byok_key") {
        throw new BYOKKeyNotFoundError(
          proxyReq.provider,
          request.metadata.tenant_id,
        )
      }
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      throw new Error(`BYOK proxy error ${res.status}: ${errBody.slice(0, 200)}`)
    }

    const data = (await res.json()) as ProxyInferenceResponse
    return {
      content: data.content,
      thinking: data.thinking,
      tool_calls: data.tool_calls as CompletionResult["tool_calls"],
      usage: data.usage,
      metadata: {
        model: data.metadata.model,
        provider_request_id: data.metadata.provider_request_id,
        latency_ms: data.metadata.latency_ms,
        trace_id: request.metadata.trace_id,
      },
    }
  }

  /**
   * Streaming completion via arrakis BYOK proxy SSE.
   */
  async *stream(
    request: CompletionRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamChunk> {
    const proxyReq = this.buildProxyRequest(request, true)
    const authToken = await this.signer.signJWT({
      purpose: "byok-proxy",
      trace_id: request.metadata.trace_id,
    })

    const abortController = new AbortController()
    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort()
      } else {
        options.signal.addEventListener("abort", () => abortController.abort(), { once: true })
      }
    }

    const res = await fetch(`${this.arrakisBaseUrl}/internal/byok-proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(proxyReq),
      signal: abortController.signal,
    })

    if (res.status === 404) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      const code = body.error === "no_byok_key" ? "BYOK_KEY_NOT_FOUND" : "BYOK_PROXY_404"
      yield { event: "error", data: { code, message: `No BYOK key for provider ${proxyReq.provider}` } }
      return
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      yield { event: "error", data: { code: `BYOK_PROXY_${res.status}`, message: errBody.slice(0, 500) } }
      return
    }

    if (!res.body) {
      yield { event: "error", data: { code: "BYOK_STREAM_ERROR", message: "Response body is null" } }
      return
    }

    // Parse SSE from arrakis proxy — same format as cheval sidecar
    yield* this.parseProxySSE(res.body)
  }

  // --- Private ---

  private buildProxyRequest(request: CompletionRequest, stream: boolean): ProxyInferenceRequest {
    return {
      trace_id: request.metadata.trace_id,
      tenant_id: request.metadata.tenant_id,
      nft_id: request.metadata.nft_id || undefined,
      user_id: request.metadata.tenant_id, // user_id derived from tenant_id for now
      provider: this.defaultProvider,
      model: this.defaultModel,
      messages: request.messages,
      tools: request.tools,
      stream,
      max_tokens: request.options?.max_tokens,
      temperature: request.options?.temperature,
    }
  }

  /**
   * Parse SSE from arrakis BYOK proxy.
   * Format matches cheval sidecar StreamChunk events.
   */
  private async *parseProxySSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
    const decoder = new TextDecoder()
    let buffer = ""
    let eventType = ""
    let dataBuffer = ""

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "")
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          let data = line.slice(5)
          if (data.startsWith(" ")) data = data.slice(1)
          dataBuffer += (dataBuffer ? "\n" : "") + data
        } else if (line === "") {
          if (dataBuffer) {
            try {
              const parsed = JSON.parse(dataBuffer) as StreamChunk
              yield parsed
            } catch {
              // Skip unparseable events
            }
          }
          eventType = ""
          dataBuffer = ""
        }
      }
    }

    // Flush final event
    buffer += decoder.decode()
    if (buffer.trim()) {
      const finalLines = buffer.split("\n")
      for (const rawLine of finalLines) {
        const line = rawLine.replace(/\r$/, "")
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          let data = line.slice(5)
          if (data.startsWith(" ")) data = data.slice(1)
          dataBuffer += (dataBuffer ? "\n" : "") + data
        }
      }
    }
    if (dataBuffer) {
      try {
        const parsed = JSON.parse(dataBuffer) as StreamChunk
        yield parsed
      } catch {
        // Skip unparseable final event
      }
    }
  }
}

// --- Error Types ---

export class BYOKKeyNotFoundError extends Error {
  readonly provider: string
  readonly tenantId: string

  constructor(provider: string, tenantId: string) {
    super(`No BYOK key found for provider "${provider}" (tenant: ${tenantId})`)
    this.name = "BYOKKeyNotFoundError"
    this.provider = provider
    this.tenantId = tenantId
  }
}
