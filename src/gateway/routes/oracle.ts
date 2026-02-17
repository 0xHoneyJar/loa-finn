// src/gateway/routes/oracle.ts — Oracle product API handler (SDD §3.1)
// BFF endpoint translating the product-facing Oracle contract into the
// internal invoke pipeline. Follows the factory pattern from invoke.ts.

import type { Context, Next } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { HounfourRouter } from "../../hounfour/router.js"
import type { FinnConfig } from "../../config.js"
import type { OracleRateLimiter } from "../oracle-rate-limit.js"
import type { OracleTenantContext } from "../oracle-auth.js"
import { HounfourError } from "../../hounfour/errors.js"

const API_VERSION = "2026-02-17"
const MAX_QUESTION_LENGTH = 10_000
const MAX_CONTEXT_LENGTH = 5_000

interface OracleRequest {
  question: string
  context?: string
  session_id?: string // reserved, ignored in Phase 1
}

interface OracleResponse {
  answer: string
  sources: Array<{
    id: string
    tags: string[]
    tokens_used: number
  }>
  metadata: {
    knowledge_mode: "full" | "reduced" | "none"
    total_knowledge_tokens: number
    knowledge_budget: number
    retrieval_ms: number
    model: string
    session_id: null // null until sessions implemented
  }
}

export function createOracleHandler(
  router: HounfourRouter,
  rateLimiter: OracleRateLimiter,
  config: FinnConfig,
) {
  return async (c: Context) => {
    const oracleTenant = c.get("oracleTenant") as OracleTenantContext | undefined
    if (!oracleTenant) {
      return c.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, 401)
    }

    let body: OracleRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
    }

    // Validate question
    if (!body.question || typeof body.question !== "string" || !body.question.trim()) {
      return c.json(
        { error: "question is required and must be a non-empty string", code: "INVALID_REQUEST" },
        400,
      )
    }
    if (body.question.length > MAX_QUESTION_LENGTH) {
      return c.json(
        { error: `question must be ≤${MAX_QUESTION_LENGTH} characters`, code: "INVALID_REQUEST" },
        400,
      )
    }
    if (body.context && body.context.length > MAX_CONTEXT_LENGTH) {
      return c.json(
        { error: `context must be ≤${MAX_CONTEXT_LENGTH} characters`, code: "INVALID_REQUEST" },
        400,
      )
    }

    // Build prompt: question + optional context
    const prompt = body.context
      ? `${body.question}\n\nAdditional context: ${body.context}`
      : body.question

    // Cost reservation: atomic check-and-reserve before invoking model (Flatline IMP-002/SKP-004)
    const reservation = await rateLimiter.reserveCost(config.oracle.estimatedCostCents)
    if (!reservation.allowed) {
      return c.json({ error: "Daily cost ceiling reached", code: "COST_CEILING_EXCEEDED" }, 503)
    }

    try {
      // Delegate to existing invoke pipeline with "oracle" agent
      const result = await router.invokeForTenant(
        "oracle",
        prompt,
        oracleTenant.asTenant(),
        "invoke",
      )

      // Reconcile actual cost (best-effort refund of overestimate)
      // cost_micro is in micro-USD (string BigInt) — convert to cents
      const actualCostCents = result.metadata.cost_micro
        ? Math.ceil(Number(result.metadata.cost_micro) / 10_000) // micro-USD → cents
        : config.oracle.estimatedCostCents
      await reservation.release(actualCostCents)

      // Reshape response for product API
      const knowledge = result.metadata.knowledge
      const response: OracleResponse = {
        answer: result.content,
        sources: (knowledge?.sources_used ?? []).map((id) => ({
          id,
          tags: knowledge?.tags_matched ?? [],
          tokens_used: 0, // individual source tokens not tracked in enricher metadata
        })),
        metadata: {
          knowledge_mode: knowledge?.mode ?? "full",
          total_knowledge_tokens: knowledge?.tokens_used ?? 0,
          knowledge_budget: knowledge?.budget ?? 0,
          retrieval_ms: result.metadata.latency_ms,
          model: result.metadata.model,
          session_id: null,
        },
      }

      c.header("X-Oracle-API-Version", API_VERSION)
      return c.json(response)
    } catch (err) {
      // Release reservation on failure (full refund)
      await reservation.release(0)

      if (err instanceof HounfourError) {
        const statusMap: Record<string, ContentfulStatusCode> = {
          BUDGET_EXCEEDED: 402,
          ORACLE_MODEL_UNAVAILABLE: 422,
          ORACLE_KNOWLEDGE_UNAVAILABLE: 503,
          CONTEXT_OVERFLOW: 413,
          RATE_LIMITED: 429,
        }
        const status = statusMap[err.code] ?? 502
        return c.json({ error: err.message, code: err.code }, status)
      }
      console.error("[oracle] unexpected error:", err)
      return c.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500)
    }
  }
}

/** Oracle-specific CORS middleware (SDD §3.6) */
export function oracleCorsMiddleware(allowedOrigins: string[]) {
  return async (c: Context, next: Next) => {
    const origin = c.req.header("Origin")
    if (origin && allowedOrigins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Access-Control-Allow-Methods", "POST, OPTIONS")
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Oracle-API-Version")
      c.header("Access-Control-Max-Age", "86400")
    }
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204)
    }
    return next()
  }
}
