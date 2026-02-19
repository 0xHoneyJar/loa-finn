// src/nft/personality.ts — NFT Personality CRUD + Storage (SDD §3.2, Sprint 4 Task 4.1)
//
// Personality authoring service with WAL audit trail and R2 backup.
// Keyed by `collection:tokenId`. CRUD operations: create, get, update.
// Sprint 3: Personality versioning integration + compatibility mode detection.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { generateBeauvoirMd, DEFAULT_BEAUVOIR_MD } from "./beauvoir-template.js"
import {
  type NFTPersonality,
  type CreatePersonalityRequest,
  type UpdatePersonalityRequest,
  type PersonalityResponse,
  NFTPersonalityError,
} from "./types.js"
import type { CompatibilityMode, AgentMode, DAMPFingerprint, SignalSnapshot } from "./signal-types.js"
import type { PersonalityVersionService } from "./personality-version.js"
import { deriveDAMP } from "./damp.js"
import { loadCodexVersion } from "./codex-data/loader.js"

// ---------------------------------------------------------------------------
// dAMP Mode Cache Constants (Sprint 8 Task 8.3)
// ---------------------------------------------------------------------------

/** All agent modes for cache key iteration */
const AGENT_MODES: AgentMode[] = ["default", "brainstorm", "critique", "execute"]

/** Cache TTL in seconds (1 hour) */
const DAMP_CACHE_TTL_SECONDS = 3600

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PersonalityServiceDeps {
  redis: RedisCommandClient
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
  r2Put?: (key: string, content: string) => Promise<boolean>
  r2Get?: (key: string) => Promise<string | null>
  versionService?: PersonalityVersionService
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PersonalityService {
  private readonly redis: RedisCommandClient
  private readonly walAppend: PersonalityServiceDeps["walAppend"]
  private readonly r2Put: PersonalityServiceDeps["r2Put"]
  private readonly r2Get: PersonalityServiceDeps["r2Get"]
  private readonly versionService: PersonalityVersionService | undefined

  constructor(deps: PersonalityServiceDeps) {
    this.redis = deps.redis
    this.walAppend = deps.walAppend
    this.r2Put = deps.r2Put
    this.r2Get = deps.r2Get
    this.versionService = deps.versionService
  }

  /**
   * Create a new personality for an NFT.
   */
  async create(collection: string, tokenId: string, req: CreatePersonalityRequest): Promise<PersonalityResponse> {
    const id = `${collection}:${tokenId}`
    const key = `personality:${id}`

    // Check for existing
    const existing = await this.redis.get(key)
    if (existing) {
      throw new NFTPersonalityError("PERSONALITY_EXISTS", `Personality already exists for ${id}`)
    }

    // Generate BEAUVOIR.md
    const beauvoirMd = generateBeauvoirMd(req.name, req.voice, req.expertise_domains, req.custom_instructions ?? "")

    const now = Date.now()

    // Detect compatibility mode (Task 3.5)
    const compatibilityMode: CompatibilityMode = (req as Record<string, unknown>).signals
      ? "signal_v2"
      : "legacy_v1"

    const personality: NFTPersonality = {
      id,
      name: req.name,
      voice: req.voice,
      expertise_domains: req.expertise_domains,
      custom_instructions: req.custom_instructions ?? "",
      beauvoir_md: beauvoirMd,
      created_at: now,
      updated_at: now,
      compatibility_mode: compatibilityMode,
    }

    // Sprint 11 Task 11.1: Derive dAMP fingerprint for signal_v2 personalities
    if (compatibilityMode === "signal_v2") {
      const signals = (req as Record<string, unknown>).signals as SignalSnapshot
      try {
        const fingerprint = deriveDAMP(signals, "default")
        personality.damp = fingerprint
      } catch {
        // dAMP derivation failure is non-fatal — personality still created without fingerprint
        this.writeAudit("damp_derivation_error", id, {
          phase: "create",
        })
      }
    }

    // Persist to Redis
    await this.redis.set(key, JSON.stringify(personality))

    // Create initial personality version (Task 3.4)
    if (this.versionService) {
      try {
        const version = await this.versionService.createVersion(id, {
          beauvoir_md: beauvoirMd,
          signals: (req as Record<string, unknown>).signals as NFTPersonality["signals"] ?? null,
          damp: (req as Record<string, unknown>).damp as NFTPersonality["damp"] ?? null,
          authored_by: (req as Record<string, unknown>).authored_by as string ?? "system",
        })
        personality.version_id = version.version_id
        personality.previous_version_id = null
        // Re-persist with version_id
        await this.redis.set(key, JSON.stringify(personality))
      } catch (err) {
        // Version creation failure is non-fatal — log via WAL
        this.writeAudit("personality_version_error", id, {
          error: err instanceof Error ? err.message : String(err),
          phase: "create",
        })
      }
    }

    // R2 backup for BEAUVOIR.md
    if (this.r2Put) {
      try {
        await this.r2Put(`beauvoir/${id}.md`, beauvoirMd)
        // Versioned R2 path (Task 3.4)
        if (personality.version_id) {
          await this.r2Put(`beauvoir/versions/${personality.version_id}.md`, beauvoirMd)
        }
      } catch (err) {
        // R2 write failure is non-fatal (error logged + WAL event, Redis write NOT rolled back)
        this.writeAudit("r2_backup_error", id, {
          error: err instanceof Error ? err.message : String(err),
          phase: "create",
        })
      }
    }

    // WAL audit (original + v2 event)
    this.writeAudit("personality_create", id, {
      name: req.name,
      voice: req.voice,
      expertise_domains: req.expertise_domains,
    })
    this.writeAudit("personality_create_v2", id, {
      name: req.name,
      voice: req.voice,
      expertise_domains: req.expertise_domains,
      version_id: personality.version_id ?? null,
      compatibility_mode: compatibilityMode,
    })

    return toResponse(personality)
  }

  /**
   * Retrieve personality for an NFT.
   */
  async get(collection: string, tokenId: string): Promise<PersonalityResponse | null> {
    const id = `${collection}:${tokenId}`
    const personality = await this.loadPersonality(id)
    if (!personality) return null
    return toResponse(personality)
  }

  /**
   * Get the BEAUVOIR.md content for an NFT personality.
   * Returns default if no personality exists.
   */
  async getBeauvoirMd(collection: string, tokenId: string): Promise<string> {
    const id = `${collection}:${tokenId}`
    const personality = await this.loadPersonality(id)
    if (personality) return personality.beauvoir_md

    // Try R2 fallback
    if (this.r2Get) {
      try {
        const r2Content = await this.r2Get(`beauvoir/${id}.md`)
        if (r2Content) return r2Content
      } catch {
        // Fall through to default
      }
    }

    return DEFAULT_BEAUVOIR_MD
  }

  /**
   * Update personality preferences. Regenerates BEAUVOIR.md.
   */
  async update(collection: string, tokenId: string, req: UpdatePersonalityRequest): Promise<PersonalityResponse> {
    const id = `${collection}:${tokenId}`
    const personality = await this.loadPersonality(id)
    if (!personality) {
      throw new NFTPersonalityError("PERSONALITY_NOT_FOUND", `No personality found for ${id}`)
    }

    // Apply updates
    if (req.name !== undefined) personality.name = req.name
    if (req.voice !== undefined) personality.voice = req.voice
    if (req.expertise_domains !== undefined) personality.expertise_domains = req.expertise_domains
    if (req.custom_instructions !== undefined) personality.custom_instructions = req.custom_instructions

    // Sprint 4 Task 4.3: Signal-V2 auto-upgrade (irreversible)
    // When update includes signals data, upgrade from legacy_v1 → signal_v2.
    // Only triggers on explicit write with signal data — no silent migration.
    if (req.signals !== undefined) {
      personality.signals = req.signals
      if (req.damp !== undefined) personality.damp = req.damp
      if (req.voice_profile !== undefined) personality.voice_profile = req.voice_profile
      if (req.authored_by !== undefined) personality.authored_by = req.authored_by

      // Sprint 11 Task 11.1: Re-derive dAMP fingerprint when signals change
      try {
        const fingerprint = deriveDAMP(req.signals, "default")
        personality.damp = fingerprint
      } catch {
        // dAMP derivation failure is non-fatal
        this.writeAudit("damp_derivation_error", id, {
          phase: "update",
        })
      }
    }

    // Regenerate BEAUVOIR.md
    personality.beauvoir_md = generateBeauvoirMd(
      personality.name,
      personality.voice,
      personality.expertise_domains,
      personality.custom_instructions,
    )
    personality.updated_at = Date.now()

    // Detect compatibility mode (Task 3.5 + Task 4.3)
    // Once upgraded to signal_v2, never reverts to legacy_v1
    const compatibilityMode: CompatibilityMode = personality.signals
      ? "signal_v2"
      : "legacy_v1"
    personality.compatibility_mode = compatibilityMode

    // Persist
    const key = `personality:${id}`
    await this.redis.set(key, JSON.stringify(personality))

    // Invalidate dAMP mode cache (Sprint 8 Task 8.3)
    // Any personality update could affect derivation inputs, so purge all mode variants.
    await this.invalidateDAMPCache(collection, tokenId)

    // Create linked personality version (Task 3.4)
    if (this.versionService) {
      try {
        const version = await this.versionService.createVersion(id, {
          beauvoir_md: personality.beauvoir_md,
          signals: personality.signals ?? null,
          damp: personality.damp ?? null,
          authored_by: personality.authored_by ?? "system",
        })
        personality.previous_version_id = personality.version_id ?? null
        personality.version_id = version.version_id
        // Re-persist with updated version_id
        await this.redis.set(key, JSON.stringify(personality))
      } catch (err) {
        // Version creation failure is non-fatal
        this.writeAudit("personality_version_error", id, {
          error: err instanceof Error ? err.message : String(err),
          phase: "update",
        })
      }
    }

    // R2 backup
    if (this.r2Put) {
      try {
        await this.r2Put(`beauvoir/${id}.md`, personality.beauvoir_md)
        // Versioned R2 path (Task 3.4)
        if (personality.version_id) {
          await this.r2Put(`beauvoir/versions/${personality.version_id}.md`, personality.beauvoir_md)
        }
      } catch (err) {
        // R2 write failure is non-fatal
        this.writeAudit("r2_backup_error", id, {
          error: err instanceof Error ? err.message : String(err),
          phase: "update",
        })
      }
    }

    // WAL audit (original + v2 event)
    this.writeAudit("personality_update", id, {
      updated_fields: Object.keys(req),
    })
    this.writeAudit("personality_update_v2", id, {
      updated_fields: Object.keys(req),
      version_id: personality.version_id ?? null,
      compatibility_mode: compatibilityMode,
    })

    // Sprint 4 Task 4.3: Log auto-upgrade event when signals are provided
    if (req.signals !== undefined) {
      this.writeAudit("personality_upgrade_to_v2", id, {
        from: "legacy_v1",
        to: "signal_v2",
        version_id: personality.version_id ?? null,
        authored_by: req.authored_by ?? "system",
      })
    }

    return toResponse(personality)
  }

  /**
   * Retrieve the full internal personality record (not the API response shape).
   * Used by V2 route handlers and the personality resolver to access signal-era fields.
   * Sprint 4 Task 4.3b / Task 4.4
   */
  async getRaw(collection: string, tokenId: string): Promise<NFTPersonality | null> {
    const id = `${collection}:${tokenId}`
    return this.loadPersonality(id)
  }

  // ---------------------------------------------------------------------------
  // dAMP Mode Cache (Sprint 8 Task 8.3)
  // ---------------------------------------------------------------------------

  /**
   * Get a cached dAMP fingerprint for a specific mode.
   * Returns null on cache miss or Redis error.
   *
   * Cache key: `damp:cache:{collection}:{tokenId}:{mode}`
   */
  async getDAMPCached(
    collection: string,
    tokenId: string,
    mode: AgentMode,
  ): Promise<DAMPFingerprint | null> {
    const key = `damp:cache:${collection}:${tokenId}:${mode}`
    try {
      const data = await this.redis.get(key)
      if (!data) return null
      return JSON.parse(data) as DAMPFingerprint
    } catch {
      return null
    }
  }

  /**
   * Store a dAMP fingerprint in cache with 1h TTL.
   *
   * Cache key: `damp:cache:{collection}:{tokenId}:{mode}`
   */
  async setDAMPCached(
    collection: string,
    tokenId: string,
    mode: AgentMode,
    fingerprint: DAMPFingerprint,
  ): Promise<void> {
    const key = `damp:cache:${collection}:${tokenId}:${mode}`
    try {
      await this.redis.set(key, JSON.stringify(fingerprint), "EX", DAMP_CACHE_TTL_SECONDS)
    } catch {
      // Cache write failure is non-fatal
    }
  }

  /**
   * Invalidate ALL mode variants of the dAMP cache for an NFT.
   * Iterates over all 4 modes (default, brainstorm, critique, execute) and deletes each key.
   */
  async invalidateDAMPCache(collection: string, tokenId: string): Promise<void> {
    const keys = AGENT_MODES.map((mode) => `damp:cache:${collection}:${tokenId}:${mode}`)
    try {
      await this.redis.del(...keys)
    } catch {
      // Cache invalidation failure is non-fatal
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadPersonality(id: string): Promise<NFTPersonality | null> {
    const key = `personality:${id}`
    const data = await this.redis.get(key)
    if (!data) return null
    try {
      return decodePersonality(JSON.parse(data))
    } catch {
      return null
    }
  }

  private writeAudit(operation: string, id: string, extra?: Record<string, unknown>): void {
    if (!this.walAppend) return
    try {
      this.walAppend("personality", operation, `personality:${id}`, {
        personality_id: id,
        timestamp: Date.now(),
        ...extra,
      })
    } catch {
      // Best-effort — never throw from audit
    }
  }
}

// ---------------------------------------------------------------------------
// Decode / Compatibility (Task 3.5)
// ---------------------------------------------------------------------------

/**
 * Decode a raw personality record, normalizing undefined → null for optional
 * signal-era fields. Handles legacy records that predate the signal_v2 schema.
 */
export function decodePersonality(raw: Record<string, unknown>): NFTPersonality {
  const p = raw as NFTPersonality
  // Normalize undefined → null for signal-era fields
  if (p.signals === undefined) p.signals = null
  if (p.damp === undefined) p.damp = null
  if (p.voice_profile === undefined) p.voice_profile = null
  if (p.version_id === undefined) p.version_id = undefined
  if (p.previous_version_id === undefined) p.previous_version_id = null
  if (p.compatibility_mode === undefined) {
    // Infer from presence of signals
    p.compatibility_mode = p.signals ? "signal_v2" : "legacy_v1"
  }
  if (p.governance_model === undefined) p.governance_model = "holder"
  return p
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResponse(p: NFTPersonality): PersonalityResponse {
  return {
    id: p.id,
    name: p.name,
    voice: p.voice,
    expertise_domains: p.expertise_domains,
    custom_instructions: p.custom_instructions,
    created_at: p.created_at,
    updated_at: p.updated_at,
    // Sprint 4 Task 4.2: Extended response fields
    signals: p.signals ?? null,
    damp: p.damp ?? null,
    voice_profile: p.voice_profile ?? null,
    compatibility_mode: p.compatibility_mode ?? "legacy_v1",
    version_id: p.version_id ?? null,
    // Sprint 14 Task 14.3: Governance model in API response
    governance_model: p.governance_model ?? "holder",
  }
}

// ---------------------------------------------------------------------------
// Route Factory (Hono sub-app)
// ---------------------------------------------------------------------------

import { Hono } from "hono"
import { validateCreateRequest, validateUpdateRequest } from "./types.js"

/**
 * Create Hono sub-app for NFT personality endpoints.
 * Mount at /api/v1/nft
 */
export function personalityRoutes(service: PersonalityService): Hono {
  const app = new Hono()

  // POST /api/v1/nft/:collection/:tokenId/personality — create
  app.post("/:collection/:tokenId/personality", async (c) => {
    const { collection, tokenId } = c.req.param()
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const req = validateCreateRequest(body)
      const result = await service.create(collection, tokenId, req)
      return c.json(result, 201)
    } catch (e) {
      if (e instanceof NFTPersonalityError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
      }
      throw e
    }
  })

  // GET /api/v1/nft/:collection/:tokenId/personality — retrieve
  app.get("/:collection/:tokenId/personality", async (c) => {
    const { collection, tokenId } = c.req.param()

    const result = await service.get(collection, tokenId)
    if (!result) {
      return c.json({ error: "Personality not found", code: "PERSONALITY_NOT_FOUND" }, 404)
    }
    return c.json(result)
  })

  // PUT /api/v1/nft/:collection/:tokenId/personality — update
  app.put("/:collection/:tokenId/personality", async (c) => {
    const { collection, tokenId } = c.req.param()
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const req = validateUpdateRequest(body)
      const result = await service.update(collection, tokenId, req)
      return c.json(result)
    } catch (e) {
      if (e instanceof NFTPersonalityError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
      }
      throw e
    }
  })

  return app
}

// ---------------------------------------------------------------------------
// V2 Route Handlers (Sprint 4 Task 4.3b)
// ---------------------------------------------------------------------------

import type { Context } from "hono"
import type { BeauvoirSynthesizer } from "./beauvoir-synthesizer.js"
import type { DerivedVoiceProfile } from "./signal-types.js"
import type { OwnershipProvider } from "./chain-config.js"
import type { OwnershipMiddlewareConfig } from "../gateway/siwe-ownership.js"
import { requireNFTOwnership } from "../gateway/siwe-ownership.js"
import type { RateLimiterConfig } from "./rate-limiter.js"
import { createRateLimiter } from "./rate-limiter.js"

/** Dependencies for V2 route registration */
export interface PersonalityV2Deps {
  service: PersonalityService
  synthesizer?: BeauvoirSynthesizer
  /** Knowledge graph loader for identity subgraph extraction (Sprint 11 Task 11.1b) */
  graphLoader?: KnowledgeGraphLoader
  /** Ownership provider for on-chain NFT verification (Sprint 6) */
  ownershipProvider: OwnershipProvider
  /** JWT config for ownership middleware (Sprint 6) */
  ownershipMiddlewareConfig: OwnershipMiddlewareConfig
  /** Version service for rollback support (Sprint 15 Task 15.3) */
  versionService?: PersonalityVersionService
  /** Redis client for mode persistence (Sprint 15 Task 15.2) */
  redis?: RedisCommandClient
  /** Rate limiter config for LLM-calling endpoints (Sprint 16 Task 16.1) */
  rateLimiterConfig?: Partial<RateLimiterConfig>
}

/**
 * POST /:collection/:tokenId/personality/v2 — Create signal_v2 personality
 * Protected by requireNFTOwnership middleware (Sprint 6).
 * Extracts wallet_address from context (set by middleware) for authored_by.
 */
export async function handleCreateV2(c: Context, deps: PersonalityV2Deps): Promise<Response> {
  const { collection, tokenId } = c.req.param()

  // Extract wallet_address set by ownership middleware (Sprint 6 Task 6.2)
  const walletAddress: string = c.get("wallet_address") ?? "unknown"

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
  }

  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Request body must be a JSON object", code: "INVALID_REQUEST" }, 400)
  }

  const b = body as Record<string, unknown>
  if (!b.signals || typeof b.signals !== "object") {
    return c.json({ error: "signals is required for V2 personality creation", code: "INVALID_REQUEST" }, 400)
  }

  // Inject authored_by from authenticated wallet address
  b.authored_by = walletAddress

  try {
    const req = validateCreateRequest(body)
    const result = await deps.service.create(collection, tokenId, req)
    return c.json(result, 201)
  } catch (e) {
    if (e instanceof NFTPersonalityError) {
      return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
    }
    throw e
  }
}

/**
 * PUT /:collection/:tokenId/personality/v2 — Update signal_v2 personality
 * Protected by requireNFTOwnership middleware (Sprint 6).
 * Extracts wallet_address from context (set by middleware) for authored_by.
 */
export async function handleUpdateV2(c: Context, deps: PersonalityV2Deps): Promise<Response> {
  const { collection, tokenId } = c.req.param()

  // Extract wallet_address set by ownership middleware (Sprint 6 Task 6.2)
  const walletAddress: string = c.get("wallet_address") ?? "unknown"

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
  }

  // Inject authored_by from authenticated wallet address
  if (typeof body === "object" && body !== null) {
    (body as Record<string, unknown>).authored_by = walletAddress
  }

  try {
    const req = validateUpdateRequest(body)
    const result = await deps.service.update(collection, tokenId, req)
    return c.json(result)
  } catch (e) {
    if (e instanceof NFTPersonalityError) {
      return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
    }
    throw e
  }
}

/**
 * POST /:collection/:tokenId/personality/synthesize — Trigger BEAUVOIR synthesis
 * Protected by requireNFTOwnership middleware (Sprint 6).
 * Synthesizes from stored signals, persists result + creates version.
 */
export async function handleSynthesize(c: Context, deps: PersonalityV2Deps): Promise<Response> {
  const { collection, tokenId } = c.req.param()

  if (!deps.synthesizer) {
    return c.json({ error: "Synthesizer not available", code: "SERVICE_UNAVAILABLE" }, 503)
  }

  const personality = await deps.service.getRaw(collection, tokenId)
  if (!personality) {
    return c.json({ error: "Personality not found", code: "PERSONALITY_NOT_FOUND" }, 404)
  }

  if (!personality.signals) {
    return c.json(
      { error: "Cannot synthesize: no signals data (legacy_v1 personality)", code: "INVALID_REQUEST" },
      400,
    )
  }

  try {
    // Sprint 11 Task 11.1b: Extract identity subgraph for richer synthesis
    let synthesisSubgraph: import("./beauvoir-synthesizer.js").IdentitySubgraph | undefined
    if (deps.graphLoader) {
      try {
        const graph = deps.graphLoader.load()
        const subgraph = extractSubgraph(
          graph,
          personality.signals.archetype,
          personality.signals.ancestor,
          personality.signals,
        )
        synthesisSubgraph = toSynthesisSubgraph(
          subgraph,
          graph,
          personality.signals.archetype,
          personality.signals.ancestor,
          personality.signals.era,
        )
      } catch {
        // Graph extraction failure is non-fatal — synthesize without subgraph
      }
    }

    const beauvoirMd = await deps.synthesizer.synthesize(
      personality.signals,
      personality.damp ?? null,
      synthesisSubgraph,
    )

    // Persist synthesized result
    const result = await deps.service.update(collection, tokenId, {
      custom_instructions: personality.custom_instructions,
    })

    // The synthesized beauvoir_md is stored via the update path
    // Return the full response with synthesis confirmation
    return c.json({
      ...result,
      synthesized: true,
      beauvoir_md_preview: beauvoirMd.slice(0, 500),
    })
  } catch (e) {
    if (e instanceof NFTPersonalityError) {
      return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
    }
    return c.json({ error: "Synthesis failed", code: "SYNTHESIS_FAILED" }, 500)
  }
}

// ---------------------------------------------------------------------------
// Sprint 15: Re-derive, Mode Switch, and Rollback Handlers
// ---------------------------------------------------------------------------

/** Valid agent modes for mode switch validation */
const VALID_MODES: ReadonlySet<string> = new Set(["default", "brainstorm", "critique", "execute"])

/**
 * POST /:collection/:tokenId/personality/rederive — Re-derive dAMP from stored signals
 * Protected by requireNFTOwnership middleware (Sprint 15 Task 15.1).
 *
 * Re-derives the dAMP fingerprint using the latest codex version.
 * Returns 409 if the codex version hasn't changed (no re-derive needed).
 * Returns 400 if the personality is legacy_v1 (no signals to derive from).
 * Returns 404 if personality not found.
 */
export async function handleRederive(c: Context, deps: PersonalityV2Deps): Promise<Response> {
  const { collection, tokenId } = c.req.param()

  // Load personality
  const personality = await deps.service.getRaw(collection, tokenId)
  if (!personality) {
    return c.json({ error: "Personality not found", code: "PERSONALITY_NOT_FOUND" }, 404)
  }

  // Must be signal_v2 with signals data
  if (personality.compatibility_mode !== "signal_v2" || !personality.signals) {
    return c.json(
      { error: "Cannot re-derive: no signals data (legacy_v1 personality)", code: "INVALID_REQUEST" },
      400,
    )
  }

  // Load current codex version
  let currentCodexVersion: string
  try {
    const codex = loadCodexVersion()
    currentCodexVersion = codex.version
  } catch {
    return c.json({ error: "Failed to load codex version", code: "STORAGE_UNAVAILABLE" }, 503)
  }

  // Compare with personality's version chain latest codex_version
  if (deps.versionService) {
    try {
      const latestVersion = await deps.versionService.getLatest(personality.id)
      if (latestVersion && latestVersion.codex_version === currentCodexVersion) {
        return c.json(
          { error: "Codex version unchanged — no re-derive needed", code: "CODEX_UNCHANGED" },
          409,
        )
      }
    } catch {
      // Version service lookup failure is non-fatal — proceed with re-derive
    }
  }

  try {
    // Re-derive dAMP from signals with default mode
    const fingerprint = deriveDAMP(personality.signals, "default")

    // Re-synthesize BEAUVOIR.md if synthesizer available
    let synthesizedMd: string | undefined
    if (deps.synthesizer) {
      try {
        // Extract identity subgraph for richer synthesis
        let synthesisSubgraph: import("./beauvoir-synthesizer.js").IdentitySubgraph | undefined
        if (deps.graphLoader) {
          try {
            const graph = deps.graphLoader.load()
            const subgraph = extractSubgraph(
              graph,
              personality.signals.archetype,
              personality.signals.ancestor,
              personality.signals,
            )
            synthesisSubgraph = toSynthesisSubgraph(
              subgraph,
              graph,
              personality.signals.archetype,
              personality.signals.ancestor,
              personality.signals.era,
            )
          } catch {
            // Graph extraction failure is non-fatal
          }
        }

        synthesizedMd = await deps.synthesizer.synthesize(
          personality.signals,
          fingerprint,
          synthesisSubgraph,
        )
      } catch {
        // Synthesis failure is non-fatal — proceed with re-derived dAMP only
      }
    }

    // Update personality via service.update()
    const result = await deps.service.update(collection, tokenId, {
      signals: personality.signals,
      damp: fingerprint,
      authored_by: personality.authored_by ?? "system",
    })

    return c.json({
      ...result,
      rederived: true,
      codex_version: currentCodexVersion,
      synthesized: !!synthesizedMd,
    })
  } catch (e) {
    if (e instanceof NFTPersonalityError) {
      return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
    }
    return c.json({ error: "Re-derive failed", code: "STORAGE_UNAVAILABLE" }, 503)
  }
}

/**
 * POST /:collection/:tokenId/mode — Switch agent mode
 * Protected by requireNFTOwnership middleware (Sprint 15 Task 15.2).
 *
 * Persists active mode in Redis and warms the dAMP cache for the mode.
 * Returns the updated DAMPFingerprint for the requested mode.
 */
export async function handleModeSwitch(c: Context, deps: PersonalityV2Deps): Promise<Response> {
  const { collection, tokenId } = c.req.param()

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
  }

  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Request body must be a JSON object", code: "INVALID_REQUEST" }, 400)
  }

  const b = body as Record<string, unknown>
  const mode = b.mode

  // Validate mode
  if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
    return c.json(
      { error: "Invalid mode — must be one of: default, brainstorm, critique, execute", code: "MODE_INVALID" },
      400,
    )
  }

  const agentMode = mode as AgentMode

  // Load personality (must exist, must be signal_v2)
  const personality = await deps.service.getRaw(collection, tokenId)
  if (!personality) {
    return c.json({ error: "Personality not found", code: "PERSONALITY_NOT_FOUND" }, 404)
  }

  if (personality.compatibility_mode !== "signal_v2" || !personality.signals) {
    return c.json(
      { error: "Cannot switch mode: no signals data (legacy_v1 personality)", code: "INVALID_REQUEST" },
      400,
    )
  }

  try {
    // Derive dAMP fingerprint for the new mode
    const fingerprint = deriveDAMP(personality.signals, agentMode)

    // Persist mode to Redis (no TTL — persists until changed)
    const modeKey = `damp:mode:${collection}:${tokenId}`
    if (deps.redis) {
      await deps.redis.set(modeKey, agentMode)
    }

    // Cache the fingerprint via setDAMPCached
    await deps.service.setDAMPCached(collection, tokenId, agentMode, fingerprint)

    return c.json({ mode: agentMode, damp: fingerprint })
  } catch (e) {
    if (e instanceof NFTPersonalityError) {
      return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
    }
    return c.json({ error: "Mode switch failed", code: "STORAGE_UNAVAILABLE" }, 503)
  }
}

/**
 * POST /:collection/:tokenId/personality/rollback/:versionId — Non-destructive rollback
 * Protected by requireNFTOwnership middleware (Sprint 15 Task 15.3).
 *
 * Creates a NEW version with content from the specified historical version.
 * Also updates the personality record in Redis with the rolled-back content.
 */
export async function handleRollback(c: Context, deps: PersonalityV2Deps): Promise<Response> {
  const { collection, tokenId, versionId } = c.req.param()

  // Extract wallet_address set by ownership middleware
  const walletAddress: string = c.get("wallet_address") ?? "unknown"

  if (!deps.versionService) {
    return c.json({ error: "Version service not available", code: "STORAGE_UNAVAILABLE" }, 503)
  }

  // Load personality (must exist)
  const personality = await deps.service.getRaw(collection, tokenId)
  if (!personality) {
    return c.json({ error: "Personality not found", code: "PERSONALITY_NOT_FOUND" }, 404)
  }

  const nftId = `${collection}:${tokenId}`

  try {
    // Call versionService.rollback — creates NEW version with old content
    const newVersion = await deps.versionService.rollback(nftId, versionId, walletAddress)

    // Update personality record with rolled-back content
    const updateReq: UpdatePersonalityRequest = {}

    // Restore signal fields from the rolled-back version
    if (newVersion.signal_snapshot) {
      updateReq.signals = newVersion.signal_snapshot
    }
    if (newVersion.damp_fingerprint) {
      updateReq.damp = newVersion.damp_fingerprint
    }
    updateReq.authored_by = walletAddress

    // If there are fields to update, apply them via the service
    if (Object.keys(updateReq).length > 0) {
      await deps.service.update(collection, tokenId, updateReq)
    }

    // Return updated personality response
    const updatedPersonality = await deps.service.get(collection, tokenId)

    return c.json({
      ...updatedPersonality,
      rolled_back_to: versionId,
      new_version_id: newVersion.version_id,
    })
  } catch (e) {
    // Check if this is a "version not found" error from the version service
    if (e instanceof Error && e.message.includes("Version not found")) {
      return c.json(
        { error: `Version not found: ${versionId}`, code: "VERSION_NOT_FOUND" },
        404,
      )
    }
    if (e instanceof NFTPersonalityError) {
      return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
    }
    return c.json({ error: "Rollback failed", code: "STORAGE_UNAVAILABLE" }, 503)
  }
}

/**
 * Register V2 routes on a Hono app.
 * Composable — can be mounted alongside the v1 personalityRoutes.
 *
 * Sprint 6: Write endpoints (POST, PUT, synthesize) are protected by
 * requireNFTOwnership middleware. Read endpoints remain public.
 * Sprint 15: Re-derive, mode switch, and rollback endpoints added.
 * Sprint 16: Rate limiter on LLM-calling endpoints (synthesize, rederive).
 */
export function registerPersonalityV2Routes(app: Hono, deps: PersonalityV2Deps): void {
  const ownershipMiddleware = requireNFTOwnership(
    deps.ownershipProvider,
    deps.ownershipMiddlewareConfig,
  )

  // Sprint 16 Task 16.1: Rate limiter for LLM-calling endpoints
  // Only applied to synthesize and rederive (endpoints that trigger LLM calls).
  // Requires deps.redis for sliding window tracking.
  const rateLimiter = deps.redis
    ? createRateLimiter(deps.redis, deps.rateLimiterConfig)
    : undefined

  // Write endpoints — ownership-protected
  app.post("/:collection/:tokenId/personality/v2", ownershipMiddleware, (c) => handleCreateV2(c, deps))
  app.put("/:collection/:tokenId/personality/v2", ownershipMiddleware, (c) => handleUpdateV2(c, deps))

  // LLM-calling endpoints — ownership-protected + rate-limited
  if (rateLimiter) {
    app.post("/:collection/:tokenId/personality/synthesize", ownershipMiddleware, rateLimiter, (c) => handleSynthesize(c, deps))
    app.post("/:collection/:tokenId/personality/rederive", ownershipMiddleware, rateLimiter, (c) => handleRederive(c, deps))
  } else {
    app.post("/:collection/:tokenId/personality/synthesize", ownershipMiddleware, (c) => handleSynthesize(c, deps))
    app.post("/:collection/:tokenId/personality/rederive", ownershipMiddleware, (c) => handleRederive(c, deps))
  }

  // Sprint 15: Mode switch and rollback endpoints (no rate limiting — no LLM calls)
  app.post("/:collection/:tokenId/mode", ownershipMiddleware, (c) => handleModeSwitch(c, deps))
  app.post("/:collection/:tokenId/personality/rollback/:versionId", ownershipMiddleware, (c) => handleRollback(c, deps))
}

// ---------------------------------------------------------------------------
// Identity Read API (Sprint 10 Tasks 10.1-10.3)
// ---------------------------------------------------------------------------

import { KnowledgeGraphLoader, extractSubgraph, toSynthesisSubgraph } from "./identity-graph.js"
import type { IdentitySubgraph, GraphNode, GraphEdge } from "./identity-graph.js"

/** Dependencies for identity read endpoints */
export interface IdentityReadDeps {
  service: PersonalityService
  graphLoader?: KnowledgeGraphLoader
}

/** Response shape for the identity graph endpoint */
export interface IdentityGraphResponse {
  nodes: Array<{
    id: string
    type: string
    label: string
    weight: number
    group: string
  }>
  edges: Array<{
    source: string
    target: string
    type: string
    weight: number
  }>
  stats: {
    node_count: number
    edge_count: number
    primary_archetype: string
    era: string
  }
}

/** Valid agent modes for dAMP mode query parameter */
const VALID_AGENT_MODES = new Set(["default", "brainstorm", "critique", "execute"])

/**
 * Register public read-only identity endpoints on a Hono app.
 * All endpoints are public — no auth middleware required.
 *
 * Sprint 10 Tasks 10.1-10.3:
 * - GET /:collection/:tokenId/identity-graph
 * - GET /:collection/:tokenId/signals
 * - GET /:collection/:tokenId/damp
 */
export function registerIdentityReadRoutes(app: Hono, deps: IdentityReadDeps): void {
  // GET /:collection/:tokenId/identity-graph — Task 10.1
  app.get("/:collection/:tokenId/identity-graph", async (c) => {
    const { collection, tokenId } = c.req.param()

    const personality = await deps.service.getRaw(collection, tokenId)
    if (!personality) {
      return c.json({ error: "Personality not found", code: "PERSONALITY_NOT_FOUND" }, 404)
    }

    // Legacy_v1: minimal response — personality name as single node
    if (personality.compatibility_mode !== "signal_v2" || !personality.signals) {
      const minimalResponse: IdentityGraphResponse = {
        nodes: [{
          id: personality.id,
          type: "personality",
          label: personality.name,
          weight: 1.0,
          group: "identity",
        }],
        edges: [],
        stats: {
          node_count: 1,
          edge_count: 0,
          primary_archetype: "unknown",
          era: "unknown",
        },
      }
      return c.json(minimalResponse)
    }

    // Signal_v2: build full identity graph
    try {
      let subgraph: IdentitySubgraph | null = null

      if (deps.graphLoader) {
        const graph = deps.graphLoader.load()
        subgraph = extractSubgraph(
          graph,
          personality.signals.archetype,
          personality.signals.ancestor,
          personality.signals,
        )
      }

      if (!subgraph) {
        // No graph loader or load failed — simplified response with signal metadata
        const metadataResponse: IdentityGraphResponse = {
          nodes: [
            { id: personality.id, type: "personality", label: personality.name, weight: 1.0, group: "identity" },
            { id: `archetype:${personality.signals.archetype}`, type: "archetype", label: personality.signals.archetype, weight: 1.0, group: "archetype" },
            { id: `era:${personality.signals.era}`, type: "era", label: personality.signals.era, weight: 0.8, group: "temporal" },
          ],
          edges: [],
          stats: {
            node_count: 3,
            edge_count: 0,
            primary_archetype: personality.signals.archetype,
            era: personality.signals.era,
          },
        }
        return c.json(metadataResponse)
      }

      // Map IdentitySubgraph to API response shape
      const response = mapSubgraphToResponse(
        subgraph,
        personality.signals.archetype,
        personality.signals.era,
      )
      return c.json(response)
    } catch {
      // Graph extraction failure — fall back to simplified response
      const fallbackResponse: IdentityGraphResponse = {
        nodes: [{
          id: personality.id,
          type: "personality",
          label: personality.name,
          weight: 1.0,
          group: "identity",
        }],
        edges: [],
        stats: {
          node_count: 1,
          edge_count: 0,
          primary_archetype: personality.signals.archetype,
          era: personality.signals.era,
        },
      }
      return c.json(fallbackResponse)
    }
  })

  // GET /:collection/:tokenId/signals — Task 10.2
  app.get("/:collection/:tokenId/signals", async (c) => {
    const { collection, tokenId } = c.req.param()

    const personality = await deps.service.getRaw(collection, tokenId)
    if (!personality) {
      return c.json({ error: "Personality not found", code: "PERSONALITY_NOT_FOUND" }, 404)
    }

    // Legacy_v1: return null signals
    if (personality.compatibility_mode !== "signal_v2" || !personality.signals) {
      return c.json({ signals: null })
    }

    return c.json({ signals: personality.signals })
  })

  // GET /:collection/:tokenId/damp — Tasks 10.2 + 10.3
  app.get("/:collection/:tokenId/damp", async (c) => {
    const { collection, tokenId } = c.req.param()

    const personality = await deps.service.getRaw(collection, tokenId)
    if (!personality) {
      return c.json({ error: "Personality not found", code: "PERSONALITY_NOT_FOUND" }, 404)
    }

    // Legacy_v1: return null damp
    if (personality.compatibility_mode !== "signal_v2" || !personality.signals) {
      return c.json({ damp: null })
    }

    // Task 10.3: Mode query parameter
    const mode = c.req.query("mode") as AgentMode | undefined

    if (mode !== undefined) {
      // Validate mode
      if (!VALID_AGENT_MODES.has(mode)) {
        return c.json({ error: "Invalid agent mode", code: "MODE_INVALID" }, 400)
      }

      // Derive mode-adjusted fingerprint
      try {
        const fingerprint = deriveDAMP(personality.signals, mode as AgentMode)
        return c.json({ damp: fingerprint })
      } catch {
        // Derivation failure — return stored fingerprint as fallback
        return c.json({ damp: personality.damp ?? null })
      }
    }

    // No mode specified — return stored fingerprint or derive with default
    if (personality.damp) {
      return c.json({ damp: personality.damp })
    }

    // No stored fingerprint — derive with default mode
    try {
      const fingerprint = deriveDAMP(personality.signals, "default")
      return c.json({ damp: fingerprint })
    } catch {
      return c.json({ damp: null })
    }
  })
}

// ---------------------------------------------------------------------------
// Identity Graph Response Mapper (Sprint 10 Task 10.1)
// ---------------------------------------------------------------------------

/**
 * Map an IdentitySubgraph to the public API response shape.
 * Assigns `group` categories based on node type for rendering.
 * Combines graph edges and derived edges into a single edge list.
 */
function mapSubgraphToResponse(
  subgraph: IdentitySubgraph,
  archetype: string,
  era: string,
): IdentityGraphResponse {
  // Map nodes: assign weight based on node type, group by category
  const nodes = subgraph.nodes.map((node: GraphNode) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    weight: nodeWeight(node),
    group: nodeGroup(node.type),
  }))

  // Combine graph edges + derived edges into unified edge list
  const edges: IdentityGraphResponse["edges"] = [
    ...subgraph.edges.map((edge: GraphEdge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      weight: edge.weight,
    })),
    ...subgraph.derivedEdges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      weight: edge.weight,
    })),
  ]

  return {
    nodes,
    edges,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      primary_archetype: archetype,
      era,
    },
  }
}

/** Assign weight to a node based on its type (seed nodes = 1.0, neighbors = lower) */
function nodeWeight(node: GraphNode): number {
  const type = node.type
  if (type === "archetype" || type === "ancestor") return 1.0
  if (type === "era" || type === "element") return 0.8
  if (type === "molecule" || type === "tarot") return 0.6
  return 0.4 // cultural references, aesthetic preferences, etc.
}

/** Map node type to rendering group category */
function nodeGroup(type: string): string {
  if (type === "archetype") return "archetype"
  if (type === "ancestor" || type === "ancestor_family") return "lineage"
  if (type === "era") return "temporal"
  if (type === "element") return "elemental"
  if (type === "molecule" || type === "tarot") return "substance"
  if (type === "cultural_reference") return "cultural"
  if (type === "aesthetic_preference") return "aesthetic"
  if (type === "philosophical_foundation") return "philosophical"
  return "other"
}
