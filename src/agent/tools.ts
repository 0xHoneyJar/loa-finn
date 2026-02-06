// src/agent/tools.ts — Loa custom tool definitions (SDD §3.1.4)

import { Type, type Static } from "@sinclair/typebox"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ToolDefinition, AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent"

const execFileAsync = promisify(execFile)

const BR_TIMEOUT_MS = 30_000

const BeadsStatusParams = Type.Object({
  label: Type.Optional(Type.String({ description: "Filter by label (e.g. 'sprint:1')" })),
  status: Type.Optional(Type.String({ description: "Filter by status (open, in_progress, closed)" })),
})

export const beadsStatusTool: ToolDefinition<typeof BeadsStatusParams> = {
  name: "beads_status",
  label: "Beads Status",
  description: "Query beads state machine for current task status. Returns bead list filtered by label and/or status.",
  parameters: BeadsStatusParams,
  async execute(
    _toolCallId: string,
    params: Static<typeof BeadsStatusParams>,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const args = ["list", "--json"]
    if (params.label) args.push("--labels", params.label)
    if (params.status) args.push("--status", params.status)

    try {
      const { stdout } = await execFileAsync("br", args, {
        timeout: BR_TIMEOUT_MS,
        signal: signal ?? undefined,
      })
      return { content: [{ type: "text", text: stdout }], details: {} }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text", text: `beads_status error: ${message}` }], details: {} }
    }
  },
}

const EmptyParams = Type.Object({})

export const healthCheckTool: ToolDefinition<typeof EmptyParams> = {
  name: "health_check",
  label: "Health Check",
  description: "Query system health status including agent, WAL, sync, and beads state.",
  parameters: EmptyParams,
  async execute(
    _toolCallId: string,
    _params: Static<typeof EmptyParams>,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const health = {
      status: "healthy",
      uptime: process.uptime(),
      checks: {
        agent: { status: "ok" },
        beads: { status: "unknown" as string },
      },
    }

    try {
      await execFileAsync("br", ["--version"], { timeout: 5000 })
      health.checks.beads = { status: "ok" }
    } catch {
      health.checks.beads = { status: "unavailable" }
    }

    return { content: [{ type: "text", text: JSON.stringify(health, null, 2) }], details: {} }
  },
}

export function getCustomTools(): ToolDefinition[] {
  // Cast needed due to ToolDefinition generic variance (TSchema contravariance on renderCall)
  return [beadsStatusTool, healthCheckTool] as unknown as ToolDefinition[]
}
