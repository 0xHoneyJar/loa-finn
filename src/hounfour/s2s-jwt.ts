// src/hounfour/s2s-jwt.ts — S2S JWT Signing (SDD §3.4, T-A.6)
// loa-finn's ES256 keypair for signing S2S JWTs and JWS payloads
// when communicating with arrakis (usage reports, budget queries).

import { importPKCS8, SignJWT, CompactSign } from "jose"
import type { KeyLike } from "jose"
import { createPublicKey, createPrivateKey } from "node:crypto"

// --- Types ---

export interface S2SConfig {
  /** PEM-encoded ES256 private key (from FINN_S2S_PRIVATE_KEY env var or file) */
  privateKeyPem: string
  /** Key ID with version suffix (e.g., "loa-finn-v1") */
  kid: string
  /** JWT issuer (default: "loa-finn") */
  issuer: string
  /** JWT audience (default: "arrakis") */
  audience: string
}

// --- S2S JWT Signer ---

export class S2SJwtSigner {
  private privateKey: KeyLike | null = null
  private publicJWK: Record<string, unknown> | null = null
  private config: S2SConfig

  constructor(config: S2SConfig) {
    this.config = config
  }

  /** Initialize by importing the PEM private key */
  async init(): Promise<void> {
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

  /** Sign a JWT for S2S communication (e.g., authenticating to arrakis) */
  async signJWT(claims: Record<string, unknown>, expiresInSeconds: number = 60): Promise<string> {
    if (!this.privateKey) throw new Error("S2SJwtSigner not initialized — call init() first")

    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: this.config.kid })
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.privateKey)
  }

  /**
   * Sign a payload as JWS (compact serialization) for usage reports.
   * The payload is canonical JSON bytes.
   */
  async signJWS(payload: Uint8Array): Promise<string> {
    if (!this.privateKey) throw new Error("S2SJwtSigner not initialized — call init() first")

    return new CompactSign(payload)
      .setProtectedHeader({ alg: "ES256", kid: this.config.kid })
      .sign(this.privateKey)
  }

  /**
   * Sign a JSON object as JWS over canonical JSON.
   * Convenience wrapper over signJWS.
   */
  async signPayload(obj: Record<string, unknown>): Promise<string> {
    const canonical = JSON.stringify(obj)
    const bytes = new TextEncoder().encode(canonical)
    return this.signJWS(bytes)
  }

  /** Get the public JWK for the JWKS endpoint */
  getPublicJWK(): Record<string, unknown> {
    if (!this.publicJWK) throw new Error("S2SJwtSigner not initialized — call init() first")
    return { ...this.publicJWK }
  }

  /** Get the full JWKS document (for serving at /.well-known/jwks.json) */
  getJWKS(): { keys: Record<string, unknown>[] } {
    return { keys: [this.getPublicJWK()] }
  }

  /** Whether the signer is ready */
  get isReady(): boolean {
    return this.privateKey !== null
  }
}
