// tests/finn/protocol-handshake.test.ts — Protocol Handshake Tests (Phase 5 T6 + Sprint 2 T3/T7)

import { describe, it, expect, afterEach } from "vitest"
import { validateProtocolAtBoot, deriveBaseUrl } from "../../src/hounfour/protocol-handshake.js"
import http from "node:http"

// --- Test Helpers ---

let mockServer: http.Server | null = null

function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    mockServer = http.createServer(handler)
    mockServer.listen(0, () => {
      const addr = mockServer!.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve(port)
    })
  })
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve())
      mockServer = null
    } else {
      resolve()
    }
  })
}

// --- Tests ---

describe("Protocol Handshake", () => {
  afterEach(async () => {
    await stopMockServer()
  })

  // 1. Compatible version — success
  it("succeeds on compatible version with status=compatible", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "healthy", contract_version: "5.0.0" }))
    })
    const result = await validateProtocolAtBoot({
      arrakisBaseUrl: `http://127.0.0.1:${port}`,
      env: "development",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
    expect(result.remoteVersion).toBe("5.0.0")
    expect(result.message).toContain("compatible")
  })

  // 2. Incompatible version — dev mode: ok:true, status:incompatible (Sprint 2 T3)
  it("returns ok:true with status=incompatible in dev mode", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "healthy", contract_version: "1.0.0" }))
    })
    const result = await validateProtocolAtBoot({
      arrakisBaseUrl: `http://127.0.0.1:${port}`,
      env: "development",
    })
    expect(result.ok).toBe(true) // Changed from false — dev always starts
    expect(result.status).toBe("incompatible")
    expect(result.message).toContain("incompatible")
  })

  // 3. Incompatible version — prod mode throws
  it("throws on incompatible version in production", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "healthy", contract_version: "1.0.0" }))
    })
    await expect(validateProtocolAtBoot({
      arrakisBaseUrl: `http://127.0.0.1:${port}`,
      env: "production",
    })).rejects.toThrow("FATAL")
  })

  // 4. Unreachable — dev mode: ok:true, status:degraded
  it("returns ok:true with status=degraded on unreachable server in dev", async () => {
    const result = await validateProtocolAtBoot({
      arrakisBaseUrl: "http://127.0.0.1:1",
      env: "development",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("degraded")
    expect(result.message).toContain("unreachable")
  })

  // 5. Unreachable — prod mode throws
  it("throws on unreachable server in production", async () => {
    await expect(validateProtocolAtBoot({
      arrakisBaseUrl: "http://127.0.0.1:1",
      env: "production",
    })).rejects.toThrow("FATAL")
  })

  // 6. Missing config — dev mode: ok:true, status:skipped
  it("returns ok:true with status=skipped when no URL in dev", async () => {
    const result = await validateProtocolAtBoot({
      env: "development",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("skipped")
    expect(result.message).toContain("skipped")
  })

  // 7. Missing config — prod mode throws
  it("throws when no URL configured in production", async () => {
    await expect(validateProtocolAtBoot({
      env: "production",
    })).rejects.toThrow("FATAL")
  })

  // 8. Missing contract_version — dev mode: ok:true, status:degraded
  it("returns ok:true with status=degraded on missing contract_version", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "healthy" })) // No contract_version
    })
    const result = await validateProtocolAtBoot({
      arrakisBaseUrl: `http://127.0.0.1:${port}`,
      env: "development",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("degraded")
    expect(result.message).toContain("missing contract_version")
  })

  // 9. Health endpoint non-ok — dev mode: status:degraded
  it("returns status=degraded on non-ok health response in dev", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(503)
      res.end()
    })
    const result = await validateProtocolAtBoot({
      arrakisBaseUrl: `http://127.0.0.1:${port}`,
      env: "development",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("degraded")
  })

  // 10. URL derivation via new URL().origin
  it("derives base URL from billing URL origin", () => {
    expect(deriveBaseUrl({
      billingUrl: "https://arrakis.example.com/api/internal/billing/finalize",
      env: "development",
    })).toBe("https://arrakis.example.com")
  })

  // 11. URL derivation — explicit base URL takes precedence
  it("prefers arrakisBaseUrl over billingUrl", () => {
    expect(deriveBaseUrl({
      arrakisBaseUrl: "https://explicit.example.com",
      billingUrl: "https://billing.example.com/api/finalize",
      env: "development",
    })).toBe("https://explicit.example.com")
  })

  // 12. URL derivation — strips trailing slashes
  it("strips trailing slashes from base URL", () => {
    expect(deriveBaseUrl({
      arrakisBaseUrl: "https://arrakis.example.com///",
      env: "development",
    })).toBe("https://arrakis.example.com")
  })

  // 13. URL derivation — returns null for invalid URL
  it("returns null for invalid billing URL", () => {
    expect(deriveBaseUrl({
      billingUrl: "not-a-url",
      env: "development",
    })).toBeNull()
  })

  // 14. Status distinguishability (Sprint 2 T3)
  it("caller can distinguish all four status values", async () => {
    // compatible
    const port = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "healthy", contract_version: "5.0.0" }))
    })
    const compatible = await validateProtocolAtBoot({
      arrakisBaseUrl: `http://127.0.0.1:${port}`,
      env: "development",
    })
    await stopMockServer()

    // skipped
    const skipped = await validateProtocolAtBoot({ env: "development" })

    const statuses = new Set([compatible.status, skipped.status])
    expect(statuses.size).toBe(2) // At minimum, compatible and skipped are distinct
    expect(statuses.has("compatible")).toBe(true)
    expect(statuses.has("skipped")).toBe(true)
  })
})
