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
import type { CompatibilityMode } from "./signal-types.js"
import type { PersonalityVersionService } from "./personality-version.js"

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

    // Persist to Redis
    await this.redis.set(key, JSON.stringify(personality))

    // Create initial personality version (Task 3.4)
    if (this.versionService) {
      try {
        const version = await this.versionService.createVersion(id, {
          beauvoir_md: beauvoirMd,
          signals: (req as Record<string, unknown>).signals as NFTPersonality["signals"] ?? null,
          dapm: (req as Record<string, unknown>).dapm as NFTPersonality["dapm"] ?? null,
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

    // Regenerate BEAUVOIR.md
    personality.beauvoir_md = generateBeauvoirMd(
      personality.name,
      personality.voice,
      personality.expertise_domains,
      personality.custom_instructions,
    )
    personality.updated_at = Date.now()

    // Detect compatibility mode (Task 3.5)
    const compatibilityMode: CompatibilityMode = personality.signals
      ? "signal_v2"
      : "legacy_v1"
    personality.compatibility_mode = compatibilityMode

    // Persist
    const key = `personality:${id}`
    await this.redis.set(key, JSON.stringify(personality))

    // Create linked personality version (Task 3.4)
    if (this.versionService) {
      try {
        const version = await this.versionService.createVersion(id, {
          beauvoir_md: personality.beauvoir_md,
          signals: personality.signals ?? null,
          dapm: personality.dapm ?? null,
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

    return toResponse(personality)
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
  if (p.dapm === undefined) p.dapm = null
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
