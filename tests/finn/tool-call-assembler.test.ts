// tests/finn/tool-call-assembler.test.ts — ToolCallAssembler tests (T-2.2)

import { describe, it, expect, beforeEach } from "vitest"
import { ToolCallAssembler } from "../../src/hounfour/tool-call-assembler.js"
import type { StreamToolCallData } from "../../src/hounfour/types.js"

describe("ToolCallAssembler", () => {
  let assembler: ToolCallAssembler

  beforeEach(() => {
    assembler = new ToolCallAssembler()
  })

  // --- Basic Assembly ---

  it("assembles a single tool call from fragments", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } })
    assembler.feed({ index: 0, function: { arguments: '{"loc' } })
    assembler.feed({ index: 0, function: { arguments: 'ation": "NYC"}' } })

    const completed = assembler.finalize()
    expect(completed).toHaveLength(1)
    expect(completed[0].id).toBe("call_1")
    expect(completed[0].function.name).toBe("get_weather")
    expect(completed[0].function.arguments).toBe('{"location": "NYC"}')
    expect(completed[0].type).toBe("function")
  })

  it("assembles complete arguments in a single chunk", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"bar": 42}' } })

    const completed = assembler.finalize()
    expect(completed).toHaveLength(1)
    expect(JSON.parse(completed[0].function.arguments)).toEqual({ bar: 42 })
  })

  // --- Multi-tool Assembly ---

  it("assembles multiple tool calls", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city": "NYC"}' } })
    // Feeding index 1 early-finalizes index 0 (valid JSON)
    const earlyCompleted = assembler.feed({ index: 1, id: "call_2", function: { name: "get_time", arguments: '{"tz": "EST"}' } })

    expect(earlyCompleted).toHaveLength(1)
    expect(earlyCompleted[0].function.name).toBe("get_weather")

    const finalCompleted = assembler.finalize()
    expect(finalCompleted).toHaveLength(1)
    expect(finalCompleted[0].function.name).toBe("get_time")

    // getCompleted should return both
    const all = assembler.getCompleted()
    expect(all).toHaveLength(2)
  })

  it("early-finalizes previous index when new index starts", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"a": 1}' } })
    // Starting index 1 should early-finalize index 0 since its args parse as JSON
    const earlyCompleted = assembler.feed({ index: 1, id: "call_2", function: { name: "bar", arguments: "" } })

    expect(earlyCompleted).toHaveLength(1)
    expect(earlyCompleted[0].id).toBe("call_1")
    expect(earlyCompleted[0].function.name).toBe("foo")

    // Finalize the rest
    assembler.feed({ index: 1, function: { arguments: '{"b": 2}' } })
    const finalCompleted = assembler.finalize()
    expect(finalCompleted).toHaveLength(1)
    expect(finalCompleted[0].id).toBe("call_2")
  })

  it("does not early-finalize if arguments are incomplete JSON", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"a": ' } })
    // Starting index 1 — index 0 args don't parse, so no early finalization
    const earlyCompleted = assembler.feed({ index: 1, id: "call_2", function: { name: "bar", arguments: "" } })
    expect(earlyCompleted).toHaveLength(0)

    // Complete index 0's arguments
    assembler.feed({ index: 0, function: { arguments: "1}" } })

    const completed = assembler.finalize()
    // Both should finalize now
    expect(completed).toHaveLength(2)
  })

  // --- finalize() ---

  it("finalize returns empty array when no tool calls", () => {
    const completed = assembler.finalize()
    expect(completed).toHaveLength(0)
  })

  it("finalize does not re-emit already-completed calls", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"a":1}' } })
    assembler.feed({ index: 1, id: "call_2", function: { name: "bar", arguments: '{"b":2}' } })

    // Early-finalize index 0 by triggering index 1
    // (already happened in feed above)

    const completed = assembler.finalize()
    // Only index 1 should be in finalize results since index 0 was already early-finalized
    // Actually both may finalize here since early-finalize requires previous index
    // The feed for index 1 early-finalizes index 0
    // So finalize only gets index 1
    expect(completed).toHaveLength(1)
    expect(completed[0].id).toBe("call_2")
  })

  // --- Parse Error Handling ---

  it("marks unparseable arguments with parseError", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: "not json at all" } })

    const completed = assembler.finalize()
    expect(completed).toHaveLength(1)
    expect(completed[0].function.arguments).toBe("not json at all")
    expect(assembler.hasParseErrors()).toBe(true)
    expect(assembler.getParseErrors()).toHaveLength(1)
    expect(assembler.getParseErrors()[0].entry.parseError).toContain("Failed to parse")
  })

  it("handles trailing comma in arguments (relaxed parse)", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"a": 1,}' } })

    const completed = assembler.finalize()
    expect(completed).toHaveLength(1)
    // Relaxed parse should strip trailing comma
    expect(JSON.parse(completed[0].function.arguments)).toEqual({ a: 1 })
    expect(assembler.hasParseErrors()).toBe(false)
  })

  it("handles trailing comma in array arguments", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"items": [1, 2,]}' } })

    const completed = assembler.finalize()
    expect(completed).toHaveLength(1)
    expect(JSON.parse(completed[0].function.arguments)).toEqual({ items: [1, 2] })
  })

  // --- getCompleted ---

  it("getCompleted returns all completed calls", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"a":1}' } })
    assembler.feed({ index: 1, id: "call_2", function: { name: "bar", arguments: '{"b":2}' } })
    assembler.finalize()

    const all = assembler.getCompleted()
    expect(all).toHaveLength(2)
  })

  // --- State Inspection ---

  it("getEntries returns internal state", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"partial' } })
    const entries = assembler.getEntries()
    expect(entries.size).toBe(1)
    expect(entries.get(0)!.state).toBe("assembling")
  })

  // --- Reset ---

  it("reset clears all state", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: '{"a":1}' } })
    assembler.reset()
    expect(assembler.getEntries().size).toBe(0)
    expect(assembler.finalize()).toHaveLength(0)
  })

  // --- Edge Cases ---

  it("handles empty arguments string", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "foo", arguments: "" } })
    assembler.feed({ index: 0, function: { arguments: "{}" } })

    const completed = assembler.finalize()
    expect(completed).toHaveLength(1)
    expect(completed[0].function.arguments).toBe("{}")
  })

  it("handles id and name arriving in separate chunks", () => {
    // First chunk has id but no name
    assembler.feed({ index: 0, id: "call_1", function: { arguments: "" } })
    // Second chunk has name
    assembler.feed({ index: 0, function: { name: "delayed_name", arguments: '{"x":1}' } })

    const completed = assembler.finalize()
    expect(completed).toHaveLength(1)
    expect(completed[0].id).toBe("call_1")
    expect(completed[0].function.name).toBe("delayed_name")
  })

  it("handles large arguments across many fragments", () => {
    assembler.feed({ index: 0, id: "call_1", function: { name: "big", arguments: "" } })

    // Build a large JSON string in small fragments
    const parts = ['{"data": "']
    for (let i = 0; i < 100; i++) {
      parts.push(`chunk_${i}_`)
    }
    parts.push('"}')
    const fullArgs = parts.join("")

    // Feed one character at a time for the first 20 chars, then rest in bulk
    for (let i = 0; i < Math.min(20, fullArgs.length); i++) {
      assembler.feed({ index: 0, function: { arguments: fullArgs[i] } })
    }
    if (fullArgs.length > 20) {
      assembler.feed({ index: 0, function: { arguments: fullArgs.slice(20) } })
    }

    const completed = assembler.finalize()
    expect(completed).toHaveLength(1)
    expect(JSON.parse(completed[0].function.arguments)).toBeTruthy()
  })
})
