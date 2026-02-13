// tests/finn/bridgebuilder-r2-context.test.ts
// Tests for R2ContextStore, IR2Client, config, and SanitizedLogger (Sprint 1)

import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"
import { R2ContextStore } from "../../src/bridgebuilder/adapters/r2-context.js"
import { SanitizedLogger } from "../../src/bridgebuilder/logger.js"
import type { IR2Client, GetResult, PutResult, ConditionalPutResult, ConditionalUpdateResult } from "../../src/bridgebuilder/r2-client.js"
import type { ILogger, IOutputSanitizer, ReviewResult, ReviewItem } from "../../src/bridgebuilder/upstream.js"

// ── In-memory mock R2 client ──────────────────────────────────

interface StoredObject {
  data: string
  etag: string
}

function createMockR2Client(): IR2Client & { store: Map<string, StoredObject> } {
  const store = new Map<string, StoredObject>()
  let etagCounter = 0

  const nextEtag = () => `"etag-${++etagCounter}"`

  return {
    store,
    async get(key: string): Promise<GetResult | null> {
      const obj = store.get(key)
      return obj ? { data: obj.data, etag: obj.etag } : null
    },
    async put(key: string, data: string): Promise<PutResult> {
      const etag = nextEtag()
      store.set(key, { data, etag })
      return { etag }
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
    async putIfAbsent(key: string, data: string): Promise<ConditionalPutResult> {
      if (store.has(key)) return { created: false }
      const etag = nextEtag()
      store.set(key, { data, etag })
      return { created: true, etag }
    },
    async putIfMatch(key: string, data: string, etag: string): Promise<ConditionalUpdateResult> {
      const existing = store.get(key)
      if (!existing || existing.etag !== etag) return { updated: false }
      const newEtag = nextEtag()
      store.set(key, { data, etag: newEtag })
      return { updated: true, etag: newEtag }
    },
  }
}

function makeReviewItem(owner: string, repo: string, prNumber: number): ReviewItem {
  return {
    owner,
    repo,
    pr: { number: prNumber, title: "test", headSha: "abc123", baseBranch: "main", labels: [], author: "test" },
    files: [],
    hash: `hash-${owner}-${repo}-${prNumber}`,
  }
}

function makeReviewResult(item: ReviewItem): ReviewResult {
  return { item, posted: true, skipped: false }
}

// ── R2ContextStore Tests ──────────────────────────────────────

describe("R2ContextStore", () => {
  let r2: ReturnType<typeof createMockR2Client>
  let store: R2ContextStore

  beforeEach(() => {
    r2 = createMockR2Client()
    store = new R2ContextStore(r2)
  })

  describe("load()", () => {
    it("loads empty state when no context.json exists", async () => {
      await store.load()
      const hash = await store.getLastHash("owner", "repo", 1)
      assert.equal(hash, null)
    })

    it("loads existing context.json", async () => {
      await r2.put("bridgebuilder/context.json", JSON.stringify({
        hashes: { "owner/repo/1": { hash: "abc", updatedAt: "2026-01-01T00:00:00Z" } },
      }))
      await store.load()
      const hash = await store.getLastHash("owner", "repo", 1)
      assert.equal(hash, "abc")
    })

    it("handles corrupt context.json gracefully", async () => {
      await r2.put("bridgebuilder/context.json", "NOT JSON")
      await store.load()
      const hash = await store.getLastHash("owner", "repo", 1)
      assert.equal(hash, null)
    })
  })

  describe("getLastHash() / setLastHash()", () => {
    it("returns null for unknown PR", async () => {
      await store.load()
      const hash = await store.getLastHash("owner", "repo", 99)
      assert.equal(hash, null)
    })

    it("stores and retrieves hash", async () => {
      await store.load()
      await store.setLastHash("owner", "repo", 1, "hash-123")
      const hash = await store.getLastHash("owner", "repo", 1)
      assert.equal(hash, "hash-123")
    })

    it("persists hash to R2", async () => {
      await store.load()
      await store.setLastHash("owner", "repo", 1, "hash-456")
      const stored = await r2.get("bridgebuilder/context.json")
      assert.ok(stored)
      const data = JSON.parse(stored.data)
      assert.equal(data.hashes["owner/repo/1"].hash, "hash-456")
    })
  })

  describe("claimReview()", () => {
    it("claims successfully when no existing claim", async () => {
      const claimed = await store.claimReview("owner", "repo", 1)
      assert.equal(claimed, true)
    })

    it("rejects claim when posted claim exists", async () => {
      await r2.put("bridgebuilder/claims/owner/repo/1", JSON.stringify({
        status: "posted",
        claimedAt: new Date().toISOString(),
        postedAt: new Date().toISOString(),
      }))
      const claimed = await store.claimReview("owner", "repo", 1)
      assert.equal(claimed, false)
    })

    it("rejects claim when active in-progress claim exists", async () => {
      const future = new Date(Date.now() + 600_000).toISOString()
      await r2.put("bridgebuilder/claims/owner/repo/1", JSON.stringify({
        status: "in-progress",
        claimedAt: new Date().toISOString(),
        expiresAt: future,
      }))
      const claimed = await store.claimReview("owner", "repo", 1)
      assert.equal(claimed, false)
    })

    it("allows retry on expired in-progress claim", async () => {
      const past = new Date(Date.now() - 60_000).toISOString()
      await r2.put("bridgebuilder/claims/owner/repo/1", JSON.stringify({
        status: "in-progress",
        claimedAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: past,
      }))
      const claimed = await store.claimReview("owner", "repo", 1)
      assert.equal(claimed, true)
    })

    it("uses putIfAbsent for atomic claim creation", async () => {
      // First claim succeeds
      const first = await store.claimReview("owner", "repo", 1)
      assert.equal(first, true)

      // Second concurrent claim fails (putIfAbsent returns created:false)
      const second = await store.claimReview("owner", "repo", 1)
      assert.equal(second, false)
    })

    it("handles corrupt claim data gracefully", async () => {
      await r2.put("bridgebuilder/claims/owner/repo/1", "NOT JSON")
      const claimed = await store.claimReview("owner", "repo", 1)
      assert.equal(claimed, true)
    })
  })

  describe("finalizeReview()", () => {
    it("upgrades claim to posted status", async () => {
      await store.load()
      const item = makeReviewItem("owner", "repo", 1)
      const result = makeReviewResult(item)

      await store.claimReview("owner", "repo", 1)
      await store.finalizeReview("owner", "repo", 1, result)

      const stored = await r2.get("bridgebuilder/claims/owner/repo/1")
      assert.ok(stored)
      const record = JSON.parse(stored.data)
      assert.equal(record.status, "posted")
      assert.ok(record.postedAt)
    })

    it("updates hash in context after finalize", async () => {
      await store.load()
      const item = makeReviewItem("owner", "repo", 1)
      const result = makeReviewResult(item)

      await store.finalizeReview("owner", "repo", 1, result)

      const hash = await store.getLastHash("owner", "repo", 1)
      assert.equal(hash, item.hash)
    })
  })

  describe("FIFO eviction", () => {
    it("evicts oldest entries when exceeding 1000", async () => {
      await store.load()

      // Add 1001 entries
      for (let i = 0; i < 1001; i++) {
        await store.setLastHash("owner", "repo", i, `hash-${i}`)
      }

      // Oldest entry (i=0) should be evicted
      const oldest = await store.getLastHash("owner", "repo", 0)
      assert.equal(oldest, null, "Oldest entry should be evicted")

      // Newest entry should still exist
      const newest = await store.getLastHash("owner", "repo", 1000)
      assert.equal(newest, "hash-1000")
    })
  })

  describe("getLastReviewedSha() / setLastReviewedSha()", () => {
    it("returns null for unknown PR", async () => {
      await store.load()
      const sha = await store.getLastReviewedSha("owner", "repo", 99)
      assert.equal(sha, null)
    })

    it("stores and retrieves SHA", async () => {
      await store.load()
      await store.setLastReviewedSha("owner", "repo", 1, "abc123def")
      const sha = await store.getLastReviewedSha("owner", "repo", 1)
      assert.equal(sha, "abc123def")
    })

    it("persists SHA to R2 without clobbering hashes", async () => {
      await store.load()
      // Set a hash first
      await store.setLastHash("owner", "repo", 1, "hash-xyz")
      // Then set a SHA
      await store.setLastReviewedSha("owner", "repo", 1, "sha-abc")

      const stored = await r2.get("bridgebuilder/context.json")
      assert.ok(stored)
      const data = JSON.parse(stored.data)
      // Both hash and SHA should be present
      assert.equal(data.hashes["owner/repo/1"].hash, "hash-xyz")
      assert.equal(data.shas["owner/repo/1"].sha, "sha-abc")
    })

    it("handles legacy context.json without shas field (backward compat)", async () => {
      // Seed with legacy format — no shas field
      await r2.put("bridgebuilder/context.json", JSON.stringify({
        hashes: { "owner/repo/1": { hash: "legacy-hash", updatedAt: "2026-01-01T00:00:00Z" } },
      }))
      await store.load()

      // getLastReviewedSha returns null (not throw) for legacy data
      const sha = await store.getLastReviewedSha("owner", "repo", 1)
      assert.equal(sha, null)

      // Hash still accessible
      const hash = await store.getLastHash("owner", "repo", 1)
      assert.equal(hash, "legacy-hash")
    })

    it("two-run incremental simulation", async () => {
      // Run 1: set SHA after review
      await store.load()
      await store.setLastReviewedSha("owner", "repo", 42, "first-head-sha")

      // Simulate new store instance loading persisted state (run 2)
      const store2 = new R2ContextStore(r2)
      await store2.load()
      const sha = await store2.getLastReviewedSha("owner", "repo", 42)
      assert.equal(sha, "first-head-sha")
    })
  })

  describe("optimistic concurrency", () => {
    it("uses putIfMatch for context updates when ETag available", async () => {
      // Seed context.json so we have an ETag
      await r2.put("bridgebuilder/context.json", JSON.stringify({ hashes: {} }))
      await store.load()

      // Now setLastHash should use putIfMatch
      await store.setLastHash("owner", "repo", 1, "hash-A")
      const stored = await r2.get("bridgebuilder/context.json")
      assert.ok(stored)
      const data = JSON.parse(stored.data)
      assert.equal(data.hashes["owner/repo/1"].hash, "hash-A")
    })
  })
})

// ── SanitizedLogger Tests ─────────────────────────────────────

describe("SanitizedLogger", () => {
  function createCapturingLogger(): ILogger & { messages: Array<{ level: string; message: string }> } {
    const messages: Array<{ level: string; message: string }> = []
    return {
      messages,
      info(message: string) { messages.push({ level: "info", message }) },
      warn(message: string) { messages.push({ level: "warn", message }) },
      error(message: string) { messages.push({ level: "error", message }) },
      debug(message: string) { messages.push({ level: "debug", message }) },
    }
  }

  function createTestSanitizer(): IOutputSanitizer {
    return {
      sanitize(content: string) {
        let sanitized = content
        const redacted: string[] = []
        if (/ghp_\w+/.test(sanitized)) {
          sanitized = sanitized.replace(/ghp_\w+/g, "[REDACTED]")
          redacted.push("GitHub PAT")
        }
        if (/sk-ant-[\w-]+/.test(sanitized)) {
          sanitized = sanitized.replace(/sk-ant-[\w-]+/g, "[REDACTED]")
          redacted.push("Anthropic key")
        }
        return { safe: redacted.length === 0, sanitizedContent: sanitized, redactedPatterns: redacted }
      },
    }
  }

  it("redacts ghp_* patterns from messages", () => {
    const inner = createCapturingLogger()
    const logger = new SanitizedLogger(inner, createTestSanitizer())

    logger.info("Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz0123")
    assert.equal(inner.messages[0].message, "Token: [REDACTED]")
  })

  it("redacts sk-ant-* patterns from messages", () => {
    const inner = createCapturingLogger()
    const logger = new SanitizedLogger(inner, createTestSanitizer())

    logger.warn("API key: sk-ant-api03-1234567890abcdef")
    assert.equal(inner.messages[0].message, "API key: [REDACTED]")
    assert.equal(inner.messages[0].level, "warn")
  })

  it("sanitized output reaches inner logger via all 4 methods", () => {
    const inner = createCapturingLogger()
    const logger = new SanitizedLogger(inner, createTestSanitizer())

    logger.info("safe message")
    logger.warn("warning")
    logger.error("error")
    logger.debug("debug")

    assert.equal(inner.messages.length, 4)
    assert.equal(inner.messages[0].level, "info")
    assert.equal(inner.messages[1].level, "warn")
    assert.equal(inner.messages[2].level, "error")
    assert.equal(inner.messages[3].level, "debug")
  })

  it("passes clean messages through unchanged", () => {
    const inner = createCapturingLogger()
    const logger = new SanitizedLogger(inner, createTestSanitizer())

    logger.info("No secrets here")
    assert.equal(inner.messages[0].message, "No secrets here")
  })
})

// ── Config Tests ──────────────────────────────────────────────

describe("loadFinnConfig", () => {
  // Config tests use dynamic import to get fresh module state
  const originalEnv = { ...process.env }

  function restoreEnv() {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  }

  it("returns r2: null when R2 env vars missing", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-for-config-test"
    delete process.env.R2_ENDPOINT
    delete process.env.R2_BUCKET
    delete process.env.R2_ACCESS_KEY_ID
    delete process.env.R2_SECRET_ACCESS_KEY

    const { loadFinnConfig } = await import("../../src/bridgebuilder/config.js")
    const config = await loadFinnConfig()
    assert.equal(config.r2, null)
    restoreEnv()
  })

  it("has correct lease defaults", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-for-config-test"
    delete process.env.BRIDGEBUILDER_LEASE_TTL_MINUTES
    delete process.env.BRIDGEBUILDER_LEASE_DELAY_MS

    const { loadFinnConfig } = await import("../../src/bridgebuilder/config.js")
    const config = await loadFinnConfig()
    assert.equal(config.lease.ttlMinutes, 30)
    assert.equal(config.lease.delayMs, 200)
    restoreEnv()
  })
})
