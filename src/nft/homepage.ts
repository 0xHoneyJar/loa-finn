// src/nft/homepage.ts — Static HTML Agent Homepage (Sprint 5 Task 5.3)
//
// Serves agent homepage at /agent/:collection/:tokenId
// Static HTML with embedded Vanilla JS modules, Tailwind CSS via CDN.
// XSS prevention: all dynamic content HTML-entity-encoded, strict CSP header.

import { Hono } from "hono"
import type { PersonalityService } from "./personality.js"

// ---------------------------------------------------------------------------
// XSS Prevention
// ---------------------------------------------------------------------------

/** HTML-entity-encode user content to prevent XSS (Flatline IMP-005) */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
}

// ---------------------------------------------------------------------------
// CSP Header (Flatline IMP-005)
// ---------------------------------------------------------------------------

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://cdn.tailwindcss.com",
  "connect-src 'self' wss:",
  "img-src 'self' data:",
  "font-src 'self'",
].join("; ")

// ---------------------------------------------------------------------------
// Homepage HTML Template
// ---------------------------------------------------------------------------

function renderHomepage(
  collection: string,
  tokenId: string,
  name: string,
  voice: string,
  expertiseDomains: string[],
): string {
  const safeName = escapeHtml(name)
  const safeVoice = escapeHtml(voice)
  const safeDomains = expertiseDomains.map(escapeHtml)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName} — HoneyJar Agent</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .chat-messages { scroll-behavior: smooth; }
    .typing-indicator { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
  </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen flex flex-col">
  <!-- Header -->
  <header class="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 font-bold text-lg">
        ${safeName.charAt(0).toUpperCase()}
      </div>
      <div>
        <h1 class="text-lg font-semibold">${safeName}</h1>
        <p class="text-sm text-gray-400">${safeVoice} agent</p>
      </div>
    </div>
    <div id="wallet-status" class="text-sm text-gray-500">
      <button id="connect-wallet" class="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors">
        Connect Wallet
      </button>
    </div>
  </header>

  <!-- Main -->
  <main class="flex-1 flex overflow-hidden">
    <!-- Chat -->
    <div class="flex-1 flex flex-col">
      <div id="chat-messages" class="chat-messages flex-1 overflow-y-auto px-6 py-4 space-y-4">
        <div class="text-center text-gray-500 py-8">
          <p class="text-lg">Welcome! I'm <strong>${safeName}</strong>.</p>
          <p class="text-sm mt-2">Connect your wallet to start chatting.</p>
        </div>
      </div>

      <!-- Input -->
      <div class="border-t border-gray-800 px-6 py-4">
        <form id="chat-form" class="flex gap-3">
          <input
            id="chat-input"
            type="text"
            placeholder="Type a message..."
            class="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-amber-500 disabled:opacity-50"
            disabled
            autocomplete="off"
          />
          <button
            type="submit"
            id="send-button"
            class="px-6 py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
            disabled
          >
            Send
          </button>
        </form>
        <div id="cost-display" class="mt-2 text-xs text-gray-500 hidden">
          <span id="last-cost"></span> · Balance: <span id="balance-display">—</span> CU
        </div>
      </div>
    </div>

    <!-- Sidebar -->
    <aside class="w-72 border-l border-gray-800 p-6 hidden lg:block overflow-y-auto">
      <div class="space-y-6">
        <!-- Personality Card -->
        <div>
          <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Personality</h3>
          <div class="bg-gray-900 rounded-lg p-4 space-y-2">
            <p class="text-sm"><span class="text-gray-400">Voice:</span> ${safeVoice}</p>
            ${safeDomains.length > 0 ? `
            <div>
              <span class="text-sm text-gray-400">Expertise:</span>
              <div class="flex flex-wrap gap-1 mt-1">
                ${safeDomains.map((d) => `<span class="text-xs bg-gray-800 text-gray-300 px-2 py-1 rounded">${d}</span>`).join("")}
              </div>
            </div>` : ""}
          </div>
        </div>

        <!-- Usage Stats -->
        <div>
          <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Usage</h3>
          <div class="bg-gray-900 rounded-lg p-4 space-y-2">
            <p class="text-sm"><span class="text-gray-400">Credits:</span> <span id="sidebar-balance">—</span> CU</p>
            <p class="text-sm"><span class="text-gray-400">Messages:</span> <span id="sidebar-messages">0</span></p>
          </div>
        </div>
      </div>
    </aside>
  </main>

  <!-- Footer -->
  <footer class="border-t border-gray-800 px-6 py-3 text-center text-xs text-gray-600">
    Powered by HoneyJar · <span id="model-indicator" class="text-gray-500">—</span>
  </footer>

  <!-- Client JS Modules -->
  <script>
    window.__AGENT_CONFIG__ = {
      collection: ${JSON.stringify(collection)},
      tokenId: ${JSON.stringify(tokenId)},
      nftId: ${JSON.stringify(`${collection}:${tokenId}`)},
      name: ${JSON.stringify(name)},
    };
  </script>
  <script src="/agent/wallet.js" type="module"></script>
  <script src="/agent/ws-client.js" type="module"></script>
  <script src="/agent/chat.js" type="module"></script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Hono Routes
// ---------------------------------------------------------------------------

export function homepageRoutes(personalityService: PersonalityService): Hono {
  const app = new Hono()

  app.get("/:collection/:tokenId", async (c) => {
    const { collection, tokenId } = c.req.param()

    // Load personality for display
    const personality = await personalityService.get(collection, tokenId)
    const name = personality?.name ?? "Agent"
    const voice = personality?.voice ?? "default"
    const domains = personality?.expertise_domains ?? []

    const html = renderHomepage(collection, tokenId, name, voice, domains)

    return c.html(html, 200, {
      "Content-Security-Policy": CSP_HEADER,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    })
  })

  return app
}
