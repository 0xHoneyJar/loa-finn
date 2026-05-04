// tests/safety/hash-chain-vectors.test.ts — Hash chain test vector validation (Task 1.7)
//
// Validates that the hash chain test vectors in hash-chain-vectors.json are internally
// consistent and that both legacy and protocol_v1 canonicalization produce the expected
// hashes. These vectors enable cross-system validation between finn and arrakis.

import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import canonicalizeJCS from "canonicalize"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Helpers ──────────────────────────────────────────────────

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/**
 * Legacy canonicalization — matches src/safety/audit-trail.ts:
 * sorted keys at all nesting levels, excludes `hash` and `hmac` fields.
 */
function canonicalizeLegacy(record: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {}
  const keys = Object.keys(record).sort()
  for (const key of keys) {
    if (key === "hash" || key === "hmac") continue
    filtered[key] = record[key]
  }
  return JSON.stringify(filtered, sortReplacer)
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}

function computePayloadHash(payload: unknown): string {
  const canonical = canonicalizeJCS(payload)
  return sha256hex(canonical!)
}

function computeEntryHash(prevHash: string, envelope: unknown): string {
  const canonical = canonicalizeJCS(envelope)
  const input = prevHash + "\n" + canonical
  return sha256hex(input)
}

// ── Types ────────────────────────────────────────────────────

interface VectorFile {
  version: number
  description: string
  canonicalization: string
  hash_algorithm: string
  separator: string
  generated_at: string
  vectors: Vector[]
}

interface Vector {
  id: string
  format: string
  description?: string
  prev_hash?: string
  prev_hash_legacy?: string
  prev_hash_protocol?: string
  record: Record<string, unknown>
  canonical_json?: string
  expected_hash?: string
  payload?: Record<string, unknown>
  envelope?: Record<string, unknown>
  expected_payload_hash?: string
  expected_entry_hash?: string
}

// ── Load vectors ─────────────────────────────────────────────

const vectorsPath = join(__dirname, "hash-chain-vectors.json")
const vectorsRaw = readFileSync(vectorsPath, "utf-8")
const vectors: VectorFile = JSON.parse(vectorsRaw)

const legacyGenesis = vectors.vectors.find((v) => v.id === "legacy_genesis")!
const bridgeEntry = vectors.vectors.find((v) => v.id === "bridge_entry")!
const protocolFirst = vectors.vectors.find((v) => v.id === "protocol_v1_first")!
const unicodeCase = vectors.vectors.find((v) => v.id === "unicode_edge_case")!

// ── Tests ────────────────────────────────────────────────────

describe("Hash Chain Test Vectors", () => {
  describe("Structural Validation", () => {
    it("vectors file has version 1", () => {
      expect(vectors.version).toBe(1)
    })

    it("vectors file specifies SHA-256 and RFC 8785", () => {
      expect(vectors.hash_algorithm).toBe("SHA-256")
      expect(vectors.canonicalization).toBe("RFC 8785 (JCS)")
    })

    it("vectors file contains exactly 4 test vectors", () => {
      expect(vectors.vectors.length).toBe(4)
    })

    it("all vectors have required id and format fields", () => {
      for (const v of vectors.vectors) {
        expect(v.id).toBeTruthy()
        expect(v.format).toBeTruthy()
        expect(["legacy", "protocol_v1"]).toContain(v.format)
      }
    })

    it("all expected_hash values are 64-char hex strings", () => {
      const hexPattern = /^[0-9a-f]{64}$/
      for (const v of vectors.vectors) {
        if (v.expected_hash) expect(v.expected_hash).toMatch(hexPattern)
        if (v.expected_payload_hash) expect(v.expected_payload_hash).toMatch(hexPattern)
        if (v.expected_entry_hash) expect(v.expected_entry_hash).toMatch(hexPattern)
      }
    })
  })

  describe("Legacy Genesis Vector", () => {
    it("canonical JSON matches recomputed value", () => {
      const recomputed = canonicalizeLegacy(legacyGenesis.record)
      expect(recomputed).toBe(legacyGenesis.canonical_json)
    })

    it("expected_hash matches SHA-256 of canonical JSON", () => {
      const hash = sha256hex(legacyGenesis.canonical_json!)
      expect(hash).toBe(legacyGenesis.expected_hash)
    })

    it("prev_hash is 'genesis'", () => {
      expect(legacyGenesis.prev_hash).toBe("genesis")
    })
  })

  describe("Bridge Entry Vector", () => {
    it("prev_hash_legacy matches legacy_genesis expected_hash", () => {
      expect(bridgeEntry.prev_hash_legacy).toBe(legacyGenesis.expected_hash)
    })

    it("prev_hash_protocol is 'genesis' (new chain)", () => {
      expect(bridgeEntry.prev_hash_protocol).toBe("genesis")
    })

    it("expected_payload_hash matches RFC 8785 SHA-256 of payload", () => {
      const recomputed = computePayloadHash(bridgeEntry.payload)
      expect(recomputed).toBe(bridgeEntry.expected_payload_hash)
    })

    it("envelope.payload_hash matches expected_payload_hash", () => {
      expect((bridgeEntry.envelope as Record<string, unknown>).payload_hash)
        .toBe(bridgeEntry.expected_payload_hash)
    })

    it("expected_entry_hash matches SHA-256(prev + newline + canonical_envelope)", () => {
      const recomputed = computeEntryHash("genesis", bridgeEntry.envelope)
      expect(recomputed).toBe(bridgeEntry.expected_entry_hash)
    })
  })

  describe("Protocol v1 First Entry", () => {
    it("prev_hash_protocol chains from bridge_entry", () => {
      expect(protocolFirst.prev_hash_protocol).toBe(bridgeEntry.expected_entry_hash)
    })

    it("expected_payload_hash matches RFC 8785 SHA-256 of payload", () => {
      const recomputed = computePayloadHash(protocolFirst.payload)
      expect(recomputed).toBe(protocolFirst.expected_payload_hash)
    })

    it("envelope.payload_hash matches expected_payload_hash", () => {
      expect((protocolFirst.envelope as Record<string, unknown>).payload_hash)
        .toBe(protocolFirst.expected_payload_hash)
    })

    it("expected_entry_hash chains correctly", () => {
      const recomputed = computeEntryHash(bridgeEntry.expected_entry_hash!, protocolFirst.envelope)
      expect(recomputed).toBe(protocolFirst.expected_entry_hash)
    })
  })

  describe("Unicode Edge Case", () => {
    it("expected_payload_hash matches RFC 8785 SHA-256 of payload", () => {
      const recomputed = computePayloadHash(unicodeCase.payload)
      expect(recomputed).toBe(unicodeCase.expected_payload_hash)
    })

    it("payload contains non-BMP characters (emoji, CJK, RTL)", () => {
      const params = unicodeCase.payload!.params as Record<string, string>
      expect(params.emoji.codePointAt(0)!).toBeGreaterThan(0xffff)
      expect(params.cjk).toMatch(/[\u4e00-\u9fff]/)
      expect(params.rtl).toMatch(/[\u0600-\u06ff]/)
    })
  })

  describe("Chain Continuity", () => {
    it("full chain: legacy_genesis -> bridge_entry -> protocol_v1_first links correctly", () => {
      expect(legacyGenesis.prev_hash).toBe("genesis")
      expect(bridgeEntry.prev_hash_legacy).toBe(legacyGenesis.expected_hash)
      expect(bridgeEntry.prev_hash_protocol).toBe("genesis")
      expect(protocolFirst.prev_hash_protocol).toBe(bridgeEntry.expected_entry_hash)
    })

    it("all hashes are distinct (no collisions)", () => {
      const allHashes = new Set<string>()
      for (const v of vectors.vectors) {
        if (v.expected_hash) allHashes.add(v.expected_hash)
        if (v.expected_payload_hash) allHashes.add(v.expected_payload_hash)
        if (v.expected_entry_hash) allHashes.add(v.expected_entry_hash)
      }
      expect(allHashes.size).toBe(6)
    })
  })

  describe("Cross-System Reproducibility", () => {
    it("legacy canonicalization is deterministic", () => {
      const a = canonicalizeLegacy(legacyGenesis.record)
      const b = canonicalizeLegacy(legacyGenesis.record)
      expect(a).toBe(b)
    })

    it("RFC 8785 canonicalization is deterministic", () => {
      const a = canonicalizeJCS(bridgeEntry.payload)
      const b = canonicalizeJCS(bridgeEntry.payload)
      expect(a).toBe(b)
    })

    it("RFC 8785 sorts keys deterministically regardless of insertion order", () => {
      const obj1 = { z: 1, a: 2, m: 3 }
      const obj2 = { a: 2, m: 3, z: 1 }
      expect(canonicalizeJCS(obj1)).toBe(canonicalizeJCS(obj2))
    })
  })
})
