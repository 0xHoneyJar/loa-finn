// src/bridgebuilder/adapters/resilient-http.ts

import type { IHttpClient, HttpRequest, HttpResponse } from "../ports/index.js"

export interface ResilientHttpConfig {
  maxRetries: number          // default: 3
  baseDelayMs: number         // default: 1000
  rateLimitBuffer: number     // default: 10
  redactPatterns: RegExp[]    // Patterns to redact from logs
}

/**
 * HTTP client with exponential backoff retry and rate-limit tracking.
 * Tracks X-RateLimit-Remaining across calls.
 *
 * Accepts an injectable `sleep` function for testability — tests inject
 * a fake that records delay values without real delays.
 */
export class ResilientHttpClient implements IHttpClient {
  private remaining: number | undefined

  constructor(
    private readonly config: ResilientHttpConfig,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    // Check rate limit budget before making request
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

        // Track rate limit
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

        // Retry on 5xx
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
