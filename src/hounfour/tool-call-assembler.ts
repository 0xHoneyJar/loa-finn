// src/hounfour/tool-call-assembler.ts — Incremental tool-call assembly (SDD §4.5, T-2.2)
//
// Assembles tool_calls from streaming SSE chunks. Tool calls arrive as
// incremental fragments (index, id, name, argument deltas) and must be
// assembled into complete ToolCall objects.

import type { ToolCall, StreamToolCallData } from "./types.js"

// --- Assembly State ---

export type AssemblyState = "pending" | "assembling" | "complete"

export interface AssemblyEntry {
  state: AssemblyState
  id: string
  name: string
  arguments: string        // Accumulated JSON fragments
  parseError?: string      // Set if arguments failed to parse on finalization
}

// --- ToolCallAssembler ---

/**
 * Incrementally assembles tool_calls from streaming SSE chunks.
 *
 * State machine per tool_call index:
 *   PENDING → ASSEMBLING → COMPLETE
 *
 * Transitions:
 *   - First chunk with id + name → ASSEMBLING
 *   - Subsequent chunks append to arguments string
 *   - When a NEW index starts AND the previous index's arguments parse
 *     as valid JSON → previous transitions to COMPLETE (early emit)
 *   - On "done" event → finalize ALL remaining ASSEMBLING calls
 *   - "tool_requested" event emitted only AFTER finalization
 */
export class ToolCallAssembler {
  private calls: Map<number, AssemblyEntry> = new Map()

  /**
   * Feed a StreamToolCallData chunk. May return newly completed ToolCalls
   * if a new index triggers early finalization of the previous index.
   */
  feed(data: StreamToolCallData): ToolCall[] {
    const completed: ToolCall[] = []
    const { index } = data

    let entry = this.calls.get(index)

    if (!entry) {
      // New tool_call — check if previous index can be early-finalized
      if (this.calls.size > 0) {
        const prevIndex = index - 1
        const prev = this.calls.get(prevIndex)
        if (prev && prev.state === "assembling") {
          const earlyResult = this.tryEarlyFinalize(prev)
          if (earlyResult) {
            completed.push(earlyResult)
          }
        }
      }

      entry = {
        state: "assembling",
        id: data.id ?? "",
        name: data.function?.name ?? "",
        arguments: data.function?.arguments ?? "",
      }
      this.calls.set(index, entry)
    } else {
      // Existing tool_call — accumulate
      if (data.id && !entry.id) entry.id = data.id
      if (data.function?.name && !entry.name) entry.name = data.function.name
      if (data.function?.arguments) {
        entry.arguments += data.function.arguments
      }
      entry.state = "assembling"
    }

    return completed
  }

  /**
   * Finalize all assembling calls (called on "done" event / finish_reason=tool_calls).
   * This is the PRIMARY completion path — most tool_calls complete here.
   * Returns all newly completed ToolCalls with parsed arguments.
   */
  finalize(): ToolCall[] {
    const completed: ToolCall[] = []

    for (const [index, entry] of this.calls) {
      if (entry.state === "assembling") {
        const result = this.tryFinalize(index, entry)
        if (result) {
          completed.push(result)
        }
      }
    }

    return completed
  }

  /**
   * All completed tool calls so far (including early-finalized ones).
   */
  getCompleted(): ToolCall[] {
    const results: ToolCall[] = []
    for (const [, entry] of this.calls) {
      if (entry.state === "complete") {
        results.push(this.entryToToolCall(entry))
      }
    }
    return results
  }

  /**
   * Get all entries (for inspection/debugging).
   */
  getEntries(): Map<number, AssemblyEntry> {
    return new Map(this.calls)
  }

  /**
   * Check if any assembled calls had parse errors.
   */
  hasParseErrors(): boolean {
    for (const [, entry] of this.calls) {
      if (entry.parseError) return true
    }
    return false
  }

  /**
   * Get entries with parse errors.
   */
  getParseErrors(): Array<{ index: number; entry: AssemblyEntry }> {
    const errors: Array<{ index: number; entry: AssemblyEntry }> = []
    for (const [index, entry] of this.calls) {
      if (entry.parseError) errors.push({ index, entry })
    }
    return errors
  }

  /** Reset state for reuse */
  reset(): void {
    this.calls.clear()
  }

  // --- Internal ---

  /**
   * Early finalization — only succeeds if arguments parse as valid JSON.
   * Does NOT mark as complete on parse error (unlike tryFinalize).
   */
  private tryEarlyFinalize(entry: AssemblyEntry): ToolCall | null {
    try {
      JSON.parse(entry.arguments)
      entry.state = "complete"
      return this.entryToToolCall(entry)
    } catch {
      // Don't early-finalize on parse failure — more fragments may arrive
      return null
    }
  }

  private tryFinalize(index: number, entry: AssemblyEntry): ToolCall | null {
    // Attempt JSON.parse on accumulated arguments
    try {
      JSON.parse(entry.arguments)
      entry.state = "complete"
      return this.entryToToolCall(entry)
    } catch {
      // Try relaxed parse (trailing comma removal)
      const relaxed = entry.arguments.replace(/,\s*([}\]])/g, "$1")
      try {
        JSON.parse(relaxed)
        entry.arguments = relaxed
        entry.state = "complete"
        return this.entryToToolCall(entry)
      } catch {
        // Mark as complete with parse error
        entry.state = "complete"
        entry.parseError = `Failed to parse arguments: ${entry.arguments.slice(0, 200)}`
        return this.entryToToolCall(entry)
      }
    }
  }

  private entryToToolCall(entry: AssemblyEntry): ToolCall {
    return {
      id: entry.id,
      type: "function",
      function: {
        name: entry.name,
        arguments: entry.arguments,
      },
    }
  }
}
