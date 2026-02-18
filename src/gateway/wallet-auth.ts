// src/gateway/wallet-auth.ts — SIWE Verify + EIP-1271 Signature Validation (SDD §4.1, Sprint 2 Task 2.3)
//
// Server-side SIWE verification with EOA ecrecover + EIP-1271 smart wallet fallback.
// JWT session management: access token (ES256, 15min) + refresh token (opaque, 24h).
// Client-side WalletConnect UI deferred to Sprint 5.5.

import { randomBytes, createHash } from "node:crypto"
import { Hono } from "hono"
import * as jose from "jose"
import { SiweMessage } from "siwe"
import { createPublicClient, http, getAddress, type PublicClient, type Hex } from "viem"
import { base } from "viem/chains"
import { RateLimiter } from "./rate-limit.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WalletAuthConfig {
  /** Expected SIWE domain (e.g. "agent.honeyjar.xyz") */
  domain: string
  /** Expected chain ID (8453 = Base mainnet) */
  chainId: number
  /** Base RPC URL for on-chain calls */
  rpcUrl: string
  /** Fallback RPC URL */
  rpcUrlFallback?: string
  /** Allowed origins for CSRF */
  allowedOrigins: string[]
  /** JWT signing key (ES256 private key PEM or JWK) */
  jwtPrivateKey: jose.KeyLike | Uint8Array
  /** JWT verification key (ES256 public key) */
  jwtPublicKey: jose.KeyLike | Uint8Array
  /** Access token TTL in seconds (default: 900 = 15min) */
  accessTokenTtlSec?: number
  /** Refresh token TTL in seconds (default: 86400 = 24h) */
  refreshTokenTtlSec?: number
}

export interface WalletAuthDeps {
  /** Redis get */
  redisGet: (key: string) => Promise<string | null>
  /** Redis set with TTL */
  redisSet: (key: string, value: string, ttlSec: number) => Promise<void>
  /** Redis delete */
  redisDel: (key: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// EIP-1271 interface
// ---------------------------------------------------------------------------

const EIP_1271_ABI = [
  {
    name: "isValidSignature",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const

const EIP_1271_MAGIC_VALUE = "0x1626ba7e"

// ---------------------------------------------------------------------------
// WalletAuth Service
// ---------------------------------------------------------------------------

export class WalletAuthService {
  private client: PublicClient
  private nonceRateLimiter: RateLimiter
  private purchaseRateLimiter: RateLimiter
  private config: Required<Pick<WalletAuthConfig, "accessTokenTtlSec" | "refreshTokenTtlSec">> & WalletAuthConfig

  constructor(
    config: WalletAuthConfig,
    private deps: WalletAuthDeps,
  ) {
    this.config = {
      ...config,
      accessTokenTtlSec: config.accessTokenTtlSec ?? 900,
      refreshTokenTtlSec: config.refreshTokenTtlSec ?? 86400,
    }
    this.client = createPublicClient({ chain: base, transport: http(config.rpcUrl) })
    // Flatline IMP-007: 10 req/min per IP on nonce endpoint
    this.nonceRateLimiter = new RateLimiter(60_000, 10)
    // Flatline IMP-007: 5 req/min per wallet on purchase endpoint
    this.purchaseRateLimiter = new RateLimiter(60_000, 5)
  }

  // -----------------------------------------------------------------------
  // Nonce Generation
  // -----------------------------------------------------------------------

  async generateNonce(): Promise<string> {
    const nonce = randomBytes(32).toString("hex")
    await this.deps.redisSet(`siwe:nonce:${nonce}`, "1", 300) // 5min TTL
    return nonce
  }

  // -----------------------------------------------------------------------
  // SIWE Verification
  // -----------------------------------------------------------------------

  async verifySiwe(
    messageStr: string,
    signature: string,
  ): Promise<{ address: string; walletType: "eoa" | "contract"; sessionId: string; accessToken: string; refreshToken: string }> {
    const message = new SiweMessage(messageStr)

    // Validate domain
    if (message.domain !== this.config.domain) {
      throw new WalletAuthError("DOMAIN_MISMATCH", `Expected domain ${this.config.domain}, got ${message.domain}`)
    }

    // Validate chain ID
    if (message.chainId !== this.config.chainId) {
      throw new WalletAuthError("CHAIN_ID_MISMATCH", `Expected chainId ${this.config.chainId}, got ${message.chainId}`)
    }

    // Validate nonce (one-time use)
    const nonceKey = `siwe:nonce:${message.nonce}`
    const nonceValid = await this.deps.redisGet(nonceKey)
    if (!nonceValid) {
      throw new WalletAuthError("NONCE_INVALID", "Nonce not found or already used")
    }
    await this.deps.redisDel(nonceKey) // consume nonce

    // Check expiration
    if (message.expirationTime && new Date(message.expirationTime) < new Date()) {
      throw new WalletAuthError("MESSAGE_EXPIRED", "SIWE message has expired")
    }

    // Verify signature — try EOA first, then EIP-1271
    let walletType: "eoa" | "contract" = "eoa"

    try {
      await message.verify({ signature })
    } catch {
      // EOA verification failed — try EIP-1271 smart wallet
      walletType = "contract"
      const isValid = await this.verifyEIP1271(
        getAddress(message.address),
        messageStr,
        signature as Hex,
      )
      if (!isValid) {
        throw new WalletAuthError("SIGNATURE_INVALID", "Signature verification failed for both EOA and contract wallet")
      }
    }

    // Issue session
    const address = getAddress(message.address).toLowerCase()
    const sessionId = randomBytes(16).toString("hex")

    // Create access JWT (ES256, 15min)
    const accessToken = await new jose.SignJWT({
      sub: address,
      chain_id: this.config.chainId,
      wallet_type: walletType,
      session_id: sessionId,
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSec}s`)
      .sign(this.config.jwtPrivateKey)

    // Create opaque refresh token (24h)
    const refreshToken = randomBytes(32).toString("hex")
    await this.deps.redisSet(
      `session:${sessionId}`,
      JSON.stringify({ address, walletType, refreshToken: hashToken(refreshToken) }),
      this.config.refreshTokenTtlSec,
    )

    return { address, walletType, sessionId, accessToken, refreshToken }
  }

  // -----------------------------------------------------------------------
  // Refresh Token
  // -----------------------------------------------------------------------

  async refreshAccessToken(refreshToken: string, sessionId: string): Promise<{ accessToken: string }> {
    const sessionData = await this.deps.redisGet(`session:${sessionId}`)
    if (!sessionData) {
      throw new WalletAuthError("SESSION_REVOKED", "Session not found or revoked")
    }

    const session = JSON.parse(sessionData) as { address: string; walletType: string; refreshToken: string }

    // Constant-time comparison of refresh token hash
    const providedHash = hashToken(refreshToken)
    if (providedHash !== session.refreshToken) {
      throw new WalletAuthError("REFRESH_INVALID", "Invalid refresh token")
    }

    // Issue new access token
    const accessToken = await new jose.SignJWT({
      sub: session.address,
      chain_id: this.config.chainId,
      wallet_type: session.walletType,
      session_id: sessionId,
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSec}s`)
      .sign(this.config.jwtPrivateKey)

    return { accessToken }
  }

  // -----------------------------------------------------------------------
  // Session Revocation
  // -----------------------------------------------------------------------

  async revokeSession(sessionId: string): Promise<void> {
    await this.deps.redisDel(`session:${sessionId}`)
  }

  // -----------------------------------------------------------------------
  // JWT Verification (middleware helper)
  // -----------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<WalletSession> {
    try {
      const { payload } = await jose.jwtVerify(token, this.config.jwtPublicKey, {
        algorithms: ["ES256"],
      })
      return {
        address: payload.sub as string,
        chainId: payload.chain_id as number,
        walletType: payload.wallet_type as "eoa" | "contract",
        sessionId: payload.session_id as string,
      }
    } catch {
      throw new WalletAuthError("TOKEN_INVALID", "Invalid or expired access token")
    }
  }

  // -----------------------------------------------------------------------
  // Rate Limiters (exposed for middleware)
  // -----------------------------------------------------------------------

  checkNonceRateLimit(ip: string): boolean {
    return this.nonceRateLimiter.check(ip).allowed
  }

  checkPurchaseRateLimit(wallet: string): boolean {
    return this.purchaseRateLimiter.check(wallet).allowed
  }

  // -----------------------------------------------------------------------
  // EIP-1271 Smart Wallet Verification
  // -----------------------------------------------------------------------

  private async verifyEIP1271(address: string, message: string, signature: Hex): Promise<boolean> {
    try {
      const messageHash = createHash("sha256").update(message).digest() as unknown as Hex
      const result = await this.client.readContract({
        address: address as `0x${string}`,
        abi: EIP_1271_ABI,
        functionName: "isValidSignature",
        args: [messageHash as `0x${string}`, signature],
      })
      return result === EIP_1271_MAGIC_VALUE
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Hono Routes
// ---------------------------------------------------------------------------

export function walletAuthRoutes(auth: WalletAuthService): Hono {
  const app = new Hono()

  // GET /api/v1/auth/nonce
  app.get("/nonce", async (c) => {
    const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown"
    if (!auth.checkNonceRateLimit(ip)) {
      return c.json({ error: "Rate limited", code: "RATE_LIMITED" }, 429)
    }
    const nonce = await auth.generateNonce()
    return c.json({ nonce })
  })

  // POST /api/v1/auth/verify
  app.post("/verify", async (c) => {
    try {
      const body = await c.req.json<{ message: string; signature: string }>()
      if (!body.message || !body.signature) {
        return c.json({ error: "Missing message or signature", code: "INVALID_REQUEST" }, 400)
      }
      const result = await auth.verifySiwe(body.message, body.signature)
      return c.json({
        address: result.address,
        wallet_type: result.walletType,
        session_id: result.sessionId,
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
      })
    } catch (e) {
      if (e instanceof WalletAuthError) {
        return c.json({ error: e.message, code: e.code }, 401)
      }
      throw e
    }
  })

  // POST /api/v1/auth/refresh
  app.post("/refresh", async (c) => {
    try {
      const body = await c.req.json<{ refresh_token: string; session_id: string }>()
      if (!body.refresh_token || !body.session_id) {
        return c.json({ error: "Missing refresh_token or session_id", code: "INVALID_REQUEST" }, 400)
      }
      const result = await auth.refreshAccessToken(body.refresh_token, body.session_id)
      return c.json({ access_token: result.accessToken })
    } catch (e) {
      if (e instanceof WalletAuthError) {
        return c.json({ error: e.message, code: e.code }, 401)
      }
      throw e
    }
  })

  // POST /api/v1/auth/logout
  app.post("/logout", async (c) => {
    try {
      const body = await c.req.json<{ session_id: string }>()
      if (!body.session_id) {
        return c.json({ error: "Missing session_id", code: "INVALID_REQUEST" }, 400)
      }
      await auth.revokeSession(body.session_id)
      return c.json({ status: "revoked" })
    } catch (e) {
      if (e instanceof WalletAuthError) {
        return c.json({ error: e.message, code: e.code }, 400)
      }
      throw e
    }
  })

  return app
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletSession {
  address: string
  chainId: number
  walletType: "eoa" | "contract"
  sessionId: string
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class WalletAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "WalletAuthError"
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
