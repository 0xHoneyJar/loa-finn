// src/agent/session.ts — createLoaSession() factory (SDD §3.1.1)

import { createAgentSession, SessionManager, codingTools } from "@mariozechner/pi-coding-agent"
import { getModel } from "@mariozechner/pi-ai"
import type { AgentSession } from "@mariozechner/pi-coding-agent"
import type { ThinkingLevel } from "@mariozechner/pi-ai"
import { createLoaResourceLoader } from "./resource-loader.js"
import { getCustomTools } from "./tools.js"
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

  // Create the Pi agent session
  const { session } = await createAgentSession({
    model,
    thinkingLevel: config.thinkingLevel,
    tools: codingTools,
    customTools: getCustomTools(),
    resourceLoader,
    sessionManager,
  })

  return {
    session,
    sessionId: session.sessionId,
  }
}
