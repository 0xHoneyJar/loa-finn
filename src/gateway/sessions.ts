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

const MAX_SESSIONS = 100
const SESSION_IDLE_MS = 30 * 60 * 1000 // 30 minutes

export class SessionRouter {
  private sessions = new Map<string, ManagedSession>()
  private evictionTimer: ReturnType<typeof setInterval>

  constructor(private config: FinnConfig) {
    // Evict idle sessions every 60s
    this.evictionTimer = setInterval(() => this.evictIdle(), 60_000)
    this.evictionTimer.unref()
  }

  async create(): Promise<{ sessionId: string; session: AgentSession }> {
    if (this.sessions.size >= MAX_SESSIONS) {
      // Evict oldest idle session to make room
      this.evictIdle()
      if (this.sessions.size >= MAX_SESSIONS) {
        throw new Error(`Session limit reached (${MAX_SESSIONS})`)
      }
    }

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

  /** Evict sessions idle longer than SESSION_IDLE_MS. Returns count evicted. */
  private evictIdle(): number {
    const now = Date.now()
    let evicted = 0
    for (const [id, managed] of this.sessions) {
      if (now - managed.lastActivity > SESSION_IDLE_MS) {
        this.sessions.delete(id)
        evicted++
      }
    }
    if (evicted > 0) {
      console.log(`[sessions] evicted ${evicted} idle sessions`)
    }
    return evicted
  }

  /** Clean up resources (stop eviction timer). */
  destroy(): void {
    clearInterval(this.evictionTimer)
  }
}
