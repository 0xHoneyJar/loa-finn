// tests/finn/hounfour/consumer-contract.test.ts — T-3.6
// Consumer contract validation: verifies finn's declared symbols exist in the
// protocol-types barrel and that warn-only startup check runs without throwing.

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  FINN_CONTRACT,
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
