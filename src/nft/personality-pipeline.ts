// src/nft/personality-pipeline.ts — Pipeline Orchestrator (Cycle 040, Sprint 1)
//
// Sequences existing personality components into the session creation hot path:
// cache check → signal resolution → DAMP derivation → BEAUVOIR synthesis → cache write.
//
// Implements PersonalityProvider so it plugs into PersonalityProviderChain.
// Includes: singleflight lock (SKP-004), dual-write consistency (SKP-003),
// BEAUVOIR sanitization (SKP-008), and fallback degradation (FR-7).

import type { Redis as RedisClient } from "ioredis"
import type { PersonalityProvider, PersonalityConfig } from "./personality-provider.js"
import type { SignalCache } from "./signal-cache.js"
import type { BeauvoirSynthesizer, IdentitySubgraph } from "./beauvoir-synthesizer.js"
import type { PersonalityStore } from "./personality-store.js"
import type { SignalSnapshot, DAMPFingerprint } from "./signal-types.js"
import { deriveDAMP } from "./damp.js"
import { nameKDF } from "./name-derivation.js"
import type { ExperienceEngine } from "./experience-engine.js"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Codex Version (cached at module load — ESM compatible)
// ---------------------------------------------------------------------------

let codexVersionCache = "unknown"
try {
  const __dirname_esm = dirname(fileURLToPath(import.meta.url))
  const versionPath = resolve(__dirname_esm, "codex-data", "codex-version.json")
  const data = JSON.parse(readFileSync(versionPath, "utf-8"))
  codexVersionCache = `v${data.version}-${(data.sha ?? "unknown").slice(0, 8)}`
} catch {
  // codex-version.json not found — use "unknown"
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineOrchestratorConfig {
  signalCache: SignalCache
  synthesizer: BeauvoirSynthesizer
  personalityStore: PersonalityStore
  redis: RedisClient
  /** Salt for deterministic name derivation */
  collectionSalt?: string
  /** Identity subgraph resolver (Sprint 2 T-2.1) */
  resolveSubgraph?: (snapshot: SignalSnapshot) => Promise<IdentitySubgraph | null>
  /** Experience engine for gradual personality drift (Sprint 2 T-2.2) */
  experienceEngine?: ExperienceEngine
  /** Singleflight lock TTL in seconds (default: 30) */
  lockTtlSeconds?: number
  /** BEAUVOIR max length in characters (default: 8000) */
  maxBeauvoirLength?: number
}

export interface PipelineResult {
  config: PersonalityConfig
  fromCache: boolean
  degraded: boolean
  degradedReason?: string
}

// ---------------------------------------------------------------------------
// BEAUVOIR Sanitization (SKP-008)
// ---------------------------------------------------------------------------

/** Forbidden patterns in generated BEAUVOIR content */
const FORBIDDEN_PATTERNS = [
  /<system-personality>/gi,
  /<\/system-personality>/gi,
  /<system>/gi,
  /<\/system>/gi,
  /\[SYSTEM\]/gi,
  /\[\/SYSTEM\]/gi,
  /<<SYS>>/gi,
  /<<\/SYS>>/gi,
  /You are now/gi,
  /Ignore all previous instructions/gi,
  /Disregard your instructions/gi,
  /Override your system prompt/gi,
]

/**
 * Sanitize BEAUVOIR content before storage.
 * Strips delimiter tokens and system-role directives.
 */
export function sanitizeBeauvoir(content: string, maxLength: number): string {
  let sanitized = content

  for (const pattern of FORBIDDEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]")
  }

  // Enforce length limit
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength)
  }

  return sanitized
}

/**
 * Compute content hash for dual-write consistency checks.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------
// Singleflight Lock (SKP-004)
// ---------------------------------------------------------------------------

const LOCK_PREFIX = "finn:synth-lock:"

async function acquireLock(
  redis: RedisClient,
  tokenId: string,
  ttlSeconds: number,
): Promise<string | null> {
  const lockValue = `${process.pid}-${Date.now()}`
  const result = await redis.set(
    `${LOCK_PREFIX}${tokenId}`,
    lockValue,
    "EX",
    ttlSeconds,
    "NX",
  )
  return result === "OK" ? lockValue : null
}

async function releaseLock(redis: RedisClient, tokenId: string, lockValue: string): Promise<void> {
  // Only delete if we still own the lock (Lua atomic check-and-delete)
  // Prevents deleting another process's lock if ours expired
  await redis.eval(
    `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
    1,
    `${LOCK_PREFIX}${tokenId}`,
    lockValue,
  )
}

async function waitForLock(
  redis: RedisClient,
  tokenId: string,
  maxWaitMs: number = 25000,
  pollIntervalMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const exists = await redis.exists(`${LOCK_PREFIX}${tokenId}`)
    if (!exists) return
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

// ---------------------------------------------------------------------------
// PersonalityPipelineOrchestrator
// ---------------------------------------------------------------------------

export class PersonalityPipelineOrchestrator implements PersonalityProvider {
  private readonly signalCache: SignalCache
  private readonly synthesizer: BeauvoirSynthesizer
  private readonly store: PersonalityStore
  private readonly redis: RedisClient
  private readonly collectionSalt: string
  private readonly resolveSubgraph?: (snapshot: SignalSnapshot) => Promise<IdentitySubgraph | null>
  private readonly experienceEngine?: ExperienceEngine
  private readonly lockTtlSeconds: number
  private readonly maxBeauvoirLength: number

  constructor(config: PipelineOrchestratorConfig) {
    this.signalCache = config.signalCache
    this.synthesizer = config.synthesizer
    this.store = config.personalityStore
    this.redis = config.redis
    this.collectionSalt = config.collectionSalt ?? "finnNFT-default-salt"
    this.resolveSubgraph = config.resolveSubgraph
    this.experienceEngine = config.experienceEngine
    this.lockTtlSeconds = config.lockTtlSeconds ?? 30
    this.maxBeauvoirLength = config.maxBeauvoirLength ?? 8000
  }

  /**
   * Resolve personality for a tokenId.
   * Pipeline: cache → singleflight lock → signals → DAMP → synthesis → store.
   */
  async get(tokenId: string): Promise<PersonalityConfig | null> {
    const result = await this.resolve(tokenId)
    return result?.config ?? null
  }

  async has(tokenId: string): Promise<boolean> {
    return (await this.store.has(tokenId)) || (await this.signalCache.hasCached(tokenId))
  }

  /**
   * Full pipeline resolution with metadata about cache status and degradation.
   * @param depth - recursion guard for singleflight retry (max 2)
   */
  async resolve(tokenId: string, depth: number = 0): Promise<PipelineResult | null> {
    // 1. Check cache (fast path)
    const cached = await this.store.get(tokenId)
    if (cached) {
      return { config: cached, fromCache: true, degraded: false }
    }

    // 2. Acquire singleflight lock (SKP-004)
    const lockValue = await acquireLock(this.redis, tokenId, this.lockTtlSeconds)

    if (!lockValue) {
      // Another request is synthesizing — wait for it, then read from store
      await waitForLock(this.redis, tokenId)
      const afterWait = await this.store.get(tokenId)
      if (afterWait) {
        return { config: afterWait, fromCache: true, degraded: false }
      }
      // Lock holder failed — re-attempt with depth guard to prevent thundering herd (C2 fix)
      if (depth < 2) {
        return this.resolve(tokenId, depth + 1)
      }
      // Max depth reached — give up
      this.logDegradation("singleflight_exhausted", tokenId, new Error("Max retry depth reached"))
      return null
    }

    try {
      return await this.synthesizePipeline(tokenId)
    } finally {
      await releaseLock(this.redis, tokenId, lockValue).catch(() => {})
    }
  }

  /**
   * Core synthesis pipeline — called under singleflight lock.
   */
  private async synthesizePipeline(tokenId: string): Promise<PipelineResult | null> {
    // 3. Resolve signals from on-chain (via cache)
    let snapshot: SignalSnapshot
    try {
      const signals = await this.signalCache.getSignals(tokenId)
      snapshot = signals.snapshot
    } catch (err) {
      this.logDegradation("signal_resolution", tokenId, err)
      return null // Cannot proceed without signals
    }

    // 4. Derive DAMP-96 fingerprint (pure function, should not fail)
    let fingerprint: DAMPFingerprint
    try {
      fingerprint = deriveDAMP(snapshot, "default")
    } catch (err) {
      this.logDegradation("damp_derivation", tokenId, err)
      return null
    }

    // 4b. Apply experience drift at read-time (Sprint 2 T-2.2, IMP-005/SKP-007)
    // Canonical ordering: birth_fingerprint + stored_offsets = effective_fingerprint
    if (this.experienceEngine) {
      try {
        fingerprint = this.experienceEngine.applyExperience(fingerprint, tokenId)
      } catch (err) {
        this.logDegradation("experience_drift", tokenId, err)
        // Continue with birth fingerprint — drift failure is non-fatal
      }
    }

    // 5. Resolve identity subgraph (optional, graceful degradation)
    let subgraph: IdentitySubgraph | undefined
    let degraded = false
    let degradedReason: string | undefined
    if (this.resolveSubgraph) {
      try {
        const result = await this.resolveSubgraph(snapshot)
        if (result) subgraph = result
      } catch (err) {
        this.logDegradation("identity_graph", tokenId, err)
        degraded = true
        degradedReason = "identity_graph_unavailable"
        // Continue without subgraph
      }
    }

    // 6a. Derive canonical name BEFORE synthesis (so it can be injected)
    const agentName = nameKDF(
      snapshot.archetype,
      snapshot.ancestor,
      snapshot.era,
      snapshot.molecule,
      snapshot.element,
      tokenId,
      this.collectionSalt,
    )

    // 6b. Synthesize BEAUVOIR (LLM call, may fail)
    // Inject the derived name into the synthesis via userCustom
    let beauvoirMd: string
    try {
      beauvoirMd = await this.synthesizer.synthesize(snapshot, fingerprint, subgraph, {
        name: agentName,
        custom_instructions: `Your name is ${agentName}. Always introduce yourself by this name. This name was deterministically derived from your on-chain identity — it is uniquely yours.`,
      }, null, tokenId)
    } catch (err) {
      this.logDegradation("beauvoir_synthesis", tokenId, err)
      // Fallback: check if there's a cached version from a previous generation
      const fallback = await this.store.get(tokenId)
      if (fallback) {
        return {
          config: fallback,
          fromCache: true,
          degraded: true,
          degradedReason: "synthesis_failed_using_cached",
        }
      }
      return null // No cached fallback available
    }

    // 7. Sanitize BEAUVOIR (SKP-008)
    beauvoirMd = sanitizeBeauvoir(beauvoirMd, this.maxBeauvoirLength)

    // 8. Build PersonalityConfig (name already derived in step 6a)
    const config: PersonalityConfig = {
      token_id: tokenId,
      archetype: snapshot.archetype,
      display_name: agentName,
      voice_description: `${snapshot.archetype} agent from era ${snapshot.era}`,
      behavioral_traits: [],
      expertise_domains: [],
      beauvoir_template: beauvoirMd,
      era: snapshot.era,
      codex_version: this.getCodexVersion(),
    }

    // 10. Dual-write: Postgres first, then Redis (SKP-003)
    try {
      const personalityId = `p-${tokenId}-${Date.now()}`
      await this.store.write(config, personalityId)
    } catch (err) {
      this.logDegradation("store_write", tokenId, err)
      // Still return the config even if persistence fails
      return { config, fromCache: false, degraded: true, degradedReason: "store_write_failed" }
    }

    return { config, fromCache: false, degraded, degradedReason }
  }

  private getCodexVersion(): string {
    return codexVersionCache
  }

  private logDegradation(stage: string, tokenId: string, err: unknown): void {
    console.error(
      JSON.stringify({
        metric: "finn.personality_pipeline",
        stage,
        token_id: tokenId,
        error: (err as Error).message,
        severity: "warn",
      }),
    )
  }
}
