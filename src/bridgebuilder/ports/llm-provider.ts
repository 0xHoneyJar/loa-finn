// src/bridgebuilder/ports/llm-provider.ts

export interface ReviewRequest {
  systemPrompt: string
  userPrompt: string
  maxOutputTokens: number
}

export interface ReviewResponse {
  content: string
  inputTokens: number
  outputTokens: number
  model: string
}

export interface ILLMProvider {
  /** Generate a review from the given prompts. */
  generateReview(request: ReviewRequest): Promise<ReviewResponse>
}
