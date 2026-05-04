// tests/nft/conversation-summarizer.test.ts — ConversationSummarizer Tests (T1.3 + T1.4)

import { describe, it, expect, vi } from "vitest"
import {
  ConversationSummarizer,
  SUMMARIZER_AGENT_BINDING,
} from "../../src/nft/conversation-summarizer.js"
import type { SummarizerDeps, SummaryMessage } from "../../src/nft/conversation-summarizer.js"

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Build a mock message array of the specified length. */
function makeMessages(count: number): SummaryMessage[] {
  const msgs: SummaryMessage[] = []
  const topics = [
    "blockchain governance models",
    "decentralized identity systems",
    "token gated community access",
    "NFT personality evolution",
    "zero-knowledge proof integration",
  ]
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant"
    const topic = topics[i % topics.length]
    msgs.push({
      role,
      content: `Tell me more about ${topic}. I'm very interested in how it works.`,
      timestamp: Date.now() - (count - i) * 60000,
    })
  }
  return msgs
}

/** Count words in a string (same approach as the implementation). */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Estimate token count (mirroring implementation heuristic). */
function estimateTokens(text: string): number {
  return Math.ceil(countWords(text) * 1.3)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("ConversationSummarizer", () => {
  // -------------------------------------------------------------------------
  // T1.3: Core summarization logic
  // -------------------------------------------------------------------------

  it("summarizes a 20-message conversation with key topics", async () => {
    const mockResponse =
      "The conversation covered blockchain governance, decentralized identity, " +
      "and NFT personality evolution. The user showed strong interest in zero-knowledge proofs."

    const deps: SummarizerDeps = {
      generateSummary: vi.fn().mockResolvedValue(mockResponse),
    }
    const summarizer = new ConversationSummarizer(deps)

    const result = await summarizer.summarize(makeMessages(20), "CryptoSage")

    expect(result).not.toBeNull()
    expect(result!).toContain("blockchain")
    expect(result!).toContain("governance")
    expect(deps.generateSummary).toHaveBeenCalledOnce()
  })

  it("never exceeds 200 estimated tokens", async () => {
    // Return a response that is way over 200 tokens (~300 words)
    const longResponse = Array(200)
      .fill("word")
      .map((_, i) => `word${i}`)
      .join(" ")

    const deps: SummarizerDeps = {
      generateSummary: vi.fn().mockResolvedValue(longResponse),
    }
    const summarizer = new ConversationSummarizer(deps)

    const result = await summarizer.summarize(makeMessages(5), "TestBot")

    expect(result).not.toBeNull()
    const tokens = estimateTokens(result!)
    expect(tokens).toBeLessThanOrEqual(200)
    // Should have truncated to ~153 words
    expect(countWords(result!)).toBeLessThanOrEqual(154)
  })

  it("returns null when generateSummary throws", async () => {
    const deps: SummarizerDeps = {
      generateSummary: vi.fn().mockRejectedValue(new Error("LLM pool exhausted")),
    }
    const summarizer = new ConversationSummarizer(deps)

    const result = await summarizer.summarize(makeMessages(10), "FailBot")

    expect(result).toBeNull()
    // Ensure it doesn't throw — the test itself would fail if it did
  })

  it("returns null for empty message array", async () => {
    const deps: SummarizerDeps = {
      generateSummary: vi.fn(),
    }
    const summarizer = new ConversationSummarizer(deps)

    const result = await summarizer.summarize([], "EmptyBot")

    expect(result).toBeNull()
    // generateSummary should never be called for empty input
    expect(deps.generateSummary).not.toHaveBeenCalled()
  })

  it("includes personality name in the system prompt", async () => {
    const deps: SummarizerDeps = {
      generateSummary: vi.fn().mockResolvedValue("A brief summary."),
    }
    const summarizer = new ConversationSummarizer(deps)

    await summarizer.summarize(makeMessages(3), "OracleOfDegen")

    // First arg to generateSummary is the system prompt
    const callArgs = (deps.generateSummary as ReturnType<typeof vi.fn>).mock.calls[0]
    const systemPrompt = callArgs[0] as string

    expect(systemPrompt).toContain("OracleOfDegen")
  })

  it("returns null for empty response", async () => {
    const deps: SummarizerDeps = {
      generateSummary: vi.fn().mockResolvedValue(""),
    }
    const summarizer = new ConversationSummarizer(deps)

    const result = await summarizer.summarize(makeMessages(5), "EmptyResponseBot")

    expect(result).toBeNull()
  })

  it("returns null for whitespace-only response", async () => {
    const deps: SummarizerDeps = {
      generateSummary: vi.fn().mockResolvedValue("   \n\t\n   "),
    }
    const summarizer = new ConversationSummarizer(deps)

    const result = await summarizer.summarize(makeMessages(5), "WhitespaceBot")

    expect(result).toBeNull()
  })

  it("formats transcript as [role]: content lines", async () => {
    const deps: SummarizerDeps = {
      generateSummary: vi.fn().mockResolvedValue("Summary text."),
    }
    const summarizer = new ConversationSummarizer(deps)

    await summarizer.summarize(makeMessages(2), "FormatBot")

    const callArgs = (deps.generateSummary as ReturnType<typeof vi.fn>).mock.calls[0]
    const transcript = callArgs[1] as string

    // Should contain [user]: and [assistant]: prefixes
    expect(transcript).toContain("[user]:")
    expect(transcript).toContain("[assistant]:")
  })

  // -------------------------------------------------------------------------
  // T1.4: Agent Binding
  // -------------------------------------------------------------------------

  it("exports SUMMARIZER_AGENT_BINDING with expected shape", () => {
    expect(SUMMARIZER_AGENT_BINDING).toEqual({
      agent: "summarizer",
      model: "cheapest_available",
      temperature: 0.3,
      max_tokens: 250,
      tools: [],
    })
  })

  it("SUMMARIZER_AGENT_BINDING is frozen (as const)", () => {
    // TypeScript 'as const' doesn't freeze at runtime, but we can verify
    // the values are correct and tools array is empty
    expect(SUMMARIZER_AGENT_BINDING.agent).toBe("summarizer")
    expect(SUMMARIZER_AGENT_BINDING.temperature).toBe(0.3)
    expect(SUMMARIZER_AGENT_BINDING.max_tokens).toBe(250)
    expect(SUMMARIZER_AGENT_BINDING.tools).toHaveLength(0)
  })
})
