// src/gateway/siwe-auth.ts — SIWE Authentication Flow (Sprint 4 T4.5)
//
// Sign-In-With-Ethereum (EIP-4361) authentication for API key management.
//
// Flow:
// 1. GET  /api/v1/auth/nonce → random nonce stored in Redis (5-min TTL, single-use)
// 2. POST /api/v1/auth/verify → validates SIWE message, recovers wallet, issues JWT
// 3. Middleware: rejects missing/invalid/expired JWT with 401
//
// JWT: HS256, exp=15min, aud=loa-finn, sub=wallet_address, clock skew=30s

import { Hono } from "hono"
import { randomBytes } from "node:crypto"
import { SiweMessage } from "siwe"
import * as jose from "jose"
import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NONCE_TTL_SECONDS = 300       // 5 minutes
const JWT_EXPIRY_SECONDS = 900      // 15 minutes
const CLOCK_SKEW_SECONDS = 30
const NONCE_KEY_PREFIX = "finn:siwe:nonce:"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiweAuthConfig {
  /** Redis client for nonce storage */
  redis: RedisCommandClient
  /** JWT signing secret (HS256) — must be at least 32 bytes */
  jwtSecret: string
  /** Expected SIWE domain (e.g., "finn.honeyjar.xyz") */
  domain: string
  /** Expected SIWE URI (e.g., "https://finn.honeyjar.xyz") */
  uri: string
  /** Expected chain ID (8453 for Base) */
  chainId: number
}

export interface SiweSession {
  /** Wallet address (checksummed) */
  walletAddress: string
  /** JWT expiry timestamp (Unix seconds) */
  exp: number
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

/**
 * Create SIWE auth routes.
 *
 * Returns a Hono sub-app with:
 * - GET  /nonce  → { nonce: string }
 * - POST /verify → { token: string, expires_in: number, wallet_address: string }
 */
export function createSiweAuthRoutes(config: SiweAuthConfig): Hono {
  validateConfig(config)

  const app = new Hono()
  const secretKey = new TextEncoder().encode(config.jwtSecret)

  // GET /nonce — generate and store a single-use nonce
  app.get("/nonce", async (c) => {
    const nonce = randomBytes(16).toString("hex")
    const redisKey = `${NONCE_KEY_PREFIX}${nonce}`

    // Store nonce with TTL — value "1" means unconsumed
    await config.redis.set(redisKey, "1", "EX", NONCE_TTL_SECONDS)

    return c.json({ nonce })
  })

  // POST /verify — validate SIWE message + signature, issue JWT
  app.post("/verify", async (c) => {
    let body: { message: string; signature: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid request body" }, 400)
    }

    if (!body.message || !body.signature) {
      return c.json({ error: "Missing message or signature" }, 400)
    }

    // Parse SIWE message
    let siweMessage: SiweMessage
    try {
      siweMessage = new SiweMessage(body.message)
    } catch {
      return c.json({ error: "Invalid SIWE message format" }, 400)
    }

    // Validate domain
    if (siweMessage.domain !== config.domain) {
      return c.json({ error: "Invalid or expired SIWE credentials" }, 401)
    }

    // Validate URI
    if (siweMessage.uri !== config.uri) {
      return c.json({ error: "Invalid or expired SIWE credentials" }, 401)
    }

    // Validate chain ID
    if (siweMessage.chainId !== config.chainId) {
      return c.json({ error: "Invalid or expired SIWE credentials" }, 401)
    }

    // Validate nonce — atomic consume (get + delete)
    const nonceKey = `${NONCE_KEY_PREFIX}${siweMessage.nonce}`
    const nonceValue = await config.redis.get(nonceKey)
    if (nonceValue !== "1") {
      return c.json({ error: "Invalid or expired SIWE credentials" }, 401)
    }
    // Consume nonce (single-use)
    await config.redis.del(nonceKey)

    // Check SIWE message timestamps
    const now = new Date()

    if (siweMessage.expirationTime) {
      const expiry = new Date(siweMessage.expirationTime)
      if (expiry.getTime() < now.getTime() - CLOCK_SKEW_SECONDS * 1000) {
        return c.json({ error: "Invalid or expired SIWE credentials" }, 401)
      }
    }

    if (siweMessage.issuedAt) {
      const issued = new Date(siweMessage.issuedAt)
      // Reject if issued more than 5 minutes in the future (clock skew tolerance)
      if (issued.getTime() > now.getTime() + NONCE_TTL_SECONDS * 1000) {
        return c.json({ error: "Invalid or expired SIWE credentials" }, 401)
      }
    }

    // Verify signature — recovers wallet address
    try {
      const result = await siweMessage.verify({
        signature: body.signature,
        domain: config.domain,
        nonce: siweMessage.nonce,
      })
      if (!result.success) {
        return c.json({ error: "Invalid or expired SIWE credentials" }, 401)
      }
    } catch {
      return c.json({ error: "Invalid or expired SIWE credentials" }, 401)
    }

    // Issue JWT
    const walletAddress = siweMessage.address
    const token = await new jose.SignJWT({ sub: walletAddress })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("loa-finn")
      .setIssuedAt()
      .setExpirationTime(`${JWT_EXPIRY_SECONDS}s`)
      .sign(secretKey)

    return c.json({
      token,
      expires_in: JWT_EXPIRY_SECONDS,
      wallet_address: walletAddress,
    })
  })

  return app
}

// ---------------------------------------------------------------------------
// JWT Middleware
// ---------------------------------------------------------------------------

/**
 * Create middleware that validates SIWE session JWT.
 * Sets `siwe_wallet` on Hono context for downstream handlers.
 *
 * Returns 401 for missing/invalid/expired JWT.
 */
export function requireSiweSession(jwtSecret: string) {
  const secretKey = new TextEncoder().encode(jwtSecret)

  return async (c: { req: { header: (name: string) => string | undefined }; json: (data: unknown, status: number) => Response; set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    const authHeader = c.req.header("authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid authorization" }, 401)
    }

    const token = authHeader.slice(7)

    // Reject dk_ API keys — those go through the payment decision tree, not SIWE sessions
    if (token.startsWith("dk_")) {
      return c.json({ error: "Missing or invalid authorization" }, 401)
    }

    try {
      const { payload } = await jose.jwtVerify(token, secretKey, {
        audience: "loa-finn",
        clockTolerance: CLOCK_SKEW_SECONDS,
      })

      if (!payload.sub) {
        return c.json({ error: "Missing or invalid authorization" }, 401)
      }

      c.set("siwe_wallet", payload.sub)
      await next()
    } catch {
      return c.json({ error: "Missing or invalid authorization" }, 401)
    }
  }
}

// ---------------------------------------------------------------------------
// Config Validation
// ---------------------------------------------------------------------------

function validateConfig(config: SiweAuthConfig): void {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new Error("SIWE JWT secret must be at least 32 characters")
  }
  if (!config.domain) {
    throw new Error("SIWE domain is required")
  }
  if (!config.uri) {
    throw new Error("SIWE URI is required")
  }
  if (!config.chainId || config.chainId <= 0) {
    throw new Error("SIWE chain ID must be a positive integer")
  }
}
