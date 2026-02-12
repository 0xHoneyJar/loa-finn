// tests/finn/byok-redaction.test.ts — BYOK Redaction & Error Scrubbing (Task 4.3, C.3)

import { describe, it, expect } from "vitest"
import {
  shannonEntropy,
  redactKeyPatterns,
  containsKeyPattern,
  redactResponseBody,
  scrubProviderError,
  createAuditEntry,
} from "../../src/hounfour/byok-redaction.js"

// --- Shannon Entropy ---

describe("shannonEntropy", () => {
  it("returns 0 for empty string", () => {
    expect(shannonEntropy("")).toBe(0)
  })

  it("returns 0 for single repeated character", () => {
    expect(shannonEntropy("aaaaaaa")).toBe(0)
  })

  it("returns ~1 for two equally-likely characters", () => {
    const e = shannonEntropy("abababab")
    expect(e).toBeCloseTo(1.0, 1)
  })

  it("returns high entropy for random-looking string", () => {
    // Simulated API key (high entropy)
    const e = shannonEntropy("sk-proj-a9B2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4")
    expect(e).toBeGreaterThan(4.0)
  })

  it("returns lower entropy for natural text", () => {
    const e = shannonEntropy("the quick brown fox jumps over the lazy dog")
    expect(e).toBeLessThan(4.5)
  })
})

// --- Pattern-Based Redaction ---

describe("redactKeyPatterns", () => {
  it("redacts OpenAI keys", () => {
    const input = 'Authorization: sk-proj-a9B2cD3eF4gH5iJ6kL7mN8oP9'
    const result = redactKeyPatterns(input)
    expect(result).not.toContain("sk-proj")
    expect(result).toContain("[REDACTED]")
  })

  it("redacts Anthropic keys", () => {
    const input = 'key: anthropic-sk-ant-api03-long-random-key-value-here'
    const result = redactKeyPatterns(input)
    expect(result).not.toContain("anthropic-sk")
    expect(result).toContain("[REDACTED]")
  })

  it("redacts Bearer tokens", () => {
    const input = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'
    const result = redactKeyPatterns(input)
    expect(result).not.toContain("eyJhbGciOi")
    expect(result).toContain("[REDACTED]")
  })

  it("redacts high-entropy base64 strings > 20 chars", () => {
    const input = 'token: a9B2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2'
    const result = redactKeyPatterns(input)
    expect(result).toContain("[REDACTED]")
  })

  it("preserves low-entropy strings", () => {
    const input = 'path: aaaaaaaaaaaaaaaaaaaaaaaaa'
    const result = redactKeyPatterns(input)
    expect(result).toBe(input) // All 'a' = zero entropy
  })

  it("preserves normal text", () => {
    const input = 'Model gpt-4o returned 200 OK with 150 tokens'
    const result = redactKeyPatterns(input)
    expect(result).toBe(input)
  })

  it("handles multiple keys in one string", () => {
    const input = 'key1: sk-test-abcdefghijklmnopqrstuvwxyz key2: anthropic-abcdefghijklmnopqrstuvwx'
    const result = redactKeyPatterns(input)
    expect(result).not.toContain("sk-test")
    expect(result).not.toContain("anthropic-")
  })
})

// --- containsKeyPattern ---

describe("containsKeyPattern", () => {
  it("detects OpenAI key", () => {
    expect(containsKeyPattern("sk-proj-a9B2cD3eF4gH5iJ6kL7mN8oP9")).toBe(true)
  })

  it("detects Anthropic key", () => {
    expect(containsKeyPattern("anthropic-sk-ant-api03-randomvalue123")).toBe(true)
  })

  it("returns false for clean text", () => {
    expect(containsKeyPattern("Model gpt-4o returned 200 OK")).toBe(false)
  })

  it("returns false for short tokens", () => {
    expect(containsKeyPattern("sk-short")).toBe(false)
  })
})

// --- Response Body Redaction ---

describe("redactResponseBody", () => {
  it("keeps allowed fields", () => {
    const body = {
      status: 200,
      model: "gpt-4o",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      id: "chatcmpl-123",
    }
    const result = redactResponseBody(body)
    expect(result.status).toBe(200)
    expect(result.model).toBe("gpt-4o")
    expect(result.id).toBe("chatcmpl-123")
  })

  it("strips non-allowed fields", () => {
    const body = {
      status: 200,
      model: "gpt-4o",
      choices: [{ message: { content: "secret response" } }],
      headers: { authorization: "Bearer sk-test" },
      raw_response: "sensitive data",
    }
    const result = redactResponseBody(body)
    expect(result.status).toBe(200)
    expect(result.model).toBe("gpt-4o")
    expect(result.choices).toBeUndefined()
    expect(result.headers).toBeUndefined()
    expect(result.raw_response).toBeUndefined()
  })

  it("handles null input", () => {
    const result = redactResponseBody(null)
    expect(result).toEqual({ redacted: true })
  })

  it("redacts key patterns in allowed string fields", () => {
    const body = {
      model: "sk-proj-a9B2cD3eF4gH5iJ6kL7mN8oP9",
    }
    const result = redactResponseBody(body)
    expect(result.model).toContain("[REDACTED]")
  })

  it("recursively redacts nested objects", () => {
    const body = {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        secret: "should-be-removed",
      },
    }
    const result = redactResponseBody(body)
    const usage = result.usage as Record<string, unknown>
    expect(usage.prompt_tokens).toBe(10)
    expect(usage.completion_tokens).toBe(5)
    expect(usage.secret).toBeUndefined()
  })
})

// --- Provider Error Scrubbing ---

describe("scrubProviderError", () => {
  it("redacts generic error body", () => {
    const result = scrubProviderError(500, {
      error: { message: "Internal server error with sk-key-abc123456789012345" },
    })
    expect(result.provider_error).toBe(true)
    expect(result.status).toBe(500)
    expect(result.message).toBe("<redacted>")
    expect(result.error_code).toBeUndefined()
  })

  it("passes through allowed error codes", () => {
    const result = scrubProviderError(429, {
      error: { code: "rate_limit_exceeded", message: "You have exceeded your rate limit" },
    })
    expect(result.error_code).toBe("rate_limit_exceeded")
    expect(result.message).toBe("Rate limit exceeded")
  })

  it("passes through context_length_exceeded", () => {
    const result = scrubProviderError(400, {
      error: { code: "context_length_exceeded" },
    })
    expect(result.error_code).toBe("context_length_exceeded")
    expect(result.message).toBe("Context length exceeded")
  })

  it("passes through model_not_found", () => {
    const result = scrubProviderError(404, {
      error: { type: "model_not_found" },
    })
    expect(result.error_code).toBe("model_not_found")
    expect(result.message).toBe("Model not found")
  })

  it("does not pass through unknown error codes", () => {
    const result = scrubProviderError(400, {
      error: { code: "unknown_error_type", message: "Detailed internal error with secrets" },
    })
    expect(result.error_code).toBeUndefined()
    expect(result.message).toBe("<redacted>")
  })

  it("handles non-object body", () => {
    const result = scrubProviderError(500, "raw error string with secrets")
    expect(result.provider_error).toBe(true)
    expect(result.message).toBe("<redacted>")
  })

  it("handles null body", () => {
    const result = scrubProviderError(502, null)
    expect(result.provider_error).toBe(true)
    expect(result.status).toBe(502)
  })
})

// --- Audit Entry ---

describe("createAuditEntry", () => {
  it("creates entry with all fields", () => {
    const entry = createAuditEntry("req-123", "tenant-abc", "openai", "/v1/chat/completions", 200, 150)
    expect(entry.request_id).toBe("req-123")
    expect(entry.tenant_id).toBe("tenant-abc")
    expect(entry.provider).toBe("openai")
    expect(entry.endpoint).toBe("/v1/chat/completions")
    expect(entry.status).toBe(200)
    expect(entry.latency_ms).toBe(150)
    expect(entry.timestamp).toBeTruthy()
  })

  it("strips query parameters from endpoint", () => {
    const entry = createAuditEntry("req-1", "t-1", "openai", "/v1/chat?api_key=secret&model=gpt-4o", 200, 100)
    expect(entry.endpoint).toBe("/v1/chat")
  })

  it("contains no key material", () => {
    const entry = createAuditEntry("req-1", "tenant-1", "openai", "/v1/chat/completions", 200, 100)
    const json = JSON.stringify(entry)
    expect(containsKeyPattern(json)).toBe(false)
  })
})
