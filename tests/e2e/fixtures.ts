// tests/e2e/fixtures.ts — E2E Test Fixtures (Sprint 3)
//
// Shared test configuration for E2E smoke tests.
// All values are deterministic and safe for CI — no real funded wallets.

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const E2E_BASE_URL = (
  process.env.E2E_BASE_URL ?? "http://localhost:3000"
).replace(/\/+$/, "")

// ---------------------------------------------------------------------------
// Test Wallet
// ---------------------------------------------------------------------------

/** Hardcoded test wallet — NOT a real funded wallet. */
export const TEST_WALLET_ADDRESS =
  "0x00000000000000000000000000000000deadbeef"

// ---------------------------------------------------------------------------
// Test NFT
// ---------------------------------------------------------------------------

/** Test NFT collection address (matches molecule-tarot test data). */
export const TEST_NFT_COLLECTION =
  "0x0000000000000000000000000000000000c0ffee"

/** Test token ID within the collection. */
export const TEST_NFT_TOKEN_ID = "42"

/** Composite NFT identifier (collection:tokenId). */
export const TEST_NFT_ID = `${TEST_NFT_COLLECTION}:${TEST_NFT_TOKEN_ID}`

// ---------------------------------------------------------------------------
// Test Personality
// ---------------------------------------------------------------------------

export const TEST_PERSONALITY_CONFIG = {
  display_name: "Smoke Test Agent",
  archetype: "trickster",
  voice: "casual",
  expertise_domains: ["testing", "quality-assurance"],
  custom_instructions: "You are a smoke test agent. Keep responses short.",
} as const
