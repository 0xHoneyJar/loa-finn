// packages/finn-sdk/src/client.ts — FinnClient (Sprint 7 T7.2, T7.3)
//
// Typed client for the Finn Agent API.
// Handles x402 payment flow via payAndChat().

import type {
  FinnClientConfig,
  ChatRequest,
  ChatResponse,
  X402Challenge,
  X402Receipt,
  CreateKeyRequest,
  CreateKeyResponse,
  RevokeKeyResponse,
  KeyBalanceResponse,
  NonceResponse,
  VerifyRequest,
  VerifyResponse,
  PaymentCallback,
} from "./types.js"

// ---------------------------------------------------------------------------
// FinnClient
// ---------------------------------------------------------------------------

export class FinnClient {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private sessionToken?: string
  private readonly _fetch: typeof globalThis.fetch

  constructor(config: FinnClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "")
    this.apiKey = config.apiKey
    this.sessionToken = config.sessionToken
    this._fetch = config.fetch ?? globalThis.fetch
  }

  // -------------------------------------------------------------------------
  // Agent Chat (T7.2)
  // -------------------------------------------------------------------------

  /**
   * Send a message to an agent.
   * Requires either an API key or x402 payment headers.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const res = await this._fetch(`${this.baseUrl}/api/v1/agent/chat`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(request),
    })

    if (!res.ok) {
      await this.throwApiError(res)
    }

    return res.json() as Promise<ChatResponse>
  }

  /**
   * Chat with automatic x402 payment handling (T7.3).
   *
   * Flow:
   * 1. Attempt chat request
   * 2. If 402 returned with challenge, invoke paymentCallback
   * 3. Retry with receipt headers
   *
   * Returns null if payment callback returns null (user aborted).
   */
  async payAndChat(
    request: ChatRequest,
    paymentCallback: PaymentCallback,
  ): Promise<ChatResponse | null> {
    const res = await this._fetch(`${this.baseUrl}/api/v1/agent/chat`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(request),
    })

    // Success on first try (e.g., using API key with credits)
    if (res.ok) {
      return res.json() as Promise<ChatResponse>
    }

    // Not a 402 — throw the error
    if (res.status !== 402) {
      await this.throwApiError(res)
    }

    // Parse the x402 challenge
    const challengeBody = (await res.json()) as X402Challenge
    if (!challengeBody.challenge) {
      throw new FinnApiError("Received 402 but no challenge in response", "MISSING_CHALLENGE", 402)
    }

    // Invoke payment callback
    const receipt = await paymentCallback(challengeBody.challenge)
    if (!receipt) {
      return null // User aborted payment
    }

    // Retry with receipt headers
    const retryHeaders = this.buildHeaders()
    retryHeaders["X-Payment-Receipt"] = receipt.tx_hash
    retryHeaders["X-Payment-Nonce"] = receipt.nonce

    const retryRes = await this._fetch(`${this.baseUrl}/api/v1/agent/chat`, {
      method: "POST",
      headers: retryHeaders,
      body: JSON.stringify(request),
    })

    if (!retryRes.ok) {
      await this.throwApiError(retryRes)
    }

    return retryRes.json() as Promise<ChatResponse>
  }

  // -------------------------------------------------------------------------
  // API Key Management (T7.2)
  // -------------------------------------------------------------------------

  /** Create a new API key (requires SIWE session). */
  async createKey(request?: CreateKeyRequest): Promise<CreateKeyResponse> {
    const res = await this._fetch(`${this.baseUrl}/api/v1/keys`, {
      method: "POST",
      headers: this.buildSessionHeaders(),
      body: request ? JSON.stringify(request) : undefined,
    })

    if (!res.ok) {
      await this.throwApiError(res)
    }

    return res.json() as Promise<CreateKeyResponse>
  }

  /** Revoke an API key (requires SIWE session, must own key). */
  async revokeKey(keyId: string): Promise<RevokeKeyResponse> {
    const res = await this._fetch(`${this.baseUrl}/api/v1/keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: this.buildSessionHeaders(),
    })

    if (!res.ok) {
      await this.throwApiError(res)
    }

    return res.json() as Promise<RevokeKeyResponse>
  }

  /** Get credit balance for an API key (requires SIWE session). */
  async getBalance(keyId: string): Promise<KeyBalanceResponse> {
    const res = await this._fetch(
      `${this.baseUrl}/api/v1/keys/${encodeURIComponent(keyId)}/balance`,
      {
        method: "GET",
        headers: this.buildSessionHeaders(),
      },
    )

    if (!res.ok) {
      await this.throwApiError(res)
    }

    return res.json() as Promise<KeyBalanceResponse>
  }

  // -------------------------------------------------------------------------
  // Auth (T7.2)
  // -------------------------------------------------------------------------

  /** Get a SIWE nonce for authentication. */
  async getNonce(): Promise<NonceResponse> {
    const res = await this._fetch(`${this.baseUrl}/api/v1/auth/nonce`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    })

    if (!res.ok) {
      await this.throwApiError(res)
    }

    return res.json() as Promise<NonceResponse>
  }

  /** Verify a SIWE signature and obtain a session token. */
  async verify(request: VerifyRequest): Promise<VerifyResponse> {
    const res = await this._fetch(`${this.baseUrl}/api/v1/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    })

    if (!res.ok) {
      await this.throwApiError(res)
    }

    const response = (await res.json()) as VerifyResponse
    // Auto-store session token
    this.sessionToken = response.token
    return response
  }

  // -------------------------------------------------------------------------
  // x402 Helpers (T7.3)
  // -------------------------------------------------------------------------

  /** Set the session token (e.g., after external SIWE flow). */
  setSessionToken(token: string): void {
    this.sessionToken = token
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`
    }
    return headers
  }

  private buildSessionHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (this.sessionToken) {
      headers["Authorization"] = `Bearer ${this.sessionToken}`
    }
    return headers
  }

  private async throwApiError(res: Response): Promise<never> {
    let body: { error?: string; code?: string } = {}
    try {
      body = await res.json()
    } catch {
      // Non-JSON response
    }
    throw new FinnApiError(
      body.error ?? `HTTP ${res.status}`,
      body.code ?? "UNKNOWN",
      res.status,
    )
  }
}

// ---------------------------------------------------------------------------
// Error Class
// ---------------------------------------------------------------------------

export class FinnApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = "FinnApiError"
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// x402 Utility Functions (T7.3)
// ---------------------------------------------------------------------------

/**
 * Parse an x402 challenge from a 402 response body.
 * Returns the challenge object or null if the body doesn't contain one.
 */
export function parseX402Challenge(body: unknown): X402Challenge["challenge"] | null {
  if (!body || typeof body !== "object") return null
  const obj = body as Record<string, unknown>
  if (!obj.challenge || typeof obj.challenge !== "object") return null

  const challenge = obj.challenge as Record<string, unknown>
  if (
    typeof challenge.nonce !== "string" ||
    typeof challenge.amount !== "string" ||
    typeof challenge.recipient !== "string" ||
    typeof challenge.chain_id !== "number" ||
    typeof challenge.expires_at !== "string" ||
    typeof challenge.hmac !== "string"
  ) {
    return null
  }

  return challenge as unknown as X402Challenge["challenge"]
}

/**
 * Format x402 receipt as HTTP headers for the retry request.
 */
export function formatReceiptHeaders(receipt: X402Receipt): Record<string, string> {
  return {
    "X-Payment-Receipt": receipt.tx_hash,
    "X-Payment-Nonce": receipt.nonce,
  }
}
