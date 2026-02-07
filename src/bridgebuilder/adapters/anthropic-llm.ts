// src/bridgebuilder/adapters/anthropic-llm.ts

import type { ILLMProvider, ReviewRequest, ReviewResponse } from "../ports/index.js"
import type { IHttpClient } from "../ports/http-client.js"

/**
 * Anthropic LLM adapter that routes through IHttpClient for consistent
 * retry/rate-limit/redaction behavior.
 */
export class AnthropicLLMAdapter implements ILLMProvider {
  constructor(
    private readonly http: IHttpClient,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generateReview(request: ReviewRequest): Promise<ReviewResponse> {
    const resp = await this.http.request({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxOutputTokens,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
      }),
    })

    if (resp.status !== 200) {
      throw new Error(`Anthropic API error ${resp.status}: ${resp.body.slice(0, 200)}`)
    }

    const data = JSON.parse(resp.body) as {
      content: Array<{ type: string; text: string }>
      usage: { input_tokens: number; output_tokens: number }
      model: string
    }

    return {
      content: data.content.map(c => c.text).join(""),
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      model: data.model,
    }
  }
}
