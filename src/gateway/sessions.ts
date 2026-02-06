// src/gateway/sessions.ts — Session router managing lifecycle (SDD §3.2, T-2.3)

import { createLoaSession } from "../agent/session.js"
import type { LoaSession } from "../agent/session.js"
import type { FinnConfig } from "../config.js"
import type { AgentSession } from "@mariozechner/pi-coding-agent"
import { readdirSync } from "node:fs"
import { join } from "node:path"

export interface SessionInfo {
  id: string
  created: number
  lastActivity: number
}

interface ManagedSession {
  loaSession: LoaSession
  created: number
  lastActivity: number
}

export class SessionRouter {
  private sessions = new Map<string, ManagedSession>()

  constructor(private config: FinnConfig) {}

  async create(): Promise<{ sessionId: string; session: AgentSession }> {
    const loaSession = await createLoaSession({ config: this.config })
    const now = Date.now()

    this.sessions.set(loaSession.sessionId, {
      loaSession,
      created: now,
      lastActivity: now,
    })

    return { sessionId: loaSession.sessionId, session: loaSession.session }
  }

  get(id: string): AgentSession | undefined {
    const managed = this.sessions.get(id)
    if (managed) {
      managed.lastActivity = Date.now()
      return managed.loaSession.session
    }
    return undefined
  }

  async resume(id: string): Promise<AgentSession | undefined> {
    // Check if already in memory
    const existing = this.get(id)
    if (existing) return existing

    // Try to load from JSONL
    try {
      const loaSession = await createLoaSession({
        config: this.config,
        existingSessionId: id,
      })
      const now = Date.now()

      this.sessions.set(id, {
        loaSession,
        created: now,
        lastActivity: now,
      })

      return loaSession.session
    } catch {
      return undefined
    }
  }

  list(): SessionInfo[] {
    const infos: SessionInfo[] = []
    for (const [id, managed] of this.sessions) {
      infos.push({
        id,
        created: managed.created,
        lastActivity: managed.lastActivity,
      })
    }
    return infos.sort((a, b) => b.lastActivity - a.lastActivity)
  }

  /** Discover session IDs from the session directory on disk */
  discoverOnDisk(): string[] {
    try {
      const entries = readdirSync(this.config.sessionDir, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  }

  getActiveCount(): number {
    return this.sessions.size
  }
}
