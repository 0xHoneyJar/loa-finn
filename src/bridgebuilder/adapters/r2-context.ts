// src/bridgebuilder/adapters/r2-context.ts
// R2ContextStore: implements upstream IContextStore using atomic conditional writes.
// Claim keys use owner/repo/prNumber for per-PR idempotency.
// context.json uses putIfMatch with ETag for optimistic concurrency.

import type { IContextStore, ReviewResult } from "../upstream.js"
import type { IR2Client } from "../r2-client.js"

const CONTEXT_KEY = "bridgebuilder/context.json"
const CLAIM_PREFIX = "bridgebuilder/claims/"
const MAX_ENTRIES = 1000
const CLAIM_TTL_MINUTES = 10

interface HashEntry {
  hash: string
  updatedAt: string
}

interface ShaEntry {
  sha: string
  updatedAt: string
}

interface ContextData {
  hashes: Record<string, HashEntry>  // key: "owner/repo/prNumber"
  shas?: Record<string, ShaEntry>    // key: "owner/repo/prNumber" — V3 incremental review
}

interface ClaimRecord {
  status: "in-progress" | "posted"
  claimedAt: string
  expiresAt?: string
  postedAt?: string
}

const EMPTY_CONTEXT: ContextData = { hashes: {} }

export class R2ContextStore implements IContextStore {
  private data: ContextData = { ...EMPTY_CONTEXT, hashes: {} }
  private contextEtag: string | undefined

  constructor(private readonly r2: IR2Client) {}

  async load(): Promise<void> {
    const result = await this.r2.get(CONTEXT_KEY)
    if (result) {
      try {
        this.data = JSON.parse(result.data) as ContextData
        this.contextEtag = result.etag
      } catch {
        this.data = { ...EMPTY_CONTEXT, hashes: {} }
        this.contextEtag = undefined
      }
    }
  }

  async getLastHash(owner: string, repo: string, prNumber: number): Promise<string | null> {
    const key = `${owner}/${repo}/${prNumber}`
    return this.data.hashes[key]?.hash ?? null
  }

  async setLastHash(owner: string, repo: string, prNumber: number, hash: string): Promise<void> {
    const key = `${owner}/${repo}/${prNumber}`
    const entry: HashEntry = { hash, updatedAt: new Date().toISOString() }
    this.data.hashes[key] = entry
    this.evictIfNeeded()
    await this.persistContext({ key, hash: entry })
  }

  async getLastReviewedSha(owner: string, repo: string, prNumber: number): Promise<string | null> {
    const key = `${owner}/${repo}/${prNumber}`
    return this.data.shas?.[key]?.sha ?? null
  }

  async setLastReviewedSha(owner: string, repo: string, prNumber: number, sha: string): Promise<void> {
    const key = `${owner}/${repo}/${prNumber}`
    if (!this.data.shas) this.data.shas = {}
    const entry: ShaEntry = { sha, updatedAt: new Date().toISOString() }
    this.data.shas[key] = entry
    this.evictShasIfNeeded()
    await this.persistContext({ key, sha: entry })
  }

  /**
   * Atomic claim acquisition using putIfAbsent (If-None-Match: *).
   * No read-then-write race — the S3 API rejects the write if key already exists.
   * Expired in-progress claims are deleted first to allow retry.
   */
  async claimReview(owner: string, repo: string, prNumber: number): Promise<boolean> {
    const claimKey = this.claimKey(owner, repo, prNumber)

    // Check for existing claim — may need to clean up expired ones
    const existing = await this.r2.get(claimKey)
    if (existing) {
      try {
        const record = JSON.parse(existing.data) as ClaimRecord
        if (record.status === "posted") return false
        if (record.expiresAt && new Date(record.expiresAt) > new Date()) {
          return false // Still in progress, not expired
        }
        // Expired in-progress — delete to allow atomic re-claim
        await this.r2.delete(claimKey)
      } catch {
        // Corrupt claim — delete and retry
        await this.r2.delete(claimKey)
      }
    }

    // Atomic create — only succeeds if no key exists
    const now = new Date()
    const claim: ClaimRecord = {
      status: "in-progress",
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CLAIM_TTL_MINUTES * 60_000).toISOString(),
    }
    const result = await this.r2.putIfAbsent(claimKey, JSON.stringify(claim))
    return result.created
  }

  /**
   * Finalize claim after successful post. Upgrades to permanent "posted" record.
   * Also persists the review hash to context.json with optimistic concurrency.
   */
  async finalizeReview(owner: string, repo: string, prNumber: number, result: ReviewResult): Promise<void> {
    const claimKey = this.claimKey(owner, repo, prNumber)
    const record: ClaimRecord = {
      status: "posted",
      claimedAt: new Date().toISOString(),
      postedAt: new Date().toISOString(),
    }

    // Read existing claim to get ETag for conditional upgrade
    const existing = await this.r2.get(claimKey)
    if (existing?.etag) {
      const upgraded = await this.r2.putIfMatch(claimKey, JSON.stringify(record), existing.etag)
      if (!upgraded.updated) {
        // Claim was concurrently modified — unconditional write as fallback
        await this.r2.put(claimKey, JSON.stringify(record))
      }
    } else {
      await this.r2.put(claimKey, JSON.stringify(record))
    }

    // Update hash in context for change detection
    if (result.item) {
      const hashKey = `${owner}/${repo}/${prNumber}`
      const entry: HashEntry = { hash: result.item.hash, updatedAt: new Date().toISOString() }
      this.data.hashes[hashKey] = entry
      this.evictIfNeeded()
      await this.persistContext({ key: hashKey, hash: entry })
    }
  }

  private claimKey(owner: string, repo: string, prNumber: number): string {
    return `${CLAIM_PREFIX}${owner}/${repo}/${prNumber}`
  }

  /** FIFO eviction: remove oldest entries when exceeding MAX_ENTRIES. */
  private evictIfNeeded(): void {
    const keys = Object.keys(this.data.hashes)
    if (keys.length <= MAX_ENTRIES) return

    const sorted = keys.sort((a, b) => {
      const aTime = this.data.hashes[a].updatedAt
      const bTime = this.data.hashes[b].updatedAt
      return aTime.localeCompare(bTime)
    })

    const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES)
    for (const key of toRemove) {
      delete this.data.hashes[key]
    }
  }

  /** FIFO eviction for SHA entries — same policy as hashes (BB-063-010). */
  private evictShasIfNeeded(): void {
    if (!this.data.shas) return
    const keys = Object.keys(this.data.shas)
    if (keys.length <= MAX_ENTRIES) return

    const sorted = keys.sort((a, b) => {
      const aTime = this.data.shas![a].updatedAt
      const bTime = this.data.shas![b].updatedAt
      return aTime.localeCompare(bTime)
    })

    const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES)
    for (const key of toRemove) {
      delete this.data.shas![key]
    }
  }

  /**
   * Persist context.json with optimistic concurrency.
   * Uses putIfMatch when we have an ETag, retries on 412 with fresh read.
   * On conflict, re-applies the pending change after reloading remote state.
   */
  private async persistContext(pending?: { key: string; hash?: HashEntry; sha?: ShaEntry }): Promise<void> {
    const json = JSON.stringify(this.data)

    if (this.contextEtag) {
      const result = await this.r2.putIfMatch(CONTEXT_KEY, json, this.contextEtag)
      if (result.updated) {
        this.contextEtag = result.etag
        return
      }
      // 412 — stale ETag, re-read remote state and re-apply our pending change
      await this.load()
      if (pending) {
        if (pending.hash) {
          this.data.hashes[pending.key] = pending.hash
          this.evictIfNeeded()
        }
        if (pending.sha) {
          if (!this.data.shas) this.data.shas = {}
          this.data.shas[pending.key] = pending.sha
          this.evictShasIfNeeded()
        }
      }
    }

    // No ETag or retry after conflict — unconditional write with fresh data
    const freshJson = JSON.stringify(this.data)
    const putResult = await this.r2.put(CONTEXT_KEY, freshJson)
    this.contextEtag = putResult.etag
  }
}
