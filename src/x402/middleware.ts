// src/x402/middleware.ts — 402 Quote Middleware (Sprint 8 Task 8.1)
//
// Returns 402 Payment Required with deterministic price quote.
// Authenticated requests (JWT or credit balance) bypass x402.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import {
  type X402Quote,
  X402Error,
  BASE_CHAIN_ID,
  USDC_BASE_ADDRESS,
  QUOTE_TTL_SECONDS,
  QUOTE_CACHE_TTL_SECONDS,
  DEFAULT_MAX_TOKENS,
} from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuoteParams {
  model: string
  max_tokens?: number
}

export interface X402MiddlewareDeps {
  redis: RedisCommandClient
  treasuryAddress: string
  /** Rate in MicroUSDC per token (e.g., "15" = 15 MicroUSDC/token) */
  ratePerToken: Record<string, string>
  /** Markup factor (e.g., 1.1 = 10% markup) */
  markupFactor?: number
  generateId?: () => string
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
}

// ---------------------------------------------------------------------------
// Quote Service
// ---------------------------------------------------------------------------

export class QuoteService {
  private readonly redis: RedisCommandClient
  private readonly treasuryAddress: string
  private readonly ratePerToken: Record<string, string>
  private readonly markupFactor: number
  private readonly generateId: () => string
  private readonly walAppend: X402MiddlewareDeps["walAppend"]

  constructor(deps: X402MiddlewareDeps) {
    this.redis = deps.redis
    this.treasuryAddress = deps.treasuryAddress
    this.ratePerToken = deps.ratePerToken
    this.markupFactor = deps.markupFactor ?? 1.0
    this.generateId = deps.generateId ?? (() => `q_${Date.now().toString(36)}`)
    this.walAppend = deps.walAppend
  }

  /**
   * Generate a deterministic price quote for the given model and token count.
   * Cached in Redis for 60s per (model, max_tokens) tuple.
   */
  async generateQuote(params: QuoteParams): Promise<X402Quote> {
    const model = params.model
    const maxTokens = params.max_tokens ?? DEFAULT_MAX_TOKENS[model] ?? 4096

    // Check cache
    const cacheKey = `x402:quote:${model}:${maxTokens}`
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as X402Quote
    }

    // Calculate max_cost: max_tokens × rate × markup, ceil to nearest 1 MicroUSDC
    const rate = BigInt(this.ratePerToken[model] ?? "15")
    const rawCost = BigInt(maxTokens) * rate
    const markupBips = BigInt(Math.ceil(this.markupFactor * 10000))
    const maxCost = (rawCost * markupBips + 9999n) / 10000n // ceil division

    const quoteId = this.generateId()
    const now = Math.floor(Date.now() / 1000)

    const quote: X402Quote = {
      max_cost: maxCost.toString(),
      max_tokens: maxTokens,
      model,
      payment_address: this.treasuryAddress,
      chain_id: BASE_CHAIN_ID,
      valid_until: now + QUOTE_TTL_SECONDS,
      token_address: USDC_BASE_ADDRESS,
      quote_id: quoteId,
    }

    // Cache the quote
    await this.redis.set(cacheKey, JSON.stringify(quote))
    await this.redis.expire(cacheKey, QUOTE_CACHE_TTL_SECONDS)

    // Also store by quote_id for verification lookup
    const quoteKey = `x402:quote_id:${quoteId}`
    await this.redis.set(quoteKey, JSON.stringify(quote))
    await this.redis.expire(quoteKey, QUOTE_TTL_SECONDS)

    this.writeAudit("x402_quote", { quote_id: quoteId, model, max_tokens: maxTokens, max_cost: maxCost.toString() })

    return quote
  }

  /**
   * Retrieve a quote by its ID (for payment verification).
   */
  async getQuote(quoteId: string): Promise<X402Quote | null> {
    const key = `x402:quote_id:${quoteId}`
    const raw = await this.redis.get(key)
    if (!raw) return null
    return JSON.parse(raw) as X402Quote
  }

  private writeAudit(operation: string, payload: Record<string, unknown>): void {
    if (!this.walAppend) return
    try {
      this.walAppend("x402", operation, "x402", { ...payload, timestamp: Date.now() })
    } catch {
      // Best-effort
    }
  }
}
