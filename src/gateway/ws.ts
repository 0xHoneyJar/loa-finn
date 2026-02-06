// src/gateway/ws.ts — WebSocket handler with Pi event bridging (SDD §3.2.2, T-2.4)

import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import type { FinnConfig } from "../config.js"
import { validateWsToken } from "./auth.js"

// WebSocket message types: Client → Server
interface PromptMessage { type: "prompt"; text: string }
interface SteerMessage { type: "steer"; text: string }
interface AbortMessage { type: "abort" }
interface PingMessage { type: "ping" }
type ClientMessage = PromptMessage | SteerMessage | AbortMessage | PingMessage

// WebSocket message types: Server → Client
interface WsOutMessage {
  type: string
  data?: Record<string, unknown>
}

const MAX_PAYLOAD_BYTES = 1_048_576 // 1MB
const IDLE_TIMEOUT_MS = 300_000 // 5 minutes
const MAX_CONNECTIONS_PER_IP = 5

// Track connections per IP
const ipConnections = new Map<string, number>()

export interface WsHandlerOptions {
  config: FinnConfig
  getSession: (id: string) => AgentSession | undefined
  resumeSession: (id: string) => Promise<AgentSession | undefined>
}

export function handleWebSocket(
  ws: WebSocket,
  sessionId: string,
  clientIp: string,
  options: WsHandlerOptions,
): void {
  const { config } = options

  // Connection cap per IP
  const currentCount = ipConnections.get(clientIp) ?? 0
  if (currentCount >= MAX_CONNECTIONS_PER_IP) {
    ws.close(4029, "Too many connections from this IP")
    return
  }
  ipConnections.set(clientIp, currentCount + 1)

  let session: AgentSession | undefined
  let unsubscribe: (() => void) | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let authenticated = false

  function send(msg: WsOutMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      ws.close(1000, "Idle timeout")
    }, IDLE_TIMEOUT_MS)
  }

  function bridgeEvents(agentSession: AgentSession): () => void {
    return agentSession.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "message_end": {
          const msg = event.message
          if (msg.role === "assistant" && msg.content) {
            for (const block of msg.content) {
              if (block.type === "text") {
                send({ type: "text_delta", data: { delta: block.text } })
              }
            }
          }
          break
        }
        case "tool_execution_start":
          send({ type: "tool_start", data: { toolName: event.toolName, args: event.args } })
          break
        case "tool_execution_end":
          send({
            type: "tool_end",
            data: {
              toolName: event.toolName,
              result: typeof event.result === "string"
                ? event.result
                : JSON.stringify(event.result),
              isError: event.isError,
            },
          })
          break
        case "turn_end":
          send({ type: "turn_end", data: {} })
          break
        case "agent_end":
          send({ type: "agent_end", data: {} })
          break
        case "auto_compaction_start":
          send({ type: "compaction", data: { reason: event.reason } })
          break
      }
    })
  }

  async function init(): Promise<void> {
    session = options.getSession(sessionId) ?? await options.resumeSession(sessionId)
    if (!session) {
      send({ type: "error", data: { message: "Session not found", recoverable: false } })
      ws.close(4004, "Session not found")
      return
    }
    unsubscribe = bridgeEvents(session)
    resetIdleTimer()
  }

  // Handle messages
  ws.addEventListener("message", async (event) => {
    resetIdleTimer()

    const rawData = typeof event.data === "string" ? event.data : ""

    // Payload size check
    if (rawData.length > MAX_PAYLOAD_BYTES) {
      ws.close(1009, "Message too large")
      return
    }

    let msg: ClientMessage
    try {
      msg = JSON.parse(rawData)
    } catch {
      send({ type: "error", data: { message: "Invalid JSON", recoverable: true } })
      return
    }

    // Auth via first message if not yet authenticated
    if (!authenticated && config.auth.bearerToken) {
      // Check if this is an auth message
      if ("token" in msg && typeof (msg as any).token === "string") {
        if (validateWsToken((msg as any).token, config)) {
          authenticated = true
          send({ type: "authenticated", data: {} })
          return
        } else {
          send({ type: "error", data: { message: "Unauthorized", recoverable: false } })
          ws.close(4001, "Unauthorized")
          return
        }
      }
    }

    if (!session) {
      send({ type: "error", data: { message: "Session not initializing", recoverable: true } })
      return
    }

    switch (msg.type) {
      case "prompt":
        if (!msg.text?.trim()) {
          send({ type: "error", data: { message: "Empty prompt", recoverable: true } })
          return
        }
        try {
          await session.prompt(msg.text)
        } catch (err) {
          send({
            type: "error",
            data: { message: err instanceof Error ? err.message : "Prompt failed", recoverable: true },
          })
        }
        break

      case "steer":
        if (msg.text?.trim()) {
          await session.steer(msg.text)
        }
        break

      case "abort":
        await session.abort()
        break

      case "ping":
        send({ type: "pong" })
        break

      default:
        send({ type: "error", data: { message: `Unknown message type: ${(msg as any).type}`, recoverable: true } })
    }
  })

  ws.addEventListener("close", () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (unsubscribe) unsubscribe()
    const count = (ipConnections.get(clientIp) ?? 1) - 1
    if (count <= 0) ipConnections.delete(clientIp)
    else ipConnections.set(clientIp, count)
  })

  ws.addEventListener("error", () => {
    ws.close(1011, "Internal error")
  })

  // Validate auth from query string (done before this function is called)
  // and initialize the session
  authenticated = !config.auth.bearerToken // Auto-auth if no token configured
  init().catch((err) => {
    console.error(`[ws] session init error for ${sessionId}:`, err)
    send({ type: "error", data: { message: "Session init failed", recoverable: false } })
    ws.close(1011, "Session init failed")
  })
}
