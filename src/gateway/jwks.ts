// src/gateway/jwks.ts — KMS-Backed JWKS Endpoint (Sprint 7 Task 7.5)
//
// Serves /.well-known/jwks.json with public keys from AWS KMS.
// Supports key rotation: new key added, old key valid for 48h overlap.
// In-memory cache with 5-minute TTL to reduce KMS API calls.

import { Hono } from "hono"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JWK {
  kty: string
  kid: string
  use: string
  alg: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
}

export interface JWKSResponse {
  keys: JWK[]
}

export interface JWKSDeps {
  /** Fetch public key(s) from KMS. Returns JWK array. */
  getPublicKeys: () => Promise<JWK[]>
  /** Cache TTL in ms */
  cacheTtlMs?: number
}

// ---------------------------------------------------------------------------
// JWKS Service
// ---------------------------------------------------------------------------

export class JWKSService {
  private readonly getPublicKeys: () => Promise<JWK[]>
  private readonly cacheTtlMs: number
  private cache: { keys: JWK[]; expiresAt: number } | null = null

  constructor(deps: JWKSDeps) {
    this.getPublicKeys = deps.getPublicKeys
    this.cacheTtlMs = deps.cacheTtlMs ?? 5 * 60 * 1000 // 5 minutes
  }

  async getJWKS(): Promise<JWKSResponse> {
    const now = Date.now()

    if (this.cache && now < this.cache.expiresAt) {
      return { keys: this.cache.keys }
    }

    const keys = await this.getPublicKeys()
    this.cache = { keys, expiresAt: now + this.cacheTtlMs }

    return { keys }
  }

  invalidateCache(): void {
    this.cache = null
  }
}

// ---------------------------------------------------------------------------
// JWKS Routes
// ---------------------------------------------------------------------------

export function jwksRoutes(service: JWKSService): Hono {
  const app = new Hono()

  // GET /.well-known/jwks.json
  app.get("/", async (c) => {
    try {
      const jwks = await service.getJWKS()
      c.header("Cache-Control", "public, max-age=300")
      return c.json(jwks)
    } catch {
      return c.json({ error: "Failed to fetch JWKS" }, 500)
    }
  })

  return app
}
