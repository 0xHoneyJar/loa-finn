// src/x402/challenge-issuer.ts — Challenge Issuance (Sprint 2 T2.3)
//
// Issues signed x402 challenges as 402 Payment Required responses.
// Challenge stored in Redis with 5-min TTL keyed by nonce.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { createChallenge, computeRequestBinding, type X402Challenge } from "./hmac.js"
import { storeChallenge } from "./atomic-verify.js"
import { getRequestCost } from "./pricing.js"
import { USDC_BASE_ADDRESS, BASE_CHAIN_ID } from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChallengeIssuerDeps {
  redis: RedisCommandClient
  /** HMAC signing secret (current — always sign with current) */
  challengeSecret: string
  /** Wallet address to receive payments */
  walletAddress: string
  /** USDC contract address (default: Base USDC) */
  usdcAddress?: string
  /** Chain ID (default: 8453 = Base) */
  chainId?: number
  /** Challenge TTL in seconds (default: 300 = 5 minutes) */
  challengeTtlSeconds?: number
}

export interface IssueParams {
  request_path: string
  request_method: string
  token_id: string
  model: string
  max_tokens: number
}

// ---------------------------------------------------------------------------
// Challenge Issuer
// ---------------------------------------------------------------------------

export class ChallengeIssuer {
  private readonly redis: RedisCommandClient
  private readonly challengeSecret: string
  private readonly walletAddress: string
  private readonly usdcAddress: string
  private readonly chainId: number
  private readonly challengeTtlSeconds: number

  constructor(deps: ChallengeIssuerDeps) {
    this.redis = deps.redis
    this.challengeSecret = deps.challengeSecret
    this.walletAddress = deps.walletAddress
    this.usdcAddress = deps.usdcAddress ?? USDC_BASE_ADDRESS
    this.chainId = deps.chainId ?? BASE_CHAIN_ID
    this.challengeTtlSeconds = deps.challengeTtlSeconds ?? 300
  }

  /**
   * Issue a signed x402 challenge.
   * Stores challenge in Redis and returns it for 402 response body.
   */
  async issue(params: IssueParams): Promise<X402Challenge> {
    // Compute request cost from pricing config
    const amount = getRequestCost(params.token_id, params.model, params.max_tokens)

    // Compute request binding (SHA-256 of stable request fields)
    const requestBinding = computeRequestBinding({
      token_id: params.token_id,
      model: params.model,
      max_tokens: params.max_tokens,
    })

    // Create signed challenge with fresh nonce
    const challenge = createChallenge(
      {
        amount,
        recipient: this.walletAddress,
        chain_id: this.chainId,
        token: this.usdcAddress,
        request_path: params.request_path,
        request_method: params.request_method,
        request_binding: requestBinding,
        ttlSeconds: this.challengeTtlSeconds,
      },
      this.challengeSecret,
    )

    // Store in Redis for later verification (keyed by nonce)
    await storeChallenge(
      this.redis,
      challenge.nonce,
      JSON.stringify(challenge),
      this.challengeTtlSeconds,
    )

    return challenge
  }
}
