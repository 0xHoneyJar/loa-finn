// src/x402/middleware.ts — 402 Quote Middleware (Sprint 8 Task 8.1)
//
// Returns 402 Payment Required with deterministic price quote.
// Authenticated requests (JWT or credit balance) bypass x402.

import { randomUUID } from "node:crypto"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import {
  type X402Quote,
  X402Error,
  BASE_CHAIN_ID,
  USDC_BASE_ADDRESS,
  QUOTE_TTL_SECONDS,
  DEFAULT_MAX_TOKENS,
} from "./types.js"
import { getTracer } from "../tracing/otlp.js"

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
    this.generateId = deps.generateId ?? (() => `q_${randomUUID()}`)
    this.walAppend = deps.walAppend
  }

  /**
   * Generate a price quote for the given model and token count.
   * Each call produces a fresh quote with a unique ID to prevent cross-user leakage.
   */
  async generateQuote(params: QuoteParams): Promise<X402Quote> {
    const tracer = getTracer("x402")
    const span = tracer?.startSpan("x402.quote")

    try {
      const model = params.model
      const maxTokens = params.max_tokens ?? DEFAULT_MAX_TOKENS[model] ?? 4096

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

      span?.setAttribute("quote_id", quoteId)
      span?.setAttribute("model", model)
      span?.setAttribute("max_cost", maxCost.toString())

      // Store by quote_id for verification lookup
      const quoteKey = `x402:quote_id:${quoteId}`
      await this.redis.set(quoteKey, JSON.stringify(quote), "EX", QUOTE_TTL_SECONDS)

      this.writeAudit("x402_quote", { quote_id: quoteId, model, max_tokens: maxTokens, max_cost: maxCost.toString() })

      return quote
    } finally {
      span?.end()
    }
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
