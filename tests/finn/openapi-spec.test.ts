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
