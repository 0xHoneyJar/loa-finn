// tests/mocks/byok-proxy-stub.ts — BYOK Proxy Stub (Task 4.5, C.5)
//
// Local BYOK proxy stub implementing two-JWT + bounded-use + nonce replay semantics.
// Intentionally includes fake API keys in error paths for redaction verification.
// Config: BYOK_BACKEND=mock|arrakis selects stub vs real endpoint.

import { randomUUID } from "node:crypto"

// --- Types ---

/** BYOK session JWT payload (minted by POST /api/v1/byok/session) */
export interface BYOKSessionToken {
  jti: string
  tenant_id: string
  provider: string
  scopes: string[]
  aud: string
  exp: number
  iat: number
}

/** BYOK proxy request body */
export interface BYOKProxyRequest {
  session_token: string
  provider: string
  req_nonce: string
  request: {
    model: string
    messages: unknown[]
    max_tokens?: number
    temperature?: number
  }
}

/** BYOK proxy response */
export interface BYOKProxyResponse {
  content: string
  usage: { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number }
  model: string
  trace_id: string
}

/** Canned provider responses */
const CANNED_RESPONSES: Record<string, BYOKProxyResponse> = {
  openai: {
    content: "Hello from OpenAI via BYOK proxy.",
    usage: { prompt_tokens: 10, completion_tokens: 8, reasoning_tokens: 0 },
    model: "gpt-4o",
    trace_id: "",
  },
  anthropic: {
    content: "Hello from Anthropic via BYOK proxy.",
    usage: { prompt_tokens: 12, completion_tokens: 10, reasoning_tokens: 0 },
    model: "claude-sonnet-4-5-20250929",
    trace_id: "",
  },
}

// --- BYOKProxyStub ---

/**
 * In-memory BYOK proxy stub for integration testing.
 * Implements the same bounded-use + nonce replay semantics as arrakis.
 */
export class BYOKProxyStub {
  /** Session store: jti → session data */
  private sessions = new Map<string, BYOKSessionToken & { request_count: number; revoked: boolean }>()

  /** Nonce replay protection: req_nonce → expiry timestamp */
  private nonces = new Map<string, number>()

  /** Max requests per session (bounded-use) */
  private maxRequestsPerSession: number

  /** Audit log */
  public auditLog: Array<{
    timestamp: string
    request_id: string
    tenant_id: string
    provider: string
    status: number
    action: string
  }> = []

  /** Intentionally leaked keys for redaction testing */
  public static readonly FAKE_OPENAI_KEY = "sk-test-FAKE-key-for-redaction-testing-12345678901234"
  public static readonly FAKE_ANTHROPIC_KEY = "anthropic-sk-test-FAKE-key-for-redaction-99999"

  constructor(opts: { maxRequestsPerSession?: number } = {}) {
    this.maxRequestsPerSession = opts.maxRequestsPerSession ?? 100
  }

  // --- Session Management ---

  /**
   * Mint a BYOK session token (simulates POST /api/v1/byok/session).
   * Returns session JWT payload (in real arrakis, this would be a signed JWT).
   */
  mintSession(tenantId: string, provider: string, scopes: string[] = ["inference"]): BYOKSessionToken {
    const jti = randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const token: BYOKSessionToken = {
      jti,
      tenant_id: tenantId,
      provider,
      scopes,
      aud: "arrakis-proxy",
      exp: now + 3600, // 1h
      iat: now,
    }

    this.sessions.set(jti, { ...token, request_count: 0, revoked: false })

    this.logAudit(randomUUID(), tenantId, provider, 201, "session_created")

    return token
  }

  /**
   * Revoke a session token.
   */
  revokeSession(jti: string): boolean {
    const session = this.sessions.get(jti)
    if (!session) return false
    session.revoked = true
    this.logAudit(randomUUID(), session.tenant_id, session.provider, 200, "session_revoked")
    return true
  }

  // --- Proxy ---

  /**
   * Process a BYOK proxy request (simulates POST /api/v1/byok/proxy).
   *
   * Validates:
   * 1. Session JWT: exists, not expired, not revoked
   * 2. Bounded-use: request count ≤ maxRequestsPerSession
   * 3. Nonce replay: req_nonce not already used
   * 4. Provider match: session provider matches request provider
   * 5. Tenant match: session tenant matches request
   *
   * Returns { status, body } mimicking HTTP response.
   */
  proxy(
    sessionJti: string,
    tenantId: string,
    request: BYOKProxyRequest,
  ): { status: number; body: unknown } {
    const requestId = randomUUID()

    // 1. Session validation
    const session = this.sessions.get(sessionJti)
    if (!session) {
      this.logAudit(requestId, tenantId, request.provider, 404, "session_not_found")
      return { status: 404, body: { error: "session_not_found" } }
    }

    if (session.revoked) {
      this.logAudit(requestId, tenantId, request.provider, 403, "session_revoked")
      return { status: 403, body: { error: "session_revoked" } }
    }

    const now = Math.floor(Date.now() / 1000)
    if (session.exp < now) {
      this.logAudit(requestId, tenantId, request.provider, 403, "session_expired")
      return { status: 403, body: { error: "session_expired" } }
    }

    // 2. Tenant match
    if (session.tenant_id !== tenantId) {
      this.logAudit(requestId, tenantId, request.provider, 403, "tenant_mismatch")
      return { status: 403, body: { error: "tenant_mismatch" } }
    }

    // 3. Provider match
    if (session.provider !== request.provider) {
      this.logAudit(requestId, tenantId, request.provider, 400, "provider_mismatch")
      return { status: 400, body: { error: "provider_mismatch" } }
    }

    // 4. Bounded-use enforcement
    if (session.request_count >= this.maxRequestsPerSession) {
      this.logAudit(requestId, tenantId, request.provider, 429, "bounded_use_exceeded")
      return { status: 429, body: { error: "bounded_use_exceeded", limit: this.maxRequestsPerSession } }
    }

    // 5. Nonce replay protection
    const nonceKey = request.req_nonce
    if (this.nonces.has(nonceKey)) {
      this.logAudit(requestId, tenantId, request.provider, 409, "nonce_replay")
      return { status: 409, body: { error: "nonce_replay", req_nonce: nonceKey } }
    }
    // Store nonce with 60s TTL
    this.nonces.set(nonceKey, now + 60)

    // 6. Increment request count
    session.request_count++

    // 7. Simulate provider call (return canned response)
    const canned = CANNED_RESPONSES[request.provider] ?? CANNED_RESPONSES.openai
    const response: BYOKProxyResponse = {
      ...canned,
      trace_id: requestId,
    }

    this.logAudit(requestId, tenantId, request.provider, 200, "proxy_success")

    return { status: 200, body: response }
  }

  /**
   * Simulate an error path that intentionally leaks fake API keys.
   * Used for redaction verification in tests.
   */
  simulateKeyLeakError(provider: string): { status: number; body: unknown } {
    const fakeKey = provider === "anthropic"
      ? BYOKProxyStub.FAKE_ANTHROPIC_KEY
      : BYOKProxyStub.FAKE_OPENAI_KEY

    return {
      status: 500,
      body: {
        error: "provider_error",
        message: `Authentication failed with key ${fakeKey} for provider ${provider}`,
        debug: { api_key: fakeKey, provider },
      },
    }
  }

  // --- Query ---

  /** Get session request count */
  getRequestCount(jti: string): number {
    return this.sessions.get(jti)?.request_count ?? 0
  }

  /** Check if session exists and is active */
  isSessionActive(jti: string): boolean {
    const session = this.sessions.get(jti)
    if (!session) return false
    if (session.revoked) return false
    return session.exp >= Math.floor(Date.now() / 1000)
  }

  /** Clean up expired nonces */
  cleanupNonces(): number {
    const now = Math.floor(Date.now() / 1000)
    let cleaned = 0
    for (const [nonce, expiry] of this.nonces) {
      if (expiry < now) {
        this.nonces.delete(nonce)
        cleaned++
      }
    }
    return cleaned
  }

  /** Clear all state */
  reset(): void {
    this.sessions.clear()
    this.nonces.clear()
    this.auditLog = []
  }

  // --- Private ---

  private logAudit(requestId: string, tenantId: string, provider: string, status: number, action: string): void {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      request_id: requestId,
      tenant_id: tenantId,
      provider,
      status,
      action,
    })
  }
}
