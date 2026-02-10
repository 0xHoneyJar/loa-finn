// src/gateway/stream-bridge.ts — Orchestrator → WebSocket bridge (SDD §4.8, T-2.6)
//
// Maps OrchestratorEvent objects to WebSocket frames for real-time dashboard updates.
// Handles backpressure logging and WS close → orchestrator cancellation.

import type { WebSocket as WsWebSocket } from "ws"
import type { OrchestratorEvent, OrchestratorResult } from "../hounfour/orchestrator.js"

// --- WS Frame Types ---

export interface WsFrame {
  type: string
  [key: string]: unknown
}

// --- Backpressure ---

const BACKPRESSURE_THRESHOLD = 64 * 1024 // 64KB send buffer

// --- StreamBridge ---

export interface StreamBridgeOptions {
  /** Called when WS closes while forwarding — should cancel the orchestrator */
  onDisconnect?: () => void
  /** External AbortController — if not provided, one is created internally (T-A.8) */
  abortController?: AbortController
}

/**
 * Bridges Orchestrator streaming events to a WebSocket client.
 *
 * Phase 5 (T-A.8): AbortController propagation — WS close triggers abort
 * signal that flows through: WS close → StreamBridge → Orchestrator → SidecarClient.
 *
 * Event mapping:
 *   token          → { type: "token", delta }
 *   tool_requested → { type: "tool_call", name, id, status: "requested" }
 *   tool_executing → { type: "tool_call", name, id, status: "executing" }
 *   tool_executed  → { type: "tool_call", name, id, status: "executed", isError, cached }
 *   tool_result_fed → { type: "tool_call", name, id, status: "result_fed" }
 *   budget_check   → { type: "budget", exceeded, remainingUsd }
 *   stream_start   → { type: "stream_start", iteration }
 *   iteration_start → { type: "iteration", status: "start", iteration }
 *   iteration_complete → { type: "iteration", status: "complete", iteration, usage }
 *   loop_complete  → { type: "complete", totalToolCalls, wallTimeMs }
 *   loop_error     → { type: "error", code, message }
 */
export class StreamBridge {
  private closed = false
  private backpressureWarned = false
  private abortController: AbortController

  constructor(
    private ws: WsWebSocket,
    private options?: StreamBridgeOptions,
  ) {
    this.abortController = options?.abortController ?? new AbortController()

    // Wire WS close → AbortController.abort() (T-A.8)
    this.ws.addEventListener("close", () => {
      if (!this.abortController.signal.aborted) {
        this.abortController.abort()
      }
    }, { once: true })
  }

  /** Get the abort signal to pass to the orchestrator */
  get signal(): AbortSignal {
    return this.abortController.signal
  }

  /**
   * Forward events from Orchestrator's streaming generator.
   * Returns when the generator completes or the WS disconnects.
   */
  async forward(
    events: AsyncGenerator<OrchestratorEvent, OrchestratorResult>,
  ): Promise<OrchestratorResult | null> {
    // Watch for WS close
    const closePromise = new Promise<void>((resolve) => {
      this.ws.addEventListener("close", () => {
        this.closed = true
        resolve()
      }, { once: true })
    })

    // If already closed, signal disconnect
    if (this.ws.readyState !== 1 /* OPEN */) {
      this.closed = true
      this.options?.onDisconnect?.()
      return null
    }

    try {
      while (true) {
        // Race: next event vs WS close
        const nextResult = events.next()

        const { value, done } = await nextResult

        if (this.closed) {
          this.options?.onDisconnect?.()
          // Try to gracefully return the generator
          await events.return(undefined as any).catch(() => {})
          return null
        }

        if (done) {
          // Generator completed — send final result
          const result = value as OrchestratorResult
          this.send({
            type: "complete",
            totalToolCalls: result.totalToolCalls,
            wallTimeMs: result.wallTimeMs,
            iterations: result.iterations,
            content: result.result.content,
            abortReason: result.abortReason,
          })
          return result
        }

        // Map OrchestratorEvent → WS frame
        const frame = this.mapEvent(value as OrchestratorEvent)
        if (frame) {
          this.send(frame)
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.send({
          type: "error",
          code: "BRIDGE_ERROR",
          message: err instanceof Error ? err.message : String(err),
        })
      }
      return null
    }
  }

  private mapEvent(event: OrchestratorEvent): WsFrame | null {
    switch (event.type) {
      case "token":
        return {
          type: "token",
          delta: event.data.delta,
          runningTokenCount: event.data.runningTokenCount,
        }

      case "tool_requested":
        return {
          type: "tool_call",
          name: event.data.toolName,
          id: event.data.toolCallId,
          status: "requested",
        }

      case "tool_executing":
        return {
          type: "tool_call",
          name: event.data.toolName,
          id: event.data.toolCallId,
          status: "executing",
        }

      case "tool_executed":
        return {
          type: "tool_call",
          name: event.data.toolName,
          id: event.data.toolCallId,
          status: "executed",
          isError: event.data.isError,
          cached: event.data.cached,
        }

      case "tool_result_fed":
        return {
          type: "tool_call",
          name: event.data.toolName,
          id: event.data.toolCallId,
          status: "result_fed",
        }

      case "budget_check":
        return {
          type: "budget",
          exceeded: event.data.exceeded,
          remainingUsd: event.data.remainingUsd,
        }

      case "stream_start":
        return {
          type: "stream_start",
          iteration: event.iteration,
        }

      case "iteration_start":
        return {
          type: "iteration",
          status: "start",
          iteration: event.iteration,
          totalToolCalls: event.data.totalToolCalls,
        }

      case "iteration_complete":
        return {
          type: "iteration",
          status: "complete",
          iteration: event.iteration,
          usage: event.data.usage,
          streamed: event.data.streamed,
        }

      case "loop_complete":
        // Handled in forward() after generator returns
        return null

      case "loop_error":
        return {
          type: "error",
          code: event.data.code,
          message: event.data.message,
        }

      default:
        return null
    }
  }

  private send(frame: WsFrame): void {
    if (this.closed || this.ws.readyState !== 1) return

    // Backpressure check
    if (this.ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
      if (!this.backpressureWarned) {
        console.warn(`[stream-bridge] WS backpressure: ${this.ws.bufferedAmount} bytes buffered`)
        this.backpressureWarned = true
      }
    } else {
      this.backpressureWarned = false
    }

    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      // WS send failure — mark as closed
      this.closed = true
    }
  }
}
