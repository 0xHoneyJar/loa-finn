// src/hounfour/cheval-invoker.ts — Subprocess wrapper for cheval.py (SDD §4.4, T-14.8)

import { execFile } from "node:child_process"
import { writeFile, mkdir, unlink, rmdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { signRequestLegacy, generateNonce } from "./hmac.js"
import type { HmacConfig } from "./hmac.js"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ChevalError, chevalExitCodeToError, HounfourError } from "./errors.js"
import type {
  ChevalRequest,
  CompletionResult,
  CompletionRequest,
  ResolvedModel,
  ProviderEntry,
  RetryPolicy,
  ModelCapabilities,
  HealthStatus,
  ModelPortBase,
} from "./types.js"
import { DEFAULT_RETRY_POLICY } from "./types.js"

// --- Canonical JSON (matches Python json.dumps(sort_keys=True, separators=(",",":"))) ---

function sortDeep(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val
  if (Array.isArray(val)) return val.map(sortDeep)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortDeep((val as Record<string, unknown>)[key])
  }
  return sorted
}

export function canonicalJsonStringify(obj: unknown): string {
  return JSON.stringify(sortDeep(obj))
}

// Re-export HMAC types and functions from shared module for backward compatibility
export { signRequestLegacy as signRequest, generateNonce } from "./hmac.js"
export type { HmacConfig } from "./hmac.js"

// --- ChevalInvoker ---

export interface ChevalInvokerConfig {
  chevalPath: string                    // Path to cheval.py
  pythonBin: string                     // Default: "python3"
  timeoutMs: number                     // Default: 300_000ms
  hmac: HmacConfig
}

export class ChevalInvoker {
  private config: ChevalInvokerConfig

  constructor(config: Partial<ChevalInvokerConfig> & { hmac: HmacConfig }) {
    this.config = {
      chevalPath: config.chevalPath ?? "adapters/cheval.py",
      pythonBin: config.pythonBin ?? "python3",
      timeoutMs: config.timeoutMs ?? 300_000,
      hmac: config.hmac,
    }
  }

  /**
   * Invoke cheval.py in machine mode.
   * 1. Serialize request to temp JSON file (0600 permissions)
   * 2. Spawn subprocess with scoped environment
   * 3. Parse stdout JSON as CompletionResult
   * 4. Clean up temp files
   */
  async invoke(request: ChevalRequest): Promise<CompletionResult> {
    const tempDir = join(tmpdir(), `cheval-${process.pid}`)
    const tempFile = join(tempDir, `req-${Date.now()}.json`)

    try {
      // Create temp directory
      if (!existsSync(tempDir)) {
        await mkdir(tempDir, { recursive: true, mode: 0o700 })
      }

      // Sign request — must match Python's json.dumps(sort_keys=True, separators=(",",":"))
      const requestForSigning = { ...request }
      delete (requestForSigning as Record<string, unknown>).hmac
      const canonicalBody = canonicalJsonStringify(requestForSigning)

      const nonce = generateNonce()
      const issuedAt = new Date().toISOString()
      const traceId = request.metadata.trace_id

      const signature = signRequestLegacy(canonicalBody, this.config.hmac.secret, nonce, traceId, issuedAt)

      // Add HMAC to request
      const signedRequest: ChevalRequest = {
        ...request,
        hmac: {
          signature,
          nonce,
          issued_at: issuedAt,
        },
      }

      // Write temp file with 0600 permissions
      const requestJson = JSON.stringify(signedRequest)
      await writeFile(tempFile, requestJson, { mode: 0o600 })

      // Spawn subprocess with scoped environment
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CHEVAL_HMAC_SECRET: this.config.hmac.secret,
      }
      if (this.config.hmac.secretPrev) {
        env.CHEVAL_HMAC_SECRET_PREV = this.config.hmac.secretPrev
      }
      // Pass the provider API key
      if (request.provider.api_key) {
        // The API key is already in the request JSON, but cheval.py reads it from there
        // No need to duplicate in env — scoped env is clean
      }

      // Invoke cheval.py
      const result = await this.spawnCheval(tempFile, env)
      return result
    } finally {
      // Clean up temp files (always, including on error)
      try {
        if (existsSync(tempFile)) await unlink(tempFile)
        if (existsSync(tempDir)) await rmdir(tempDir).catch(() => {})
      } catch {
        // Best-effort cleanup
      }
    }
  }

  private spawnCheval(requestPath: string, env: Record<string, string>): Promise<CompletionResult> {
    return new Promise((resolve, reject) => {
      const args = [
        this.config.chevalPath,
        "--request", requestPath,
        "--schema-version", "1",
      ]

      const child = execFile(this.config.pythonBin, args, {
        env,
        timeout: this.config.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }, (error, stdout, stderr) => {
        // Log stderr diagnostics (never structured data)
        if (stderr && stderr.trim()) {
          for (const line of stderr.trim().split("\n")) {
            console.warn(`[cheval] ${line}`)
          }
        }

        if (error) {
          const exitCode = (error as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? 5
            : (error as NodeJS.ErrnoException & { killed?: boolean }).killed
              ? 2 // Killed by timeout
              : (error as any).status ?? 5

          // Try to parse structured error from stdout
          if (stdout && stdout.trim()) {
            try {
              const parsed = JSON.parse(stdout.trim())
              if (parsed.error === "ChevalError") {
                reject(new ChevalError({
                  code: parsed.code ?? "cheval_crash",
                  message: parsed.message ?? "Unknown error",
                  providerCode: parsed.provider_code,
                  statusCode: parsed.status_code,
                  retryable: parsed.retryable ?? false,
                }))
                return
              }
            } catch {
              // Not JSON — fall through to exit code mapping
            }
          }

          reject(chevalExitCodeToError(exitCode, stderr?.trim() ?? ""))
          return
        }

        // Parse stdout JSON
        if (!stdout || !stdout.trim()) {
          reject(new ChevalError({
            code: "cheval_invalid_response",
            message: "Empty stdout from cheval.py",
          }))
          return
        }

        try {
          const result = JSON.parse(stdout.trim()) as CompletionResult
          resolve(result)
        } catch (parseErr) {
          reject(new ChevalError({
            code: "cheval_invalid_response",
            message: `Failed to parse cheval.py stdout: ${(parseErr as Error).message}`,
          }))
        }
      })
    })
  }
}

// --- ChevalModelAdapter ---

/** Health prober interface (minimal for Phase 0-2) */
export interface HealthProber {
  recordSuccess(provider: string, modelId: string): void
  recordFailure(provider: string, modelId: string, error: Error): void
  isHealthy(resolved: ResolvedModel): boolean
}

/**
 * ModelPortBase adapter for remote_model providers.
 * Wraps ChevalInvoker with retry logic per SDD §4.2.
 */
export class ChevalModelAdapter implements ModelPortBase {
  constructor(
    private cheval: ChevalInvoker,
    private resolvedModel: ResolvedModel,
    private providerConfig: ProviderEntry,
    private health: HealthProber,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const chevalReq = this.buildChevalRequest(request)
    const retryPolicy = this.providerConfig.retryPolicy ?? DEFAULT_RETRY_POLICY
    let lastError: ChevalError | undefined

    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.calculateBackoff(attempt, retryPolicy)
          await sleep(delay)
          console.warn(
            `[hounfour] Retrying ${this.resolvedModel.provider}:${this.resolvedModel.modelId} ` +
            `(attempt ${attempt + 1}/${retryPolicy.maxRetries + 1}): ${lastError?.message}`,
          )
        }

        const result = await this.cheval.invoke(chevalReq)
        this.health.recordSuccess(this.resolvedModel.provider, this.resolvedModel.modelId)
        return result
      } catch (err) {
        if (!(err instanceof ChevalError)) throw err

        lastError = err

        if (!this.isRetryable(err, retryPolicy)) throw err

        if (attempt === retryPolicy.maxRetries) {
          this.health.recordFailure(this.resolvedModel.provider, this.resolvedModel.modelId, err)
          throw err
        }
      }
    }

    throw lastError!
  }

  capabilities(): ModelCapabilities {
    const model = this.providerConfig.models.get(this.resolvedModel.modelId)
    if (!model) {
      throw new HounfourError("CONFIG_INVALID", `Model ${this.resolvedModel.modelId} not found in provider ${this.resolvedModel.provider}`, {})
    }
    return model.capabilities
  }

  async healthCheck(): Promise<HealthStatus> {
    const healthy = this.health.isHealthy(this.resolvedModel)
    return { healthy, latency_ms: 0 }
  }

  private buildChevalRequest(request: CompletionRequest): ChevalRequest {
    const options = this.providerConfig.options
    return {
      schema_version: 1,
      provider: {
        name: this.providerConfig.name,
        type: this.providerConfig.type as "openai" | "openai-compatible",
        base_url: options?.baseURL ?? "",
        api_key: options?.apiKey ?? "",
        connect_timeout_ms: options?.connectTimeoutMs ?? 5000,
        read_timeout_ms: options?.readTimeoutMs ?? 60000,
        total_timeout_ms: options?.totalTimeoutMs ?? 300000,
      },
      model: this.resolvedModel.modelId,
      messages: request.messages,
      tools: request.tools,
      options: request.options,
      metadata: request.metadata,
      retry: {
        max_retries: (this.providerConfig.retryPolicy ?? DEFAULT_RETRY_POLICY).maxRetries,
        base_delay_ms: (this.providerConfig.retryPolicy ?? DEFAULT_RETRY_POLICY).baseDelayMs,
        max_delay_ms: (this.providerConfig.retryPolicy ?? DEFAULT_RETRY_POLICY).maxDelayMs,
        jitter_percent: (this.providerConfig.retryPolicy ?? DEFAULT_RETRY_POLICY).jitterPercent,
        retryable_status_codes: (this.providerConfig.retryPolicy ?? DEFAULT_RETRY_POLICY).retryableStatusCodes,
      },
      hmac: { signature: "", nonce: "", issued_at: "" }, // Filled by ChevalInvoker.invoke()
    }
  }

  private calculateBackoff(attempt: number, policy: RetryPolicy): number {
    const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt - 1)
    const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs)
    const jitterRange = cappedDelay * (policy.jitterPercent / 100)
    const jitter = (Math.random() * 2 - 1) * jitterRange
    return Math.max(0, cappedDelay + jitter)
  }

  private isRetryable(err: ChevalError, policy: RetryPolicy): boolean {
    if (err.statusCode && policy.retryableStatusCodes.includes(err.statusCode)) return true
    if (err.code && policy.retryableErrors.includes(err.code)) return true
    if (err.statusCode && [400, 401, 403, 404].includes(err.statusCode)) return false
    return false
  }
}

// --- Factory ---

/**
 * Create the right ModelPortBase adapter for a resolved model.
 */
export function createModelAdapter(
  resolved: ResolvedModel,
  providerConfig: ProviderEntry,
  cheval: ChevalInvoker,
  health: HealthProber,
): ModelPortBase {
  if (providerConfig.type === "claude-code") {
    throw new HounfourError("NATIVE_RUNTIME_REQUIRED", "NativeRuntimeAdapter not implemented in Phase 0-2", {
      provider: resolved.provider,
      model: resolved.modelId,
    })
  }
  return new ChevalModelAdapter(cheval, resolved, providerConfig, health)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
