// tests/finn/openapi-spec.test.ts — OpenAPI 3.1 Spec Tests (Sprint 7 T7.1)

import { describe, it, expect } from "vitest"
import { buildOpenApiSpec } from "../../src/gateway/openapi-spec.js"

describe("OpenAPI Specification (T7.1)", () => {
  const spec = buildOpenApiSpec()

  it("returns valid OpenAPI 3.1 structure", () => {
    expect(spec.openapi).toBe("3.1.0")
    expect(spec.info).toBeDefined()
    expect((spec.info as Record<string, unknown>).title).toBe("Finn Agent API")
    expect((spec.info as Record<string, unknown>).version).toBe("1.0.0")
  })

  it("includes all expected paths", () => {
    const paths = spec.paths as Record<string, unknown>
    expect(paths["/api/v1/agent/chat"]).toBeDefined()
    expect(paths["/api/v1/keys"]).toBeDefined()
    expect(paths["/api/v1/keys/{key_id}"]).toBeDefined()
    expect(paths["/api/v1/keys/{key_id}/balance"]).toBeDefined()
    expect(paths["/api/v1/auth/nonce"]).toBeDefined()
    expect(paths["/api/v1/auth/verify"]).toBeDefined()
    expect(paths["/health"]).toBeDefined()
    expect(paths["/metrics"]).toBeDefined()
    expect(paths["/llms.txt"]).toBeDefined()
    expect(paths["/agents.md"]).toBeDefined()
    expect(paths["/agent/{tokenId}"]).toBeDefined()
  })

  it("defines all required component schemas", () => {
    const schemas = (spec.components as Record<string, Record<string, unknown>>).schemas as Record<string, unknown>
    expect(schemas["ChatRequest"]).toBeDefined()
    expect(schemas["ChatResponse"]).toBeDefined()
    expect(schemas["X402Challenge"]).toBeDefined()
    expect(schemas["CreateKeyResponse"]).toBeDefined()
    expect(schemas["HealthResponse"]).toBeDefined()
    expect(schemas["Error"]).toBeDefined()
  })

  it("defines all four security schemes", () => {
    const securitySchemes = (spec.components as Record<string, Record<string, unknown>>).securitySchemes as Record<string, unknown>
    expect(securitySchemes["bearerApiKey"]).toBeDefined()
    expect(securitySchemes["x402Payment"]).toBeDefined()
    expect(securitySchemes["siweSession"]).toBeDefined()
    expect(securitySchemes["metricsBearer"]).toBeDefined()
  })

  it("chat endpoint requires bearerApiKey or x402Payment", () => {
    const chatPath = (spec.paths as Record<string, Record<string, unknown>>)["/api/v1/agent/chat"] as Record<string, Record<string, unknown>>
    const security = chatPath.post.security as Array<Record<string, unknown>>
    expect(security).toHaveLength(2)
    expect(security[0]).toHaveProperty("bearerApiKey")
    expect(security[1]).toHaveProperty("x402Payment")
  })

  it("keys endpoints require siweSession", () => {
    const keysPath = (spec.paths as Record<string, Record<string, unknown>>)["/api/v1/keys"] as Record<string, Record<string, unknown>>
    const security = keysPath.post.security as Array<Record<string, unknown>>
    expect(security).toHaveLength(1)
    expect(security[0]).toHaveProperty("siweSession")
  })

  it("chat endpoint documents 402 response with X402Challenge schema", () => {
    const chatPath = (spec.paths as Record<string, Record<string, unknown>>)["/api/v1/agent/chat"] as Record<string, Record<string, unknown>>
    const responses = chatPath.post.responses as Record<string, Record<string, unknown>>
    expect(responses["402"]).toBeDefined()
    const content = responses["402"].content as Record<string, Record<string, unknown>>
    const schema = content["application/json"].schema as Record<string, string>
    expect(schema.$ref).toBe("#/components/schemas/X402Challenge")
  })

  it("X402Challenge schema includes required challenge fields", () => {
    const schemas = (spec.components as Record<string, Record<string, unknown>>).schemas as Record<string, Record<string, unknown>>
    const x402 = schemas["X402Challenge"] as Record<string, unknown>
    const props = x402.properties as Record<string, Record<string, unknown>>
    const challenge = props.challenge as Record<string, unknown>
    const challengeProps = challenge.properties as Record<string, unknown>
    expect(challengeProps).toHaveProperty("nonce")
    expect(challengeProps).toHaveProperty("amount")
    expect(challengeProps).toHaveProperty("recipient")
    expect(challengeProps).toHaveProperty("chain_id")
    expect(challengeProps).toHaveProperty("expires_at")
    expect(challengeProps).toHaveProperty("hmac")
  })

  it("includes Discovery tag", () => {
    const tags = spec.tags as Array<Record<string, string>>
    const discoveryTag = tags.find((t) => t.name === "Discovery")
    expect(discoveryTag).toBeDefined()
    expect(discoveryTag!.description).toContain("discovery")
  })

  it("discovery endpoints have no security requirement", () => {
    const llms = (spec.paths as Record<string, Record<string, unknown>>)["/llms.txt"] as Record<string, Record<string, unknown>>
    expect(llms.get.security).toBeUndefined()

    const agents = (spec.paths as Record<string, Record<string, unknown>>)["/agents.md"] as Record<string, Record<string, unknown>>
    expect(agents.get.security).toBeUndefined()

    const homepage = (spec.paths as Record<string, Record<string, unknown>>)["/agent/{tokenId}"] as Record<string, Record<string, unknown>>
    expect(homepage.get.security).toBeUndefined()
  })

  it("ChatRequest requires token_id and message", () => {
    const schemas = (spec.components as Record<string, Record<string, unknown>>).schemas as Record<string, Record<string, unknown>>
    const chatReq = schemas["ChatRequest"] as Record<string, unknown>
    expect(chatReq.required).toContain("token_id")
    expect(chatReq.required).toContain("message")
  })

  it("includes server definitions", () => {
    const servers = spec.servers as Array<Record<string, string>>
    expect(servers.length).toBeGreaterThanOrEqual(1)
    expect(servers[0].url).toContain("finn.honeyjar.xyz")
  })
})

// ===========================================================================
// OpenAPI Augmentation (T3.1 · bd-14wv) — bring the spec in line with the
// live route surface mounted in server.ts: the tenant-authenticated invoke /
// usage endpoints, conversation CRUD, and the Dixie-aligned identity shapes.
// ===========================================================================

describe("OpenAPI Augmentation (T3.1 · bd-14wv)", () => {
  const spec = buildOpenApiSpec()
  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>
  const schemas = (spec.components as Record<string, Record<string, unknown>>).schemas as Record<string, Record<string, unknown>>
  const securitySchemes = (spec.components as Record<string, Record<string, unknown>>).securitySchemes as Record<string, unknown>

  it("documents the tenant-authenticated POST /api/v1/invoke endpoint", () => {
    const invoke = paths["/api/v1/invoke"]
    expect(invoke).toBeDefined()
    expect(invoke.post).toBeDefined()
    const security = invoke.post.security as Array<Record<string, unknown>>
    expect(security[0]).toHaveProperty("tenantJwt")
    const responses = invoke.post.responses as Record<string, unknown>
    expect(responses["200"]).toBeDefined()
    expect(responses["402"]).toBeDefined() // BUDGET_EXCEEDED maps to 402
    expect(responses["500"]).toBeDefined() // unexpected error → INTERNAL_ERROR (routes/invoke.ts)
  })

  it("documents the tenant-authenticated GET /api/v1/usage endpoint with days param", () => {
    const usage = paths["/api/v1/usage"]
    expect(usage).toBeDefined()
    expect(usage.get).toBeDefined()
    const security = usage.get.security as Array<Record<string, unknown>>
    expect(security[0]).toHaveProperty("tenantJwt")
    const params = usage.get.parameters as Array<Record<string, unknown>>
    expect(params.some((p) => p.name === "days" && p.in === "query")).toBe(true)
    // /api/v1/usage passes through rateLimitMiddleware (server.ts) → 429 reachable
    expect((usage.get.responses as Record<string, unknown>)["429"]).toBeDefined()
  })

  it("documents conversation CRUD endpoints under SIWE session auth", () => {
    expect(paths["/api/v1/conversations"]).toBeDefined()
    expect(paths["/api/v1/conversations"].post).toBeDefined()
    expect(paths["/api/v1/conversations"].get).toBeDefined()
    expect(paths["/api/v1/conversations/{id}/messages"]).toBeDefined()
    expect(paths["/api/v1/conversations/{id}/messages"].get).toBeDefined()

    const createSec = paths["/api/v1/conversations"].post.security as Array<Record<string, unknown>>
    expect(createSec[0]).toHaveProperty("siweSession")
  })

  it("documents the deprecated singular identity /nft endpoint (RFC 8594)", () => {
    const singular = paths["/api/identity/wallet/{wallet}/nft"]
    expect(singular).toBeDefined()
    expect(singular.get.deprecated).toBe(true)
    const ok = (singular.get.responses as Record<string, Record<string, unknown>>)["200"]
    const headers = ok.headers as Record<string, unknown>
    expect(headers).toHaveProperty("Deprecation")
    expect(headers).toHaveProperty("Sunset")
  })

  it("aligns the plural /nfts response with the Dixie NFTOwnershipInfo shape", () => {
    const plural = paths["/api/identity/wallet/{wallet}/nfts"]
    const ok = (plural.get.responses as Record<string, Record<string, unknown>>)["200"]
    const content = ok.content as Record<string, Record<string, Record<string, unknown>>>
    const schema = content["application/json"].schema as Record<string, Record<string, unknown>>
    // No phantom `total` field — the live handler returns only { nfts: [...] }
    expect(Object.keys(schema.properties)).toEqual(["nfts"])
    const items = (schema.properties.nfts as Record<string, Record<string, string>>).items
    expect(items.$ref).toBe("#/components/schemas/NFTOwnershipInfo")
  })

  it("defines the tenantJwt security scheme", () => {
    expect(securitySchemes["tenantJwt"]).toBeDefined()
  })

  it("defines the augmentation component schemas", () => {
    expect(schemas["InvokeResponse"]).toBeDefined()
    expect(schemas["UsageResponse"]).toBeDefined()
    expect(schemas["Conversation"]).toBeDefined()
    expect(schemas["ConversationSummaryList"]).toBeDefined()
    expect(schemas["ConversationMessageList"]).toBeDefined()
    expect(schemas["NFTOwnershipInfo"]).toBeDefined()
  })

  it("NFTOwnershipInfo carries the Dixie ownership fields", () => {
    const props = schemas["NFTOwnershipInfo"].properties as Record<string, unknown>
    expect(props).toHaveProperty("nftId")
    expect(props).toHaveProperty("contractAddress")
    expect(props).toHaveProperty("tokenId")
    expect(props).toHaveProperty("ownerWallet")
    expect(props).toHaveProperty("delegatedWallets")
  })

  it("every $ref resolves to a defined component schema (contract integrity)", () => {
    const refs: string[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk)
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "$ref" && typeof v === "string") refs.push(v)
          else walk(v)
        }
      }
    }
    walk(spec)
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "")
      expect(schemas[name], `unresolved $ref: ${ref}`).toBeDefined()
    }
  })
})
