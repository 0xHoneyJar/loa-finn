// src/hounfour/s2s-jwt.ts — S2S JWT Signing (SDD §3.4, T-A.6)
// loa-finn's keypair for signing S2S JWTs and JWS payloads
// when communicating with arrakis (usage reports, budget queries).
// Supports ES256 (asymmetric) and HS256 (symmetric shared secret).

import { importPKCS8, SignJWT, CompactSign } from "jose"
import { createPublicKey, createPrivateKey, type KeyObject } from "node:crypto"

// --- Types ---

/** ES256 asymmetric config — uses PEM private key + kid */
export interface S2SConfigES256 {
  alg: "ES256"
  /** PEM-encoded ES256 private key (from FINN_S2S_PRIVATE_KEY env var or file) */
  privateKeyPem: string
  /** Key ID with version suffix (e.g., "loa-finn-v1") */
  kid: string
  /** JWT issuer (default: "loa-finn") */
  issuer: string
  /** JWT audience (default: "arrakis") */
  audience: string
}

/** HS256 symmetric config — uses shared secret (for arrakis billing integration) */
export interface S2SConfigHS256 {
  alg: "HS256"
  /** Shared secret (from FINN_S2S_JWT_SECRET env var) */
  secret: string
  /** JWT issuer (default: "loa-finn") */
  issuer: string
  /** JWT audience (default: "arrakis") */
  audience: string
}

/** Discriminated union — algorithm determined at construction, never from untrusted input */
export type S2SConfig = S2SConfigES256 | S2SConfigHS256

// --- S2S JWT Signer ---

export class S2SJwtSigner {
  private privateKey: CryptoKey | KeyObject | null = null
  private signingKey: Uint8Array | null = null
  private publicJWK: Record<string, unknown> | null = null
  private config: S2SConfig

  constructor(config: S2SConfig) {
    this.config = config
  }

  /** Initialize by importing the key material */
  async init(): Promise<void> {
    if (this.config.alg === "HS256") {
      // HS256: encode shared secret as Uint8Array for jose
      this.signingKey = new TextEncoder().encode(this.config.secret)
    } else {
      // ES256: import PEM private key
      this.privateKey = await importPKCS8(this.config.privateKeyPem, "ES256")
      // Derive public JWK via Node.js crypto (importPKCS8 produces non-extractable CryptoKey)
      const nodePrivateKey = createPrivateKey({ key: this.config.privateKeyPem, format: "pem" })
      const nodePublicKey = createPublicKey(nodePrivateKey)
      const jwk = nodePublicKey.export({ format: "jwk" }) as Record<string, unknown>
      // For JWKS endpoint: only expose the public key components
      this.publicJWK = {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
        kid: this.config.kid,
        alg: "ES256",
        use: "sig",
      }
    }
  }

  /** Sign a JWT for S2S communication (e.g., authenticating to arrakis).
   *  Default TTL: 300s (5 minutes). */
  async signJWT(claims: Record<string, unknown>, expiresInSeconds: number = 300): Promise<string> {
    // Algorithm hardcoded from config, never from untrusted input
    if (this.config.alg === "HS256") {
      if (!this.signingKey) throw new Error("S2SJwtSigner not initialized — call init() first")
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" }) // no kid for HS256
        .setIssuer(this.config.issuer)
        .setAudience(this.config.audience)
        .setIssuedAt()
        .setExpirationTime(`${expiresInSeconds}s`)
        .sign(this.signingKey)
    } else {
      if (!this.privateKey) throw new Error("S2SJwtSigner not initialized — call init() first")
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: this.config.kid })
        .setIssuer(this.config.issuer)
        .setAudience(this.config.audience)
        .setIssuedAt()
        .setExpirationTime(`${expiresInSeconds}s`)
        .sign(this.privateKey)
    }
  }

  /**
   * Sign a payload as JWS (compact serialization) for usage reports.
   * The payload is canonical JSON bytes.
   * Not applicable for HS256 billing integration — throws.
   */
  async signJWS(payload: Uint8Array): Promise<string> {
    if (this.config.alg === "HS256") {
      throw new Error("signJWS is not supported for HS256 config — use signJWT for billing")
    }
    if (!this.privateKey) throw new Error("S2SJwtSigner not initialized — call init() first")

    return new CompactSign(payload)
      .setProtectedHeader({ alg: "ES256", kid: this.config.kid })
      .sign(this.privateKey)
  }

  /**
   * Sign a JSON object as JWS over canonical JSON.
   * Convenience wrapper over signJWS.
   * Not applicable for HS256 — throws.
   */
  async signPayload(obj: Record<string, unknown>): Promise<string> {
    const canonical = JSON.stringify(obj)
    const bytes = new TextEncoder().encode(canonical)
    return this.signJWS(bytes)
  }

  /** Get the public JWK for the JWKS endpoint.
   *  Not applicable for HS256 — throws. */
  getPublicJWK(): Record<string, unknown> {
    if (this.config.alg === "HS256") {
      throw new Error("getPublicJWK is not supported for HS256 config")
    }
    if (!this.publicJWK) throw new Error("S2SJwtSigner not initialized — call init() first")
    return { ...this.publicJWK }
  }

  /** Get the full JWKS document (for serving at /.well-known/jwks.json).
   *  HS256: returns empty keys array (arrakis verifies via shared secret, not JWKS). */
  getJWKS(): { keys: Record<string, unknown>[] } {
    if (this.config.alg === "HS256") {
      return { keys: [] }
    }
    return { keys: [this.getPublicJWK()] }
  }

  /** Whether the signer is ready */
  get isReady(): boolean {
    if (this.config.alg === "HS256") {
      return this.signingKey !== null
    }
    return this.privateKey !== null
  }
}
