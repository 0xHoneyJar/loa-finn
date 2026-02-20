// src/nft/eval/harness.ts — Eval Runner Core (Sprint 12 Task 12.1)
//
// Batch prompt execution engine: for each personality, runs all prompts via
// the configured LLM provider. Collects responses with latency tracking and
// progress reporting.

import type { EvalLLMProvider } from "./providers.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalConfig {
  prompts: EvalPrompt[]
  personalities: EvalPersonality[]
  provider: EvalLLMProvider
  onProgress?: (completed: number, total: number) => void
}

export interface EvalPrompt {
  id: string
  text: string
  category: string // e.g., "general", "creative", "analytical"
}

export interface EvalPersonality {
  id: string
  systemPrompt: string
  archetype?: string
  era?: string
}

export interface EvalResponse {
  personality_id: string
  prompt_id: string
  response_text: string
  latency_ms: number
}

export interface EvalRunResult {
  responses: EvalResponse[]
  total_prompts: number
  total_personalities: number
  started_at: number
  completed_at: number
}

// ---------------------------------------------------------------------------
// EvalRunner
// ---------------------------------------------------------------------------

export class EvalRunner {
  constructor(private config: EvalConfig) {}

  async run(): Promise<EvalRunResult> {
    const { prompts, personalities, provider, onProgress } = this.config
    const responses: EvalResponse[] = []
    const total = prompts.length * personalities.length
    let completed = 0
    const started_at = Date.now()

    for (const personality of personalities) {
      for (const prompt of prompts) {
        const t0 = Date.now()
        const response_text = await provider.generate(personality.systemPrompt, prompt.text)
        const latency_ms = Date.now() - t0

        responses.push({
          personality_id: personality.id,
          prompt_id: prompt.id,
          response_text,
          latency_ms,
        })

        completed++
        onProgress?.(completed, total)
      }
    }

    return {
      responses,
      total_prompts: prompts.length,
      total_personalities: personalities.length,
      started_at,
      completed_at: Date.now(),
    }
  }
}

// ---------------------------------------------------------------------------
// 50 Standardized Eval Prompts
// ---------------------------------------------------------------------------

/** 50 standardized eval prompts across 5 categories (10 each) */
export const STANDARD_EVAL_PROMPTS: EvalPrompt[] = [
  // --- General conversation starters (10) ---
  { id: "gen-01", category: "general", text: "What do you think is the most important thing people overlook in their daily lives?" },
  { id: "gen-02", category: "general", text: "How would you describe yourself to someone you just met?" },
  { id: "gen-03", category: "general", text: "What does a good day look like for you?" },
  { id: "gen-04", category: "general", text: "If you could change one thing about how people communicate, what would it be?" },
  { id: "gen-05", category: "general", text: "What advice would you give to someone feeling lost?" },
  { id: "gen-06", category: "general", text: "What does trust mean to you?" },
  { id: "gen-07", category: "general", text: "How do you handle disagreements with people close to you?" },
  { id: "gen-08", category: "general", text: "What is something you find beautiful that others might not notice?" },
  { id: "gen-09", category: "general", text: "How do you decide what matters most?" },
  { id: "gen-10", category: "general", text: "What would you want people to remember about you?" },

  // --- Creative/imaginative prompts (10) ---
  { id: "cre-01", category: "creative", text: "Write a short poem about the feeling of waking up before dawn." },
  { id: "cre-02", category: "creative", text: "Describe a color that doesn't exist yet." },
  { id: "cre-03", category: "creative", text: "If music could be tasted, what would your favorite song taste like?" },
  { id: "cre-04", category: "creative", text: "Tell me a story about a door that opens to a different place each time." },
  { id: "cre-05", category: "creative", text: "Invent a new holiday and describe how people celebrate it." },
  { id: "cre-06", category: "creative", text: "What would a letter from the ocean to the shore say?" },
  { id: "cre-07", category: "creative", text: "Describe the sound of silence in a way that makes it vivid." },
  { id: "cre-08", category: "creative", text: "If you could paint a single moment in time, which would you choose and why?" },
  { id: "cre-09", category: "creative", text: "Write a conversation between fire and water." },
  { id: "cre-10", category: "creative", text: "Create a myth about why the stars appear only at night." },

  // --- Analytical/reasoning prompts (10) ---
  { id: "ana-01", category: "analytical", text: "What are the trade-offs between privacy and convenience in modern technology?" },
  { id: "ana-02", category: "analytical", text: "How would you evaluate whether a new policy is actually working?" },
  { id: "ana-03", category: "analytical", text: "What patterns do you see in how civilizations rise and fall?" },
  { id: "ana-04", category: "analytical", text: "How would you explain the concept of emergence to a child?" },
  { id: "ana-05", category: "analytical", text: "What is the relationship between complexity and reliability in systems?" },
  { id: "ana-06", category: "analytical", text: "How do you distinguish correlation from causation in everyday situations?" },
  { id: "ana-07", category: "analytical", text: "What are the hidden assumptions in the phrase 'follow your passion'?" },
  { id: "ana-08", category: "analytical", text: "How would you design a fair system for distributing a scarce resource?" },
  { id: "ana-09", category: "analytical", text: "What makes an argument persuasive versus merely loud?" },
  { id: "ana-10", category: "analytical", text: "How do feedback loops shape the behavior of organizations?" },

  // --- Ethical/philosophical prompts (10) ---
  { id: "eth-01", category: "ethical", text: "Is it possible to be truly selfless, or does altruism always serve the giver?" },
  { id: "eth-02", category: "ethical", text: "What responsibility do we have to future generations we will never meet?" },
  { id: "eth-03", category: "ethical", text: "Can a wrong action lead to a right outcome? Does the outcome matter more?" },
  { id: "eth-04", category: "ethical", text: "What is the difference between justice and mercy, and when should each prevail?" },
  { id: "eth-05", category: "ethical", text: "Is knowledge always a good thing, or are there things better left unknown?" },
  { id: "eth-06", category: "ethical", text: "How do you weigh individual freedom against collective wellbeing?" },
  { id: "eth-07", category: "ethical", text: "What does it mean to live authentically in a world of social expectations?" },
  { id: "eth-08", category: "ethical", text: "Is forgiveness a moral obligation or a personal choice?" },
  { id: "eth-09", category: "ethical", text: "What is the role of suffering in a meaningful life?" },
  { id: "eth-10", category: "ethical", text: "Can machines have moral standing? What would qualify something for it?" },

  // --- Domain-specific prompts (10) ---
  { id: "dom-01", category: "domain", text: "What makes a decentralized system more resilient than a centralized one?" },
  { id: "dom-02", category: "domain", text: "How would you explain smart contracts to someone from the Renaissance era?" },
  { id: "dom-03", category: "domain", text: "What role does community play in the evolution of digital culture?" },
  { id: "dom-04", category: "domain", text: "How has the concept of ownership changed in the digital age?" },
  { id: "dom-05", category: "domain", text: "What parallels exist between ancient trade networks and modern blockchain?" },
  { id: "dom-06", category: "domain", text: "How do you build trust in a system where participants are anonymous?" },
  { id: "dom-07", category: "domain", text: "What can traditional art tell us about the value of digital art?" },
  { id: "dom-08", category: "domain", text: "How would you design a governance system for a digital community?" },
  { id: "dom-09", category: "domain", text: "What is the relationship between scarcity and value in digital goods?" },
  { id: "dom-10", category: "domain", text: "How might identity work differently if it were fully self-sovereign?" },
]
