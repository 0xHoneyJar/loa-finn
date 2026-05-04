// tests/finn/hounfour/consumer-contract.test.ts — T-3.6
// Consumer contract validation: verifies finn's declared symbols exist in the
// protocol-types barrel and that warn-only startup check runs without throwing.

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  FINN_CONTRACT,
  NON_CONTRACT_EXPORTS,
  buildExportMap,
  runConsumerContractCheck,
} from "../../../src/boot/consumer-contract-check.js"
import {
  validateConsumerContract,
  computeContractChecksum,
} from "../../../src/hounfour/protocol-types.js"

// ── Export map coverage ──────────────────────────────────────────────────

describe("consumer contract — export map", () => {
  it("export map contains >=10 symbols from v8.3.0", () => {
    const exportMap = buildExportMap()
    const symbols = exportMap["protocol-types"]
    expect(symbols).toBeDefined()
    expect(symbols.length).toBeGreaterThanOrEqual(10)
  })

  it("export map includes all FINN_CONTRACT symbols", () => {
    const exportMap = buildExportMap()
    const symbols = new Set(exportMap["protocol-types"])
    const contractSymbols =
      FINN_CONTRACT.entrypoints["protocol-types"].symbols

    for (const sym of contractSymbols) {
      expect(symbols.has(sym), `Missing symbol: ${sym}`).toBe(true)
    }
  })

  it("export map includes key v8.3.0 additions", () => {
    const exportMap = buildExportMap()
    const symbols = new Set(exportMap["protocol-types"])

    const v830Symbols = [
      "computeChainBoundHash",
      "validateDomainTag",
      "ChainBoundHashError",
      "computeAdvisoryLockKey",
      "computeDampenedScore",
      "GovernedResourceBase",
      "validateConsumerContract",
      "computeContractChecksum",
    ]

    for (const sym of v830Symbols) {
      expect(symbols.has(sym), `Missing v8.3.0 symbol: ${sym}`).toBe(true)
    }
  })
})

// ── Contract scope policy (T-4.1, GPT-review IMP-001) ──────────────────

describe("consumer contract — scope policy", () => {
  const exportMap = buildExportMap()
  const allBarrelExports = new Set(exportMap["protocol-types"])
  const contractSymbols = FINN_CONTRACT.entrypoints["protocol-types"].symbols

  it("(a) every symbol finn imports at runtime is in FINN_CONTRACT", () => {
    // These are the symbols finn actually imports at runtime (from src/ analysis)
    const runtimeImports = [
      "microUSDC", "readMicroUSDC", "protocolSerializeMicroUSDC",
      "isValidNftId", "parseNftId",
      "protocolComputeCostMicro", "verifyPricingConservation",
      "evaluateEconomicBoundary", "evaluateAccessPolicy",
      "PROTOCOL_JTI_POLICY",
      "computeAuditEntryHash", "computeChainBoundHash",
      "validateDomainTag", "buildDomainTag", "AUDIT_TRAIL_GENESIS_HASH",
      "verifyAuditTrailIntegrity", "AuditEntrySchema", "QuarantineRecordSchema",
      "validateAuditTimestamp",
      "computeAdvisoryLockKey",
      "computeDampenedScore", "FeedbackDampeningConfigSchema",
      "GovernedResourceBase", "GovernanceMutationSchema", "InvariantSchema",
      "ConservationLawSchema", "buildNonNegativeInvariant",
      "buildBoundedInvariant", "createBalanceConservation",
      "validateConsumerContract", "computeContractChecksum",
      "REPUTATION_STATES", "isKnownReputationState",
    ]

    const contractSet = new Set(contractSymbols)
    const missing = runtimeImports.filter((sym) => !contractSet.has(sym))
    expect(missing, `Runtime imports missing from FINN_CONTRACT: ${missing.join(", ")}`).toHaveLength(0)
  })

  it("(b) FINN_CONTRACT symbols are a subset of actual barrel exports", () => {
    const stale = contractSymbols.filter((sym) => !allBarrelExports.has(sym))
    expect(stale, `Stale contract symbols not in barrel: ${stale.join(", ")}`).toHaveLength(0)
  })

  it("(c) adding a new barrel export does NOT fail (contract stable across unrelated additions)", () => {
    // Simulate: barrel has extra symbols not in contract and not in NON_CONTRACT
    // The contract validation only checks that contract symbols exist in the export map,
    // NOT that every export is in the contract. So extra exports are fine.
    const result = validateConsumerContract(FINN_CONTRACT, exportMap)
    expect(result.valid).toBe(true)

    // Also verify that barrel exports NOT in contract are covered by NON_CONTRACT_EXPORTS
    const contractSet = new Set(contractSymbols)
    const uncovered = Array.from(allBarrelExports).filter(
      (sym) => !contractSet.has(sym) && !NON_CONTRACT_EXPORTS.has(sym),
    )
    // Allow type-only exports (they appear as undefined in Object.keys at runtime)
    // Any truly uncovered runtime export should be added to either contract or NON_CONTRACT
    expect(
      uncovered.length,
      `Uncategorized barrel exports (add to FINN_CONTRACT or NON_CONTRACT_EXPORTS): ${uncovered.join(", ")}`,
    ).toBe(0)
  })
})

// ── Contract validation ─────────────────────────────────────────────────

describe("consumer contract — validation", () => {
  it("validateConsumerContract returns valid for FINN_CONTRACT", () => {
    const exportMap = buildExportMap()
    const result = validateConsumerContract(FINN_CONTRACT, exportMap)

    expect(result.valid).toBe(true)
    expect(result.missing_symbols).toHaveLength(0)
    expect(result.unknown_entrypoints).toHaveLength(0)
  })

  it("computeContractChecksum is deterministic", () => {
    const checksum1 = computeContractChecksum(FINN_CONTRACT)
    const checksum2 = computeContractChecksum(FINN_CONTRACT)
    expect(checksum1).toBe(checksum2)
    expect(checksum1).toMatch(/^sha256:[a-f0-9]{64}$/) // SHA-256 hex with prefix
  })

  it("detects missing symbols", () => {
    const emptyMap: Record<string, string[]> = {
      "protocol-types": [],
    }
    const result = validateConsumerContract(FINN_CONTRACT, emptyMap)

    expect(result.valid).toBe(false)
    expect(result.missing_symbols.length).toBeGreaterThan(0)
  })
})

// ── Startup warn-only check ─────────────────────────────────────────────

describe("consumer contract — startup check", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("runConsumerContractCheck does not throw", () => {
    expect(() => runConsumerContractCheck()).not.toThrow()
  })

  it("does not log warning when contract is valid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    runConsumerContractCheck()
    // Should not warn about drift (contract matches actual exports)
    const driftWarns = warnSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" && args[0].includes("Drift detected"),
    )
    expect(driftWarns).toHaveLength(0)
  })
})
