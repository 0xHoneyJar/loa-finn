// src/nft/conversation-summarizer.ts — Conversation Summarizer Service (T1.3 + T1.4)
//
// Best-effort summarization of conversation history using the cheapest
// available inference pool.  Returns null on any failure — never throws.

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Dependency-injection interface for the inference call. */
export interface SummarizerDeps {
  /** Generate a response from the cheap inference pool. */
  generateSummary: (systemPrompt: string, userContent: string) => Promise<string>
}

/** Shape of a single conversation message. */
export interface SummaryMessage {
  role: "user" | "assistant"
  content: string
  timestamp: number
}

/** Full input bundle (convenience wrapper). */
export interface SummaryInput {
  messages: SummaryMessage[]
  personalityName: string
}

// -----------------------------------------------------------------------------
// Agent Binding
// -----------------------------------------------------------------------------

/**
 * HounfourRouter binding for the summarizer agent.
 * `model` is resolved at runtime by the router to the cheapest pool.
 */
export const SUMMARIZER_AGENT_BINDING = {
  agent: "summarizer",
  model: "cheapest_available",
  temperature: 0.3,
  max_tokens: 250,
  tools: [],
} as const

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Approximate token-to-word ratio (1 token ~ 0.77 words => 1 word ~ 1.3 tokens). */
const TOKENS_PER_WORD = 1.3

/** Hard ceiling in estimated tokens. */
const MAX_TOKENS = 200

/** Derived word limit (floor to stay safely under token budget). */
const MAX_WORDS = Math.floor(MAX_TOKENS / TOKENS_PER_WORD) // 153

// -----------------------------------------------------------------------------
// Prompt
// -----------------------------------------------------------------------------

function buildSystemPrompt(personalityName: string): string {
  return [
    `You are a conversation summarizer for the personality "${personalityName}".`,
    "Produce a concise paragraph summarizing the conversation below.",
    "Requirements:",
    "- Capture the key topics discussed.",
    "- Note any decisions or commitments made.",
    "- Identify user interests and preferences revealed.",
    "- Output a single concise paragraph.",
    "- Stay under 200 tokens.",
  ].join("\n")
}

function formatTranscript(messages: SummaryMessage[]): string {
  return messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n")
}

// -----------------------------------------------------------------------------
// Truncation
// -----------------------------------------------------------------------------

/**
 * Truncate text to fit within the estimated token budget, cutting at a word
 * boundary so no word is split mid-way.
 */
function truncateToTokenBudget(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= MAX_WORDS) return text

  return words.slice(0, MAX_WORDS).join(" ")
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export class ConversationSummarizer {
  constructor(private deps: SummarizerDeps) {}

  /**
   * Generate a <=200-token summary of the provided messages.
   *
   * Returns `null` on **any** failure — the caller should treat summaries as
   * best-effort enrichment data.
   */
  async summarize(
    messages: SummaryMessage[],
    personalityName: string,
  ): Promise<string | null> {
    try {
      // Guard: nothing to summarize
      if (!messages || messages.length === 0) return null

      const systemPrompt = buildSystemPrompt(personalityName)
      const transcript = formatTranscript(messages)

      const raw = await this.deps.generateSummary(systemPrompt, transcript)

      // Guard: empty / whitespace-only response
      if (!raw || raw.trim().length === 0) return null

      return truncateToTokenBudget(raw.trim())
    } catch {
      // Best-effort: swallow and return null
      return null
    }
  }
}
