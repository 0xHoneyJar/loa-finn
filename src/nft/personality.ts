// src/nft/personality.ts — NFT Personality CRUD + Storage (SDD §3.2, Sprint 4 Task 4.1)
//
// Personality authoring service with WAL audit trail and R2 backup.
// Keyed by `collection:tokenId`. CRUD operations: create, get, update.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { generateBeauvoirMd, DEFAULT_BEAUVOIR_MD } from "./beauvoir-template.js"
import {
  type NFTPersonality,
  type CreatePersonalityRequest,
  type UpdatePersonalityRequest,
  type PersonalityResponse,
  NFTPersonalityError,
} from "./types.js"

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PersonalityServiceDeps {
  redis: RedisCommandClient
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
  r2Put?: (key: string, content: string) => Promise<boolean>
  r2Get?: (key: string) => Promise<string | null>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PersonalityService {
  private readonly redis: RedisCommandClient
  private readonly walAppend: PersonalityServiceDeps["walAppend"]
  private readonly r2Put: PersonalityServiceDeps["r2Put"]
  private readonly r2Get: PersonalityServiceDeps["r2Get"]

  constructor(deps: PersonalityServiceDeps) {
    this.redis = deps.redis
    this.walAppend = deps.walAppend
    this.r2Put = deps.r2Put
    this.r2Get = deps.r2Get
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
    const personality: NFTPersonality = {
      id,
      name: req.name,
      voice: req.voice,
      expertise_domains: req.expertise_domains,
      custom_instructions: req.custom_instructions ?? "",
      beauvoir_md: beauvoirMd,
      created_at: now,
      updated_at: now,
    }

    // Persist to Redis
    await this.redis.set(key, JSON.stringify(personality))

    // R2 backup for BEAUVOIR.md
    if (this.r2Put) {
      try {
        await this.r2Put(`beauvoir/${id}.md`, beauvoirMd)
      } catch {
        // Best-effort R2 backup
      }
    }

    // WAL audit
    this.writeAudit("personality_create", id, {
      name: req.name,
      voice: req.voice,
      expertise_domains: req.expertise_domains,
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

    // Persist
    const key = `personality:${id}`
    await this.redis.set(key, JSON.stringify(personality))

    // R2 backup
    if (this.r2Put) {
      try {
        await this.r2Put(`beauvoir/${id}.md`, personality.beauvoir_md)
      } catch {
        // Best-effort
      }
    }

    // WAL audit
    this.writeAudit("personality_update", id, {
      updated_fields: Object.keys(req),
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
      return JSON.parse(data) as NFTPersonality
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
