// tests/e2e/health.test.ts — E2E test harness skeleton (Sprint 1 T1.6)
// First E2E test: GET /health returns 200 with { status: "ok" | "healthy" | "degraded" }
//
// Requires running services:
//   docker compose -f docker-compose.dev.yml up -d

import { describe, it, expect } from "vitest"

const FINN_URL = process.env.FINN_URL ?? "http://localhost:3001"

describe("E2E: Health Check", () => {
  it("GET /health returns 200", async () => {
    const response = await fetch(`${FINN_URL}/health`)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toHaveProperty("status")
    expect(["ok", "healthy", "degraded", "unhealthy"]).toContain(body.status)
  })

  it("GET /health includes uptime", async () => {
    const response = await fetch(`${FINN_URL}/health`)
    const body = await response.json()
    expect(typeof body.uptime).toBe("number")
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })
})
