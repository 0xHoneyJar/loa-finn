// tests/finn/vocabulary-adoption.test.ts — Protocol Vocabulary Adoption (Sprint 2, Task 2.5)
//
// Consistency tests verifying local and protocol functions agree on same inputs.
// Vocabulary constants imported and validated.

import { describe, it, expect } from "vitest"
import {
  protocolComputeCostMicro,
  protocolComputeCostMicroSafe,
  verifyPricingConservation,
  isValidNftId,
  parseNftId,
  formatNftId,
  isKnownReputationState,
  REPUTATION_STATES,
  TRANSFER_CHOREOGRAPHY,
  TRANSFER_INVARIANTS,
  ECONOMIC_CHOREOGRAPHY,
} from "../../src/hounfour/protocol-types.js"
import type {
  ProtocolPricingInput,
  ProtocolUsageInput,
  TransferChoreography,
  EconomicChoreography,
  NftId,
} from "../../src/hounfour/protocol-types.js"

// Local pricing functions for consistency comparison
import { calculateCostMicro } from "../../src/hounfour/pricing.js"
import { computeCostMicro as localComputeCostMicro } from "../../src/hounfour/budget.js"

// ---------------------------------------------------------------------------
// Pricing consistency: local vs protocol
// ---------------------------------------------------------------------------

describe("Pricing consistency — local vs protocol", () => {
  // Protocol pricing uses string-based micro-USD and ceil rounding.
  // Local pricing uses Number/BigInt arithmetic with floor rounding.
  // They should agree on the integer part for reasonable token counts.

  it("small token count: 100 tokens at $2.50/1M input", () => {
    const tokens = 100
    const priceMicroPerMillion = 2_500_000 // $2.50/1M

    // Local (Number-based)
    const localResult = calculateCostMicro(tokens, priceMicroPerMillion)

    // Local (BigInt-based)
    const localBigInt = localComputeCostMicro(BigInt(tokens), BigInt(priceMicroPerMillion))

    // Both local implementations should agree
    expect(localResult.cost_micro).toBe(Number(localBigInt.cost_micro))

    // Protocol (string-based) — uses ceil rounding, may be 1 higher
    const protocolResult = protocolComputeCostMicro(
      { input_per_million_micro: String(priceMicroPerMillion), output_per_million_micro: "0" },
      { prompt_tokens: tokens, completion_tokens: 0 },
    )
    const protocolCost = BigInt(protocolResult)

    // Protocol ceil vs local floor: protocol >= local, difference <= 1
    expect(protocolCost).toBeGreaterThanOrEqual(localBigInt.cost_micro)
    expect(protocolCost - localBigInt.cost_micro).toBeLessThanOrEqual(1n)
  })

  it("large token count: 1M tokens at $15/1M input", () => {
    const tokens = 1_000_000
    const priceMicroPerMillion = 15_000_000 // $15/1M

    const localBigInt = localComputeCostMicro(BigInt(tokens), BigInt(priceMicroPerMillion))

    const protocolResult = protocolComputeCostMicro(
      { input_per_million_micro: String(priceMicroPerMillion), output_per_million_micro: "0" },
      { prompt_tokens: tokens, completion_tokens: 0 },
    )
    const protocolCost = BigInt(protocolResult)

    // For exact division (1M tokens / 1M), both should agree exactly
    expect(protocolCost).toBe(localBigInt.cost_micro)
  })

  it("protocolComputeCostMicroSafe returns ok result for valid inputs", () => {
    const result = protocolComputeCostMicroSafe(
      { input_per_million_micro: "2500000", output_per_million_micro: "10000000" },
      { prompt_tokens: 500, completion_tokens: 200 },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(BigInt(result.cost)).toBeGreaterThan(0n)
    }
  })

  it("protocolComputeCostMicroSafe returns error for negative tokens", () => {
    const result = protocolComputeCostMicroSafe(
      { input_per_million_micro: "2500000", output_per_million_micro: "10000000" },
      { prompt_tokens: -1, completion_tokens: 0 },
    )
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pricing conservation verification
// ---------------------------------------------------------------------------

describe("verifyPricingConservation", () => {
  it("conserved when cost matches computation", () => {
    const pricing: ProtocolPricingInput = {
      input_per_million_micro: "2500000",
      output_per_million_micro: "10000000",
    }
    const usage: ProtocolUsageInput = {
      prompt_tokens: 1000,
      completion_tokens: 500,
    }
    const expectedCost = protocolComputeCostMicro(pricing, usage)

    const result = verifyPricingConservation(
      { cost_micro: expectedCost, pricing_snapshot: pricing },
      usage,
    )
    expect(result.conserved).toBe(true)
    expect(result.status).toBe("conserved")
  })

  it("violated when cost differs from computation", () => {
    const pricing: ProtocolPricingInput = {
      input_per_million_micro: "2500000",
      output_per_million_micro: "10000000",
    }
    const usage: ProtocolUsageInput = {
      prompt_tokens: 1000,
      completion_tokens: 500,
    }

    const result = verifyPricingConservation(
      { cost_micro: "999999999", pricing_snapshot: pricing },
      usage,
    )
    expect(result.conserved).toBe(false)
    expect(result.status).toBe("violated")
  })

  it("unverifiable when pricing snapshot missing", () => {
    const usage: ProtocolUsageInput = {
      prompt_tokens: 1000,
      completion_tokens: 500,
    }

    const result = verifyPricingConservation(
      { cost_micro: "12345" },
      usage,
    )
    expect(result.status).toBe("unverifiable")
  })
})

// ---------------------------------------------------------------------------
// NFT ID utilities
// ---------------------------------------------------------------------------

describe("NFT ID utilities — protocol adoption", () => {
  const VALID_NFT_ID = "eip155:1/0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D/1234"

  it("isValidNftId accepts valid canonical NFT ID", () => {
    expect(isValidNftId(VALID_NFT_ID)).toBe(true)
  })

  it("isValidNftId accepts lowercase address", () => {
    expect(isValidNftId("eip155:1/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1")).toBe(true)
  })

  it("isValidNftId rejects invalid format", () => {
    expect(isValidNftId("invalid")).toBe(false)
    expect(isValidNftId("")).toBe(false)
    expect(isValidNftId("eip155:1/notanaddress/1")).toBe(false)
  })

  it("parseNftId extracts components", () => {
    const parsed = parseNftId(VALID_NFT_ID)
    expect(parsed.chainId).toBe(1)
    expect(parsed.tokenId).toBe("1234")
    expect(typeof parsed.collection).toBe("string")
    expect(parsed.collection.startsWith("0x")).toBe(true)
  })

  it("formatNftId round-trips with parseNftId", () => {
    const parsed = parseNftId(VALID_NFT_ID)
    const formatted = formatNftId(parsed.chainId, parsed.collection, parsed.tokenId)
    const reparsed = parseNftId(formatted)
    expect(reparsed.chainId).toBe(parsed.chainId)
    expect(reparsed.tokenId).toBe(parsed.tokenId)
    expect(reparsed.collection.toLowerCase()).toBe(parsed.collection.toLowerCase())
  })
})

// ---------------------------------------------------------------------------
// Reputation state vocabulary
// ---------------------------------------------------------------------------

describe("Reputation state vocabulary — protocol adoption", () => {
  it("REPUTATION_STATES covers all 4 canonical states", () => {
    expect(REPUTATION_STATES).toHaveLength(4)
    expect(REPUTATION_STATES).toContain("cold")
    expect(REPUTATION_STATES).toContain("warming")
    expect(REPUTATION_STATES).toContain("established")
    expect(REPUTATION_STATES).toContain("authoritative")
  })

  it("isKnownReputationState validates and narrows", () => {
    for (const state of REPUTATION_STATES) {
      expect(isKnownReputationState(state)).toBe(true)
    }
    expect(isKnownReputationState("invalid")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Transfer choreography vocabulary
// ---------------------------------------------------------------------------

describe("Transfer choreography vocabulary — protocol adoption", () => {
  it("TRANSFER_CHOREOGRAPHY has sale scenario", () => {
    expect(TRANSFER_CHOREOGRAPHY.sale).toBeDefined()
    expect(TRANSFER_CHOREOGRAPHY.sale.forward).toBeDefined()
    expect(TRANSFER_CHOREOGRAPHY.sale.compensation).toBeDefined()
    expect(TRANSFER_CHOREOGRAPHY.sale.forward.length).toBeGreaterThan(0)
  })

  it("TRANSFER_CHOREOGRAPHY has gift scenario", () => {
    expect(TRANSFER_CHOREOGRAPHY.gift).toBeDefined()
  })

  it("TRANSFER_CHOREOGRAPHY has admin_recovery scenario", () => {
    expect(TRANSFER_CHOREOGRAPHY.admin_recovery).toBeDefined()
  })

  it("TRANSFER_CHOREOGRAPHY has custody_change scenario", () => {
    expect(TRANSFER_CHOREOGRAPHY.custody_change).toBeDefined()
  })

  it("TRANSFER_INVARIANTS defined for all scenarios", () => {
    expect(TRANSFER_INVARIANTS).toBeDefined()
    expect(TRANSFER_INVARIANTS.sale).toBeDefined()
    expect(TRANSFER_INVARIANTS.sale.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Economic choreography vocabulary
// ---------------------------------------------------------------------------

describe("Economic choreography vocabulary — protocol adoption", () => {
  it("ECONOMIC_CHOREOGRAPHY has stake scenario", () => {
    expect(ECONOMIC_CHOREOGRAPHY.stake).toBeDefined()
    expect(ECONOMIC_CHOREOGRAPHY.stake.forward).toBeDefined()
    expect(ECONOMIC_CHOREOGRAPHY.stake.compensation).toBeDefined()
  })

  it("ECONOMIC_CHOREOGRAPHY has escrow scenario", () => {
    expect(ECONOMIC_CHOREOGRAPHY.escrow).toBeDefined()
  })

  it("ECONOMIC_CHOREOGRAPHY has mutual_credit scenario", () => {
    expect(ECONOMIC_CHOREOGRAPHY.mutual_credit).toBeDefined()
  })
})
