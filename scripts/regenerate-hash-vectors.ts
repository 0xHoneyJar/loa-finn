#!/usr/bin/env npx tsx
// scripts/regenerate-hash-vectors.ts — T-4.3
//
// Computes fresh expected hash values from the current hounfour installation
// and prints them in the EXPECTED format used by chain-bound-hash-vectors.test.ts.
//
// Usage: npx tsx scripts/regenerate-hash-vectors.ts
//
// Compare output against the hardcoded EXPECTED object in the test file.
// If values differ, hounfour changed its hash internals — review before updating.

import {
  computeAuditEntryHash,
  computeChainBoundHash,
  buildDomainTag,
  AUDIT_TRAIL_GENESIS_HASH,
} from "../src/hounfour/protocol-types.js"
import type { AuditEntryHashInput } from "../src/hounfour/protocol-types.js"

const LEGACY_DOMAIN_TAG = buildDomainTag("test-store", "8.3.0")
const SANITIZED_DOMAIN_TAG = LEGACY_DOMAIN_TAG.replace(/\./g, "-")

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

const legacyA = computeAuditEntryHash(ENTRY_A, LEGACY_DOMAIN_TAG)
const legacyB = computeAuditEntryHash(ENTRY_B, LEGACY_DOMAIN_TAG)
const legacyC = computeAuditEntryHash(ENTRY_C, LEGACY_DOMAIN_TAG)

const chainBoundA = computeChainBoundHash(ENTRY_A, SANITIZED_DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH)
const chainBoundB = computeChainBoundHash(ENTRY_B, SANITIZED_DOMAIN_TAG, chainBoundA)
const chainBoundC = computeChainBoundHash(ENTRY_C, SANITIZED_DOMAIN_TAG, chainBoundB)

const chainBoundA_tampered = computeChainBoundHash(
  ENTRY_A,
  SANITIZED_DOMAIN_TAG,
  "sha256:0000000000000000000000000000000000000000000000000000000000000000",
)

console.log("const EXPECTED = {")
console.log(`  legacyA: "${legacyA}",`)
console.log(`  legacyB: "${legacyB}",`)
console.log(`  legacyC: "${legacyC}",`)
console.log(`  chainBoundA: "${chainBoundA}",`)
console.log(`  chainBoundB: "${chainBoundB}",`)
console.log(`  chainBoundC: "${chainBoundC}",`)
console.log(`  chainBoundA_tampered: "${chainBoundA_tampered}",`)
console.log("} as const")
