// tests/finn/hounfour-registry.test.ts — ProviderRegistry unit tests (T-14.3)

import assert from "node:assert/strict"
import { ProviderRegistry, validateCapabilities } from "../../src/hounfour/registry.js"
import type { RawProviderConfig } from "../../src/hounfour/registry.js"
import { HounfourError } from "../../src/hounfour/errors.js"

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

function makeConfig(overrides?: Partial<RawProviderConfig>): RawProviderConfig {
  return {
    providers: {
      openai: {
        type: "openai",
        options: { baseURL: "https://api.openai.com/v1", apiKey: "sk-test-key" },
        models: {
          "gpt-4o": {
            name: "GPT-4o",
            capabilities: { tool_calling: true, thinking_traces: false, vision: true, streaming: true },
            limit: { context: 128000, output: 4096 },
          },
          "gpt-4o-mini": {
            name: "GPT-4o Mini",
            capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
            limit: { context: 128000, output: 4096 },
          },
        },
      },
      moonshot: {
        type: "openai-compatible",
        options: { baseURL: "https://api.moonshot.cn/v1", apiKey: "ms-test-key" },
        models: {
          "kimi-k2-thinking": {
            name: "Kimi-K2 Thinking",
            capabilities: { tool_calling: true, thinking_traces: true, vision: false, streaming: true },
            limit: { context: 128000, output: 8192 },
          },
        },
      },
      "claude-code": {
        type: "claude-code",
        models: {
          "claude-opus-4-6": {
            name: "Claude Opus 4.6",
            capabilities: { tool_calling: true, thinking_traces: true, vision: true, streaming: true },
            limit: { context: 200000, output: 8192 },
          },
        },
      },
    },
    aliases: {
      "reviewer": "openai:gpt-4o",
      "reasoning": "moonshot:kimi-k2-thinking",
      "fast": "openai:gpt-4o-mini",
    },
    agents: {
      "reviewing-code": {
        model: "reviewer",
        requires: { tool_calling: true },
      },
      "implementing-tasks": {
        model: "claude-code:claude-opus-4-6",
        requires: { native_runtime: true, tool_calling: true },
      },
      "flatline-challenger": {
        model: "reasoning",
        requires: { thinking_traces: "required" },
      },
      "translating-for-executives": {
        model: "fast",
        requires: {},
      },
    },
    pricing: {
      "openai:gpt-4o": { input_per_1m: 2.5, output_per_1m: 10.0 },
      "openai:gpt-4o-mini": { input_per_1m: 0.15, output_per_1m: 0.6 },
      "moonshot:kimi-k2-thinking": { input_per_1m: 1.0, output_per_1m: 4.0, reasoning_per_1m: 2.0 },
    },
    ...overrides,
  }
}

async function main() {
  console.log("ProviderRegistry Tests (T-14.3)")
  console.log("================================")

  // --- fromConfig ---

  await test("fromConfig creates registry from valid config", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    const providers = registry.listProviders()
    assert.equal(providers.length, 3)
  })

  await test("fromConfig skips disabled providers", () => {
    const config = makeConfig()
    ;(config.providers.moonshot as any).enabled = false
    const registry = ProviderRegistry.fromConfig(config)
    assert.equal(registry.getProvider("moonshot"), undefined)
    assert.equal(registry.listProviders().length, 2)
  })

  // --- resolveAlias ---

  await test("resolveAlias resolves alias to canonical provider:model", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    const resolved = registry.resolveAlias("reviewer")
    assert.equal(resolved.provider, "openai")
    assert.equal(resolved.modelId, "gpt-4o")
  })

  await test("resolveAlias passes through canonical provider:model", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    const resolved = registry.resolveAlias("openai:gpt-4o-mini")
    assert.equal(resolved.provider, "openai")
    assert.equal(resolved.modelId, "gpt-4o-mini")
  })

  await test("resolveAlias throws CONFIG_INVALID for unresolvable alias", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    assert.throws(
      () => registry.resolveAlias("nonexistent"),
      (err: any) => err instanceof HounfourError && err.code === "CONFIG_INVALID",
    )
  })

  // --- getProvider / getModel ---

  await test("getProvider returns entry for existing provider", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    const provider = registry.getProvider("openai")
    assert.ok(provider)
    assert.equal(provider.name, "openai")
    assert.equal(provider.type, "openai")
  })

  await test("getProvider returns undefined for missing provider", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    assert.equal(registry.getProvider("nonexistent"), undefined)
  })

  await test("getModel returns entry for existing model", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    const model = registry.getModel("openai", "gpt-4o")
    assert.ok(model)
    assert.equal(model.id, "gpt-4o")
    assert.equal(model.name, "GPT-4o")
    assert.equal(model.capabilities.tool_calling, true)
  })

  await test("getModel returns undefined for missing model", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    assert.equal(registry.getModel("openai", "nonexistent"), undefined)
  })

  // --- getAgentBinding ---

  await test("getAgentBinding returns binding for configured agent", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    const binding = registry.getAgentBinding("reviewing-code")
    assert.ok(binding)
    assert.equal(binding.model, "reviewer")
    assert.equal(binding.requires.tool_calling, true)
  })

  await test("getAgentBinding returns undefined for unconfigured agent", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    assert.equal(registry.getAgentBinding("nonexistent"), undefined)
  })

  // --- getPricing ---

  await test("getPricing returns pricing for configured model", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    const pricing = registry.getPricing("openai", "gpt-4o")
    assert.ok(pricing)
    assert.equal(pricing.input_per_1m, 2.5)
    assert.equal(pricing.output_per_1m, 10.0)
  })

  await test("getPricing returns undefined for unconfigured model", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    assert.equal(registry.getPricing("openai", "nonexistent"), undefined)
  })

  // --- validateBindings ---

  await test("validateBindings returns valid for correct config", () => {
    const registry = ProviderRegistry.fromConfig(makeConfig())
    const results = registry.validateBindings()
    const allValid = results.filter(r => r.valid)
    assert.equal(allValid.length, 4, `Expected 4 valid bindings, got ${allValid.length}`)
  })

  await test("validateBindings detects missing provider", () => {
    const config = makeConfig()
    config.agents!["bad-agent"] = {
      model: "nonexistent:model",
      requires: {},
    }
    const registry = ProviderRegistry.fromConfig(config)
    const results = registry.validateBindings()
    const badResult = results.find(r => r.agent === "bad-agent")
    assert.ok(badResult)
    assert.equal(badResult.valid, false)
    assert.ok(badResult.errors[0].includes("not found"))
  })

  await test("validateBindings detects native_runtime on non-Claude provider", () => {
    const config = makeConfig()
    config.agents!["bad-native"] = {
      model: "openai:gpt-4o",
      requires: { native_runtime: true },
    }
    const registry = ProviderRegistry.fromConfig(config)
    const results = registry.validateBindings()
    const badResult = results.find(r => r.agent === "bad-native")
    assert.ok(badResult)
    assert.equal(badResult.valid, false)
    assert.ok(badResult.errors[0].includes("native_runtime"))
  })

  await test("validateBindings detects tool_calling capability mismatch", () => {
    const config = makeConfig()
    // Add a model without tool_calling
    config.providers.openai.models["no-tools"] = {
      name: "No Tools Model",
      capabilities: { tool_calling: false, thinking_traces: false, vision: false, streaming: false },
      limit: { context: 4096, output: 1024 },
    }
    config.agents!["needs-tools"] = {
      model: "openai:no-tools",
      requires: { tool_calling: true },
    }
    const registry = ProviderRegistry.fromConfig(config)
    const results = registry.validateBindings()
    const badResult = results.find(r => r.agent === "needs-tools")
    assert.ok(badResult)
    assert.equal(badResult.valid, false)
    assert.ok(badResult.errors[0].includes("tool_calling"))
  })

  await test("validateBindings detects thinking_traces capability mismatch", () => {
    const config = makeConfig()
    config.agents!["needs-thinking"] = {
      model: "openai:gpt-4o",
      requires: { thinking_traces: "required" },
    }
    const registry = ProviderRegistry.fromConfig(config)
    const results = registry.validateBindings()
    const badResult = results.find(r => r.agent === "needs-thinking")
    assert.ok(badResult)
    assert.equal(badResult.valid, false)
    assert.ok(badResult.errors[0].includes("thinking_traces"))
  })

  // --- validateCapabilities ---

  await test("validateCapabilities returns valid when all requirements met", () => {
    const caps = { tool_calling: true, thinking_traces: true, vision: true, streaming: true }
    const reqs = { tool_calling: true, thinking_traces: "required" as const }
    const result = validateCapabilities(caps, reqs)
    assert.equal(result.valid, true)
    assert.equal(result.missing.length, 0)
  })

  await test("validateCapabilities allows optional thinking_traces", () => {
    const caps = { tool_calling: true, thinking_traces: false, vision: false, streaming: true }
    const reqs = { thinking_traces: "optional" as const }
    const result = validateCapabilities(caps, reqs)
    assert.equal(result.valid, true)
  })

  // --- {env:VAR} interpolation ---

  await test("{env:VAR} resolves allowed env vars", () => {
    process.env.TEST_API_KEY = "resolved-key-value"
    const config = makeConfig()
    config.providers.openai.options = { apiKey: "{env:TEST_API_KEY}" }
    const registry = ProviderRegistry.fromConfig(config)
    const provider = registry.getProvider("openai")
    assert.equal(provider!.options.apiKey, "resolved-key-value")
    delete process.env.TEST_API_KEY
  })

  await test("{env:VAR} rejects disallowed env var names", () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)

    const config = makeConfig()
    config.providers.openai.options = { apiKey: "{env:DANGEROUS_VAR}" }
    const registry = ProviderRegistry.fromConfig(config)
    const provider = registry.getProvider("openai")
    assert.equal(provider!.options.apiKey, "")
    assert.ok(warnings.some(w => w.includes("does not match allowlist")))

    console.warn = origWarn
  })

  await test("{env:VAR} returns empty string for missing env var", () => {
    delete process.env.NONEXISTENT_API_KEY
    const config = makeConfig()
    config.providers.openai.options = { apiKey: "{env:NONEXISTENT_API_KEY}" }
    const registry = ProviderRegistry.fromConfig(config)
    const provider = registry.getProvider("openai")
    assert.equal(provider!.options.apiKey, "")
  })

  // --- Cycle detection ---

  await test("fromConfig detects cycles in fallback chains", () => {
    const config = makeConfig()
    config.routing = {
      fallback: {
        "openai:gpt-4o": ["moonshot:kimi-k2-thinking"],
        "moonshot:kimi-k2-thinking": ["openai:gpt-4o"],
      },
    }
    assert.throws(
      () => ProviderRegistry.fromConfig(config),
      (err: any) => err instanceof HounfourError && err.code === "CONFIG_INVALID" && err.message.includes("Cycle"),
    )
  })

  await test("fromConfig accepts acyclic fallback chains", () => {
    const config = makeConfig()
    config.routing = {
      fallback: {
        "openai:gpt-4o": ["moonshot:kimi-k2-thinking"],
        "moonshot:kimi-k2-thinking": ["openai:gpt-4o-mini"],
      },
    }
    const registry = ProviderRegistry.fromConfig(config)
    assert.ok(registry)
  })

  console.log("\nDone.")
}

main()
