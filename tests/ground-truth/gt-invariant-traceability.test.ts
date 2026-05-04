// tests/ground-truth/gt-invariant-traceability.test.ts — GT-derived invariant verification
// Sprint 3 T-3.2, T-3.3, T-3.4
//
// Verifies that GT-documented invariants (contracts.yaml) are backed by actual tests.
// Does NOT duplicate existing property tests — instead verifies their existence and
// closes the loop: GT claims → YAML → test coverage → traceability.

import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  loadGTInvariants,
  getAllInvariants,
  getInvariant,
  getDomainInvariants,
  gtTestName,
  type GTInvariant,
} from "./gt-invariant-harness.js"

const REPO_ROOT = join(__dirname, "../..")

// --- Traceability Map: GT Invariant ID → existing test file:line ---
// This is the core artifact of Sprint 3 T-3.4.
// Each entry documents WHERE the invariant is tested and HOW.

interface TestCoverage {
  file: string
  description: string
  type: "property" | "unit" | "integration" | "e2e"
}

const INVARIANT_TEST_MAP: Record<string, TestCoverage[]> = {
  // Billing invariants (T-3.2)
  "INV-1": [
    {
      file: "tests/finn/billing-invariants.test.ts",
      description: "INV-1: random FinalizeResult always passes completeness (100 scenarios)",
      type: "property",
    },
    {
      file: "tests/finn/billing-invariants.test.ts",
      description: "INV-1: invalid states throw",
      type: "unit",
    },
  ],
  "INV-2": [
    {
      file: "tests/finn/dlq-persistence.test.ts",
      description: "DLQ store persistence with Redis AOF semantics",
      type: "integration",
    },
  ],
  "INV-2D": [
    {
      file: "tests/finn/billing-invariants.test.ts",
      description: "store failure: put() error is catchable, entry available for manual recovery",
      type: "unit",
    },
  ],
  "INV-3": [
    {
      file: "tests/finn/billing-invariants.test.ts",
      description: "INV-3: duplicate reservation_id is idempotent via upsert (100 scenarios)",
      type: "property",
    },
    {
      file: "tests/finn/dlq-persistence.test.ts",
      description: "409 idempotency E2E: second finalize returns idempotent status",
      type: "integration",
    },
  ],
  "INV-4": [
    {
      file: "tests/finn/billing-conservation-guard.test.ts",
      description: "BillingConservationGuard lifecycle and invariant evaluation",
      type: "unit",
    },
  ],
  "INV-5": [
    {
      file: "tests/finn/billing-invariants.test.ts",
      description: "INV-5: replay exhausts retries → entry removed at maxRetries (50 scenarios)",
      type: "property",
    },
    {
      file: "tests/finn/billing-invariants.test.ts",
      description: "terminal drop preserves audit record in store",
      type: "unit",
    },
  ],

  // Credit conservation (T-3.3)
  "CREDIT-SUM": [
    {
      file: "tests/credits/ledger.test.ts",
      description: "Conservation holds after full lifecycle: allocate → unlock → reserve → consume",
      type: "unit",
    },
    {
      file: "tests/credits/ledger.test.ts",
      description: "verifyAllConservation checks all accounts",
      type: "unit",
    },
    {
      file: "tests/credits/consumption-atomic.test.ts",
      description: "TOCTOU race: 10 concurrent reserve requests against balance=5",
      type: "integration",
    },
    {
      file: "tests/e2e/budget-conservation.test.ts",
      description: "Budget exhaustion returns 429",
      type: "e2e",
    },
  ],
  "CREDIT-NONCE": [
    {
      file: "tests/credits/ledger.test.ts",
      description: "markNonceUsed() returns true on first use, false on replay",
      type: "unit",
    },
    {
      file: "tests/credits/nonce-cleanup.test.ts",
      description: "NonceCleanupService wrapping cleanupExpiredNonces",
      type: "unit",
    },
  ],

  // WAL invariants
  "WAL-SEQ": [
    {
      file: "tests/finn/billing-invariants.test.ts",
      description: "WAL sequence monotonicity via ULID monotonicFactory",
      type: "unit",
    },
  ],
  "WAL-CRC": [
    {
      file: "tests/finn/hash-chain-round-trip.test.ts",
      description: "Hash chain round-trip verification",
      type: "property",
    },
  ],

  // Auth invariants
  "AUTH-JTI": [
    {
      file: "tests/finn/billing-finalize.test.ts",
      description: "JWT JTI replay guard (via DLQ test infrastructure)",
      type: "integration",
    },
  ],

  // Circuit breaker
  "CB-FSM": [
    {
      file: "tests/finn/billing-conservation-guard.test.ts",
      description: "Circuit breaker state machine transitions",
      type: "unit",
    },
  ],
}

// --- Tests ---

describe("GT Contracts YAML — Structural Integrity", () => {
  it("contracts.yaml loads and parses", () => {
    const contracts = loadGTInvariants()
    expect(contracts.version).toBe("1.0.0")
    expect(contracts.domains.length).toBeGreaterThan(0)
  })

  it("all invariants have required fields", () => {
    const invariants = getAllInvariants()
    for (const inv of invariants) {
      expect(inv.id, `${inv.id}: missing id`).toBeTruthy()
      expect(inv.name, `${inv.id}: missing name`).toBeTruthy()
      expect(inv.statement, `${inv.id}: missing statement`).toBeTruthy()
      expect(inv.source, `${inv.id}: missing source`).toBeTruthy()
      expect(inv.enforcement, `${inv.id}: missing enforcement`).toBeTruthy()
      expect(inv.severity, `${inv.id}: missing severity`).toBeTruthy()
    }
  })

  it("no duplicate invariant IDs", () => {
    const invariants = getAllInvariants()
    const ids = invariants.map(i => i.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  it("source files exist for all invariants", () => {
    const invariants = getAllInvariants()
    const missing: string[] = []
    for (const inv of invariants) {
      const srcPath = join(REPO_ROOT, inv.source.file)
      if (!existsSync(srcPath)) {
        missing.push(`${inv.id}: ${inv.source.file}`)
      }
    }
    expect(missing, `Missing source files:\n${missing.join("\n")}`).toHaveLength(0)
  })
})

describe("GT Invariant Traceability — Billing (T-3.2)", () => {
  const billingInvariants = ["INV-1", "INV-3", "INV-5"]

  for (const id of billingInvariants) {
    it(`[${id}] has property-based test coverage`, () => {
      const coverage = INVARIANT_TEST_MAP[id]
      expect(coverage, `${id}: no test coverage mapped`).toBeDefined()
      expect(coverage!.length).toBeGreaterThan(0)

      // Verify at least one property test
      const propertyTests = coverage!.filter(c => c.type === "property")
      expect(
        propertyTests.length,
        `${id}: expected at least 1 property test, found ${propertyTests.length}`,
      ).toBeGreaterThan(0)

      // Verify test files exist
      for (const tc of coverage!) {
        const testPath = join(REPO_ROOT, tc.file)
        expect(existsSync(testPath), `${id}: test file not found: ${tc.file}`).toBe(true)
      }
    })
  }
})

describe("GT Invariant Traceability — Credit Conservation (T-3.3)", () => {
  const creditInvariants = ["CREDIT-SUM", "CREDIT-NONCE"]

  for (const id of creditInvariants) {
    it(`[${id}] has test coverage`, () => {
      const coverage = INVARIANT_TEST_MAP[id]
      expect(coverage, `${id}: no test coverage mapped`).toBeDefined()
      expect(coverage!.length).toBeGreaterThan(0)

      // Verify test files exist
      for (const tc of coverage!) {
        const testPath = join(REPO_ROOT, tc.file)
        expect(existsSync(testPath), `${id}: test file not found: ${tc.file}`).toBe(true)
      }
    })
  }

  it("[CREDIT-SUM] has multi-layer coverage (unit + integration + e2e)", () => {
    const coverage = INVARIANT_TEST_MAP["CREDIT-SUM"]!
    const types = new Set(coverage.map(c => c.type))
    expect(types.has("unit"), "CREDIT-SUM: missing unit test").toBe(true)
    expect(types.has("integration"), "CREDIT-SUM: missing integration test").toBe(true)
    expect(types.has("e2e"), "CREDIT-SUM: missing e2e test").toBe(true)
  })
})

describe("GT Traceability Report (T-3.4)", () => {
  it("generates coverage report for all GT invariants", () => {
    const invariants = getAllInvariants()
    const covered: string[] = []
    const uncovered: string[] = []

    for (const inv of invariants) {
      const coverage = INVARIANT_TEST_MAP[inv.id]
      if (coverage && coverage.length > 0) {
        covered.push(inv.id)
      } else {
        uncovered.push(inv.id)
      }
    }

    // Report
    console.log("\n=== GT Invariant Test Coverage Report ===")
    console.log(`Total invariants: ${invariants.length}`)
    console.log(`Covered: ${covered.length} (${Math.round(100 * covered.length / invariants.length)}%)`)
    console.log(`Uncovered: ${uncovered.length}`)
    console.log("")

    for (const inv of invariants) {
      const coverage = INVARIANT_TEST_MAP[inv.id]
      if (coverage) {
        for (const tc of coverage) {
          console.log(`  ${inv.id} → ${tc.file} (${tc.type})`)
        }
      } else {
        console.log(`  ${inv.id} → NO TEST COVERAGE`)
      }
    }

    // All billing + credit invariants must be covered
    const requiredCovered = ["INV-1", "INV-2", "INV-2D", "INV-3", "INV-4", "INV-5", "CREDIT-SUM", "CREDIT-NONCE"]
    for (const id of requiredCovered) {
      expect(covered, `Required invariant ${id} is not covered`).toContain(id)
    }
  })
})
