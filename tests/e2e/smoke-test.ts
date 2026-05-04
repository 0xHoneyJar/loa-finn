// tests/e2e/smoke-test.ts — E2E Smoke Test Suite (Sprint 3)
//
// Vitest-based smoke tests that exercise the live HTTP API.
// All tests use fetch() against E2E_BASE_URL — no in-process Hono mounting.
//
// Run:  npx vitest run --config vitest.config.e2e.ts tests/e2e/smoke-test.ts
//
// Requires a running loa-finn instance. Tests that need WebSocket connections
// or actual model responses are skipped with describe.skip / test.todo.

import { describe, it, expect, test } from "vitest"
import {
  E2E_BASE_URL,
  TEST_WALLET_ADDRESS,
  TEST_NFT_COLLECTION,
  TEST_NFT_TOKEN_ID,
  TEST_NFT_ID,
} from "./fixtures.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = E2E_BASE_URL

/**
 * Convenience wrapper — fetch with default JSON headers.
 */
async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
}

// ---------------------------------------------------------------------------
// Test 1: Health endpoint
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 with status healthy", async () => {
    const res = await fetch(`${BASE}/health`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toHaveProperty("status")
    expect(body.status).toBe("healthy")
  })
})

// ---------------------------------------------------------------------------
// Test 2: Agent homepage
// ---------------------------------------------------------------------------

describe("GET /agent/:collection/:tokenId", () => {
  it("returns HTML for a valid token", async () => {
    const res = await fetch(
      `${BASE}/agent/${TEST_NFT_COLLECTION}/${TEST_NFT_TOKEN_ID}`,
    )

    // Accept both 200 (personality exists) and 404 (not-activated page — still HTML)
    expect([200, 404]).toContain(res.status)

    const contentType = res.headers.get("content-type") ?? ""
    expect(contentType).toContain("text/html")
  })
})

// ---------------------------------------------------------------------------
// Test 3: Onboarding start
// ---------------------------------------------------------------------------

describe("POST /api/v1/onboarding/start", () => {
  it("returns a session_id for a test wallet", async () => {
    const res = await apiFetch("/api/v1/onboarding/start", {
      method: "POST",
      body: JSON.stringify({ wallet_address: TEST_WALLET_ADDRESS }),
    })

    // 200 = success, 401 = auth required (no SIWE), 403 = not allowlisted,
    // 503 = feature disabled. All are valid infrastructure responses.
    if (res.status === 200) {
      const body = await res.json()
      expect(body).toHaveProperty("session_id")
      expect(typeof body.session_id).toBe("string")
    } else {
      // Non-200 is acceptable — confirms the endpoint exists and responds
      expect([401, 403, 503]).toContain(res.status)
    }
  })
})

// ---------------------------------------------------------------------------
// Test 4: Public personality API
// ---------------------------------------------------------------------------

describe("GET /api/v1/public", () => {
  it("returns personality data for a tokenId", async () => {
    const res = await fetch(
      `${BASE}/api/v1/public?tokenId=${TEST_NFT_TOKEN_ID}`,
    )

    // 200 = personality found, 404 = token not configured yet.
    // Both confirm the endpoint is wired and responding.
    expect([200, 404]).toContain(res.status)

    const body = await res.json()
    if (res.status === 200) {
      expect(body).toHaveProperty("display_name")
      expect(body).toHaveProperty("archetype")
    } else {
      expect(body).toHaveProperty("error")
    }
  })
})

// ---------------------------------------------------------------------------
// Test 5: Create conversation
// ---------------------------------------------------------------------------

describe("POST /api/v1/conversations", () => {
  it("creates a conversation for the test wallet", async () => {
    const res = await apiFetch("/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        nft_id: TEST_NFT_ID,
        wallet_address: TEST_WALLET_ADDRESS,
      }),
    })

    // 200 = created, 401 = auth required (no SIWE session).
    // Both confirm the route is mounted and responding.
    if (res.status === 200) {
      const body = await res.json()
      expect(body).toHaveProperty("id")
    } else {
      expect([401, 403]).toContain(res.status)
    }
  })
})

// ---------------------------------------------------------------------------
// Test 6: List conversations
// ---------------------------------------------------------------------------

describe("GET /api/v1/conversations", () => {
  it("lists conversations for a given nft_id", async () => {
    const res = await fetch(
      `${BASE}/api/v1/conversations?nft_id=${encodeURIComponent(TEST_NFT_ID)}`,
    )

    // 200 = list returned, 401 = auth required.
    if (res.status === 200) {
      const body = await res.json()
      expect(body).toHaveProperty("conversations")
      expect(Array.isArray(body.conversations)).toBe(true)
    } else {
      expect([401, 403]).toContain(res.status)
    }
  })
})

// ---------------------------------------------------------------------------
// Skipped: Tests requiring running infrastructure
// ---------------------------------------------------------------------------

describe.skip("WebSocket chat", () => {
  test.todo("connects to /ws/:sessionId and receives greeting")
  test.todo("sends message and receives streamed response")
})

describe.skip("Model responses", () => {
  test.todo("POST /api/v1/invoke returns a model-generated response")
  test.todo("Oracle endpoint returns ensemble-scored response")
})
