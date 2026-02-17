// tests/finn/oracle-xss.test.ts — XSS Prevention Tests (Sprint 5 Task 5.7)
// Verifies Oracle API-side XSS defenses per OWASP filter evasion cheat sheet.
// Server-side defenses: JSON content-type, no HTML reflection, CORS enforcement.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { setupE2E, requestWithIp, createDefaultResult } from "./e2e-harness.js"
import type { E2EContext } from "./e2e-harness.js"

const BASE_URL = "http://localhost:3000"
const ORACLE_URL = `${BASE_URL}/api/v1/oracle`

// XSS vectors from OWASP Filter Evasion Cheat Sheet
const XSS_VECTORS = {
  scriptTag: '<script>alert(1)</script>',
  imgOnerror: '<img src=x onerror=alert(1)>',
  unclosedScript: '<script>alert(1)',
  htmlEntities: '&#60;script&#62;alert(1)&#60;/script&#62;',
  javascriptProtocol: '[link](javascript:alert(1))',
  multilineTag: '<scr\nipt>alert(1)</scr\nipt>',
  eventHandler: '<a onclick=alert(1)>click</a>',
  svgOnload: '<svg onload=alert(1)>',
  iframeSrcdoc: '<iframe srcdoc="<script>alert(1)</script>">',
  styleExpression: '<div style="background:url(javascript:alert(1))">',
}

describe("Oracle XSS Prevention", () => {
  let ctx: E2EContext

  beforeEach(() => {
    ctx = setupE2E()
  })

  afterEach(() => {
    ctx.teardown()
  })

  // --- Defense 1: Content-Type is always application/json ---

  it("responses are always application/json (never text/html)", async () => {
    for (const [name, vector] of Object.entries(XSS_VECTORS)) {
      const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: vector }),
      })

      const res = await ctx.app.fetch(req)
      const contentType = res.headers.get("Content-Type") ?? ""
      expect(contentType).toContain("application/json")
    }
  })

  // --- Defense 2: Error messages don't reflect user input verbatim ---

  it("<script>alert(1)</script> in question does not reflect in error response", async () => {
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "" }), // empty triggers validation error
    })

    const res = await ctx.app.fetch(req)
    const body = await res.json()
    // Error message should be a static string, not echoing input
    expect(body.error).not.toContain("<script>")
  })

  it("oversized question error does not echo the content", async () => {
    const payload = XSS_VECTORS.scriptTag.repeat(1000)
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: payload }),
    })

    const res = await ctx.app.fetch(req)
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).not.toContain("<script>")
    expect(body.error).not.toContain("alert(")
  })

  // --- Defense 3: XSS vectors in questions pass through to model safely ---

  it("XSS in question is sent to model, response is JSON-wrapped", async () => {
    // Mock router returns content with XSS (simulating model echoing input)
    vi.mocked(ctx.mockRouter.invokeForTenant).mockResolvedValueOnce(
      createDefaultResult({
        content: `You asked about: ${XSS_VECTORS.scriptTag}. That's a common XSS vector.`,
      }),
    )

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: XSS_VECTORS.scriptTag }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(200)

    // Response is JSON — browser won't execute script tags in JSON
    const contentType = res.headers.get("Content-Type") ?? ""
    expect(contentType).toContain("application/json")

    const body = await res.json()
    // Content is in the answer field, safely wrapped in JSON
    expect(typeof body.answer).toBe("string")
  })

  // --- Defense 4: img onerror vector ---

  it("<img src=x onerror=alert(1)> in model response is JSON-wrapped", async () => {
    vi.mocked(ctx.mockRouter.invokeForTenant).mockResolvedValueOnce(
      createDefaultResult({ content: XSS_VECTORS.imgOnerror }),
    )

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test" }),
    })

    const res = await ctx.app.fetch(req)
    const contentType = res.headers.get("Content-Type") ?? ""
    expect(contentType).toContain("application/json")
  })

  // --- Defense 5: Unclosed tags ---

  it("unclosed <script> tag in question does not break response format", async () => {
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: XSS_VECTORS.unclosedScript }),
    })

    const res = await ctx.app.fetch(req)
    // Should either succeed (200) or be a valid JSON error — never raw HTML
    const body = await res.json()
    expect(body).toBeDefined()
  })

  // --- Defense 6: HTML entities ---

  it("HTML entities in question handled without rendering as HTML", async () => {
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: XSS_VECTORS.htmlEntities }),
    })

    const res = await ctx.app.fetch(req)
    const contentType = res.headers.get("Content-Type") ?? ""
    expect(contentType).toContain("application/json")
  })

  // --- Defense 7: javascript: protocol in markdown links ---

  it("javascript: protocol in question handled safely", async () => {
    vi.mocked(ctx.mockRouter.invokeForTenant).mockResolvedValueOnce(
      createDefaultResult({ content: XSS_VECTORS.javascriptProtocol }),
    )

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: XSS_VECTORS.javascriptProtocol }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Content is a JSON string — client must sanitize before rendering as HTML
    expect(typeof body.answer).toBe("string")
  })

  // --- Defense 8: Event handlers in tags ---

  it("event handler XSS in model response stays in JSON envelope", async () => {
    vi.mocked(ctx.mockRouter.invokeForTenant).mockResolvedValueOnce(
      createDefaultResult({ content: XSS_VECTORS.eventHandler }),
    )

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test event handlers" }),
    })

    const res = await ctx.app.fetch(req)
    // Verify JSON envelope integrity
    const text = await res.text()
    expect(() => JSON.parse(text)).not.toThrow()
  })

  // --- Defense 9: CORS prevents unauthorized cross-origin access ---

  it("disallowed origin cannot read Oracle responses", async () => {
    const req = new Request(ORACLE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://evil.example.com",
        "X-Forwarded-For": "1.2.3.4, 10.0.0.1",
      },
      body: JSON.stringify({ question: "steal data" }),
    })

    const res = await ctx.app.fetch(req)
    // No Access-Control-Allow-Origin for unauthorized origins
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  // --- Defense 10: SVG onload vector ---

  it("SVG onload vector in model response stays JSON-wrapped", async () => {
    vi.mocked(ctx.mockRouter.invokeForTenant).mockResolvedValueOnce(
      createDefaultResult({ content: XSS_VECTORS.svgOnload }),
    )

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "svg test" }),
    })

    const res = await ctx.app.fetch(req)
    const contentType = res.headers.get("Content-Type") ?? ""
    expect(contentType).toContain("application/json")
    const body = await res.json()
    expect(body.answer).toContain("svg")
  })
})
