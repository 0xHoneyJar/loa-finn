// src/gateway/waitlist.ts — Static Waitlist Page (Sprint 6 Task 6.4, Sprint 13 Task 13.2)
//
// Serves "Coming Soon" page for non-allowlisted users.
// Static HTML with hardened CSP headers (nonce-based, no unsafe-inline).
// CSP violation reporting endpoint at /api/v1/csp-report.

import { Hono } from "hono"
import { randomBytes } from "node:crypto"

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
// CSP Nonce Generation
// ---------------------------------------------------------------------------

/** Generate a cryptographically random nonce for CSP */
function generateNonce(): string {
  return randomBytes(16).toString("base64")
}

// ---------------------------------------------------------------------------
// CSP Header Builder
// ---------------------------------------------------------------------------

/**
 * Build CSP header with per-request nonce.
 * Allows Tailwind CDN and its sub-resources (fonts, stylesheets loaded by the CDN script).
 */
function buildCSPHeader(nonce: string): string {
  return [
    "default-src 'self'",
    `style-src 'self' 'nonce-${nonce}' https://cdn.tailwindcss.com`,
    `script-src 'self' 'nonce-${nonce}' https://cdn.tailwindcss.com`,
    "img-src 'self' data:",
    "connect-src 'self' https://cdn.tailwindcss.com",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-ancestors 'none'",
    "report-uri /api/v1/csp-report",
    "report-to csp-endpoint",
  ].join("; ")
}

/** Whether to use Report-Only mode (set to false after validation) */
const CSP_REPORT_ONLY = process.env.CSP_ENFORCE === "true" ? false : true

// ---------------------------------------------------------------------------
// Waitlist Page Renderer
// ---------------------------------------------------------------------------

export interface WaitlistConfig {
  projectName: string
  projectDescription: string
  /** Optional contact email for access requests */
  contactEmail?: string
}

function renderWaitlistPage(config: WaitlistConfig, nonce: string): string {
  const name = escapeHtml(config.projectName)
  const desc = escapeHtml(config.projectDescription)
  const email = config.contactEmail ? escapeHtml(config.contactEmail) : null

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} — Coming Soon</title>
  <script nonce="${nonce}" src="https://cdn.tailwindcss.com"></script>
  <style nonce="${nonce}">
    body { font-family: system-ui, -apple-system, sans-serif; }
  </style>
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
// CSP Violation Report Handler
// ---------------------------------------------------------------------------

/** Max payload size for CSP reports: 10KB */
const MAX_CSP_REPORT_SIZE = 10 * 1024

export function cspReportRoutes(): Hono {
  const app = new Hono()

  app.post("/", async (c) => {
    // Check content type
    const contentType = c.req.header("content-type") ?? ""
    if (!contentType.includes("application/csp-report") && !contentType.includes("application/json")) {
      return c.text("Unsupported content type", 415)
    }

    // Check content length
    const contentLength = parseInt(c.req.header("content-length") ?? "0", 10)
    if (contentLength > MAX_CSP_REPORT_SIZE) {
      return c.text("Payload too large", 413)
    }

    try {
      const body = await c.req.text()
      if (body.length > MAX_CSP_REPORT_SIZE) {
        return c.text("Payload too large", 413)
      }

      const report = JSON.parse(body)
      const violation = report["csp-report"] ?? report

      // Log structured event
      console.log(JSON.stringify({
        metric: "csp.violation",
        document_uri: violation["document-uri"] ?? violation.documentURL ?? "unknown",
        violated_directive: violation["violated-directive"] ?? violation.effectiveDirective ?? "unknown",
        blocked_uri: violation["blocked-uri"] ?? violation.blockedURL ?? "unknown",
        timestamp: Date.now(),
      }))

      return c.body(null, 204)
    } catch {
      return c.text("Invalid report", 400)
    }
  })

  return app
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function waitlistRoutes(config: WaitlistConfig): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const nonce = generateNonce()
    const cspHeader = buildCSPHeader(nonce)
    const headerName = CSP_REPORT_ONLY ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy"

    c.header(headerName, cspHeader)
    c.header("Reporting-Endpoints", 'csp-endpoint="/api/v1/csp-report"')
    c.header("X-Content-Type-Options", "nosniff")
    c.header("X-Frame-Options", "DENY")
    return c.html(renderWaitlistPage(config, nonce))
  })

  return app
}
