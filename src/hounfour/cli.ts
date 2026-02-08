// src/hounfour/cli.ts — model-invoke CLI entry point (SDD §6.1, T-14.9)
// Usage: model-invoke <agent> <prompt-file> [--model alias]

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { ProviderRegistry } from "./registry.js"
import { ChevalInvoker } from "./cheval-invoker.js"
import { BudgetEnforcer } from "./budget.js"
import { HounfourError } from "./errors.js"
import type { ChevalRequest, ScopeMeta } from "./types.js"
import { DEFAULT_RETRY_POLICY } from "./types.js"

interface CliArgs {
  agent: string
  promptFile: string
  modelAlias?: string
  systemPromptFile?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2) // Strip node and script path

  if (args.length < 2) {
    console.error("Usage: model-invoke <agent> <prompt-file> [--model alias]")
    console.error("")
    console.error("Arguments:")
    console.error("  agent        Agent name from .loa.config.yaml agents section")
    console.error("  prompt-file  Path to file containing the prompt text")
    console.error("")
    console.error("Options:")
    console.error("  --model alias  Override model alias for this invocation")
    process.exit(1)
  }

  const agent = args[0]
  const promptFile = args[1]
  let modelAlias: string | undefined

  const modelIdx = args.indexOf("--model")
  if (modelIdx !== -1 && modelIdx + 1 < args.length) {
    modelAlias = args[modelIdx + 1]
  }

  let systemPromptFile: string | undefined
  const sysIdx = args.indexOf("--system-prompt")
  if (sysIdx !== -1 && sysIdx + 1 < args.length) {
    systemPromptFile = args[sysIdx + 1]
  }

  return { agent, promptFile, modelAlias, systemPromptFile }
}

function loadConfig(): Record<string, unknown> {
  // Prefer JSON config if present
  const jsonConfigPath = ".loa.config.json"
  if (existsSync(jsonConfigPath)) {
    return JSON.parse(readFileSync(jsonConfigPath, "utf8"))
  }

  const yamlConfigPath = ".loa.config.yaml"
  if (!existsSync(yamlConfigPath)) {
    throw new HounfourError("CONFIG_INVALID", `Config not found: ${yamlConfigPath} or ${jsonConfigPath}`, { path: yamlConfigPath })
  }

  // Try YAML via yaml package
  try {
    const yaml = require("yaml")
    return yaml.parse(readFileSync(yamlConfigPath, "utf8"))
  } catch {
    // Fall back: try reading as JSON
    try {
      return JSON.parse(readFileSync(yamlConfigPath, "utf8"))
    } catch {
      throw new HounfourError("CONFIG_INVALID", "Cannot parse config file. Install 'yaml' package or use JSON format.", {})
    }
  }
}

function readTextFileOrExit(path: string, label: string): string {
  if (!existsSync(path)) {
    console.error(JSON.stringify({
      error: "HounfourError",
      code: "CONFIG_INVALID",
      message: `${label} file not found: ${path}`,
    }))
    process.exit(1)
  }
  try {
    return readFileSync(path, "utf8")
  } catch {
    console.error(JSON.stringify({
      error: "HounfourError",
      code: "CONFIG_INVALID",
      message: `Unable to read ${label} file: ${path}`,
    }))
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv)

  // Read prompt file
  const prompt = readTextFileOrExit(cliArgs.promptFile, "Prompt")

  // Read optional system prompt file
  let systemPrompt: string | undefined
  if (cliArgs.systemPromptFile) {
    systemPrompt = readTextFileOrExit(cliArgs.systemPromptFile, "System prompt")
  }

  // Load config
  let config: Record<string, unknown>
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof HounfourError) {
      console.error(JSON.stringify(err.toJSON()))
    } else {
      console.error(JSON.stringify({ error: "HounfourError", code: "CONFIG_INVALID", message: String(err) }))
    }
    process.exit(1)
  }

  const hounfourConfig = (config as any).hounfour ?? config
  if (!hounfourConfig.providers) {
    console.error(JSON.stringify({
      error: "HounfourError",
      code: "CONFIG_INVALID",
      message: "No providers configured in hounfour config",
    }))
    process.exit(1)
  }

  // Build registry
  const registry = ProviderRegistry.fromConfig(hounfourConfig)

  // Resolve agent binding
  const binding = registry.getAgentBinding(cliArgs.agent)
  if (!binding) {
    console.error(JSON.stringify({
      error: "HounfourError",
      code: "BINDING_INVALID",
      message: `No binding found for agent "${cliArgs.agent}"`,
    }))
    process.exit(1)
  }

  // Resolve model
  const modelRef = cliArgs.modelAlias ?? binding.model
  const resolved = registry.resolveAlias(modelRef)
  const provider = registry.getProvider(resolved.provider)
  if (!provider) {
    console.error(JSON.stringify({
      error: "HounfourError",
      code: "PROVIDER_UNAVAILABLE",
      message: `Provider "${resolved.provider}" not found or disabled`,
    }))
    process.exit(1)
  }

  // Initialize HMAC
  let hmacSecret = process.env.CHEVAL_HMAC_SECRET ?? ""
  if (!hmacSecret) {
    hmacSecret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")
    console.warn("[hounfour] WARNING: Auto-generated HMAC secret for local development. Set CHEVAL_HMAC_SECRET for production.")
  }

  // Create invoker
  const invoker = new ChevalInvoker({
    hmac: {
      secret: hmacSecret,
      secretPrev: process.env.CHEVAL_HMAC_SECRET_PREV,
    },
  })

  // Build request
  const traceId = randomUUID()
  const retryPolicy = provider.retryPolicy ?? DEFAULT_RETRY_POLICY

  const chevalRequest: ChevalRequest = {
    schema_version: 1,
    provider: {
      name: provider.name,
      type: provider.type as "openai" | "openai-compatible",
      base_url: provider.options?.baseURL ?? "",
      api_key: provider.options?.apiKey ?? "",
      connect_timeout_ms: provider.options?.connectTimeoutMs ?? 5000,
      read_timeout_ms: provider.options?.readTimeoutMs ?? 60000,
      total_timeout_ms: provider.options?.totalTimeoutMs ?? 300000,
    },
    model: resolved.modelId,
    messages: [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      { role: "user" as const, content: prompt },
    ],
    options: {
      temperature: binding.temperature,
    },
    metadata: {
      agent: cliArgs.agent,
      tenant_id: "local",
      nft_id: "",
      trace_id: traceId,
    },
    retry: {
      max_retries: retryPolicy.maxRetries,
      base_delay_ms: retryPolicy.baseDelayMs,
      max_delay_ms: retryPolicy.maxDelayMs,
      jitter_percent: retryPolicy.jitterPercent,
      retryable_status_codes: retryPolicy.retryableStatusCodes,
    },
    hmac: { signature: "", nonce: "", issued_at: "" },
  }

  // Initialize cost ledger (if data dir exists)
  const dataDir = join(process.cwd(), "data", "hounfour")
  let budget: BudgetEnforcer | undefined
  try {
    budget = new BudgetEnforcer({
      ledgerPath: join(dataDir, "cost-ledger.jsonl"),
      checkpointPath: join(dataDir, "budget-checkpoint.json"),
      onLedgerFailure: "fail-open",
      warnPercent: 80,
      budgets: (hounfourConfig as any).metering?.budgets ?? {},
    })
  } catch {
    // Non-fatal — cost metering is optional for CLI usage
  }

  // Invoke
  try {
    const result = await invoker.invoke(chevalRequest)

    // Record cost in ledger (T-15.4 AC: metered through JSONL ledger)
    if (budget) {
      const pricing = registry.getPricing(resolved.provider, resolved.modelId)
      if (pricing) {
        const scopeMeta: ScopeMeta = {
          project_id: (hounfourConfig as any).project_id ?? "default",
          phase_id: (hounfourConfig as any).phase_id ?? "phase-0",
          sprint_id: (hounfourConfig as any).sprint_id ?? "sprint-0",
        }
        await budget.recordCost(scopeMeta, result.usage, pricing, {
          trace_id: traceId,
          agent: cliArgs.agent,
          provider: resolved.provider,
          model: resolved.modelId,
          tenant_id: "local",
          latency_ms: result.metadata.latency_ms,
        }).catch(() => {}) // Non-fatal
      }
    }

    // Print CompletionResult JSON to stdout
    console.log(JSON.stringify(result))
  } catch (err) {
    if (err instanceof HounfourError) {
      console.error(JSON.stringify(err.toJSON()))
    } else if ((err as any).toJSON) {
      console.error(JSON.stringify((err as any).toJSON()))
    } else {
      console.error(JSON.stringify({
        error: "HounfourError",
        code: "PROVIDER_UNAVAILABLE",
        message: String(err),
      }))
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(JSON.stringify({
    error: "HounfourError",
    code: "PROVIDER_UNAVAILABLE",
    message: `Unhandled error: ${err}`,
  }))
  process.exit(1)
})
