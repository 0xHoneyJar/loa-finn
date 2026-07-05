// tests/gateway/route-policy.test.ts — Route guard policy registry
// (#202, #208, #217, #221, #226, #233)
//
// Proves:
// 1. The skip predicate is exactly the set of self-guarded /api/v1 prefixes.
// 2. Every policy entry declares a guard, guard source, and evidence.
// 3. Guard sources exist on disk (no phantom guards).
// 4. docs/gateway-route-policy.md stays in sync with the registry.
// 5. The shared chain still covers non-listed /api/v1 routes (no prefix confusion).

import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  GATEWAY_ROUTE_POLICY,
  isSelfGuardedApiV1Path,
} from "../../src/gateway/route-policy.js"

const SELF_GUARDED = GATEWAY_ROUTE_POLICY.filter((e) => e.selfGuarded)
const SHARED_CHAIN = GATEWAY_ROUTE_POLICY.filter((e) => !e.selfGuarded)

describe("route policy registry (#217, #221)", () => {
  it("every entry declares auth, rate limit, guard source, and evidence", () => {
    for (const entry of GATEWAY_ROUTE_POLICY) {
      expect(entry.prefix, entry.prefix).toMatch(/^\/api\//)
      expect(entry.auth.length, `${entry.prefix} auth`).toBeGreaterThan(0)
      expect(entry.rateLimit.length, `${entry.prefix} rateLimit`).toBeGreaterThan(0)
      expect(entry.guardSource.length, `${entry.prefix} guardSource`).toBeGreaterThan(0)
      expect(entry.evidence.length, `${entry.prefix} evidence`).toBeGreaterThan(0)
    }
  })

  it("guard source and evidence files exist on disk", () => {
    for (const entry of GATEWAY_ROUTE_POLICY) {
      expect(existsSync(resolve(entry.guardSource)), `${entry.prefix} guardSource: ${entry.guardSource}`).toBe(true)
      expect(existsSync(resolve(entry.evidence)), `${entry.prefix} evidence: ${entry.evidence}`).toBe(true)
    }
  })

  it("prefixes are unique", () => {
    const prefixes = GATEWAY_ROUTE_POLICY.map((e) => e.prefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })

  it("public visibility is an explicit declaration, not an omission", () => {
    // /api/v1/public is intentionally unauthenticated — assert the registry
    // says so out loud (this is the evidence for its matrix row).
    const publicEntry = GATEWAY_ROUTE_POLICY.find((e) => e.prefix === "/api/v1/public")
    expect(publicEntry).toBeDefined()
    expect(publicEntry!.visibility).toBe("public")
    expect(publicEntry!.auth).toContain("public")
  })
})

describe("isSelfGuardedApiV1Path — the derived skip predicate (#202, #221, #228)", () => {
  it("matches every self-guarded /api/v1 prefix and its subpaths", () => {
    for (const entry of SELF_GUARDED.filter((e) => e.prefix.startsWith("/api/v1/"))) {
      expect(isSelfGuardedApiV1Path(entry.prefix), entry.prefix).toBe(true)
      expect(isSelfGuardedApiV1Path(`${entry.prefix}/sub/path`), `${entry.prefix}/sub/path`).toBe(true)
    }
  })

  it("does NOT match shared-chain routes — they stay behind JWT + rate limit", () => {
    for (const entry of SHARED_CHAIN.filter((e) => e.prefix.startsWith("/api/v1/"))) {
      expect(isSelfGuardedApiV1Path(entry.prefix), entry.prefix).toBe(false)
    }
    expect(isSelfGuardedApiV1Path("/api/v1/invoke")).toBe(false)
    expect(isSelfGuardedApiV1Path("/api/v1/usage")).toBe(false)
    expect(isSelfGuardedApiV1Path("/api/v1/agent/chat")).toBe(false)
  })

  it("is segment-exact — no prefix-confusion bypass", () => {
    // "/api/v1/oraclefoo" must NOT inherit oracle's exclusion
    expect(isSelfGuardedApiV1Path("/api/v1/oraclefoo")).toBe(false)
    expect(isSelfGuardedApiV1Path("/api/v1/publicity")).toBe(false)
    expect(isSelfGuardedApiV1Path("/api/v1/administrator")).toBe(false)
    expect(isSelfGuardedApiV1Path("/api/v1/x402x")).toBe(false)
    expect(isSelfGuardedApiV1Path("/api/v1/payments")).toBe(false)
  })

  it("does not match non-v1 paths (identity is outside the v1 chain)", () => {
    expect(isSelfGuardedApiV1Path("/api/identity")).toBe(false)
    expect(isSelfGuardedApiV1Path("/api/identity/wallet/0xabc/nfts")).toBe(false)
    expect(isSelfGuardedApiV1Path("/api/sessions")).toBe(false)
  })

  it("skip set matches exactly the documented self-guarded v1 groups", () => {
    const expected = [
      "/api/v1/oracle",
      "/api/v1/public",
      "/api/v1/conversations",
      "/api/v1/admin",
      "/api/v1/x402",
      "/api/v1/pay",
    ].sort()
    const actual = SELF_GUARDED
      .filter((e) => e.prefix.startsWith("/api/v1/"))
      .map((e) => e.prefix)
      .sort()
    expect(actual).toEqual(expected)
  })
})

describe("docs/gateway-route-policy.md sync (#208, #226, #233)", () => {
  const doc = readFileSync(resolve("docs/gateway-route-policy.md"), "utf-8")

  it("has a matrix row for every registry entry", () => {
    for (const entry of GATEWAY_ROUTE_POLICY) {
      expect(doc, `missing row for ${entry.prefix}`).toContain(`| \`${entry.prefix}\` |`)
    }
  })

  it("matrix rows agree with the registry on self-guarded status and guard source", () => {
    for (const entry of GATEWAY_ROUTE_POLICY) {
      const row = doc.split("\n").find((l) => l.startsWith(`| \`${entry.prefix}\` |`))
      expect(row, `row for ${entry.prefix}`).toBeDefined()
      expect(row!, `${entry.prefix} self-guarded flag`).toContain(entry.selfGuarded ? "| yes |" : "| no |")
      expect(row!, `${entry.prefix} guard source`).toContain(entry.guardSource)
      expect(row!, `${entry.prefix} evidence`).toContain(entry.evidence)
    }
  })

  it("documents no routes that are absent from the registry", () => {
    const rowPrefixes = doc
      .split("\n")
      .filter((l) => /^\| `\/api\//.test(l))
      .map((l) => l.split("|")[1].trim().replace(/`/g, ""))
    const registryPrefixes = new Set(GATEWAY_ROUTE_POLICY.map((e) => e.prefix))
    for (const p of rowPrefixes) {
      expect(registryPrefixes.has(p), `doc row ${p} missing from registry`).toBe(true)
    }
  })
})
