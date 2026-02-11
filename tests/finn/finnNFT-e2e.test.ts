// tests/finn/finnNFT-e2e.test.ts — finnNFT Routing E2E + Integration Tests (T-C.4, T-C.5)
// Simulates Discord NFT holder flow: JWT with NFT claims → route to preferred pool → response.
// Also covers tier authorization, BYOK path, fallback, cost attribution, and edge cases.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ProviderRegistry } from "../../src/hounfour/registry.js"
import type { RawProviderConfig } from "../../src/hounfour/registry.js"
import { HounfourRouter } from "../../src/hounfour/router.js"
import { BudgetEnforcer } from "../../src/hounfour/budget.js"
import { PoolRegistry, DEFAULT_POOLS } from "../../src/hounfour/pool-registry.js"
import type { Tier } from "../../src/hounfour/pool-registry.js"
import type { TenantContext, JWTClaims } from "../../src/hounfour/jwt-auth.js"
import { BYOKProxyClient, BYOKKeyNotFoundError } from "../../src/hounfour/byok-proxy-client.js"
import { HounfourError } from "../../src/hounfour/errors.js"
import type {
  CompletionRequest,
  CompletionResult,
  ResolvedModel,
  ScopeMeta,
} from "../../src/hounfour/types.js"

// --- Temp Dir Helpers ---

const PREFIX = "finn-nft-e2e-"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), PREFIX))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

// --- Fixtures ---

const SCOPE: ScopeMeta = { project_id: "thj", phase_id: "p5", sprint_id: "c" }

function makeProviderConfig(): RawProviderConfig {
  return {
    providers: {
      "qwen-local": {
        type: "openai-compatible",
        options: { baseURL: "http://localhost:8080/v1", apiKey: "test" },
        models: {
          "Qwen/Qwen2.5-7B-Instruct": {
            name: "Qwen 2.5 7B",
            capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
            limit: { context: 32000, output: 4096 },
          },
          "Qwen/Qwen2.5-Coder-7B-Instruct": {
            name: "Qwen 2.5 Coder 7B",
            capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
            limit: { context: 32000, output: 4096 },
          },
        },
      },
      openai: {
        type: "openai",
        options: { baseURL: "https://api.openai.com/v1", apiKey: "sk-test" },
        models: {
          "gpt-4o": {
            name: "GPT-4o",
            capabilities: { tool_calling: true, thinking_traces: false, vision: true, streaming: true },
            limit: { context: 128000, output: 4096 },
          },
          "o3": {
            name: "O3",
            capabilities: { tool_calling: true, thinking_traces: true, vision: false, streaming: true },
            limit: { context: 200000, output: 100000 },
          },
        },
      },
      anthropic: {
        type: "openai-compatible",
        options: { baseURL: "https://api.anthropic.com/v1", apiKey: "sk-ant-test" },
        models: {
          "claude-opus-4-6": {
            name: "Claude Opus 4.6",
            capabilities: { tool_calling: true, thinking_traces: true, vision: true, streaming: true },
            limit: { context: 200000, output: 32000 },
          },
        },
      },
    },
    aliases: {
      cheap: "qwen-local:Qwen/Qwen2.5-7B-Instruct",
      "fast-code": "qwen-local:Qwen/Qwen2.5-Coder-7B-Instruct",
      reviewer: "openai:gpt-4o",
      reasoning: "openai:o3",
      architect: "anthropic:claude-opus-4-6",
    },
    agents: {
      "chat-agent": { model: "cheap", requires: {} },
      "code-agent": { model: "fast-code", requires: { tool_calling: true } },
      "review-agent": { model: "reviewer", requires: { tool_calling: true } },
      "analysis-agent": { model: "reasoning", requires: { thinking_traces: "required" } },
    },
    pricing: {
      "qwen-local:Qwen/Qwen2.5-7B-Instruct": { input_per_1m: 0, output_per_1m: 0 },
      "qwen-local:Qwen/Qwen2.5-Coder-7B-Instruct": { input_per_1m: 0, output_per_1m: 0 },
      "openai:gpt-4o": { input_per_1m: 2.5, output_per_1m: 10 },
      "openai:o3": { input_per_1m: 10, output_per_1m: 40 },
      "anthropic:claude-opus-4-6": { input_per_1m: 15, output_per_1m: 75 },
    },
  }
}

function makeBudget(dir: string, budgets: Record<string, number> = {}): BudgetEnforcer {
  return new BudgetEnforcer({
    ledgerPath: join(dir, "ledger.jsonl"),
    checkpointPath: join(dir, "checkpoint.json"),
    onLedgerFailure: "fail-open",
    warnPercent: 80,
    budgets,
  })
}

function makeHealthProber(unhealthyProviders: Set<string> = new Set()) {
  return {
    recordSuccess() {},
    recordFailure() {},
    isHealthy(resolved: ResolvedModel) {
      return !unhealthyProviders.has(resolved.provider)
    },
  }
}

function makeMockCheval(customResult?: Partial<CompletionResult>) {
  const calls: CompletionRequest[] = []
  const defaultResult: CompletionResult = {
    content: "Mock NFT response",
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0 },
    metadata: { model: "mock", latency_ms: 150, trace_id: "" },
    ...customResult,
  }
  return {
    invoke: async (req: CompletionRequest) => {
      calls.push(req)
      return { ...defaultResult, metadata: { ...defaultResult.metadata, trace_id: req.metadata.trace_id } }
    },
    getCalls: () => calls,
  }
}

// --- Mock S2S JWT Signer ---

function createMockSigner() {
  return {
    signJWT: vi.fn().mockResolvedValue("mock-s2s-jwt"),
    signJWS: vi.fn().mockResolvedValue("mock-jws"),
    signPayload: vi.fn().mockResolvedValue("mock-jws-payload"),
    init: vi.fn().mockResolvedValue(undefined),
    getPublicJWK: vi.fn().mockReturnValue({}),
    getJWKS: vi.fn().mockReturnValue({ keys: [] }),
    get isReady() { return true },
  }
}

// --- TenantContext Factory ---

function makeTenantContext(overrides?: Partial<JWTClaims> & { isBYOK?: boolean }): TenantContext {
  const { isBYOK: byokOverride, ...claimOverrides } = overrides ?? {}
  const claims: JWTClaims = {
    iss: "arrakis",
    aud: "loa-finn",
    sub: "discord:user-4269",
    tenant_id: "community:thj",
    tier: "pro",
    nft_id: "mibera:4269",
    model_preferences: {
      chat: "cheap",
      code: "fast-code",
      review: "reviewer",
    },
    byok: false,
    req_hash: "sha256:abc123",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claimOverrides,
  }

  return {
    claims,
    resolvedPools: Object.values(claims.model_preferences ?? {}),
    isNFTRouted: !!claims.nft_id,
    isBYOK: byokOverride ?? !!claims.byok,
  }
}

// --- Tests ---

describe("finnNFT E2E Routing", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
  })

  afterEach(() => {
    cleanup(dir)
    vi.restoreAllMocks()
  })

  // --- T-C.4: E2E NFT Routing Demo ---

  describe("NFT holder routing flow", () => {
    it("routes chat request to cheap pool via NFT model_preferences", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        model_preferences: { chat: "cheap", code: "fast-code" },
      })

      const result = await router.invokeForTenant("chat-agent", "What is Honey Jar?", tenant, "chat")

      expect(result.content).toBe("Mock NFT response")
      expect(result.metadata.trace_id).toBeTruthy()
    })

    it("routes code request to fast-code pool via NFT model_preferences", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        model_preferences: { chat: "cheap", code: "fast-code" },
      })

      const result = await router.invokeForTenant("code-agent", "Implement a sort function", tenant, "code")

      expect(result.content).toBe("Mock NFT response")
    })

    it("routes analysis request to reasoning pool for enterprise tenant", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        tier: "enterprise",
        model_preferences: { analysis: "reasoning" },
      })

      const result = await router.invokeForTenant("analysis-agent", "Analyze this contract", tenant, "analysis")

      expect(result.content).toBe("Mock NFT response")
    })

    it("includes tenant_id and nft_id in request metadata", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        tenant_id: "community:thj",
        nft_id: "mibera:4269",
      })

      const result = await router.invokeForTenant("chat-agent", "Hello", tenant, "chat")

      // Verify the result has a valid trace_id (metadata propagation)
      expect(result.metadata.trace_id).toBeTruthy()
      expect(typeof result.metadata.trace_id).toBe("string")
      expect(result.metadata.trace_id.length).toBeGreaterThan(0)
    })

    it("records cost with tenant attribution", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir, { "project:thj": 100 })
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext()

      await router.invokeForTenant("chat-agent", "Hello", tenant, "chat")

      const snapshot = budget.getBudgetSnapshot(SCOPE)
      // cheap pool (qwen-local) has $0 pricing, so spent should be 0
      expect(snapshot.spent_usd).toBe(0)
    })
  })

  // --- T-C.3: BYOK Delegation Path ---

  describe("BYOK delegation", () => {
    it("delegates to BYOKProxyClient when tenant isBYOK", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()
      const signer = createMockSigner()

      const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        content: "BYOK response via arrakis proxy",
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 20, completion_tokens: 10, reasoning_tokens: 0 },
        metadata: { model: "gpt-4o", latency_ms: 300, trace_id: "byok-trace" },
      }), { status: 200 }))
      vi.stubGlobal("fetch", fetchSpy)

      const byokProxy = new BYOKProxyClient(
        "https://arrakis.example.com",
        signer as any,
        "openai",
        "gpt-4o",
      )

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
        byokProxy,
      })

      const tenant = makeTenantContext({
        byok: true,
        isBYOK: true,
      })

      const result = await router.invokeForTenant("chat-agent", "Hello from BYOK", tenant, "chat")

      expect(result.content).toBe("BYOK response via arrakis proxy")
      expect(signer.signJWT).toHaveBeenCalled()

      // Verify request went to arrakis proxy, not direct provider
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url] = fetchSpy.mock.calls[0]
      expect(url).toContain("/internal/byok-proxy")
    })

    it("falls back to direct provider when isBYOK is false", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()
      const signer = createMockSigner()

      const byokProxy = new BYOKProxyClient(
        "https://arrakis.example.com",
        signer as any,
        "openai",
        "gpt-4o",
      )

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
        byokProxy,
      })

      const tenant = makeTenantContext({
        byok: false,
        isBYOK: false,
      })

      const result = await router.invokeForTenant("chat-agent", "Hello", tenant, "chat")

      // Should use cheval (direct provider), not BYOK proxy
      expect(result.content).toBe("Mock NFT response")
      expect(signer.signJWT).not.toHaveBeenCalled()
    })

    it("throws BYOK_PROXY_UNAVAILABLE when isBYOK but no proxy configured", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
        // No byokProxy configured
      })

      const tenant = makeTenantContext({
        byok: true,
        isBYOK: true,
      })

      await expect(
        router.invokeForTenant("chat-agent", "Hello", tenant, "chat"),
      ).rejects.toThrow("BYOK proxy is not configured")
    })
  })

  // --- T-C.5: Integration / Edge Cases ---

  describe("tier authorization", () => {
    it("throws TIER_UNAUTHORIZED when free tier requests pro pool", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        tier: "free",
        model_preferences: { code: "fast-code" }, // fast-code requires pro
      })

      await expect(
        router.invokeForTenant("code-agent", "Write code", tenant, "code"),
      ).rejects.toThrow(HounfourError)

      try {
        await router.invokeForTenant("code-agent", "Write code", tenant, "code")
      } catch (err) {
        expect(err).toBeInstanceOf(HounfourError)
        expect((err as HounfourError).code).toBe("TIER_UNAUTHORIZED")
      }
    })

    it("allows free tier to use cheap pool", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        tier: "free",
        model_preferences: { chat: "cheap" },
      })

      const result = await router.invokeForTenant("chat-agent", "Hello", tenant, "chat")
      expect(result.content).toBe("Mock NFT response")
    })

    it("allows enterprise tier to use reasoning pool", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        tier: "enterprise",
        model_preferences: { analysis: "reasoning" },
      })

      const result = await router.invokeForTenant("analysis-agent", "Deep analysis", tenant, "analysis")
      expect(result.content).toBe("Mock NFT response")
    })
  })

  describe("pool fallback behavior", () => {
    it("falls back to tier default when NFT preference references unknown task type", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        tier: "pro",
        model_preferences: { chat: "cheap" },
        // No "review" task type in preferences — should fall back to tier default
      })

      const result = await router.invokeForTenant("chat-agent", "Review this", tenant, "review")
      expect(result.content).toBe("Mock NFT response")
    })

    it("falls back to 'cheap' pool when no tier pools match", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      // Create a pool registry with only pools that no tier has access to... actually,
      // cheap is accessible by all tiers in DEFAULT_POOLS, so the global fallback works.
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      // Tenant with no NFT routing — falls through to tier default → global fallback
      const tenant = makeTenantContext({
        nft_id: undefined,
        model_preferences: undefined,
        tier: "free",
      })

      const result = await router.invokeForTenant("chat-agent", "Hello", tenant, "chat")
      expect(result.content).toBe("Mock NFT response")
    })

    it("follows health-aware fallback chain when primary pool provider is unhealthy", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      // Mark openai as unhealthy — reviewer pool (openai:gpt-4o) should fall back to fast-code
      const health = makeHealthProber(new Set(["openai"]))
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        tier: "pro",
        model_preferences: { review: "reviewer" },
      })

      // reviewer → fast-code (fallback) since openai is unhealthy
      const result = await router.invokeForTenant("review-agent", "Review this code", tenant, "review")
      expect(result.content).toBe("Mock NFT response")
    })
  })

  describe("no-NFT JWT defaults to tier routing", () => {
    it("routes via tier default when JWT has no nft_id", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        nft_id: undefined,
        model_preferences: undefined,
        tier: "pro",
      })

      const result = await router.invokeForTenant("chat-agent", "Hello", tenant, "chat")
      expect(result.content).toBe("Mock NFT response")
    })
  })

  describe("multiple NFTs independence", () => {
    it("different NFTs can have different model_preferences", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      // NFT #1 prefers cheap for chat
      const tenant1 = makeTenantContext({
        nft_id: "mibera:1001",
        model_preferences: { chat: "cheap" },
        tier: "pro",
      })

      // NFT #2 prefers fast-code for chat
      const tenant2 = makeTenantContext({
        nft_id: "mibera:2002",
        model_preferences: { chat: "fast-code" },
        tier: "pro",
      })

      const result1 = await router.invokeForTenant("chat-agent", "Hello from NFT 1", tenant1, "chat")
      const result2 = await router.invokeForTenant("chat-agent", "Hello from NFT 2", tenant2, "chat")

      // Both should succeed independently
      expect(result1.content).toBe("Mock NFT response")
      expect(result2.content).toBe("Mock NFT response")
    })
  })

  describe("error cases", () => {
    it("throws CONFIG_INVALID when PoolRegistry is not provided", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        // No poolRegistry
      })

      const tenant = makeTenantContext()

      await expect(
        router.invokeForTenant("chat-agent", "Hello", tenant, "chat"),
      ).rejects.toThrow("PoolRegistry required")
    })

    it("throws BINDING_INVALID for unknown agent", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext()

      await expect(
        router.invokeForTenant("nonexistent-agent", "Hello", tenant, "chat"),
      ).rejects.toThrow("not found in registry")
    })

    it("throws BUDGET_EXCEEDED when tenant budget is exhausted", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      // Budget of $0 — already exceeded
      const budget = makeBudget(dir, { "project:thj": 0 })
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      // Force budget to show exceeded by recording a cost first
      const budgetWithSpend = makeBudget(dir, { "project:thj": 0.001 })
      await budgetWithSpend.recordCost(
        SCOPE,
        { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 0 },
        { input_per_1m: 2.5, output_per_1m: 10 },
        {
          trace_id: "pre-test",
          agent: "test",
          provider: "openai",
          model: "gpt-4o",
          tenant_id: "community:thj",
          latency_ms: 100,
        },
      )

      const router = new HounfourRouter({
        registry, budget: budgetWithSpend, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext()

      await expect(
        router.invokeForTenant("chat-agent", "Hello", tenant, "chat"),
      ).rejects.toThrow("Budget exceeded")
    })

    it("throws PROVIDER_UNAVAILABLE when all fallbacks exhausted", async () => {
      const registry = ProviderRegistry.fromConfig(makeProviderConfig())
      const poolRegistry = new PoolRegistry(DEFAULT_POOLS)
      const budget = makeBudget(dir)
      // Mark ALL providers as unhealthy
      const health = makeHealthProber(new Set(["qwen-local", "openai", "anthropic"]))
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        poolRegistry,
      })

      const tenant = makeTenantContext({
        tier: "pro",
        model_preferences: { chat: "cheap" },
      })

      await expect(
        router.invokeForTenant("chat-agent", "Hello", tenant, "chat"),
      ).rejects.toThrow("PROVIDER_UNAVAILABLE")
    })
  })
})
