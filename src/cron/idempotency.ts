// src/cron/idempotency.ts — Durable idempotency index for mutation deduplication (SDD §4.9)

import { createHash } from "node:crypto"
import { AtomicJsonStore } from "../cron/store.js"

// ---------------------------------------------------------------------------
// Types (SDD §4.9)
// ---------------------------------------------------------------------------

export interface DedupeEntry {
  intentSeq: number
  status: "pending" | "completed" | "unknown"
  ts: number // epoch ms
}

export interface DedupeStore {
  version: 1
  entries: Record<string, DedupeEntry>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Crash compensation notes (SDD §4.9)
// ---------------------------------------------------------------------------
//
// Some GitHub mutations are safe to retry after a crash; others risk duplicates.
//
//   create_pull_request_review : safe to retry (GitHub deduplicates by content)
//   add_issue_comment          : REQUIRES CHECK — search for duplicate comment
//   update_issue (labels)      : safe to retry (labels are idempotent sets)
//   create_pull_request        : REQUIRES CHECK — search for existing PR with same head
//   create_or_update_file      : safe to retry (content-addressed)
//
// When a 'pending' entry survives a crash, the reconciliation layer should
// consult this table to decide whether to retry blindly or search first.
// The markUnknown() method supports orphan reconciliation for the "requires
// check" category.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DedupeIndex (SDD §4.9)
// ---------------------------------------------------------------------------

/**
 * Durable key-value store for mutation-level deduplication.
 * Deterministic keys per mutation type enable reliable detection across restarts.
 */
export class DedupeIndex {
  private store: AtomicJsonStore<DedupeStore>
  private data: DedupeStore

  constructor(filePath: string) {
    this.store = new AtomicJsonStore<DedupeStore>(filePath)
    this.data = { version: 1, entries: {} }
  }

  /** Load existing store from disk, or start with an empty one. */
  async init(): Promise<void> {
    const loaded = await this.store.read()
    if (loaded) {
      this.data = loaded
    }
  }

  // -------------------------------------------------------------------------
  // Key generation
  // -------------------------------------------------------------------------

  /**
   * Build a deterministic deduplication key for a mutation.
   *
   * Format: `{action}:{scope}/{resource}:{stateHash(16)}`
   *
   * - scope = `owner/repo` or `_` if absent
   * - resource = first of: pull_number, issue_number, path, or `_`
   * - stateHash = first 16 hex chars of SHA-256 of sorted remaining params
   */
  static buildKey(action: string, params: Record<string, unknown>): string {
    // Determine scope
    const owner = params.owner
    const repo = params.repo
    const scope =
      typeof owner === "string" && typeof repo === "string"
        ? `${owner}/${repo}`
        : "_"

    // Determine resource (first match wins)
    let resource = "_"
    let resourceKey: string | undefined
    for (const key of ["pull_number", "issue_number", "path"] as const) {
      if (params[key] !== undefined) {
        resource = String(params[key])
        resourceKey = key
        break
      }
    }

    // Build remaining params for hashing (exclude owner, repo, and the chosen resource key)
    const excluded = new Set<string>(["owner", "repo"])
    if (resourceKey) excluded.add(resourceKey)

    const remaining: Record<string, unknown> = {}
    for (const key of Object.keys(params).sort()) {
      if (!excluded.has(key)) {
        remaining[key] = params[key]
      }
    }

    // SHA-256 of sorted remaining params, truncated to 16 hex chars
    const json = JSON.stringify(remaining, Object.keys(remaining).sort())
    const hash = createHash("sha256").update(json).digest("hex").slice(0, 16)

    return `${action}:${scope}/${resource}:${hash}`
  }

  // -------------------------------------------------------------------------
  // Query & mutation methods
  // -------------------------------------------------------------------------

  /** Returns true only if entry exists AND status is 'completed'. */
  isDuplicate(key: string): boolean {
    const entry = this.data.entries[key]
    return entry !== undefined && entry.status === "completed"
  }

  /** Add entry with status 'pending'. Persists to disk. */
  async recordPending(key: string, intentSeq: number): Promise<void> {
    this.data.entries[key] = {
      intentSeq,
      status: "pending",
      ts: Date.now(),
    }
    await this.store.write(this.data)
  }

  /**
   * Add or update entry with status 'completed'. Persists to disk.
   * Also evicts entries older than 7 days.
   */
  async record(key: string, intentSeq: number): Promise<void> {
    this.data.entries[key] = {
      intentSeq,
      status: "completed",
      ts: Date.now(),
    }
    this.evictStaleInternal(SEVEN_DAYS_MS)
    await this.store.write(this.data)
  }

  /**
   * Update entry status to 'unknown' (for orphan reconciliation).
   * Persists to disk. No-op if entry does not exist.
   */
  async markUnknown(key: string): Promise<void> {
    const entry = this.data.entries[key]
    if (entry) {
      entry.status = "unknown"
      await this.store.write(this.data)
    }
  }

  /** Remove entries older than maxAge. Default 7 days. Persists to disk. */
  async evictStale(maxAgeMs: number = SEVEN_DAYS_MS): Promise<void> {
    this.evictStaleInternal(maxAgeMs)
    await this.store.write(this.data)
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Evict stale entries in-memory (caller must persist). */
  private evictStaleInternal(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs
    const entries = this.data.entries
    for (const key of Object.keys(entries)) {
      if (entries[key].ts < cutoff) {
        delete entries[key]
      }
    }
  }
}
