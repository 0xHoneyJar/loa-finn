// src/nft/eval/providers.ts — LLM Provider Interfaces for Eval Harness (Sprint 12 Task 12.1)
//
// Defines provider interfaces for generation, embedding, and judging.
// Includes deterministic fake implementations for CI tests (no network calls).

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** LLM provider interface for eval harness */
export interface EvalLLMProvider {
  generate(systemPrompt: string, userPrompt: string): Promise<string>
}

/** Embedding provider for distinctiveness scoring */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
}

/** Judge provider for signal fidelity scoring */
export interface JudgeProvider {
  identify(transcript: string, options: string[]): Promise<string>
}

// ---------------------------------------------------------------------------
// Fake Implementations (CI-safe, deterministic)
// ---------------------------------------------------------------------------

/** Fake LLM provider for CI tests — returns deterministic canned responses */
export class FakeEvalLLMProvider implements EvalLLMProvider {
  private callCount = 0

  async generate(systemPrompt: string, userPrompt: string): Promise<string> {
    this.callCount++
    // Return deterministic canned response incorporating the prompt index
    return `Response ${this.callCount}: I approach this with careful consideration, drawing from my understanding and perspective. ${userPrompt.slice(0, 50)}`
  }
}

/** Fake embedding provider for CI tests — returns deterministic vectors based on text hash */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text, i) => {
      const seed = text.length + i
      return Array.from({ length: 256 }, (_, j) => Math.sin(seed * (j + 1)) * 0.5 + 0.5)
    })
  }
}

/** Fake judge provider for CI tests — deterministic selection based on transcript length */
export class FakeJudgeProvider implements JudgeProvider {
  async identify(transcript: string, options: string[]): Promise<string> {
    return options[transcript.length % options.length]
  }
}
