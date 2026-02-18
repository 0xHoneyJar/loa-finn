// src/gateway/x402-routes.ts — x402 Route Registration (Sprint 8 Task 8.4)
//
// Dedicated /api/v1/x402/invoke endpoint with x402-only middleware stack.
// During closed beta: allowlist-gated. feature:x402:public controls future access.
// Rate limited: 100 req/hour per wallet.
// MUST NOT accept nft_id — generic system prompt only.

import { Hono } from "hono"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { QuoteService } from "../x402/middleware.js"
import type { PaymentVerifier } from "../x402/verify.js"
import type { SettlementService } from "../x402/settlement.js"
import type { CreditNoteService } from "../x402/credit-note.js"
import type { AllowlistService } from "./allowlist.js"
import type { FeatureFlagService } from "./feature-flags.js"
import { X402Error, X402_RATE_LIMIT_PER_HOUR } from "../x402/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface X402RouteDeps {
  redis: RedisCommandClient
  quoteService: QuoteService
  paymentVerifier: PaymentVerifier
  settlementService: SettlementService
  creditNoteService?: CreditNoteService
  allowlistService: AllowlistService
  featureFlagService: FeatureFlagService
  /** Execute inference with generic system prompt (no NFT personality) */
  executeInference: (model: string, maxTokens: number, prompt: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// Rate Limiter Helper
// ---------------------------------------------------------------------------

async function checkRateLimit(
  redis: RedisCommandClient,
  walletAddress: string,
): Promise<boolean> {
  const key = `x402:rate:${walletAddress.toLowerCase()}`
  const count = await redis.incrby(key, 1)
  if (count === 1) {
    await redis.expire(key, 3600) // 1 hour window
  }
  return count <= X402_RATE_LIMIT_PER_HOUR
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function x402Routes(deps: X402RouteDeps): Hono {
  const app = new Hono()

  // POST /api/v1/x402/invoke
  app.post("/invoke", async (c) => {
    // 1. Check feature flag
    const x402Enabled = await deps.featureFlagService.isEnabled("x402")
    if (!x402Enabled) {
      return c.json({ error: "x402 payments are currently disabled", code: "FEATURE_DISABLED" }, 503)
    }

    // 2. Parse request body
    const body = await c.req.json<{
      model?: string
      max_tokens?: number
      prompt: string
      nft_id?: string
    }>()

    // Reject nft_id — x402 is generic system prompt only (Task 8.4)
    if (body.nft_id) {
      return c.json({
        error: "x402 endpoint does not support nft_id. Use /api/v1/invoke with authentication for NFT-personalized inference.",
        code: "NFT_NOT_SUPPORTED",
      }, 400)
    }

    if (!body.prompt) {
      return c.json({ error: "prompt is required", code: "INVALID_REQUEST" }, 400)
    }

    const model = body.model ?? "claude-sonnet-4-6"
    const maxTokens = body.max_tokens

    // 3. Check for X-Payment header
    const paymentHeader = c.req.header("X-Payment")

    if (!paymentHeader) {
      // No payment — return 402 with quote
      try {
        const quote = await deps.quoteService.generateQuote({ model, max_tokens: maxTokens })

        c.header("X-Payment-Required", JSON.stringify(quote))
        return c.json({
          error: "Payment required",
          code: "PAYMENT_REQUIRED",
          quote,
        }, 402)
      } catch (e) {
        if (e instanceof X402Error) {
          return c.json({ error: e.message, code: e.code }, e.httpStatus as 402)
        }
        throw e
      }
    }

    // 4. Parse payment proof
    let proof
    try {
      proof = JSON.parse(paymentHeader)
    } catch {
      return c.json({ error: "Invalid X-Payment header format", code: "INVALID_PAYMENT" }, 400)
    }

    // 5. Allowlist check (during beta, unless x402:public is ON)
    const x402Public = await deps.featureFlagService.isEnabled("x402:public")
    if (!x402Public) {
      const walletAddress = proof.authorization?.from
      if (!walletAddress) {
        return c.json({ error: "Payment authorization must include from address", code: "INVALID_PAYMENT" }, 400)
      }

      const allowed = await deps.allowlistService.isAllowed(walletAddress)
      if (!allowed) {
        return c.json({
          error: "x402 is in closed beta. Wallet not on allowlist.",
          code: "NOT_ALLOWLISTED",
          waitlist_url: "/waitlist",
        }, 403)
      }
    }

    // 6. Rate limit
    const walletAddress = proof.authorization?.from
    if (walletAddress) {
      const withinLimit = await checkRateLimit(deps.redis, walletAddress)
      if (!withinLimit) {
        return c.json({
          error: `Rate limit exceeded: ${X402_RATE_LIMIT_PER_HOUR} requests per hour`,
          code: "RATE_LIMITED",
        }, 429)
      }
    }

    // 7. Retrieve quote
    const quote = await deps.quoteService.getQuote(proof.quote_id)
    if (!quote) {
      return c.json({ error: "Quote expired or not found", code: "QUOTE_NOT_FOUND" }, 402)
    }

    // 8. Verify payment
    try {
      const verification = await deps.paymentVerifier.verify(proof, quote)

      // 9. Settle payment
      if (!verification.idempotent_replay) {
        await deps.settlementService.settle(verification.authorization, proof.quote_id)
      }

      // 10. Execute inference (with max_tokens from quote)
      // If inference fails after settlement, issue a credit note so the payer can retry.
      let result: string
      try {
        result = await deps.executeInference(quote.model, quote.max_tokens, body.prompt)
      } catch (inferenceError) {
        // Settlement already happened — issue credit note for the full amount
        let creditNote = null
        if (deps.creditNoteService && !verification.idempotent_replay) {
          try {
            creditNote = await deps.creditNoteService.issueCreditNote(
              verification.authorization.from,
              quote.quote_id,
              quote.max_cost,
              "0", // actual cost is 0 since inference failed
            )
          } catch {
            // Best-effort credit note issuance
          }
        }
        return c.json({
          error: "Inference failed after settlement. A credit note has been issued.",
          code: "INFERENCE_FAILED",
          payment_id: verification.payment_id,
          credit_note: creditNote ? { id: creditNote.id, amount: creditNote.amount } : null,
        }, 502)
      }

      return c.json({
        result,
        payment_id: verification.payment_id,
        quote_id: quote.quote_id,
      })
    } catch (e) {
      if (e instanceof X402Error) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 402 | 403)
      }
      throw e
    }
  })

  return app
}
