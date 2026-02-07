// src/safety/__spike__/mcp-interception-spike.ts — TASK-1.0: MCP SDK Interception Spike
//
// Proves that Pi SDK tool arrays can be intercepted at the execute() boundary.
// Tools are plain objects with an execute() method; wrapping replaces the original
// in the array before createAgentSession() sees it, leaving no bypass path.

import type { TSchema, Static } from "@sinclair/typebox"
import type {
  ToolDefinition,
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent"

// ── Hook types ──────────────────────────────────────────────

/** Context passed to pre/post hooks for a single tool invocation. */
export interface FirewallHookContext {
  /** Tool name (from ToolDefinition.name) */
  toolName: string
  /** The tool call ID assigned by the LLM runtime */
  toolCallId: string
  /** Deserialized parameters the LLM passed to the tool */
  params: Record<string, unknown>
  /** Wall-clock timestamp when the hook fires (ms since epoch) */
  timestamp: number
}

/**
 * Pre-execution hook. Runs before the original execute().
 *
 * Return "allow" to proceed, or "deny" with a reason to block the call.
 * Throwing also blocks (treated as deny + error message).
 */
export type PreHook = (
  ctx: FirewallHookContext,
) => Promise<PreHookResult> | PreHookResult

export type PreHookResult =
  | { action: "allow" }
  | { action: "deny"; reason: string }

/**
 * Post-execution hook. Runs after the original execute() returns.
 *
 * Receives the result for inspection/logging. Cannot mutate the result
 * in this spike (that could be added later as a "redact" action).
 */
export type PostHook = (
  ctx: FirewallHookContext & { result: AgentToolResult<unknown>; durationMs: number },
) => Promise<void> | void

// ── Firewall options ────────────────────────────────────────

export interface FirewallOptions {
  /** Called before every tool execute(). */
  preHook?: PreHook
  /** Called after every tool execute() completes (success or error). */
  postHook?: PostHook
}

// ── Core implementation ─────────────────────────────────────

/**
 * Wrap every tool in the array with firewall pre/post hooks.
 *
 * Returns a **new** array of ToolDefinition objects. Each wrapped tool:
 * - Preserves name, label, description, parameters, renderCall, renderResult
 * - Replaces execute() with a wrapper that runs preHook -> original -> postHook
 * - The original execute() reference is captured in a closure (not exposed)
 *
 * The caller replaces the original array with the returned array before
 * passing it to createAgentSession(). Because the original ToolDefinition
 * objects are never registered, the agent can only reach the wrapped versions.
 */
export function wrapToolsWithFirewall(
  tools: ToolDefinition[],
  options: FirewallOptions,
): ToolDefinition[] {
  return tools.map((tool) => wrapSingleTool(tool, options))
}

/**
 * Wrap a single ToolDefinition. Useful when tools are added incrementally
 * (e.g. customTools added after built-in tools).
 */
export function wrapSingleTool(
  tool: ToolDefinition,
  options: FirewallOptions,
): ToolDefinition {
  // Capture the original execute in a closure — the only reference
  const originalExecute = tool.execute

  const wrappedExecute = async (
    toolCallId: string,
    params: Static<TSchema>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> => {
    const hookCtx: FirewallHookContext = {
      toolName: tool.name,
      toolCallId,
      params: params as Record<string, unknown>,
      timestamp: Date.now(),
    }

    // ── Pre-hook ──────────────────────────────────────────
    if (options.preHook) {
      let preResult: PreHookResult
      try {
        preResult = await options.preHook(hookCtx)
      } catch (err) {
        // Hook threw — treat as deny
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `[firewall] pre-hook error: ${message}` }],
          details: {},
        }
      }

      if (preResult.action === "deny") {
        return {
          content: [{ type: "text", text: `[firewall] blocked: ${preResult.reason}` }],
          details: {},
        }
      }
    }

    // ── Execute original ─────────────────────────────────
    const startMs = Date.now()
    const result = await originalExecute.call(tool, toolCallId, params, signal, onUpdate, ctx)
    const durationMs = Date.now() - startMs

    // ── Post-hook ─────────────────────────────────────────
    if (options.postHook) {
      try {
        await options.postHook({ ...hookCtx, result, durationMs })
      } catch {
        // Post-hook errors are swallowed — the tool already executed.
        // Production code would log this to the audit trail.
      }
    }

    return result
  }

  // Build a new ToolDefinition with the same shape, swapping only execute().
  // Spread is intentional: any future fields the SDK adds are preserved.
  return {
    ...tool,
    execute: wrappedExecute,
  }
}

// ── Enumeration helper ──────────────────────────────────────

/** Enumerate all tools in the array. Proves tools are inspectable plain objects. */
export function enumerateTools(
  tools: ToolDefinition[],
): Array<{ name: string; label: string; description: string; hasCustomRender: boolean }> {
  return tools.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.description,
    hasCustomRender: typeof t.renderCall === "function" || typeof t.renderResult === "function",
  }))
}

// ── Integration example (not executed, demonstrates wiring) ─

/*
 * Usage in session.ts would look like:
 *
 *   import { wrapToolsWithFirewall } from "../safety/__spike__/mcp-interception-spike.js"
 *
 *   const firewalled = wrapToolsWithFirewall(
 *     [jailedReadTool, sandboxedBashTool, jailedEditTool, jailedWriteTool],
 *     {
 *       preHook: async (ctx) => {
 *         auditLog.append({ action: "tool_call", tool: ctx.toolName, params: ctx.params })
 *         return { action: "allow" }
 *       },
 *       postHook: async (ctx) => {
 *         auditLog.append({ action: "tool_result", tool: ctx.toolName, durationMs: ctx.durationMs })
 *       },
 *     },
 *   )
 *
 *   // customTools get the same treatment
 *   const firewalledCustom = wrapToolsWithFirewall(getCustomTools(), { preHook, postHook })
 *
 *   const { session } = await createAgentSession({
 *     model,
 *     tools: firewalled,           // <-- wrapped, no bypass
 *     customTools: firewalledCustom,
 *     resourceLoader,
 *     sessionManager,
 *   })
 */
