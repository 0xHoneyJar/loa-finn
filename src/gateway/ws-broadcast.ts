// src/gateway/ws-broadcast.ts — WebSocket event broadcaster (SDD §3.2.2, TASK-3.7)
// Bridges EventEmitter events from CronService to connected WebSocket clients.

import { EventEmitter } from "node:events"

/** Duck-typed WebSocket client interface. */
export interface BroadcastClient {
  send(data: string): void
  readonly readyState?: number
}

/** Event types relayed from CronService to WebSocket clients. */
export const BROADCAST_EVENTS = [
  "job:started",
  "job:completed",
  "job:failed",
  "job:skipped",
  "github:mutation",
  "github:denied",
  "circuit:opened",
  "circuit:closed",
  "kill-switch",
  "alert",
] as const

export type BroadcastEventType = (typeof BROADCAST_EVENTS)[number]

export interface BroadcastMessage {
  type: BroadcastEventType
  timestamp: string
  data: unknown
}

/**
 * Subscribes to EventEmitter events and JSON-broadcasts them
 * to all connected WebSocket clients.
 */
export class EventBroadcaster {
  private clients = new Set<BroadcastClient>()
  private source: EventEmitter
  private handlers = new Map<string, (...args: unknown[]) => void>()

  constructor(source: EventEmitter) {
    this.source = source
  }

  /** Subscribe to all BROADCAST_EVENTS on the source emitter. */
  start(): void {
    for (const event of BROADCAST_EVENTS) {
      const handler = (data: unknown) => this.broadcast(event, data)
      this.handlers.set(event, handler)
      this.source.on(event, handler)
    }
  }

  /** Unsubscribe from all events and disconnect all clients. */
  stop(): void {
    for (const [event, handler] of this.handlers) {
      this.source.off(event, handler)
    }
    this.handlers.clear()
    this.clients.clear()
  }

  addClient(client: BroadcastClient): void {
    this.clients.add(client)
  }

  removeClient(client: BroadcastClient): void {
    this.clients.delete(client)
  }

  getClientCount(): number {
    return this.clients.size
  }

  /** JSON-serialize and send a message to every connected client. */
  private broadcast(type: BroadcastEventType, data: unknown): void {
    const message: BroadcastMessage = {
      type,
      timestamp: new Date().toISOString(),
      data,
    }
    const json = JSON.stringify(message)
    for (const client of this.clients) {
      try {
        client.send(json)
      } catch {
        // Remove clients that error on send (likely disconnected)
        this.clients.delete(client)
      }
    }
  }
}
