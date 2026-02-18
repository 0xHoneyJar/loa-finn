// src/gateway/waitlist.ts — Static Waitlist Page (Sprint 6 Task 6.4)
//
// Serves "Coming Soon" page for non-allowlisted users.
// Static HTML with CSP headers. No JS required.

import { Hono } from "hono"

// ---------------------------------------------------------------------------
// XSS Prevention
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
}

// ---------------------------------------------------------------------------
// CSP Header
// ---------------------------------------------------------------------------

const CSP_HEADER = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
  "script-src 'self' https://cdn.tailwindcss.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join("; ")

// ---------------------------------------------------------------------------
// Waitlist Page Renderer
// ---------------------------------------------------------------------------

export interface WaitlistConfig {
  projectName: string
  projectDescription: string
  /** Optional contact email for access requests */
  contactEmail?: string
}

function renderWaitlistPage(config: WaitlistConfig): string {
  const name = escapeHtml(config.projectName)
  const desc = escapeHtml(config.projectDescription)
  const email = config.contactEmail ? escapeHtml(config.contactEmail) : null

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} — Coming Soon</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center">
  <div class="max-w-lg mx-auto text-center px-6">
    <div class="mb-8">
      <div class="w-20 h-20 bg-amber-500/20 rounded-2xl flex items-center justify-center mx-auto mb-6">
        <span class="text-4xl">&#x1F510;</span>
      </div>
      <h1 class="text-3xl font-bold mb-3">${name}</h1>
      <p class="text-gray-400 text-lg">${desc}</p>
    </div>

    <div class="bg-gray-900 rounded-xl p-6 mb-6 border border-gray-800">
      <h2 class="text-xl font-semibold mb-2 text-amber-400">Closed Beta</h2>
      <p class="text-gray-300 text-sm">
        Access is currently limited to allowlisted wallets.
        Connect an authorized wallet to get started.
      </p>
    </div>

    <div class="space-y-3">
      <a href="/" class="block w-full bg-amber-500 hover:bg-amber-600 text-black font-semibold py-3 px-6 rounded-lg transition-colors">
        Try Connecting Wallet
      </a>
      ${email ? `
      <p class="text-gray-500 text-sm">
        Want access? Contact
        <a href="mailto:${email}" class="text-amber-400 hover:text-amber-300 underline">${email}</a>
      </p>` : `
      <p class="text-gray-500 text-sm">
        Check back soon for public access.
      </p>`}
    </div>

    <p class="text-gray-600 text-xs mt-8">
      &copy; ${new Date().getFullYear()} ${name}. All rights reserved.
    </p>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function waitlistRoutes(config: WaitlistConfig): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    c.header("Content-Security-Policy", CSP_HEADER)
    c.header("X-Content-Type-Options", "nosniff")
    c.header("X-Frame-Options", "DENY")
    return c.html(renderWaitlistPage(config))
  })

  return app
}
