// src/gateway/routes/agent-homepage.ts — Agent Homepage Route (T2.4)
//
// Server-side rendered agent homepage at /agent/:collection/:tokenId.
// Public view shows personality data; owner view adds chat entry point.

import { Hono } from "hono"
import type { PersonalityProvider, PersonalityConfig } from "../../nft/personality-provider.js"
import type { RedisCommandClient } from "../../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentHomepageDeps {
  personalityProvider: PersonalityProvider
  redis: RedisCommandClient
  getConversationCount?: (nftId: string) => Promise<number>
  getReputationState?: (nftId: string) => Promise<string>
  getCreditBalance?: (nftId: string, wallet: string) => Promise<number>
  baseUrl: string
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

export function createAgentHomepageRoutes(deps: AgentHomepageDeps): Hono {
  const app = new Hono()

  // GET /agent/:collection/:tokenId — Server-rendered homepage
  app.get("/:collection/:tokenId", async (c) => {
    const { collection, tokenId } = c.req.param()
    const fullTokenId = `${collection}:${tokenId}`

    const personality = await deps.personalityProvider.get(fullTokenId)
    if (!personality) {
      return c.html(buildNotActivatedPage(collection, tokenId, deps.baseUrl), 404)
    }

    // Gather data
    let conversationCount = 0
    let reputationState = "cold"
    if (deps.getConversationCount) {
      try { conversationCount = await deps.getConversationCount(fullTokenId) } catch { /* best effort */ }
    }
    if (deps.getReputationState) {
      try { reputationState = await deps.getReputationState(fullTokenId) } catch { /* best effort */ }
    }

    // Check if viewer is the owner (via SIWE session)
    const walletAddress = c.get("siwe_wallet") as string | undefined
    const isOwner = !!walletAddress

    const html = buildHomepage(personality, {
      conversationCount,
      reputationState,
      isOwner,
      walletAddress,
      baseUrl: deps.baseUrl,
    })

    return c.html(html)
  })

  return app
}

// ---------------------------------------------------------------------------
// HTML Builders
// ---------------------------------------------------------------------------

interface HomepageData {
  conversationCount: number
  reputationState: string
  isOwner: boolean
  walletAddress?: string
  baseUrl: string
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function buildHomepage(p: PersonalityConfig, data: HomepageData): string {
  const archetype = esc(p.archetype)
  const displayName = esc(p.display_name)
  const voice = esc(p.voice_description)
  const tokenId = esc(p.token_id)

  const expertiseHtml = p.expertise_domains
    .map((d) => `<li>${esc(d)}</li>`)
    .join("")

  const traitsHtml = p.behavioral_traits
    .map((t) => `<li>${esc(t)}</li>`)
    .join("")

  const ownerSection = data.isOwner
    ? `<div class="owner-actions">
        <a href="/chat/${tokenId}" class="btn btn-primary">Start Chatting</a>
        <div class="stats">
          <span>${data.conversationCount} conversation${data.conversationCount !== 1 ? "s" : ""}</span>
        </div>
      </div>`
    : `<div class="public-cta">
        <a href="/onboarding" class="btn btn-primary">Connect Wallet to Chat</a>
      </div>`

  const jsonData = JSON.stringify({
    token_id: p.token_id,
    archetype: p.archetype,
    display_name: p.display_name,
    voice_description: p.voice_description,
    reputation_state: data.reputationState,
    conversation_count: data.conversationCount,
    is_owner: data.isOwner,
  })

  return `<!DOCTYPE html>
<html lang="en" data-archetype="${archetype}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${displayName} — Finn Agent</title>
  <link rel="stylesheet" href="/css/base.css">
  <link rel="stylesheet" href="/css/personality.css">
  <link rel="stylesheet" href="/css/agent.css">
  <script type="application/json" id="agent-data">${jsonData}</script>
</head>
<body>
  <div class="container agent-page">
    <header class="agent-header">
      <personality-card
        archetype="${archetype}"
        display-name="${displayName}"
        voice="${voice}"
      ></personality-card>
      <reputation-badge
        state="${esc(data.reputationState)}"
        score="50"
      ></reputation-badge>
    </header>

    <main class="agent-main">
      <section class="agent-about">
        <h2>About</h2>
        <blockquote class="voice-description">${voice}</blockquote>

        <h3>Expertise</h3>
        <ul class="expertise-list">${expertiseHtml}</ul>

        <h3>Traits</h3>
        <ul class="traits-list">${traitsHtml}</ul>
      </section>

      ${ownerSection}
    </main>

    <footer class="agent-footer">
      <p>Powered by <a href="${esc(data.baseUrl)}">Finn</a></p>
    </footer>
  </div>

  <script src="/js/personality-card.js"></script>
  <script src="/js/reputation-badge.js"></script>
</body>
</html>`
}

function buildNotActivatedPage(collection: string, tokenId: string, baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Not Activated — Finn</title>
  <link rel="stylesheet" href="/css/base.css">
</head>
<body>
  <div class="container" style="text-align: center; padding-top: 4rem;">
    <h1>Agent Not Activated Yet</h1>
    <p style="color: var(--text-muted); margin: 1rem 0 2rem;">
      This NFT (${esc(collection)}/${esc(tokenId)}) hasn't been activated as a Finn agent.
    </p>
    <a href="/onboarding" class="btn btn-primary">Activate Your Agent</a>
  </div>
</body>
</html>`
}
