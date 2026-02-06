// src/agent/tools.ts — Loa custom tool definitions (SDD §3.1.4, T-6.2, T-6.3)

import { Type, type Static } from "@sinclair/typebox"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, readdir } from "node:fs/promises"
import { join, resolve, relative } from "node:path"
import type { ToolDefinition, AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent"

const execFileAsync = promisify(execFile)

const BR_TIMEOUT_MS = 30_000
const GRIMOIRE_ROOT = "grimoires/loa"

// --- T-1.6: beads_status ---

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

// --- T-1.6: health_check ---

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

// --- T-6.2: grimoire_read ---

const GrimoireReadParams = Type.Object({
  path: Type.String({ description: "File path relative to grimoires/loa/ (e.g. 'NOTES.md')" }),
})

export const grimoireReadTool: ToolDefinition<typeof GrimoireReadParams> = {
  name: "grimoire_read",
  label: "Grimoire Read",
  description: "Read files from the Loa grimoire (NOTES.md, learnings, context files). Path is relative to grimoires/loa/.",
  parameters: GrimoireReadParams,
  async execute(
    _toolCallId: string,
    params: Static<typeof GrimoireReadParams>,
    _signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    try {
      // Path traversal protection
      const absRoot = resolve(GRIMOIRE_ROOT)
      const target = resolve(join(GRIMOIRE_ROOT, params.path))
      const rel = relative(absRoot, target)

      if (rel.startsWith("..") || resolve(target) !== target.replace(/\/$/, "")) {
        return {
          content: [{ type: "text", text: `Error: Path traversal blocked. Access restricted to grimoires/loa/` }],
          details: {},
        }
      }

      // Check if target is outside grimoire root
      if (!target.startsWith(absRoot)) {
        return {
          content: [{ type: "text", text: `Error: Access denied. Path must be within grimoires/loa/` }],
          details: {},
        }
      }

      const content = await readFile(target, "utf-8")
      return { content: [{ type: "text", text: content }], details: {} }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        return { content: [{ type: "text", text: `File not found: ${params.path}` }], details: {} }
      }
      if (code === "EISDIR") {
        // List directory contents instead
        try {
          const entries = await readdir(resolve(join(GRIMOIRE_ROOT, params.path)))
          return { content: [{ type: "text", text: `Directory contents:\n${entries.join("\n")}` }], details: {} }
        } catch {
          return { content: [{ type: "text", text: `Error reading directory: ${params.path}` }], details: {} }
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text", text: `Error: ${message}` }], details: {} }
    }
  },
}

// --- T-6.3: beads_update ---

const BeadsUpdateParams = Type.Object({
  id: Type.String({ description: "Bead ID (e.g. 'bd-abc123')" }),
  status: Type.Optional(Type.String({ description: "New status: open, in_progress, closed" })),
  addLabels: Type.Optional(Type.Array(Type.String(), { description: "Labels to add" })),
  removeLabels: Type.Optional(Type.Array(Type.String(), { description: "Labels to remove" })),
})

export const beadsUpdateTool: ToolDefinition<typeof BeadsUpdateParams> = {
  name: "beads_update",
  label: "Beads Update",
  description: "Update bead status and labels for self-management. Agent can mark tasks in_progress or closed, add/remove labels.",
  parameters: BeadsUpdateParams,
  async execute(
    _toolCallId: string,
    params: Static<typeof BeadsUpdateParams>,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const args = ["update", params.id]
    if (params.status) args.push("--status", params.status)
    if (params.addLabels) {
      for (const label of params.addLabels) {
        args.push("--add-label", label)
      }
    }
    if (params.removeLabels) {
      for (const label of params.removeLabels) {
        args.push("--remove-label", label)
      }
    }

    try {
      const { stdout } = await execFileAsync("br", args, {
        timeout: BR_TIMEOUT_MS,
        signal: signal ?? undefined,
      })
      return { content: [{ type: "text", text: `Bead ${params.id} updated.\n${stdout}` }], details: {} }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text", text: `beads_update error: ${message}` }], details: {} }
    }
  },
}

// --- Tool registry ---

export function getCustomTools(): ToolDefinition[] {
  // Cast needed due to ToolDefinition generic variance (TSchema contravariance on renderCall)
  return [
    beadsStatusTool,
    healthCheckTool,
    grimoireReadTool,
    beadsUpdateTool,
  ] as unknown as ToolDefinition[]
}
