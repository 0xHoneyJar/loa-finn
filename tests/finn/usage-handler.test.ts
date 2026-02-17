// tests/finn/usage-handler.test.ts — Usage endpoint handler tests (cycle-024 T6)

import { describe, it, expect, afterEach } from "vitest"
import { Hono } from "hono"
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { createUsageHandler } from "../../src/gateway/routes/usage.js"
import type { TenantContext } from "../../src/hounfour/jwt-auth.js"

// --- Test Helpers ---

function createMockTenant(tenantId = "tenant-abc"): TenantContext {
  return {
    claims: {
      iss: "arrakis",
      aud: "loa-finn",
      sub: tenantId,
      tenant_id: tenantId,
      tier: "premium" as const,
      req_hash: "hash",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    resolvedPools: ["default"],
    isNFTRouted: false,
    isBYOK: false,
  } as TenantContext
}

/** Create a temporary ledger directory with JSONL content */
function createTempLedger(lines: string[]): string {
  const dir = join(tmpdir(), `finn-usage-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "cost-ledger.jsonl")
  writeFileSync(path, lines.join("\n") + "\n")
  return path
}

function createTestApp(ledgerPath: string, tenant?: TenantContext | null) {
  const app = new Hono()
  const mockTenant = tenant === null ? undefined : (tenant ?? createMockTenant())

  app.use("*", async (c, next) => {
    if (mockTenant) {
      c.set("tenant", mockTenant)
    }
    return next()
  })

  app.get("/api/v1/usage", createUsageHandler(ledgerPath))
  return app
}

// Build a ledger entry JSON line
function ledgerLine(overrides: Record<string, unknown> = {}): string {
  const now = new Date()
  return JSON.stringify({
    schema_version: 2,
    timestamp: now.toISOString(),
    trace_id: `trace-${randomUUID().slice(0, 8)}`,
    agent: "reviewer",
    provider: "openai",
    model: "gpt-4o",
    project_id: "proj-001",
    phase_id: "phase-1",
    sprint_id: "sprint-1",
    tenant_id: "tenant-abc",
    prompt_tokens: 100,
    completion_tokens: 50,
    reasoning_tokens: 0,
    total_cost_micro: "1500",
    latency_ms: 200,
    ...overrides,
  })
}

// Track temp dirs for cleanup
const tempPaths: string[] = []

afterEach(() => {
  for (const p of tempPaths) {
    const dir = p.replace(/\/cost-ledger\.jsonl$/, "")
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  tempPaths.length = 0
})

// --- Tests ---

describe("createUsageHandler", () => {
  // 1. Empty response when ledger doesn't exist
  it("returns empty usage when ledger does not exist", async () => {
    const path = join(tmpdir(), `nonexistent-${randomUUID()}`, "ledger.jsonl")
    const app = createTestApp(path)
    const res = await app.request("/api/v1/usage")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tenant_id).toBe("tenant-abc")
    expect(body.total_cost_micro).toBe("0")
    expect(body.total_requests).toBe(0)
    expect(body.by_model).toEqual([])
    expect(body.settlement_status).toBe("pre_settlement")
  })

  // 2. Basic aggregation with V2 entries
  it("aggregates V2 entries for the correct tenant", async () => {
    const path = createTempLedger([
      ledgerLine({ total_cost_micro: "1000", prompt_tokens: 50, completion_tokens: 25 }),
      ledgerLine({ total_cost_micro: "2000", prompt_tokens: 100, completion_tokens: 50 }),
      ledgerLine({ tenant_id: "other-tenant", total_cost_micro: "9999" }), // different tenant
    ])
    tempPaths.push(path)

    const app = createTestApp(path)
    const res = await app.request("/api/v1/usage")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total_cost_micro).toBe("3000")
    expect(body.total_requests).toBe(2)
    expect(body.by_model).toHaveLength(1)
    expect(body.by_model[0].provider).toBe("openai")
    expect(body.by_model[0].model).toBe("gpt-4o")
    expect(body.by_model[0].total_cost_micro).toBe("3000")
    expect(body.by_model[0].prompt_tokens).toBe(150)
    expect(body.by_model[0].completion_tokens).toBe(75)
  })

  // 3. V1 entry compatibility (float USD → micro-USD)
  it("converts V1 float USD entries to micro-USD", async () => {
    const path = createTempLedger([
      JSON.stringify({
        timestamp: new Date().toISOString(),
        tenant_id: "tenant-abc",
        provider: "anthropic",
        model: "claude-3",
        prompt_tokens: 200,
        completion_tokens: 100,
        total_cost_usd: 0.015, // $0.015 = 15000 micro-USD
      }),
    ])
    tempPaths.push(path)

    const app = createTestApp(path)
    const res = await app.request("/api/v1/usage")
    const body = await res.json()
    expect(body.total_cost_micro).toBe("15000")
    expect(body.total_requests).toBe(1)
    expect(body.by_model[0].provider).toBe("anthropic")
    expect(body.by_model[0].model).toBe("claude-3")
  })

  // 4. Multi-model aggregation
  it("aggregates separately by provider:model", async () => {
    const path = createTempLedger([
      ledgerLine({ provider: "openai", model: "gpt-4o", total_cost_micro: "1000" }),
      ledgerLine({ provider: "anthropic", model: "claude-3", total_cost_micro: "2000" }),
      ledgerLine({ provider: "openai", model: "gpt-4o", total_cost_micro: "500" }),
    ])
    tempPaths.push(path)

    const app = createTestApp(path)
    const res = await app.request("/api/v1/usage")
    const body = await res.json()
    expect(body.total_requests).toBe(3)
    expect(body.by_model).toHaveLength(2)

    const openai = body.by_model.find((m: Record<string, unknown>) => m.provider === "openai")
    const anthropic = body.by_model.find((m: Record<string, unknown>) => m.provider === "anthropic")
    expect(openai.total_cost_micro).toBe("1500")
    expect(openai.requests).toBe(2)
    expect(anthropic.total_cost_micro).toBe("2000")
    expect(anthropic.requests).toBe(1)
  })

  // 5. Days parameter filtering
  it("filters entries by days parameter", async () => {
    const now = new Date()
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)

    const path = createTempLedger([
      ledgerLine({ timestamp: now.toISOString(), total_cost_micro: "1000" }),
      ledgerLine({ timestamp: threeDaysAgo.toISOString(), total_cost_micro: "2000" }),
      ledgerLine({ timestamp: tenDaysAgo.toISOString(), total_cost_micro: "5000" }),
    ])
    tempPaths.push(path)

    const app = createTestApp(path)

    // Default 7 days — should include first two entries
    const res7 = await app.request("/api/v1/usage")
    const body7 = await res7.json()
    expect(body7.total_requests).toBe(2)
    expect(body7.total_cost_micro).toBe("3000")

    // 1 day — only today's entry
    const res1 = await app.request("/api/v1/usage?days=1")
    const body1 = await res1.json()
    expect(body1.total_requests).toBe(1)
    expect(body1.total_cost_micro).toBe("1000")

    // 30 days — all entries
    const res30 = await app.request("/api/v1/usage?days=30")
    const body30 = await res30.json()
    expect(body30.total_requests).toBe(3)
    expect(body30.total_cost_micro).toBe("8000")
  })

  // 6. Invalid days parameter → 400
  it("returns 400 for invalid days parameter", async () => {
    const path = createTempLedger([])
    tempPaths.push(path)
    const app = createTestApp(path)

    const res = await app.request("/api/v1/usage?days=abc")
    expect(res.status).toBe(400)

    const resNeg = await app.request("/api/v1/usage?days=-1")
    expect(resNeg.status).toBe(400)

    const resZero = await app.request("/api/v1/usage?days=0")
    expect(resZero.status).toBe(400)
  })

  // 7. Days capped at MAX_DAYS (90)
  it("caps days at 90", async () => {
    const path = createTempLedger([
      ledgerLine({ total_cost_micro: "1000" }),
    ])
    tempPaths.push(path)
    const app = createTestApp(path)
    const res = await app.request("/api/v1/usage?days=365")
    const body = await res.json()
    expect(body.period.days).toBe(90)
  })

  // 8. Missing tenant context → 401
  it("returns 401 when tenant context is missing", async () => {
    const path = createTempLedger([])
    tempPaths.push(path)
    const app = createTestApp(path, null)
    const res = await app.request("/api/v1/usage")
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe("TENANT_CONTEXT_MISSING")
  })

  // 9. Corrupt JSONL lines are skipped
  it("skips corrupt JSONL lines without error", async () => {
    const path = createTempLedger([
      ledgerLine({ total_cost_micro: "1000" }),
      "not valid json {{{",
      "",
      ledgerLine({ total_cost_micro: "2000" }),
    ])
    tempPaths.push(path)
    const app = createTestApp(path)
    const res = await app.request("/api/v1/usage")
    const body = await res.json()
    expect(body.total_requests).toBe(2)
    expect(body.total_cost_micro).toBe("3000")
  })

  // 10. Tenant isolation — cannot see other tenant's data
  it("enforces strict tenant isolation", async () => {
    const path = createTempLedger([
      ledgerLine({ tenant_id: "tenant-abc", total_cost_micro: "1000" }),
      ledgerLine({ tenant_id: "tenant-xyz", total_cost_micro: "5000" }),
      ledgerLine({ tenant_id: "tenant-abc", total_cost_micro: "2000" }),
    ])
    tempPaths.push(path)

    const app = createTestApp(path, createMockTenant("tenant-abc"))
    const res = await app.request("/api/v1/usage")
    const body = await res.json()
    expect(body.tenant_id).toBe("tenant-abc")
    expect(body.total_requests).toBe(2)
    expect(body.total_cost_micro).toBe("3000")
  })

  // 11. Response includes period metadata
  it("includes period metadata in response", async () => {
    const path = createTempLedger([])
    tempPaths.push(path)
    const app = createTestApp(path)
    const res = await app.request("/api/v1/usage?days=14")
    const body = await res.json()
    expect(body.period.days).toBe(14)
    expect(body.period.from).toBeDefined()
    expect(body.period.to).toBeDefined()
  })
})
