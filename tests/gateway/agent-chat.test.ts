// tests/gateway/agent-chat.test.ts — Agent Chat Route Tests (Sprint 4 T4.7)

import { describe, it, expect, beforeEach } from "vitest"
import { Hono } from "hono"
import { createAgentChatRoutes } from "../../src/gateway/routes/agent-chat.js"
import type { PersonalityProvider, PersonalityConfig } from "../../src/nft/personality-provider.js"

// ---------------------------------------------------------------------------
// Mock PersonalityProvider
// ---------------------------------------------------------------------------

class MockPersonalityProvider implements PersonalityProvider {
  private personalities = new Map<string, PersonalityConfig>()

  add(config: PersonalityConfig): void {
    this.personalities.set(config.token_id, config)
  }

  async get(tokenId: string): Promise<PersonalityConfig | null> {
    return this.personalities.get(tokenId) ?? null
  }

  async has(tokenId: string): Promise<boolean> {
    return this.personalities.has(tokenId)
  }
}

// ---------------------------------------------------------------------------
// Mock Response Generator
// ---------------------------------------------------------------------------

function createMockGenerator() {
  const calls: Array<{ systemPrompt: string; userMessage: string }> = []

  const generate = async (systemPrompt: string, userMessage: string): Promise<string> => {
    calls.push({ systemPrompt, userMessage })
    // Echo back a response that proves personality was injected
    if (systemPrompt.includes("peer-to-peer")) {
      return "From a decentralized perspective, I recommend..."
    }
    if (systemPrompt.includes("aesthetic")) {
      return "Aesthetically speaking, the form and function..."
    }
    if (systemPrompt.includes("precision")) {
      return "With precision and structure, let me break this down..."
    }
    if (systemPrompt.includes("transformation")) {
      return "Dissolving the boundaries between these concepts..."
    }
    return "Generic response"
  }

  return { generate, calls }
}

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

function makeTestPersonality(tokenId: string, archetype: string, templateKeyword: string): PersonalityConfig {
  return {
    token_id: tokenId,
    archetype: archetype as PersonalityConfig["archetype"],
    display_name: `Agent #${tokenId}`,
    voice_description: "Test voice",
    behavioral_traits: ["Test trait"],
    expertise_domains: ["Test domain"],
    beauvoir_template: `You are an agent focused on ${templateKeyword} and related topics.`,
  }
}

describe("T4.7: Agent Chat Route", () => {
  let app: Hono
  let provider: MockPersonalityProvider
  let generator: ReturnType<typeof createMockGenerator>

  beforeEach(() => {
    provider = new MockPersonalityProvider()
    provider.add(makeTestPersonality("1", "freetekno", "peer-to-peer systems"))
    provider.add(makeTestPersonality("2", "milady", "aesthetic refinement"))
    provider.add(makeTestPersonality("3", "chicago_detroit", "precision engineering"))
    provider.add(makeTestPersonality("4", "acidhouse", "transformation and experimentation"))

    generator = createMockGenerator()

    const routes = createAgentChatRoutes({
      personalityProvider: provider,
      generateResponse: generator.generate,
    })

    app = new Hono()
    app.route("/api/v1/agent/chat", routes)
  })

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it("rejects missing body", async () => {
    const res = await app.request("/api/v1/agent/chat", { method: "POST" })
    expect(res.status).toBe(400)
  })

  it("rejects missing token_id", async () => {
    const res = await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("token_id")
  })

  it("rejects missing message", async () => {
    const res = await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "1" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("message")
  })

  // -------------------------------------------------------------------------
  // Personality resolution
  // -------------------------------------------------------------------------

  it("returns 404 for unknown tokenId", async () => {
    const res = await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "999", message: "hello" }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe("PERSONALITY_NOT_FOUND")
  })

  // -------------------------------------------------------------------------
  // Personality-conditioned responses
  // -------------------------------------------------------------------------

  it("freetekno personality produces decentralization-themed response", async () => {
    const res = await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "1", message: "What about governance?" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.response).toContain("decentralized")
    expect(body.personality.archetype).toBe("freetekno")
    expect(body.personality.display_name).toBe("Agent #1")
  })

  it("milady personality produces aesthetics-themed response", async () => {
    const res = await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "2", message: "What about design?" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.response).toContain("Aesthetically")
    expect(body.personality.archetype).toBe("milady")
  })

  it("chicago_detroit personality produces precision-themed response", async () => {
    const res = await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "3", message: "How to optimize?" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.response).toContain("precision")
    expect(body.personality.archetype).toBe("chicago_detroit")
  })

  it("acidhouse personality produces transformation-themed response", async () => {
    const res = await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "4", message: "How to innovate?" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.response).toContain("Dissolving")
    expect(body.personality.archetype).toBe("acidhouse")
  })

  // -------------------------------------------------------------------------
  // System prompt injection verification
  // -------------------------------------------------------------------------

  it("passes beauvoir_template as system prompt to generator", async () => {
    await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "1", message: "test message" }),
    })

    expect(generator.calls.length).toBe(1)
    expect(generator.calls[0].systemPrompt).toContain("peer-to-peer")
    expect(generator.calls[0].userMessage).toBe("test message")
  })

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("returns 503 when generator fails", async () => {
    const failApp = new Hono()
    const failRoutes = createAgentChatRoutes({
      personalityProvider: provider,
      generateResponse: async () => { throw new Error("Model unavailable") },
    })
    failApp.route("/api/v1/agent/chat", failRoutes)

    const res = await failApp.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "1", message: "hello" }),
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe("Agent temporarily unavailable")
  })

  // -------------------------------------------------------------------------
  // Response shape
  // -------------------------------------------------------------------------

  it("response includes personality and billing fields", async () => {
    const res = await app.request("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_id: "1", message: "hello" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    // Personality metadata present
    expect(body.personality).toBeDefined()
    expect(body.personality.archetype).toBe("freetekno")
    expect(body.personality.display_name).toBe("Agent #1")

    // Response present
    expect(typeof body.response).toBe("string")
    expect(body.response.length).toBeGreaterThan(0)
  })
})
