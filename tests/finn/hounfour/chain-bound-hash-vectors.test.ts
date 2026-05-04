// tests/finn/hounfour/chain-bound-hash-vectors.test.ts — T-2.4
// Hash vector tests for dual-format audit trail (legacy + chain-bound).
// All expected hex values are hardcoded from canonical hounfour v8.3.1 functions.

import { describe, it, expect } from "vitest"
import {
  computeAuditEntryHash,
  computeChainBoundHash,
  buildDomainTag,
  AUDIT_TRAIL_GENESIS_HASH,
  computeAdvisoryLockKey,
  validateDomainTag,
} from "../../../src/hounfour/protocol-types.js"
import type { AuditEntryHashInput } from "../../../src/hounfour/protocol-types.js"

// ── Test domain tag ──────────────────────────────────────────────────────
// v8.3.1+: buildDomainTag natively sanitizes dots to hyphens (hounfour PR #42).
// No manual sanitization needed — the tag is always validateDomainTag-compliant.
const DOMAIN_TAG = buildDomainTag("test-store", "8.3.1")

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

// ── Expected hash values (Golden File Pattern — computed from hounfour v8.3.1) ──
//
// These hex values are hardcoded golden outputs computed from hounfour v8.3.1
// (domain tag sanitization fix, PR #42). They serve as regression detectors:
// if hounfour changes its internal hash serialization, these tests will fail,
// signaling that finn's stored audit trails need migration consideration.
//
// To regenerate after hounfour upgrade:
//   npx tsx scripts/regenerate-hash-vectors.ts

const EXPECTED = {
  legacyA: "sha256:4138f5818cc52a21c48e947575d36dce5f475d604e7c9ed7859c1526ebdb014d",
  legacyB: "sha256:57c9366c3dda6d88c53a1787b48df36bcc58e3a1fd0137049cc767e9e7fb4300",
  legacyC: "sha256:763dc9a22cab6a8159f365f1cf2a7b2fddd7d1a7eaa249ec8eb6d0585a8c93a9",
  chainBoundA: "sha256:10600b194009a43953fd6dfb66e0eca9c7f610e70ec5611d0e1a99bff40815a6",
  chainBoundB: "sha256:7727a5ba79d4b8526787e60bb5360b0d3bda93579a4062e3d4393c516104a19d",
  chainBoundC: "sha256:1ad372d1795129158f3d19ab0b6d27bb5f759b0bee5634b30df0435ffbe4c385",
  chainBoundA_tampered: "sha256:5d14e0a7d0ede8fb504c6c7f953a7f596e7e50727d93292abc9032a191a42b0f",
} as const

// ── Tests ────────────────────────────────────────────────────────────────

describe("hash vector tests — dual-format audit trail", () => {
  describe("domain tag format", () => {
    it("buildDomainTag produces sanitized format (dots → hyphens)", () => {
      expect(DOMAIN_TAG).toBe("loa-commons:audit:test-store:8-3-1")
    })

    it("validateDomainTag accepts buildDomainTag output", () => {
      const result = validateDomainTag(DOMAIN_TAG)
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
      expect(computeAuditEntryHash(ENTRY_A, DOMAIN_TAG)).toBe(EXPECTED.legacyA)
    })

    it("entry B produces expected hash", () => {
      expect(computeAuditEntryHash(ENTRY_B, DOMAIN_TAG)).toBe(EXPECTED.legacyB)
    })

    it("entry C produces expected hash", () => {
      expect(computeAuditEntryHash(ENTRY_C, DOMAIN_TAG)).toBe(EXPECTED.legacyC)
    })

    it("is deterministic (same input → same output)", () => {
      const h1 = computeAuditEntryHash(ENTRY_A, DOMAIN_TAG)
      const h2 = computeAuditEntryHash(ENTRY_A, DOMAIN_TAG)
      expect(h1).toBe(h2)
    })
  })

  describe("chain-bound computeChainBoundHash", () => {
    it("entry A (genesis → A) produces expected hash", () => {
      expect(
        computeChainBoundHash(ENTRY_A, DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH),
      ).toBe(EXPECTED.chainBoundA)
    })

    it("entry B (A → B) produces expected hash", () => {
      expect(
        computeChainBoundHash(ENTRY_B, DOMAIN_TAG, EXPECTED.chainBoundA),
      ).toBe(EXPECTED.chainBoundB)
    })

    it("entry C (B → C) produces expected hash", () => {
      expect(
        computeChainBoundHash(ENTRY_C, DOMAIN_TAG, EXPECTED.chainBoundB),
      ).toBe(EXPECTED.chainBoundC)
    })
  })

  describe("3-entry chain integrity", () => {
    it("legacy chain: genesis → A → B → C", () => {
      const hashA = computeAuditEntryHash(ENTRY_A, DOMAIN_TAG)
      const hashB = computeAuditEntryHash(ENTRY_B, DOMAIN_TAG)
      const hashC = computeAuditEntryHash(ENTRY_C, DOMAIN_TAG)

      // Legacy hashes are content-only (no chain linkage) — each is independent
      expect(hashA).toBe(EXPECTED.legacyA)
      expect(hashB).toBe(EXPECTED.legacyB)
      expect(hashC).toBe(EXPECTED.legacyC)
    })

    it("chain-bound chain: genesis → A → B → C", () => {
      const hashA = computeChainBoundHash(
        ENTRY_A, DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH,
      )
      const hashB = computeChainBoundHash(ENTRY_B, DOMAIN_TAG, hashA)
      const hashC = computeChainBoundHash(ENTRY_C, DOMAIN_TAG, hashB)

      expect(hashA).toBe(EXPECTED.chainBoundA)
      expect(hashB).toBe(EXPECTED.chainBoundB)
      expect(hashC).toBe(EXPECTED.chainBoundC)
    })
  })

  describe("tamper detection", () => {
    it("changing prevHash produces different chain-bound hash", () => {
      const tampered = computeChainBoundHash(
        ENTRY_A,
        DOMAIN_TAG,
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      )
      expect(tampered).toBe(EXPECTED.chainBoundA_tampered)
      expect(tampered).not.toBe(EXPECTED.chainBoundA)
    })

    it("swapping entry order produces different chain-bound hashes", () => {
      // Chain: genesis → B → A (swapped order)
      const hashB_first = computeChainBoundHash(
        ENTRY_B, DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH,
      )
      const hashA_second = computeChainBoundHash(
        ENTRY_A, DOMAIN_TAG, hashB_first,
      )

      // Must differ from normal order (genesis → A → B)
      expect(hashB_first).not.toBe(EXPECTED.chainBoundA)
      expect(hashA_second).not.toBe(EXPECTED.chainBoundB)
    })
  })

  describe("algorithm isolation", () => {
    it("legacy and chain-bound produce different hashes for same entry", () => {
      const legacy = computeAuditEntryHash(ENTRY_A, DOMAIN_TAG)
      const chainBound = computeChainBoundHash(
        ENTRY_A, DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH,
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
      expect(computeAdvisoryLockKey(DOMAIN_TAG)).toBe(-31603983)
    })

    it("governed-credits domain tag → expected key", () => {
      const tag = buildDomainTag("governed-credits", "8.3.1")
      expect(computeAdvisoryLockKey(tag)).toBe(-2057365484)
    })

    it("sessions domain tag → expected key", () => {
      const tag = buildDomainTag("sessions", "8.3.1")
      expect(computeAdvisoryLockKey(tag)).toBe(-1806563120)
    })

    it("produces signed 32-bit integers", () => {
      const key = computeAdvisoryLockKey(DOMAIN_TAG)
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
