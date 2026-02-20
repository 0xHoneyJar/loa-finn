// tests/finn/discovery-routes.test.ts — Discovery Routes Tests (Sprint 7 T7.4, T7.5, T7.6)

import { describe, it, expect } from "vitest"
import { createDiscoveryRoutes } from "../../src/gateway/routes/discovery.js"
import type { PersonalityConfig } from "../../src/nft/personality-provider.js"

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const MOCK_PERSONALITIES: PersonalityConfig[] = [
  {
    token_id: "1",
    archetype: "freetekno",
    display_name: "Tekno Sage",
    voice_description: "Speaks with rave wisdom",
    expertise_domains: ["sound systems", "community organizing"],
    behavioral_traits: ["direct", "passionate"],
  },
  {
    token_id: "2",
    archetype: "milady",
    display_name: "Lady Net",
    voice_description: "Post-ironic digital mystic",
    expertise_domains: ["meme culture", "aesthetics", "network states"],
    behavioral_traits: ["cryptic", "playful"],
  },
]

const BASE_URL = "https://finn.honeyjar.xyz"
const COST_MICRO = 100_000

function createTestApp() {
  return createDiscoveryRoutes({
    getAllPersonalities: () => MOCK_PERSONALITIES,
    baseUrl: BASE_URL,
    requestCostMicro: COST_MICRO,
  })
}

// ---------------------------------------------------------------------------
// T7.1: GET /openapi.json
// ---------------------------------------------------------------------------

describe("GET /openapi.json (T7.1)", () => {
  it("returns valid JSON with OpenAPI version", async () => {
    const app = createTestApp()
    const res = await app.request("/openapi.json")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.openapi).toBe("3.1.0")
    expect(body.info.title).toBe("Finn Agent API")
  })
})

// ---------------------------------------------------------------------------
// T7.4: GET /llms.txt
// ---------------------------------------------------------------------------

describe("GET /llms.txt (T7.4)", () => {
  it("returns text/plain content type", async () => {
    const app = createTestApp()
    const res = await app.request("/llms.txt")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/plain")
  })

  it("contains agent manifest header", async () => {
    const app = createTestApp()
    const res = await app.request("/llms.txt")
    const text = await res.text()
    expect(text).toContain("# Finn Agent API")
    expect(text).toContain(BASE_URL)
  })

  it("lists all agents with token IDs", async () => {
    const app = createTestApp()
    const res = await app.request("/llms.txt")
    const text = await res.text()
    expect(text).toContain("Tekno Sage")
    expect(text).toContain("Token ID: 1")
    expect(text).toContain("Lady Net")
    expect(text).toContain("Token ID: 2")
  })

  it("includes pricing information", async () => {
    const app = createTestApp()
    const res = await app.request("/llms.txt")
    const text = await res.text()
    expect(text).toContain("$0.10")
    expect(text).toContain("100000 micro-USDC")
  })

  it("includes API endpoint references", async () => {
    const app = createTestApp()
    const res = await app.request("/llms.txt")
    const text = await res.text()
    expect(text).toContain("/openapi.json")
    expect(text).toContain("/api/v1/agent/chat")
    expect(text).toContain("x402")
  })

  it("includes per-agent capabilities", async () => {
    const app = createTestApp()
    const res = await app.request("/llms.txt")
    const text = await res.text()
    expect(text).toContain("sound systems")
    expect(text).toContain("meme culture")
  })
})

// ---------------------------------------------------------------------------
// T7.5: GET /agents.md
// ---------------------------------------------------------------------------

describe("GET /agents.md (T7.5)", () => {
  it("returns 200 with text content type", async () => {
    const app = createTestApp()
    const res = await app.request("/agents.md")
    expect(res.status).toBe(200)
    // Hono c.text() sets text/plain; the Content-Type header set prior
    // is overridden. Content is markdown served as text/plain.
    expect(res.headers.get("Content-Type")).toContain("text/")
  })

  it("contains markdown table with all agents", async () => {
    const app = createTestApp()
    const res = await app.request("/agents.md")
    const text = await res.text()
    expect(text).toContain("# Finn Agents")
    expect(text).toContain("| Token ID |")
    expect(text).toContain("| 1 | Tekno Sage |")
    expect(text).toContain("| 2 | Lady Net |")
  })

  it("includes detailed per-agent sections", async () => {
    const app = createTestApp()
    const res = await app.request("/agents.md")
    const text = await res.text()
    expect(text).toContain("### Tekno Sage")
    expect(text).toContain("### Lady Net")
    expect(text).toContain("**Archetype**: freetekno")
    expect(text).toContain("**Archetype**: milady")
  })

  it("includes behavioral traits", async () => {
    const app = createTestApp()
    const res = await app.request("/agents.md")
    const text = await res.text()
    expect(text).toContain("- direct")
    expect(text).toContain("- passionate")
    expect(text).toContain("- cryptic")
    expect(text).toContain("- playful")
  })

  it("includes homepage links", async () => {
    const app = createTestApp()
    const res = await app.request("/agents.md")
    const text = await res.text()
    expect(text).toContain(`${BASE_URL}/agent/1`)
    expect(text).toContain(`${BASE_URL}/agent/2`)
  })
})

// ---------------------------------------------------------------------------
// T7.6: GET /agent/:tokenId
// ---------------------------------------------------------------------------

describe("GET /agent/:tokenId (T7.6)", () => {
  it("returns HTML for valid token ID", async () => {
    const app = createTestApp()
    const res = await app.request("/agent/1")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain("Tekno Sage")
    expect(html).toContain("freetekno")
  })

  it("returns 404 for unknown token ID", async () => {
    const app = createTestApp()
    const res = await app.request("/agent/999")
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe("PERSONALITY_NOT_FOUND")
  })

  it("includes archetype badge", async () => {
    const app = createTestApp()
    const res = await app.request("/agent/2")
    const html = await res.text()
    expect(html).toContain("badge-milady")
    expect(html).toContain("milady")
  })

  it("includes expertise and traits", async () => {
    const app = createTestApp()
    const res = await app.request("/agent/1")
    const html = await res.text()
    expect(html).toContain("sound systems")
    expect(html).toContain("community organizing")
    expect(html).toContain("direct")
    expect(html).toContain("passionate")
  })

  it("includes pricing information", async () => {
    const app = createTestApp()
    const res = await app.request("/agent/1")
    const html = await res.text()
    expect(html).toContain("$0.10")
    expect(html).toContain("100000 micro-USDC")
  })

  it("escapes HTML entities in personality data", async () => {
    const xssPersonality: PersonalityConfig = {
      token_id: "xss",
      archetype: "freetekno",
      display_name: '<script>alert("xss")</script>',
      voice_description: "test",
      expertise_domains: ["test"],
      behavioral_traits: ["test"],
    }
    const app = createDiscoveryRoutes({
      getAllPersonalities: () => [xssPersonality],
      baseUrl: BASE_URL,
      requestCostMicro: COST_MICRO,
    })
    const res = await app.request("/agent/xss")
    const html = await res.text()
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("includes chat CTA link", async () => {
    const app = createTestApp()
    const res = await app.request("/agent/1")
    const html = await res.text()
    expect(html).toContain(`${BASE_URL}/api/v1/agent/chat`)
    expect(html).toContain("Chat with this Agent")
  })
})
