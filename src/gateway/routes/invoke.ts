// src/gateway/routes/invoke.ts — Invoke endpoint handler (SDD §3.1, cycle-024 T1)
// Thin wrapper over HounfourRouter.invokeForTenant() that bridges tenant-authenticated
// HTTP requests through pool selection, model routing, and billing finalization.

import type { Context } from "hono"
import type { HounfourRouter } from "../../hounfour/router.js"
import type { TenantContext } from "../../hounfour/jwt-auth.js"
import { HounfourError } from "../../hounfour/errors.js"

/** Map HounfourError codes to HTTP status codes */
function mapErrorToStatus(code: string): number {
  switch (code) {
    case "BUDGET_EXCEEDED": return 402
    case "BINDING_INVALID": return 400
    case "BUDGET_CIRCUIT_OPEN": return 503
    case "PROVIDER_UNAVAILABLE": return 502
    case "RATE_LIMITED": return 429
    case "ORACLE_MODEL_UNAVAILABLE": return 422
    case "ORACLE_KNOWLEDGE_UNAVAILABLE": return 503
    case "KNOWLEDGE_INJECTION": return 403
    case "CONTEXT_OVERFLOW": return 413
    default: return 502
  }
}

/**
 * Create the POST /api/v1/invoke handler.
 *
 * Expects hounfourAuth middleware to have set TenantContext on the Hono context.
 * Routes through invokeForTenant() which handles pool selection, model routing,
 * cost recording, and billing finalization internally.
 */
export function createInvokeHandler(router: HounfourRouter) {
  return async (c: Context) => {
    const tenant = c.get("tenant") as TenantContext | undefined
    if (!tenant) {
      return c.json({ error: "Unauthorized", code: "TENANT_CONTEXT_MISSING" }, 401)
    }

    let body: { agent?: string; prompt?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
    }

    const agent = body.agent
    const prompt = body.prompt

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return c.json({ error: "prompt is required and must be a non-empty string", code: "INVALID_REQUEST" }, 400)
    }

    if (!agent || typeof agent !== "string" || !agent.trim()) {
      return c.json({ error: "agent is required and must be a non-empty string", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const result = await router.invokeForTenant(agent, prompt, tenant, "invoke")

      return c.json({
        response: result.content,
        model: result.metadata.model,
        usage: {
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
          total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
        },
        cost_micro: result.metadata.cost_micro ?? "0",
        trace_id: result.metadata.trace_id,
        ...(result.metadata.knowledge && { knowledge: result.metadata.knowledge }),
      })
    } catch (err) {
      if (err instanceof HounfourError) {
        const status = mapErrorToStatus(err.code)
        const safeMessages: Record<string, string> = {
          BUDGET_EXCEEDED: "Budget exceeded",
          BINDING_INVALID: "Invalid agent or binding",
          BUDGET_CIRCUIT_OPEN: "Service temporarily unavailable",
          PROVIDER_UNAVAILABLE: "Upstream provider unavailable",
          RATE_LIMITED: "Rate limit exceeded",
          ORACLE_MODEL_UNAVAILABLE: "Model context window insufficient for knowledge enrichment",
          ORACLE_KNOWLEDGE_UNAVAILABLE: "Knowledge sources unavailable",
          KNOWLEDGE_INJECTION: "Knowledge source rejected for security",
          CONTEXT_OVERFLOW: "Context window exceeded",
        }
        const safeMessage = safeMessages[err.code] ?? "Upstream error"
        return c.json({ error: safeMessage, code: err.code }, status)
      }

      console.error("[invoke] unexpected error:", err)
      return c.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500)
    }
  }
}
