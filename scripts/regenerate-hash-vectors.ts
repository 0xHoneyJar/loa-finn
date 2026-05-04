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
  computeAdvisoryLockKey,
} from "../src/hounfour/protocol-types.js"
import type { AuditEntryHashInput } from "../src/hounfour/protocol-types.js"

// v8.3.1+: buildDomainTag natively sanitizes dots to hyphens (hounfour PR #42)
const DOMAIN_TAG = buildDomainTag("test-store", "8.3.1")

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

const legacyA = computeAuditEntryHash(ENTRY_A, DOMAIN_TAG)
const legacyB = computeAuditEntryHash(ENTRY_B, DOMAIN_TAG)
const legacyC = computeAuditEntryHash(ENTRY_C, DOMAIN_TAG)

const chainBoundA = computeChainBoundHash(ENTRY_A, DOMAIN_TAG, AUDIT_TRAIL_GENESIS_HASH)
const chainBoundB = computeChainBoundHash(ENTRY_B, DOMAIN_TAG, chainBoundA)
const chainBoundC = computeChainBoundHash(ENTRY_C, DOMAIN_TAG, chainBoundB)

const chainBoundA_tampered = computeChainBoundHash(
  ENTRY_A,
  DOMAIN_TAG,
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

// Advisory lock key vectors
const tagTestStore = buildDomainTag("test-store", "8.3.1")
const tagGovCredits = buildDomainTag("governed-credits", "8.3.1")
const tagSessions = buildDomainTag("sessions", "8.3.1")

console.log("")
console.log("// Advisory lock key vectors:")
console.log(`//   test-store tag: "${tagTestStore}" → ${computeAdvisoryLockKey(tagTestStore)}`)
console.log(`//   governed-credits tag: "${tagGovCredits}" → ${computeAdvisoryLockKey(tagGovCredits)}`)
console.log(`//   sessions tag: "${tagSessions}" → ${computeAdvisoryLockKey(tagSessions)}`)
