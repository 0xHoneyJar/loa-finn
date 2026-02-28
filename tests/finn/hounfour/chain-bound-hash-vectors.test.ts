// tests/finn/hounfour/chain-bound-hash-vectors.test.ts — T-2.4
// Hash vector tests for dual-format audit trail (legacy + chain-bound).
// All expected hex values are hardcoded from canonical hounfour v8.3.0 functions.

import { describe, it, expect } from "vitest"
import {
  computeAuditEntryHash,
  computeChainBoundHash,
  buildDomainTag,
  AUDIT_TRAIL_GENESIS_HASH,
  computeAdvisoryLockKey,
  ChainBoundHashError,
  validateDomainTag,
} from "../../../src/hounfour/protocol-types.js"
import type { AuditEntryHashInput } from "../../../src/hounfour/protocol-types.js"

// ── Test domain tags ─────────────────────────────────────────────────────
// buildDomainTag produces "loa-commons:audit:<schemaId>:<version>"
// Legacy tag has dots in version (valid for computeAuditEntryHash but NOT for computeChainBoundHash).
// Sanitized tag replaces dots with hyphens for validateDomainTag compliance.
const LEGACY_DOMAIN_TAG = buildDomainTag("test-store", "8.3.0")
const SANITIZED_DOMAIN_TAG = LEGACY_DOMAIN_TAG.replace(/\./g, "-")

// ── Fixed test entries ───────────────────────────────────────────────────

const ENTRY_A: AuditEntryHashInput = {
  entry_id: "00000000-0000-0000-0000-000000000001",
  timestamp: "2026-02-28T12:00:00.000Z",
  event_type: "store.data.write",
  payload: { payload_hash: "sha256:aaaa" },
}

const ENTRY_B: AuditEntryHashInput = {
  entry_id: "00000000-0000-0000-0000-000000000002",
  timestamp: "2026-02-28T12:01:00.000Z",
  event_type: "store.data.write",
  payload: { payload_hash: "sha256:bbbb" },
}

const ENTRY_C: AuditEntryHashInput = {
  entry_id: "00000000-0000-0000-0000-000000000003",
  timestamp: "2026-02-28T12:02:00.000Z",
  event_type: "store.data.write",
  payload: { payload_hash: "sha256:cccc" },
}

// ── Expected hash values (computed from hounfour v8.3.0) ────────────────

const EXPECTED = {
  legacyA: "sha256:17f61b10466b6db654fa71eef67856192145c5ac0b56a43597eaf8a4ad698122",
  legacyB: "sha256:72134e471a51a61ae31676c14017228d38ac3a5ab562dab91cc40f0528e8d2a2",
  legacyC: "sha256:74cc08686e64520560b385ed3b7d3fc8f6ee4a86e429cd63e7a17764d4600caa",
  chainBoundA: "sha256:d181547f7639700da6c5208d053df4f91fdfaf57bbb936e18f6eebd2a7654130",
  chainBoundB: "sha256:e6620938ade641a9abe76eaba98a1e46555aa269a9fd006e76facaaf028e594a",
  chainBoundC: "sha256:3b274f93de53e0ca2fe801ddb225771ea1bb11e241e11629d08c311a5330aafc",
  chainBoundA_tampered: "sha256:2be11e39f434692e1ac0312e793936f65527f9cafda1db5a79af2a6e766d3091",
} as const

// ── Tests ────────────────────────────────────────────────────────────────

describe("hash vector tests — dual-format audit trail", () => {
  describe("domain tag format", () => {
    it("buildDomainTag produces expected format", () => {
      expect(LEGACY_DOMAIN_TAG).toBe("loa-commons:audit:test-store:8.3.0")
    })

    it("sanitized tag replaces dots with hyphens", () => {
      expect(SANITIZED_DOMAIN_TAG).toBe("loa-commons:audit:test-store:8-3-0")
    })

    it("validateDomainTag rejects legacy tag (dots in version)", () => {
      const result = validateDomainTag(LEGACY_DOMAIN_TAG)
      expect(result.valid).toBe(false)
    })

    it("validateDomainTag accepts sanitized tag", () => {
      const result = validateDomainTag(SANITIZED_DOMAIN_TAG)
      expect(result.valid).toBe(true)
    })
  })

  describe("genesis hash", () => {
    it("is SHA-256 of empty string", () => {
      expect(AUDIT_TRAIL_GENESIS_HASH).toBe(
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      )
    })
  })

  describe("legacy computeAuditEntryHash", () => {
    it("entry A produces expected hash", () => {
      expect(computeAuditEntryHash(ENTRY_A, LEGACY_DOMAIN_TAG)).toBe(EXPECTED.legacyA)
    })

    it("entry B produces expected hash", () => {
      expect(computeAuditEntryHash(ENTRY_B, LEGACY_DOMAIN_TAG)).toBe(EXPECTED.legacyB)
    })

    it("entry C produces expected hash", () => {
      expect(computeAuditEntryHash(ENTRY_C, LEGACY_DOMAIN_TAG)).toBe(EXPECTED.legacyC)
    })

    it("is deterministic (same input → same output)", () => {
      const h1 = computeAuditEntryHash(ENTRY_A, LEGACY_DOMAIN_TAG)
      const h2 = computeAuditEntryHash(ENTRY_A, LEGACY_DOMAIN_TAG)
      expect(h1).toBe(h2)
    })
  })

  describe("chain-bound computeChainBoundHash", () => {
    it("entry A (genesis → A) produces expected hash", () => {
      expect(
        computeChainBoundHash(ENTRY_A, SANITIZED_DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH),
      ).toBe(EXPECTED.chainBoundA)
    })

    it("entry B (A → B) produces expected hash", () => {
      expect(
        computeChainBoundHash(ENTRY_B, SANITIZED_DOMAIN_TAG, EXPECTED.chainBoundA),
      ).toBe(EXPECTED.chainBoundB)
    })

    it("entry C (B → C) produces expected hash", () => {
      expect(
        computeChainBoundHash(ENTRY_C, SANITIZED_DOMAIN_TAG, EXPECTED.chainBoundB),
      ).toBe(EXPECTED.chainBoundC)
    })

    it("rejects legacy domain tag (dots)", () => {
      expect(() =>
        computeChainBoundHash(ENTRY_A, LEGACY_DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH),
      ).toThrow(ChainBoundHashError)
    })
  })

  describe("3-entry chain integrity", () => {
    it("legacy chain: genesis → A → B → C", () => {
      const hashA = computeAuditEntryHash(ENTRY_A, LEGACY_DOMAIN_TAG)
      const hashB = computeAuditEntryHash(ENTRY_B, LEGACY_DOMAIN_TAG)
      const hashC = computeAuditEntryHash(ENTRY_C, LEGACY_DOMAIN_TAG)

      // Legacy hashes are content-only (no chain linkage) — each is independent
      expect(hashA).toBe(EXPECTED.legacyA)
      expect(hashB).toBe(EXPECTED.legacyB)
      expect(hashC).toBe(EXPECTED.legacyC)
    })

    it("chain-bound chain: genesis → A → B → C", () => {
      const hashA = computeChainBoundHash(
        ENTRY_A, SANITIZED_DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH,
      )
      const hashB = computeChainBoundHash(ENTRY_B, SANITIZED_DOMAIN_TAG, hashA)
      const hashC = computeChainBoundHash(ENTRY_C, SANITIZED_DOMAIN_TAG, hashB)

      expect(hashA).toBe(EXPECTED.chainBoundA)
      expect(hashB).toBe(EXPECTED.chainBoundB)
      expect(hashC).toBe(EXPECTED.chainBoundC)
    })
  })

  describe("tamper detection", () => {
    it("changing prevHash produces different chain-bound hash", () => {
      const tampered = computeChainBoundHash(
        ENTRY_A,
        SANITIZED_DOMAIN_TAG,
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      )
      expect(tampered).toBe(EXPECTED.chainBoundA_tampered)
      expect(tampered).not.toBe(EXPECTED.chainBoundA)
    })

    it("swapping entry order produces different chain-bound hashes", () => {
      // Chain: genesis → B → A (swapped order)
      const hashB_first = computeChainBoundHash(
        ENTRY_B, SANITIZED_DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH,
      )
      const hashA_second = computeChainBoundHash(
        ENTRY_A, SANITIZED_DOMAIN_TAG, hashB_first,
      )

      // Must differ from normal order (genesis → A → B)
      expect(hashB_first).not.toBe(EXPECTED.chainBoundA)
      expect(hashA_second).not.toBe(EXPECTED.chainBoundB)
    })
  })

  describe("algorithm isolation", () => {
    it("legacy and chain-bound produce different hashes for same entry", () => {
      const legacy = computeAuditEntryHash(ENTRY_A, LEGACY_DOMAIN_TAG)
      const chainBound = computeChainBoundHash(
        ENTRY_A, SANITIZED_DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH,
      )
      expect(legacy).not.toBe(chainBound)
    })

    it("all three entries have distinct hashes in both algorithms", () => {
      const legacyHashes = new Set([EXPECTED.legacyA, EXPECTED.legacyB, EXPECTED.legacyC])
      const chainHashes = new Set([EXPECTED.chainBoundA, EXPECTED.chainBoundB, EXPECTED.chainBoundC])

      expect(legacyHashes.size).toBe(3)
      expect(chainHashes.size).toBe(3)
    })
  })

  describe("advisory lock key vectors", () => {
    it("test-store domain tag → expected key", () => {
      expect(computeAdvisoryLockKey(LEGACY_DOMAIN_TAG)).toBe(717523562)
    })

    it("governed-credits domain tag → expected key", () => {
      const tag = buildDomainTag("governed-credits", "8.2.0")
      expect(computeAdvisoryLockKey(tag)).toBe(-1040989068)
    })

    it("sessions domain tag → expected key", () => {
      const tag = buildDomainTag("sessions", "8.3.0")
      expect(computeAdvisoryLockKey(tag)).toBe(1487982359)
    })

    it("produces signed 32-bit integers", () => {
      const key = computeAdvisoryLockKey(LEGACY_DOMAIN_TAG)
      expect(key).toBeGreaterThanOrEqual(-2147483648)
      expect(key).toBeLessThanOrEqual(2147483647)
      expect(Number.isInteger(key)).toBe(true)
    })

    it("different domain tags → different keys", () => {
      const key1 = computeAdvisoryLockKey(buildDomainTag("alpha", "1.0.0"))
      const key2 = computeAdvisoryLockKey(buildDomainTag("beta", "1.0.0"))
      expect(key1).not.toBe(key2)
    })
  })
})
