// src/gateway/payment-decision.ts — Payment Decision Tree (Sprint 3 T3.1, T3.2, T3.7)
//
// Hono middleware implementing the strict 5-branch decision tree (SDD §4.1):
// 1. Free endpoints → allow (method: "free")
// 2. BOTH Authorization AND X-Payment headers → 400 (ambiguous_payment)
// 3. Has Authorization: Bearer dk_... → API key path
// 4. Has X-Payment-Receipt + X-Payment-Nonce → x402 path
// 5. No headers on paid endpoint → 402 challenge
//
// 401 ALWAYS means auth failure (bad/missing/revoked key).
// 402 ALWAYS means payment required.
// These are NEVER conflated (T3.7).

import type { Context, MiddlewareHandler } from "hono"
import { randomUUID } from "node:crypto"
import type { ApiKeyManager, ValidatedApiKey } from "./api-keys.js"
import type { X402ReceiptVerifier, VerifiedReceipt } from "../x402/receipt-verifier.js"
import type { ChallengeIssuer } from "../x402/challenge-issuer.js"
import type { MultiTierRateLimiter } from "./rate-limit.js"
import type { BillingEventsRecorder } from "./billing-events.js"
import { getRequestCost } from "../x402/pricing.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaymentDecision {
  method: "free" | "x402" | "api_key"
  requestId: string
  apiKeyId?: string
  apiKey?: ValidatedApiKey
  creditBalance?: number
  x402Receipt?: VerifiedReceipt
  amountMicro?: number
}

export interface PaymentDecisionDeps {
  apiKeyManager: ApiKeyManager
  receiptVerifier: X402ReceiptVerifier
  challengeIssuer: ChallengeIssuer
  rateLimiter: MultiTierRateLimiter
  billingRecorder: BillingEventsRecorder
  /** Set of free endpoint patterns (e.g., "GET /health") */
  freeEndpoints: Set<string>
}

// ---------------------------------------------------------------------------
// Free endpoint defaults (SDD §4.1)
// ---------------------------------------------------------------------------

export const DEFAULT_FREE_ENDPOINTS = new Set([
  "GET /health",
  "GET /llms.txt",
  "GET /agents.md",
  "GET /.well-known/jwks.json",
  "GET /metrics",
  "GET /",
  "GET /dashboard",
])

/**
 * Check if a request matches a free endpoint.
 * Supports exact match and prefix match for parameterized routes.
 */
function isFreeEndpoint(method: string, path: string, freeEndpoints: Set<string>): boolean {
  const key = `${method} ${path}`
  if (freeEndpoints.has(key)) return true

  // Check prefix patterns (e.g., "GET /agent/" matches "GET /agent/:tokenId")
  for (const ep of freeEndpoints) {
    if (ep.endsWith("/") && key.startsWith(ep)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Create PaymentDecision middleware.
 * Attaches PaymentDecision to Hono context variable "paymentDecision".
 */
export function paymentDecisionMiddleware(deps: PaymentDecisionDeps): MiddlewareHandler {
  return async (c: Context, next) => {
    const method = c.req.method
    const path = c.req.path
    const requestId = c.req.header("X-Request-Id") ?? randomUUID()

    // Branch 1: Free endpoints → allow
    if (isFreeEndpoint(method, path, deps.freeEndpoints)) {
      c.set("paymentDecision", {
        method: "free",
        requestId,
      } satisfies PaymentDecision)
      return next()
    }

    // Detect headers
    const authHeader = c.req.header("Authorization")
    const paymentReceipt = c.req.header("X-Payment-Receipt")
    const paymentNonce = c.req.header("X-Payment-Nonce")
    const hasApiKeyAuth = authHeader?.startsWith("Bearer dk_") ?? false
    const hasX402 = !!(paymentReceipt && paymentNonce)

    // Branch 2: Both credentials → 400 (T3.2)
    if (hasApiKeyAuth && hasX402) {
      return c.json(
        {
          error: "ambiguous_payment",
          message: "Provide exactly one of Authorization (API key) or X-Payment-Receipt (x402), not both.",
        },
        400,
      )
    }

    // Branch 3: API key path
    if (hasApiKeyAuth) {
      const plaintextKey = authHeader!.slice("Bearer ".length)
      return handleApiKeyPath(c, deps, plaintextKey, requestId, path, method, next)
    }

    // Branch 4: x402 receipt path
    if (hasX402) {
      return handleX402Path(c, deps, paymentReceipt!, paymentNonce!, requestId, path, method, next)
    }

    // Branch 5: No payment headers → 402 challenge
    return issueChallenge(c, deps, requestId, path, method)
  }
}

// ---------------------------------------------------------------------------
// Branch 3: API Key Path
// ---------------------------------------------------------------------------

async function handleApiKeyPath(
  c: Context,
  deps: PaymentDecisionDeps,
  plaintextKey: string,
  requestId: string,
  path: string,
  method: string,
  next: () => Promise<void>,
): Promise<Response | void> {
  // Rate limit: API key tier
  const rateCheck = await deps.rateLimiter.check(
    "api_key_default",
    plaintextKey.slice(0, 32), // Use prefix for rate limit key (not full secret)
    60,
    60_000,
  )
  if (!rateCheck.allowed) {
    setRateLimitHeaders(c, rateCheck.remaining, rateCheck.resetMs, rateCheck.retryAfterSeconds)
    return c.json({ error: "Too Many Requests", code: "RATE_LIMITED" }, 429)
  }

  // Validate key — 401 on failure (T3.7: 401 ALWAYS means auth failure)
  const apiKey = await deps.apiKeyManager.validate(plaintextKey)
  if (!apiKey) {
    return c.json(
      { error: "Invalid or revoked API key", code: "UNAUTHORIZED" },
      401,
    )
  }

  // Get request cost
  const body = await peekJsonBody(c)
  const amountMicro = parseInt(
    getRequestCost(body?.token_id ?? "", body?.model ?? "", body?.max_tokens ?? 0),
    10,
  )

  // Check credits — 402 on insufficient (T3.7: 402 ALWAYS means payment required)
  if (apiKey.balanceMicro < amountMicro) {
    c.header("X-Payment-Upgrade", "x402")
    return c.json(
      {
        error: "Insufficient credits",
        code: "PAYMENT_REQUIRED",
        balance_micro: apiKey.balanceMicro,
        required_micro: amountMicro,
        upgrade: "x402",
      },
      402,
    )
  }

  // Debit credits atomically (T3.8)
  const debitResult = await deps.apiKeyManager.debitCredits(
    apiKey.id,
    amountMicro,
    requestId,
    { path, method, model: body?.model },
  )

  if (!debitResult.success) {
    // Race condition: balance changed between check and debit
    c.header("X-Payment-Upgrade", "x402")
    return c.json(
      {
        error: "Insufficient credits",
        code: "PAYMENT_REQUIRED",
        upgrade: "x402",
      },
      402,
    )
  }

  const decision: PaymentDecision = {
    method: "api_key",
    requestId,
    apiKeyId: apiKey.id,
    apiKey,
    creditBalance: debitResult.balanceAfter,
    amountMicro,
  }

  c.set("paymentDecision", decision)
  setRateLimitHeaders(c, rateCheck.remaining, rateCheck.resetMs, 0)

  // Record billing event (best-effort, fire-and-forget)
  deps.billingRecorder
    .record({
      requestId,
      paymentMethod: "api_key",
      amountMicro,
      apiKeyId: apiKey.id,
      responseStatus: 200,
    })
    .catch(() => {}) // Never break the request flow

  return next()
}

// ---------------------------------------------------------------------------
// Branch 4: x402 Receipt Path
// ---------------------------------------------------------------------------

async function handleX402Path(
  c: Context,
  deps: PaymentDecisionDeps,
  receiptTxHash: string,
  nonce: string,
  requestId: string,
  path: string,
  method: string,
  next: () => Promise<void>,
): Promise<Response | void> {
  // Rate limit: x402 per wallet (use nonce as proxy until we know wallet)
  const rateCheck = await deps.rateLimiter.check(
    "x402_per_wallet",
    nonce.slice(0, 16),
    30,
    60_000,
  )
  if (!rateCheck.allowed) {
    setRateLimitHeaders(c, rateCheck.remaining, rateCheck.resetMs, rateCheck.retryAfterSeconds)
    return c.json({ error: "Too Many Requests", code: "RATE_LIMITED" }, 429)
  }

  // Parse request body for binding parameters
  const body = await peekJsonBody(c)
  const tokenId = body?.token_id ?? ""
  const model = body?.model ?? ""
  const maxTokens = body?.max_tokens ?? 0

  try {
    const receipt = await deps.receiptVerifier.verify({
      tx_hash: receiptTxHash,
      nonce,
      request_path: path,
      request_method: method,
      token_id: tokenId,
      model,
      max_tokens: maxTokens,
    })

    const decision: PaymentDecision = {
      method: "x402",
      requestId,
      x402Receipt: receipt,
      amountMicro: parseInt(receipt.amount, 10),
    }

    c.set("paymentDecision", decision)

    // Record billing event (best-effort, fire-and-forget)
    deps.billingRecorder
      .record({
        requestId,
        paymentMethod: "x402",
        amountMicro: parseInt(receipt.amount, 10),
        txHash: receipt.tx_hash,
        responseStatus: 200,
      })
      .catch(() => {}) // Never break the request flow

    return next()
  } catch (err) {
    const error = err as Error & { code?: string; httpStatus?: number }
    const status = error.httpStatus ?? 402
    return c.json(
      { error: error.message, code: error.code ?? "VERIFICATION_FAILED" },
      status as 402,
    )
  }
}

// ---------------------------------------------------------------------------
// Branch 5: Issue Challenge (402)
// ---------------------------------------------------------------------------

async function issueChallenge(
  c: Context,
  deps: PaymentDecisionDeps,
  requestId: string,
  path: string,
  method: string,
): Promise<Response> {
  // Rate limit: challenge generation per IP
  const ip = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown"
  const rateCheck = await deps.rateLimiter.check("challenge_per_ip", ip, 120, 60_000)
  if (!rateCheck.allowed) {
    setRateLimitHeaders(c, rateCheck.remaining, rateCheck.resetMs, rateCheck.retryAfterSeconds)
    return c.json({ error: "Too Many Requests", code: "RATE_LIMITED" }, 429)
  }

  // Parse body to get binding parameters
  const body = await peekJsonBody(c)
  const tokenId = body?.token_id ?? ""
  const model = body?.model ?? ""
  const maxTokens = body?.max_tokens ?? 0

  try {
    const challenge = await deps.challengeIssuer.issue({
      request_path: path,
      request_method: method,
      token_id: tokenId,
      model,
      max_tokens: maxTokens,
    })

    return c.json(
      {
        error: "Payment required",
        code: "PAYMENT_REQUIRED",
        challenge,
      },
      402,
    )
  } catch (err) {
    console.error(
      JSON.stringify({
        metric: "finn.challenge_issue_error",
        requestId,
        error: (err as Error).message,
      }),
    )
    return c.json(
      { error: "Failed to generate payment challenge", code: "CHALLENGE_ERROR" },
      500,
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setRateLimitHeaders(
  c: Context,
  remaining: number,
  resetMs: number,
  retryAfterSeconds: number,
): void {
  c.header("X-RateLimit-Remaining", String(remaining))
  c.header("X-RateLimit-Reset", String(Math.ceil(resetMs / 1000)))
  if (retryAfterSeconds > 0) {
    c.header("Retry-After", String(retryAfterSeconds))
  }
}

/**
 * Peek at the JSON body without consuming it.
 * Returns null if body isn't JSON or parsing fails.
 */
async function peekJsonBody(
  c: Context,
): Promise<Record<string, unknown> | null> {
  try {
    // Hono caches parsed body, so this is safe to call multiple times
    return await c.req.json()
  } catch {
    return null
  }
}
