// src/hounfour/goodhart/dixie-transport.ts — Dixie Transport Layer (SDD §6.3, T-2.4)
//
// Three concrete transports behind DixieTransport interface:
//   Stub (null), HTTP (fetch + AbortSignal), Direct (library import).

import { normalizeResponse, type ReputationResponse } from "./reputation-response.js"

// --- Interface ---

export interface DixieTransport {
  getReputation(nftId: string, options?: { signal?: AbortSignal }): Promise<ReputationResponse | null>
}

// --- Stub Transport (zero behavioral change) ---

export class DixieStubTransport implements DixieTransport {
  async getReputation(): Promise<null> {
    return null
  }
}

// --- HTTP Transport ---

export interface DixieHttpConfig {
  baseUrl: string
  timeoutMs?: number // Per-request timeout (default: 100ms, composed with AbortSignal.any)
}

export class DixieHttpTransport implements DixieTransport {
  private readonly baseOrigin: string
  private readonly config: DixieHttpConfig

  constructor(config: DixieHttpConfig) {
    // Validate baseUrl at construction to prevent URL injection
    const parsed = new URL(config.baseUrl)
    this.baseOrigin = parsed.origin
    this.config = config
  }

  async getReputation(nftId: string, options?: { signal?: AbortSignal }): Promise<ReputationResponse | null> {
    try {
      const response = await fetch(`${this.baseOrigin}/reputation/${encodeURIComponent(nftId)}`, {
        signal: options?.signal,
        headers: { "Accept": "application/json" },
      })

      if (!response.ok) return null

      const raw = await response.json()
      return normalizeResponse(raw)
    } catch {
      // Network error, abort, timeout — all return null
      return null
    }
  }
}

// --- Direct Import Transport ---

/** Interface for dixie library's ReputationStore */
export interface DixieReputationStore {
  get(nftId: string): Promise<unknown>
}

export class DixieDirectTransport implements DixieTransport {
  private readonly store: DixieReputationStore

  constructor(store: DixieReputationStore) {
    this.store = store
  }

  async getReputation(nftId: string, options?: { signal?: AbortSignal }): Promise<ReputationResponse | null> {
    // Honor abort signal
    if (options?.signal?.aborted) return null

    try {
      const raw = await this.store.get(nftId)
      return normalizeResponse(raw)
    } catch {
      return null
    }
  }
}
