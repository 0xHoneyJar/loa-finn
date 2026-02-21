// src/gateway/routes/discovery.ts — Discovery Endpoints (Sprint 7 T7.4, T7.5, T7.6)
//
// Free endpoints for agent discovery:
// - GET /llms.txt     → agent capability manifest (T7.4)
// - GET /agents.md    → human-readable agent directory (T7.5)
// - GET /agent/:tokenId → per-agent HTML homepage (T7.6)
// - GET /openapi.json → OpenAPI 3.1 spec (T7.1)

import { Hono } from "hono"
import type { PersonalityConfig } from "../../nft/personality-provider.js"
import { buildOpenApiSpec } from "../openapi-spec.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveryDeps {
  /** Returns all personality configs. */
  getAllPersonalities: () => PersonalityConfig[]
  /** Base URL for constructing links (e.g., "https://finn.honeyjar.xyz") */
  baseUrl: string
  /** x402 pricing in micro-USDC per request */
  requestCostMicro: number
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

export function createDiscoveryRoutes(deps: DiscoveryDeps): Hono {
  const app = new Hono()

  // Cache the OpenAPI spec (immutable at runtime)
  const openApiSpec = buildOpenApiSpec()

  // GET /openapi.json — OpenAPI 3.1 specification (T7.1)
  app.get("/openapi.json", (c) => {
    return c.json(openApiSpec)
  })

  // GET /llms.txt — Agent capability manifest (T7.4)
  app.get("/llms.txt", (c) => {
    const personalities = deps.getAllPersonalities()
    const text = buildLlmsTxt(personalities, deps.baseUrl, deps.requestCostMicro)
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.text(text)
  })

  // GET /agents.md — Human-readable agent directory (T7.5)
  app.get("/agents.md", (c) => {
    const personalities = deps.getAllPersonalities()
    const md = buildAgentsMd(personalities, deps.baseUrl)
    c.header("Content-Type", "text/markdown; charset=utf-8")
    return c.text(md)
  })

  // GET /agent/:tokenId — Per-agent HTML homepage (T7.6)
  app.get("/agent/:tokenId", (c) => {
    const tokenId = c.req.param("tokenId")
    const personalities = deps.getAllPersonalities()
    const personality = personalities.find((p) => p.token_id === tokenId)

    if (!personality) {
      return c.json({ error: "Token ID not found", code: "PERSONALITY_NOT_FOUND" }, 404)
    }

    const html = buildAgentHomepage(personality, deps.baseUrl, deps.requestCostMicro)
    return c.html(html)
  })

  return app
}

// ---------------------------------------------------------------------------
// T7.4: llms.txt Builder
// ---------------------------------------------------------------------------

function buildLlmsTxt(
  personalities: PersonalityConfig[],
  baseUrl: string,
  costMicro: number,
): string {
  const costUsd = (costMicro / 1_000_000).toFixed(2)
  const lines: string[] = [
    "# Finn Agent API",
    `# ${baseUrl}`,
    "",
    "## About",
    "Personality-conditioned AI agents. Each agent has a unique voice derived from",
    "cultural archetypes (freetekno, milady, chicago_detroit, acidhouse).",
    "",
    "## API",
    `- OpenAPI: ${baseUrl}/openapi.json`,
    `- Chat: POST ${baseUrl}/api/v1/agent/chat`,
    `- Auth: SIWE (EIP-4361) at ${baseUrl}/api/v1/auth/nonce`,
    "",
    "## Payment",
    "- Method: x402 (on-chain USDC on Base) or prepaid API keys",
    `- Cost: $${costUsd} per request (${costMicro} micro-USDC)`,
    `- Chain: Base (chain ID 8453)`,
    "",
    "## Agents",
    "",
  ]

  for (const p of personalities) {
    lines.push(`### ${p.display_name} (${p.archetype})`)
    lines.push(`- Token ID: ${p.token_id}`)
    lines.push(`- Voice: ${p.voice_description}`)
    lines.push(`- Capabilities: ${p.expertise_domains.join(", ")}`)
    lines.push(`- Homepage: ${baseUrl}/agent/${p.token_id}`)
    lines.push("")
  }

  lines.push("## Contact")
  lines.push("- Web: https://thehoneyjar.xyz")
  lines.push("")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// T7.5: agents.md Builder
// ---------------------------------------------------------------------------

function buildAgentsMd(
  personalities: PersonalityConfig[],
  baseUrl: string,
): string {
  const lines: string[] = [
    "# Finn Agents",
    "",
    "Personality-conditioned AI agents, each with a unique voice and expertise.",
    "",
    "| Token ID | Name | Archetype | Capabilities | Chat |",
    "|----------|------|-----------|-------------|------|",
  ]

  for (const p of personalities) {
    const caps = p.expertise_domains.slice(0, 3).join(", ")
    lines.push(
      `| ${p.token_id} | ${p.display_name} | ${p.archetype} | ${caps} | [Chat](${baseUrl}/api/v1/agent/chat) |`,
    )
  }

  lines.push("")
  lines.push("## Agent Details")
  lines.push("")

  for (const p of personalities) {
    lines.push(`### ${p.display_name}`)
    lines.push("")
    lines.push(`**Archetype**: ${p.archetype}`)
    lines.push(`**Token ID**: ${p.token_id}`)
    lines.push("")
    lines.push(`> ${p.voice_description}`)
    lines.push("")
    lines.push("**Expertise**:")
    for (const domain of p.expertise_domains) {
      lines.push(`- ${domain}`)
    }
    lines.push("")
    lines.push("**Behavioral Traits**:")
    for (const trait of p.behavioral_traits) {
      lines.push(`- ${trait}`)
    }
    lines.push("")
    lines.push(`[View Homepage](${baseUrl}/agent/${p.token_id})`)
    lines.push("")
    lines.push("---")
    lines.push("")
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// T7.6: Agent Homepage Builder
// ---------------------------------------------------------------------------

function buildAgentHomepage(
  personality: PersonalityConfig,
  baseUrl: string,
  costMicro: number,
): string {
  const costUsd = (costMicro / 1_000_000).toFixed(2)
  const escapedName = escapeHtml(personality.display_name)
  const escapedArchetype = escapeHtml(personality.archetype)
  const escapedVoice = escapeHtml(personality.voice_description)

  const expertiseHtml = personality.expertise_domains
    .map((d) => `<li>${escapeHtml(d)}</li>`)
    .join("\n            ")

  const traitsHtml = personality.behavioral_traits
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("\n            ")

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapedName} — Finn Agent</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; line-height: 1.6; }
        .container { max-width: 640px; margin: 0 auto; padding: 2rem; }
        h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
        .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }
        .badge-freetekno { background: #1a472a; color: #4ade80; }
        .badge-milady { background: #3b1a47; color: #c084fc; }
        .badge-chicago_detroit { background: #472e1a; color: #fb923c; }
        .badge-acidhouse { background: #1a3847; color: #38bdf8; }
        .voice { font-style: italic; color: #a0a0a0; margin-bottom: 1.5rem; border-left: 3px solid #333; padding-left: 1rem; }
        h2 { font-size: 1.1rem; margin-top: 1.5rem; margin-bottom: 0.5rem; color: #ccc; }
        ul { padding-left: 1.25rem; }
        li { margin-bottom: 0.3rem; }
        .pricing { background: #141414; border: 1px solid #222; border-radius: 0.5rem; padding: 1rem; margin-top: 1.5rem; }
        .pricing strong { color: #f0f0f0; }
        .cta { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 2rem; background: #2563eb; color: white; text-decoration: none; border-radius: 0.5rem; font-weight: 600; }
        .cta:hover { background: #1d4ed8; }
        .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #222; font-size: 0.8rem; color: #666; }
        .footer a { color: #888; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${escapedName}</h1>
        <span class="badge badge-${escapedArchetype}">${escapedArchetype}</span>
        <p class="voice">${escapedVoice}</p>

        <h2>Expertise</h2>
        <ul>
            ${expertiseHtml}
        </ul>

        <h2>Behavioral Traits</h2>
        <ul>
            ${traitsHtml}
        </ul>

        <div class="pricing">
            <strong>Pricing</strong>: $${costUsd} per request (${costMicro} micro-USDC)
            <br>
            <strong>Payment</strong>: x402 on-chain (Base) or prepaid API key
        </div>

        <a href="${escapeHtml(baseUrl)}/api/v1/agent/chat" class="cta">Chat with this Agent</a>

        <div class="footer">
            <p>Token ID: ${escapeHtml(personality.token_id)} | <a href="${escapeHtml(baseUrl)}/openapi.json">API Docs</a> | <a href="${escapeHtml(baseUrl)}/agents.md">All Agents</a></p>
        </div>
    </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
