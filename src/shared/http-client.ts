// src/shared/http-client.ts
// ResilientHttpClient: HTTP client with exponential backoff retry and rate-limit tracking.
// Extracted from bridgebuilder for cross-cutting use (ActivityFeed, etc.).

export interface HttpRequest {
  url: string
  method: "GET" | "POST" | "PUT" | "DELETE"
  headers?: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
  rateLimitRemaining?: number
}

export interface IHttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
  getRateLimitRemaining(): number | undefined
}

export interface ResilientHttpConfig {
  maxRetries: number
  baseDelayMs: number
  rateLimitBuffer: number
  redactPatterns: RegExp[]
}

export class ResilientHttpClient implements IHttpClient {
  private remaining: number | undefined

  constructor(
    private readonly config: ResilientHttpConfig,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    if (this.remaining !== undefined && this.remaining <= this.config.rateLimitBuffer) {
      throw new Error(
        `Rate limit budget exhausted: ${this.remaining} remaining (buffer: ${this.config.rateLimitBuffer})`,
      )
    }

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.config.baseDelayMs * Math.pow(2, attempt - 1)
        await this.sleep(delay)
      }

      try {
        const resp = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        })

        const body = await resp.text()
        const headers: Record<string, string> = {}
        resp.headers.forEach((v, k) => { headers[k] = v })

        const rlRemaining = resp.headers.get("x-ratelimit-remaining")
        if (rlRemaining) {
          this.remaining = parseInt(rlRemaining, 10)
        }

        const response: HttpResponse = {
          status: resp.status,
          headers,
          body,
          rateLimitRemaining: this.remaining,
        }

        if (resp.status >= 500 && attempt < this.config.maxRetries) {
          lastError = new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`)
          continue
        }

        return response
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt >= this.config.maxRetries) break
      }
    }

    throw lastError ?? new Error("Request failed after retries")
  }

  getRateLimitRemaining(): number | undefined {
    return this.remaining
  }
}
