// src/agent/session.ts — createLoaSession() factory (SDD §3.1.1)

import { createAgentSession, SessionManager, readTool, editTool, writeTool, createBashTool } from "@mariozechner/pi-coding-agent"
import { getModel } from "@mariozechner/pi-ai"
import type { AgentSession } from "@mariozechner/pi-coding-agent"
import type { ThinkingLevel } from "@mariozechner/pi-ai"
import { createLoaResourceLoader } from "./resource-loader.js"
import { getCustomTools } from "./tools.js"
import { ToolSandbox } from "./sandbox.js"
import { AuditLog } from "./audit-log.js"
import type { FinnConfig } from "../config.js"
import { mkdirSync } from "node:fs"

export interface LoaSessionOptions {
  config: FinnConfig
  existingSessionId?: string
}

export interface LoaSession {
  session: AgentSession
  sessionId: string
}

export async function createLoaSession(options: LoaSessionOptions): Promise<LoaSession> {
  const { config, existingSessionId } = options

  // Ensure session directory exists
  mkdirSync(config.sessionDir, { recursive: true })

  // Create resource loader with Loa identity
  const resourceLoader = await createLoaResourceLoader({
    cwd: process.cwd(),
    beauvoirPath: config.beauvoirPath,
    notesPath: "grimoires/loa/NOTES.md",
  })

  // Resolve the model
  const model = getModel("anthropic", config.model as any)

  // Create or resume session manager
  let sessionManager: SessionManager
  if (existingSessionId) {
    sessionManager = SessionManager.open(
      `${config.sessionDir}/${existingSessionId}`,
      config.sessionDir,
    )
  } else {
    sessionManager = SessionManager.create(process.cwd(), config.sessionDir)
  }

  // Initialize sandbox (SDD §3.8)
  const auditLog = new AuditLog(config.dataDir)
  const sandbox = new ToolSandbox(config.sandbox, auditLog)

  // Create sandboxed bash tool using Pi SDK's BashOperations extension point
  const sandboxedBashTool = createBashTool(process.cwd(), {
    operations: {
      exec: async (command, _cwd, options) => {
        try {
          const result = sandbox.execute(command)
          // Stream stdout to the onData callback for Pi SDK truncation/display
          if (result.stdout) {
            options.onData(Buffer.from(result.stdout))
          }
          if (result.stderr) {
            options.onData(Buffer.from(result.stderr))
          }
          return { exitCode: result.exitCode }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          options.onData(Buffer.from(`[sandbox] ${message}\n`))
          return { exitCode: 1 }
        }
      },
    },
  })

  // Create the Pi agent session
  const { session } = await createAgentSession({
    model,
    thinkingLevel: config.thinkingLevel,
    tools: [readTool, sandboxedBashTool, editTool, writeTool],
    customTools: getCustomTools(),
    resourceLoader,
    sessionManager,
  })

  return {
    session,
    sessionId: session.sessionId,
  }
}
